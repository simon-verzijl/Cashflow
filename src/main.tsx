import React, {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import html2canvas from "html2canvas";
import "./styles.css";
import "./extra.css";
import { defaultCategories } from "./data";
import { decodeBankCsv, parseRaboCsv } from "./csv";
import { parseNnPdf } from "./nnPdf";
import {
  isValidPattern,
  matchingRule,
  ruleMatchesTransaction,
  suggest,
} from "./categorize";
import {
  loadAll,
  replaceAll,
  saveCategories,
  saveRules,
  saveTransactions,
} from "./storage";
import type { Category, Rule, Transaction } from "./types";

const money = new Intl.NumberFormat("nl-NL", {
  style: "currency",
  currency: "EUR",
});
const date = (s: string) =>
  new Intl.DateTimeFormat("nl-NL", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${s}T12:00:00`));
const uid = (p: string) => `${p}-${crypto.randomUUID()}`;
const MAX_VISIBLE_RESULTS = 250;
const RECENT_CATEGORY_STORAGE_KEY = "cashflow-recent-categories";
const IGNORED_RULE_PROPOSALS_STORAGE_KEY = "cashflow-ignored-rule-proposals";
const YEAR_CHART_ORDER_STORAGE_KEY = "cashflow-year-chart-order";
const ruleMatchCountCache = new Map<string, number>();
const transactionMatchSignature = (transactions: Transaction[]) =>
  JSON.stringify(
    transactions
      .map((t) => [
        t.id,
        t.date,
        t.amount,
        t.counterpartyIban,
        t.counterparty,
        t.description,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
const sortCategories = (categories: Category[]) =>
  [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, "nl", { sensitivity: "base" }),
  );
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftMonths = (value: string, months: number) => {
  const d = new Date(`${value}T12:00:00`);
  d.setMonth(d.getMonth() + months);
  return iso(d);
};
const monthStart = (month: string) => `${month}-01`;
const monthEnd = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number);
  return iso(new Date(year, monthNumber, 0, 12));
};
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat("nl-NL", { month: "long", year: "numeric" }).format(
    new Date(`${month}-01T12:00:00`),
  );
const monthName = (month: string) =>
  new Intl.DateTimeFormat("nl-NL", { month: "long" }).format(
    new Date(`${month}-01T12:00:00`),
  );

function DateFilterInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (inputRef.current && !editing.current) inputRef.current.value = value;
  }, [value]);
  return (
    <input
      ref={inputRef}
      type="date"
      defaultValue={value}
      required
      onFocus={() => {
        editing.current = true;
      }}
      onBlur={(e) => {
        editing.current = false;
        const next = e.currentTarget.value;
        if (
          next &&
          e.currentTarget.validity.valid &&
          /^\d{4}-\d{2}-\d{2}$/.test(next)
        ) {
          if (next !== value) onCommit(next);
        } else {
          e.currentTarget.value = value;
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<
    | "overzicht"
    | "review"
    | "regels"
    | "categorieen"
    | "jaarvergelijking"
    | "importeren"
  >("overzicht");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [darkMode, setDarkMode] = useState(
    () => localStorage.getItem("cashflow-dark-mode") === "true",
  );
  const [reviewQuery, setReviewQuery] = useState("");
  const [focusRuleId, setFocusRuleId] = useState<string | null>(null);
  const [start, setStart] = useState(shiftMonths(iso(new Date()), -11));
  const [end, setEnd] = useState(iso(new Date()));
  const [domainStart, setDomainStart] = useState(
    shiftMonths(iso(new Date()), -11),
  );
  const [domainEnd, setDomainEnd] = useState(iso(new Date()));
  const dateRangeFollowsData = useRef(true);
  const [chartCat, setChartCat] = useState("all");
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkCat, setBulkCat] = useState("");
  const downloadBackup = async () => {
    const data = await loadAll();
    const blob = new Blob(
      [
        JSON.stringify(
          { version: 1, exportedAt: new Date().toISOString(), ...data },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cashflow-backup-${iso(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(url);
    localStorage.setItem("cashflow-last-backup", new Date().toISOString());
    setNotice("Backup opgeslagen als JSON-bestand.");
  };
  const restoreBackup = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (
        !Array.isArray(data.transactions) ||
        !Array.isArray(data.categories) ||
        !Array.isArray(data.rules)
      )
        throw new Error("Ongeldig backupbestand");
      const confirmed = window.confirm(
        "Weet je zeker dat je de huidige transacties, categorieën en automatische regels wilt overschrijven met deze backup?",
      );
      if (!confirmed) {
        setNotice("Herstellen geannuleerd. Je huidige data is niet gewijzigd.");
        return;
      }
      const restored = {
        transactions: data.transactions as Transaction[],
        categories: data.categories as Category[],
        rules: data.rules as Rule[],
      };
      await replaceAll(restored);
      setTransactions(restored.transactions);
      setCategories(
        sortCategories(
          restored.categories.length ? restored.categories : defaultCategories,
        ),
      );
      setRules(restored.rules);
      localStorage.setItem("cashflow-last-backup", new Date().toISOString());
      setNotice("Backup hersteld.");
    } catch {
      setNotice("Het backupbestand kon niet worden hersteld.");
    }
  };
  useEffect(() => {
    loadAll().then(async (x) => {
      // Repair the old "Geen categorie" action, which incorrectly confirmed
      // manually cleared transactions. Persist before marking the repair done.
      const repairKey = "cashflow-repair-cleared-categories-v1";
      if (localStorage.getItem(repairKey) !== "done") {
        const repaired = x.transactions
          .filter(
            (t) =>
              !t.categoryId &&
              t.status === "confirmed" &&
              t.suggestionSource === "handmatig",
          )
          .map((t): Transaction => ({
            ...t,
            categoryId: null,
            suggestedCategoryId: null,
            suggestionSource: "onbekend",
            status: "pending",
          }));
        await saveTransactions(repaired);
        const byId = new Map(repaired.map((t) => [t.id, t]));
        x.transactions = x.transactions.map((t) => byId.get(t.id) ?? t);
        localStorage.setItem(repairKey, "done");
        if (repaired.length) {
          setNotice(
            `${repaired.length} transacties zonder categorie hersteld naar Te beoordelen.`,
          );
        }
      }
      // Older versions marked an explicitly cleared category as "handmatig".
      // A cleared category is not a category choice: normalize those records
      // so they behave like ordinary uncategorized transactions.
      const clearedCategoryRepairKey = "cashflow-repair-cleared-categories-v2";
      if (localStorage.getItem(clearedCategoryRepairKey) !== "done") {
        const cleared = x.transactions
          .filter((t) => !t.categoryId && t.suggestionSource === "handmatig")
          .map((t): Transaction => ({
            ...t,
            categoryId: null,
            suggestedCategoryId: null,
            suggestionSource: "onbekend",
            status: "pending",
          }));
        if (cleared.length) {
          await saveTransactions(cleared);
          const byId = new Map(cleared.map((t) => [t.id, t]));
          x.transactions = x.transactions.map((t) => byId.get(t.id) ?? t);
        }
        localStorage.setItem(clearedCategoryRepairKey, "done");
        if (cleared.length) {
          setNotice(
            `${cleared.length} transacties zonder categorie zijn teruggezet naar Te beoordelen.`,
          );
        }
      }
      setTransactions(x.transactions);
      setCategories(
        sortCategories(x.categories.length ? x.categories : defaultCategories),
      );
      setRules(x.rules);
      if (x.transactions.length) {
        const sortedDates = x.transactions.map((t) => t.date).sort();
        const latest = sortedDates[sortedDates.length - 1];
        const earliest = sortedDates[0];
      setEnd(latest);
      setStart(earliest);
      setDomainEnd(latest);
      setDomainStart(earliest);
      dateRangeFollowsData.current = true;
      }
      setHydrated(true);
    });
  }, []);
  useEffect(() => {
    if (hydrated) void saveCategories(categories);
  }, [categories, hydrated]);
  useEffect(() => {
    localStorage.setItem("cashflow-dark-mode", String(darkMode));
  }, [darkMode]);
  useEffect(() => {
    saveTransactions(transactions);
  }, [transactions]);
  useEffect(() => {
    if (hydrated) saveRules(rules);
  }, [rules, hydrated]);
  useEffect(() => {
    if (!hydrated || !transactions.length) return;
    const lastBackup = localStorage.getItem("cashflow-last-backup");
    if (
      !lastBackup ||
      Date.now() - new Date(lastBackup).getTime() > 30 * 24 * 60 * 60 * 1000
    )
      setNotice(
        "Maak een backup van je lokale gegevens; de laatste backup is ouder dan 30 dagen of ontbreekt.",
      );
  }, [hydrated, transactions.length]);
  const filtered = useMemo(
    () => transactions.filter((t) => t.date >= start && t.date <= end),
    [transactions, start, end],
  );
  const totals = useMemo(
    () =>
      categories
        .filter((c) => !c.excludeFromSummary)
        .map((c) => ({
          ...c,
          total: filtered
            .filter((t) => t.categoryId === c.id)
            .reduce((s, t) => s + t.amount, 0),
          count: filtered.filter((t) => t.categoryId === c.id).length,
        }))
        .filter((c) => c.count || c.name === "Overig"),
    [categories, filtered],
  );
  const uncategorizedCount = filtered.filter((t) => !t.categoryId).length;
  const pending = transactions.filter((t) => t.status === "pending");
  const imported = async (file: File) => {
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      const isPdf = file.name.toLowerCase().endsWith(".pdf");
      const parsed = isPdf
        ? await parseNnPdf(bytes)
        : parseRaboCsv(decodeBankCsv(bytes));
      const existing = new Set(transactions.map((t) => t.id));
      const existingDates = transactions.map((t) => t.date).sort();
      const importedDates = parsed.map((t) => t.date).sort();
      let continuityWarning = "";
      if (existingDates.length && importedDates.length) {
        const latestExisting = existingDates[existingDates.length - 1];
        const earliestImported = importedDates[0];
        const existingTime = Date.parse(`${latestExisting}T00:00:00Z`);
        const importedTime = Date.parse(`${earliestImported}T00:00:00Z`);
        if (importedTime > existingTime) {
          const missingDays =
            Math.round((importedTime - existingTime) / 86_400_000) - 1;
          if (missingDays > 0) {
            continuityWarning = ` Let op: de nieuwe data sluit niet direct aan. De laatste bestaande transactie is van ${latestExisting} en de eerste nieuwe van ${earliestImported}; er zit ${missingDays} ${missingDays === 1 ? "dag" : "dagen"} tussen.`;
          }
        }
      }
      const fresh = parsed
        .filter((t) => !existing.has(t.id))
        .map((t) => {
          const s = suggest(
            t,
            categories.length ? categories : defaultCategories,
            rules,
          );
          return {
            ...t,
            suggestedCategoryId: s.id,
            categoryId: s.id,
            suggestionSource: s.source,
            status:
              s.source === "regel"
                ? ("confirmed" as const)
                : ("pending" as const),
          };
        });
      setTransactions((x) => [...x, ...fresh]);
      if (fresh.length && dateRangeFollowsData.current) {
        const allDates = [...transactions, ...fresh].map((t) => t.date).sort();
        setStart(allDates[0]);
        setEnd(allDates[allDates.length - 1]);
        setDomainStart(allDates[0]);
        setDomainEnd(allDates[allDates.length - 1]);
      }
      setNotice(
        `${fresh.length} nieuwe transacties geïmporteerd (${parsed.length - fresh.length} dubbelen overgeslagen).${continuityWarning}`,
      );
      setTab("review");
    } catch {
      setNotice(
        "Het bestand kon niet worden gelezen. Gebruik een Rabo-CSV of Nationale-Nederlanden PDF-export.",
      );
    } finally {
      setBusy(false);
    }
  };
  const confirm = (ids: string[], categoryId?: string) => {
    const clearCategory = categoryId === "__uncategorized__";
    setTransactions((xs) =>
      xs.map((t) =>
        ids.includes(t.id)
          ? {
              ...t,
              categoryId: clearCategory
                ? null
                : (categoryId ?? t.suggestedCategoryId),
              suggestedCategoryId: clearCategory
                ? null
                : (categoryId ?? t.suggestedCategoryId),
              status: clearCategory ? "pending" : "confirmed",
              suggestionSource: clearCategory
                ? "onbekend"
                : categoryId
                  ? "handmatig"
                  : t.suggestionSource,
            }
          : t,
      ),
    );
    setSelected([]);
  };
  const skip = (ids: string[]) => {
    setTransactions((xs) =>
      xs.map((t) => (ids.includes(t.id) ? { ...t, status: "skipped" } : t)),
    );
    setSelected([]);
  };
  const addRule = (
    t: Transaction,
    field: "counterparty" | "counterpartyIban" | "description",
    regex: boolean,
  ) => {
    const value = t[field];
    if (!t.categoryId || !value) return;
    const rule: Rule = {
      id: uid("rule"),
      priority:
        Math.max(
          0,
          ...rules.map((existingRule) => existingRule.priority ?? 0),
        ) + 1,
      field,
      value,
      regex,
      categoryId: t.categoryId!,
      enabled: true,
    };
    setRules((x) => [...x, rule]);
    // Open the rules page immediately so the newly created rule can be
    // reviewed or refined without having to find it in the sorted list.
    setFocusRuleId(rule.id);
    setTab("regels");
    setTransactions((xs) =>
      xs.map((transaction) => {
        if (transaction.suggestionSource === "handmatig") return transaction;
        const match = matchingRule(transaction, [rule]);
        return match
          ? {
              ...transaction,
              categoryId: rule.categoryId,
              suggestedCategoryId: rule.categoryId,
              suggestionSource: "regel",
              status: "confirmed",
            }
          : transaction;
      }),
    );
    setNotice(
      `Automatische regel opgeslagen en toegepast op bestaande transacties op ${field === "counterparty" ? "naam" : field === "counterpartyIban" ? "rekeningnummer" : "omschrijving"}.`,
    );
  };
  const applyBulk = () => {
    if (bulkCat && selected.length) confirm(selected, bulkCat);
  };
  const clearAllTransactions = () => {
    const today = iso(new Date());
    setTransactions([]);
    setSelected([]);
    setReviewQuery("");
    setStart(shiftMonths(today, -11));
    setEnd(today);
    setDomainStart(shiftMonths(today, -11));
    setDomainEnd(today);
    setZoom(null);
    setNotice(
      "Alle transacties zijn gewist. Categorieën en automatische regels zijn behouden.",
    );
    setTab("overzicht");
  };
  const openRule = (ruleId: string) => {
    setFocusRuleId(ruleId);
    setTab("regels");
  };
  return (
    <div className={`app ${darkMode ? "dark-mode" : ""}`}>
      <header>
        <button
          className="brand brand-home"
          onClick={() => {
            setFocusRuleId(null);
            setTab("overzicht");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          aria-label="Naar overzicht"
          title="Naar overzicht"
        >
          <span className="brand-mark">↗</span>
          <span>Cashflow v1.0</span>
        </button>
        <div className="privacy">● Alleen lokaal opgeslagen</div>
        <button
          className="theme-toggle"
          onClick={() => setDarkMode((value) => !value)}
          aria-label={
            darkMode ? "Lichte modus inschakelen" : "Donkere modus inschakelen"
          }
          title={darkMode ? "Lichte modus" : "Donkere modus"}
        >
          {darkMode ? "☀" : "☾"}
        </button>
        <button className="import-button" onClick={() => setTab("importeren")}>
          Export/Import
        </button>
      </header>
      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">FINANCIEEL OVERZICHT</p>
            <h1>
              Grip op je <em>geldstromen.</em>
            </h1>
            <p className="intro">
              Importeer je banktransacties, categoriseer je uitgaven en krijg
              helder inzicht in je financiële stromen.
            </p>
          </div>
          <div className="hero-stat">
            <span>TRANSACTIES</span>
            <strong>{transactions.length.toLocaleString("nl-NL")}</strong>
            <small>
              {pending.length
                ? `${pending.length} wacht op bevestiging`
                : "Alles verwerkt"}
            </small>
          </div>
        </section>
        <nav className="tabs">
          <button
            className={tab === "overzicht" ? "active" : ""}
            onClick={() => setTab("overzicht")}
          >
            Overzicht
          </button>
          <button
            className={tab === "review" ? "active" : ""}
            onClick={() => setTab("review")}
          >
            Te beoordelen {pending.length > 0 && <b>{pending.length}</b>}
          </button>
          <button
            className={tab === "regels" ? "active" : ""}
            onClick={() => setTab("regels")}
          >
            Automatische regels{" "}
            <span>{rules.filter((r) => r.enabled).length}</span>
          </button>
          <button
            className={tab === "categorieen" ? "active" : ""}
            onClick={() => setTab("categorieen")}
          >
            Categorieën
          </button>
          <button
            className={tab === "jaarvergelijking" ? "active" : ""}
            onClick={() => setTab("jaarvergelijking")}
          >
            Trends
          </button>
        </nav>
        {notice && (
          <div className="notice">
            {notice}
            <button onClick={() => setNotice("")}>×</button>
          </div>
        )}
        {tab === "importeren" && (
          <ImportPage
            busy={busy}
            onImport={imported}
            onBack={() => setTab("overzicht")}
            onBackup={downloadBackup}
            onRestore={restoreBackup}
          />
        )}
        {tab === "overzicht" && (
          <Overview
            transactions={filtered}
            allTransactions={transactions}
            totals={totals}
            uncategorizedCount={uncategorizedCount}
            start={start}
            end={end}
            domainStart={domainStart}
            domainEnd={domainEnd}
            setStart={(value: string) => {
              dateRangeFollowsData.current = false;
              setStart(value);
              setDomainStart(value);
            }}
            setEnd={(value: string) => {
              dateRangeFollowsData.current = false;
              setEnd(value);
              setDomainEnd(value);
            }}
            setVisibleStart={(value: string) => {
              dateRangeFollowsData.current = false;
              setStart(value);
            }}
            setVisibleEnd={(value: string) => {
              dateRangeFollowsData.current = false;
              setEnd(value);
            }}
            chartCat={chartCat}
            setChartCat={setChartCat}
            zoom={zoom}
            setZoom={setZoom}
            categories={categories}
            rules={rules}
            setTransactions={setTransactions}
            openRule={openRule}
          />
        )}
        {tab === "review" && (
          <Review
            pending={pending}
            query={reviewQuery}
            setQuery={setReviewQuery}
            categories={categories}
            selected={selected}
            setSelected={setSelected}
            setTransactions={setTransactions}
            confirm={confirm}
            skip={skip}
            addRule={addRule}
            bulkCat={bulkCat}
            setBulkCat={setBulkCat}
            applyBulk={applyBulk}
          />
        )}
        {tab === "regels" && (
          <Rules
            rules={rules}
            categories={categories}
            setRules={setRules}
            transactions={transactions}
            setTransactions={setTransactions}
            setNotice={setNotice}
            focusRuleId={focusRuleId}
          />
        )}
        {tab === "categorieen" && (
          <Categories
            categories={categories}
            setCategories={setCategories}
            rules={rules}
            setRules={setRules}
            transactions={transactions}
            setTransactions={setTransactions}
            onClearTransactions={clearAllTransactions}
          />
        )}
        {tab === "jaarvergelijking" && (
          <YearComparison
            transactions={transactions}
            categories={categories}
            setTransactions={setTransactions}
          />
        )}
      </main>
      <footer>
        Je gegevens verlaten deze browser niet. <span>Cashflow v1.0</span>
      </footer>
    </div>
  );
}

function ImportPage({
  busy,
  onImport,
  onBack,
  onBackup,
  onRestore,
}: {
  busy: boolean;
  onImport: (file: File) => void;
  onBack: () => void;
  onBackup: () => void;
  onRestore: (file: File) => void;
}) {
  return (
    <section className="panel import-page">
      <div className="panel-head">
        <div>
          <p className="eyebrow">TRANSACTIES</p>
          <h2>Transacties importeren</h2>
          <p className="muted">
            Kies het exportbestand van je bank. De gegevens blijven lokaal in
            deze browser opgeslagen.
          </p>
          <p className="muted import-dedup-note">
            Bij het importeren worden bestaande transacties herkend. Dubbele
            transacties worden automatisch overgeslagen.
          </p>
        </div>
        <button className="small-muted" onClick={onBack}>
          Terug naar overzicht
        </button>
      </div>
      <div className="import-options">
        <label className="import-option">
          <span className="eyebrow">RABOBANK</span>
          <strong>Rabobank CSV-export</strong>
          <small>Importeer een Rabo-exportbestand met de extensie .csv.</small>
          <div className="import-guidance">
            <b>Waar vind je de export?</b>
            <div>
              <strong>In de Rabo App</strong>
              <p>
                Selecteer je rekening en kies <em>Acties → Download transacties</em>.
              </p>
            </div>
            <div>
              <strong>Op de Rabobank-website</strong>
              <p>
                Selecteer je rekening en kies rechts <em>Download transacties</em>.
              </p>
            </div>
          </div>
          <span className="small-primary">CSV-bestand kiezen</span>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
          />
        </label>
        <label className="import-option">
          <span className="eyebrow">NATIONALE-NEDERLANDEN</span>
          <strong>Nationale-Nederlanden PDF-export</strong>
          <small>Importeer een NN-rekeningafschrift als PDF-bestand.</small>
          <div className="import-guidance">
            <b>Exporteren kan via de NN-app</b>
            <div>
              <p>
                Selecteer je bankrekening en kies <em>Meer → Download transacties</em>.
              </p>
            </div>
          </div>
          <span className="small-primary">PDF-bestand kiezen</span>
          <input
            type="file"
            accept=".pdf,application/pdf"
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
          />
        </label>
      </div>
      {busy && <p className="muted import-status">Bestand wordt gelezen…</p>}
      <div className="data-backup-section">
        <div>
          <p className="eyebrow">ALLE LOKALE DATA</p>
          <h3>Backup en herstel</h3>
          <p className="muted">
            Maak een backup van transacties, categorieën en automatische regels,
            of herstel eerder geëxporteerde data.
          </p>
        </div>
        <div className="data-backup-actions">
          <button className="small-primary" onClick={onBackup}>
            Backup maken
          </button>
          <label className="small-muted backup-file-button">
            Backup herstellen
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) =>
                e.target.files?.[0] && onRestore(e.target.files[0])
              }
            />
          </label>
        </div>
      </div>
    </section>
  );
}

function Overview({
  transactions,
  allTransactions,
  totals,
  uncategorizedCount,
  start,
  end,
  domainStart,
  domainEnd,
  setStart,
  setEnd,
  setVisibleStart,
  setVisibleEnd,
  chartCat,
  setChartCat,
  zoom,
  setZoom,
  categories,
  rules,
  setTransactions,
  openRule,
}: any) {
  const excludedCategoryIds = new Set(
    categories
      .filter((c: Category) => c.excludeFromSummary)
      .map((c: Category) => c.id),
  );
  const includedTransactions = transactions.filter(
    (t: Transaction) => !t.categoryId || !excludedCategoryIds.has(t.categoryId),
  );
  const categoryTotal = includedTransactions.reduce(
    (sum: number, t: Transaction) => sum + t.amount,
    0,
  );
  const uncategorizedTotal = transactions
    .filter((t: Transaction) => !t.categoryId)
    .reduce((sum: number, t: Transaction) => sum + t.amount, 0);
  const categoryNetExpenses =
    totals.reduce(
      (sum: number, category: any) =>
        sum + Math.min(0, Number(category.total) || 0),
      0,
    ) + Math.min(0, uncategorizedTotal);
  const expenses = categoryNetExpenses;
  const income =
    totals.reduce(
      (sum: number, category: any) =>
        sum + Math.max(0, Number(category.total) || 0),
      0,
    ) + Math.max(0, uncategorizedTotal);
  const categoryExpenseTotals = new Map<string, number>(
    totals.map((category: any) => [
      category.id,
      category.total < 0 ? Math.abs(category.total) : 0,
    ]),
  );
  const uncategorizedExpenses =
    uncategorizedTotal < 0 ? Math.abs(uncategorizedTotal) : 0;
  const categoryBarTotal = Math.max(
    1,
    [...categoryExpenseTotals.values()].reduce(
      (sum: number, amount: number) => sum + amount,
      0,
    ) + uncategorizedExpenses,
  );
  const categoryPercentage = (categoryId: string | null) =>
    ((categoryId === null
      ? uncategorizedExpenses
      : categoryExpenseTotals.get(categoryId) || 0) /
      categoryBarTotal) *
    100;
  const percentageLabel = (categoryId: string | null) =>
    `${categoryPercentage(categoryId).toLocaleString("nl-NL", { maximumFractionDigits: 1 })}% van de uitgaven`;
  const [categorySort, setCategorySort] = useState<
    "name" | "count" | "amount" | "percentage"
  >("name");
  const [categorySortDirection, setCategorySortDirection] = useState<
    "asc" | "desc"
  >("asc");
  const sortedCategoryRows = useMemo(() => {
    const rows = [
      ...totals,
      {
        id: null,
        name: "Niet gecategoriseerd",
        color: "#a6b0ab",
        count: uncategorizedCount,
        total: uncategorizedTotal,
      },
    ];
    const valueFor = (row: (typeof rows)[number]) =>
      categorySort === "name"
        ? row.name.toLocaleLowerCase()
        : categorySort === "count"
          ? row.count
          : categorySort === "amount"
            ? row.total
            : categoryPercentage(row.id);
    return rows.sort((a, b) => {
      const aValue = valueFor(a);
      const bValue = valueFor(b);
      const result =
        typeof aValue === "number" && typeof bValue === "number"
          ? aValue - bValue
          : String(aValue).localeCompare(String(bValue), "nl-NL");
      return categorySortDirection === "asc" ? result : -result;
    });
  }, [
    totals,
    uncategorizedCount,
    uncategorizedTotal,
    categorySort,
    categorySortDirection,
    categoryBarTotal,
  ]);
  const sortCategories = (
    field: "name" | "count" | "amount" | "percentage",
  ) => {
    if (categorySort === field) {
      setCategorySortDirection((direction) =>
        direction === "asc" ? "desc" : "asc",
      );
    } else {
      setCategorySort(field);
      setCategorySortDirection(field === "name" ? "asc" : "desc");
    }
  };
  const categorySortArrow = (
    field: "name" | "count" | "amount" | "percentage",
  ) =>
    categorySort === field
      ? categorySortDirection === "asc"
        ? "↑"
        : "↓"
      : "↕";
  const series = useMemo(() => {
    const byMonth: Record<string, number> = {};
    allTransactions
      .filter(
        (t: Transaction) =>
          t.date >= domainStart &&
          t.date <= domainEnd &&
          t.amount < 0 &&
          !excludedCategoryIds.has(t.categoryId || "") &&
          (chartCat === "all" || t.categoryId === chartCat),
      )
      .forEach((t: Transaction) => {
        const k = t.date.slice(0, 7);
        byMonth[k] = (byMonth[k] || 0) + Math.abs(t.amount);
      });
    const firstMonth = domainStart.slice(0, 7);
    const lastMonth = domainEnd.slice(0, 7);
    const months: string[] = [];
    let cursor = firstMonth;
    while (cursor <= lastMonth) {
      months.push(cursor);
      cursor = shiftMonths(monthStart(cursor), 1).slice(0, 7);
    }
    return months.map(
      (month) => [month, byMonth[month] || 0] as [string, number],
    );
  }, [allTransactions, domainStart, domainEnd, chartCat, categories]);
  const view = zoom ? series.slice(zoom[0], zoom[1] + 1) : series;
  const [fitFullRange, setFitFullRange] = useState(false);
  const [resetViewKey, setResetViewKey] = useState(0);
  const [comparisonOffsets, setComparisonOffsets] = useState<number[]>([1]);
  const previousByMonth = useMemo(() => {
    const byMonth: Record<string, number> = {};
    allTransactions
      .filter(
        (t: Transaction) =>
          t.amount < 0 &&
          !excludedCategoryIds.has(t.categoryId || "") &&
          (chartCat === "all" || t.categoryId === chartCat),
      )
      .forEach((t: Transaction) => {
        const key = t.date.slice(0, 7);
        byMonth[key] = (byMonth[key] || 0) + Math.abs(t.amount);
      });
    return byMonth;
  }, [allTransactions, chartCat, categories]);
  const annualTotals = useMemo(() => {
    const byYear: Record<string, number> = {};
    allTransactions
      .filter(
        (t: Transaction) =>
          t.amount < 0 &&
          !excludedCategoryIds.has(t.categoryId || "") &&
          (chartCat === "all" || t.categoryId === chartCat),
      )
      .forEach((t: Transaction) => {
        const year = t.date.slice(0, 4);
        byYear[year] = (byYear[year] || 0) + Math.abs(t.amount);
      });
    return byYear;
  }, [allTransactions, chartCat, categories]);
  const comparisonValues = comparisonOffsets.map((offset) =>
    view.map(([label]) => {
      const previousMonth = shiftMonths(monthStart(label), -12 * offset).slice(
        0,
        7,
      );
      return previousByMonth[previousMonth] || 0;
    }),
  );
  const max = Math.max(
    1,
    ...view.map(([, value]) => value),
    ...comparisonValues.flat(),
  );
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(
    null,
  );
  const chartRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const dragRef = useRef<[number, number] | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [restoreRange, setRestoreRange] = useState<[string, string] | null>(
    null,
  );
  const pointerX = useRef<number | null>(null);
  const autoScrollFrame = useRef<number | null>(null);
  const previousTransactionsRef = useRef(allTransactions);
  const previousDomainRef = useRef(`${domainStart}|${domainEnd}`);
  const resetChartRef = useRef(false);
  const indexAt = (clientX: number) => {
    const svg = chartRef.current?.querySelector("svg");
    const matrix = svg?.getScreenCTM();
    if (!matrix || !series.length) return 0;
    const x = (clientX - matrix.e) / matrix.a;
    const local =
      view.length === 1
        ? 0
        : Math.round((x - 35) / ((chartViewWidth - 70) / (view.length - 1)));
    return Math.max(
      0,
      Math.min(series.length - 1, (zoom ? zoom[0] : 0) + local),
    );
  };
  const stopAutoScroll = () => {
    if (autoScrollFrame.current !== null)
      cancelAnimationFrame(autoScrollFrame.current);
    autoScrollFrame.current = null;
  };
  const updateDrag = (x: number) => {
    if (!dragRef.current) return;
    const next: [number, number] = [dragRef.current[0], indexAt(x)];
    dragRef.current = next;
    setDrag(next);
    const first = Math.min(next[0], next[1]);
    const last = Math.max(next[0], next[1]);
    if (series[first] && series[last]) {
      setVisibleStart(monthStart(series[first][0]));
      setVisibleEnd(monthEnd(series[last][0]));
    }
  };
  const autoScroll = () => {
    autoScrollFrame.current = null;
    const node = chartRef.current;
    const x = pointerX.current;
    if (!node || x === null || !dragRef.current) return;
    const rect = node.getBoundingClientRect();
    const delta =
      x < rect.left + 60
        ? -Math.min(18, (rect.left + 60 - x) / 4)
        : x > rect.right - 60
          ? Math.min(18, (x - rect.right + 60) / 4)
          : 0;
    if (delta) {
      node.scrollLeft += delta;
      updateDrag(x);
    }
    autoScrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !series.length || e.pointerType === "touch") return;
    stopAutoScroll();
    const i = indexAt(e.clientX);
    dragRef.current = [i, i];
    pointerX.current = e.clientX;
    setDrag([i, i]);
    setHovered(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    autoScrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    pointerX.current = e.clientX;
    updateDrag(e.clientX);
  };
  const cancelDrag = () => {
    stopAutoScroll();
    pointerX.current = null;
    dragRef.current = null;
    setDrag(null);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    updateDrag(e.clientX);
    const [a, b] = dragRef.current;
    const first = Math.min(a, b),
      last = Math.max(a, b);
    setSelectedRange([first, last]);
    if (!restoreRange) setRestoreRange([start, end]);
    setVisibleStart(monthStart(series[first][0]));
    setVisibleEnd(monthEnd(series[last][0]));
    cancelDrag();
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  useEffect(() => () => stopAutoScroll(), []);
  useEffect(() => {
    if (!selectedRange || dragRef.current || !series.length) return;
    const first = Math.min(selectedRange[0], selectedRange[1]);
    const last = Math.max(selectedRange[0], selectedRange[1]);
    if (!series[first] || !series[last]) return;
    setVisibleStart(monthStart(series[first][0]));
    setVisibleEnd(monthEnd(series[last][0]));
  }, [selectedRange, series]);
  useEffect(() => {
    cancelDrag();
    setSelectedRange(null);
  }, [domainStart, domainEnd, chartCat]);
  useEffect(() => {
    const node = document.querySelector(
      ".interactive-chart",
    ) as HTMLElement | null;
    if (!node || !series.length) return;
    const transactionsChanged =
      previousTransactionsRef.current !== allTransactions;
    const initialDataLoad =
      previousTransactionsRef.current.length === 0 &&
      allTransactions.length > 0;
    const domainChanged =
      previousDomainRef.current !== `${domainStart}|${domainEnd}`;
    const resetRequested = resetChartRef.current;
    const dates = allTransactions.map((t: Transaction) => t.date).sort();
    const latestDate = dates[dates.length - 1];
    const resetRangeApplied =
      resetRequested &&
      !!latestDate &&
      domainStart === shiftMonths(latestDate, -11) &&
      domainEnd === latestDate;
    if (resetRangeApplied || !allTransactions.length)
      resetChartRef.current = false;
    previousTransactionsRef.current = allTransactions;
    previousDomainRef.current = `${domainStart}|${domainEnd}`;
    const preserveVisibleDates =
      !resetRequested &&
      !initialDataLoad &&
      (transactionsChanged || domainChanged);
    const setChartWidth = () => {
      const sourceLength = zoom ? view.length : series.length;
      node.style.setProperty(
        "--chart-width",
        `${fitFullRange ? node.clientWidth : Math.max(node.clientWidth, (node.clientWidth * sourceLength) / 12)}px`,
      );
      if (!zoom && (!preserveVisibleDates || resetRangeApplied)) {
        const moveToLatest = () => {
          node.scrollLeft = node.scrollWidth - node.clientWidth;
        };
        moveToLatest();
        if (resetRangeApplied) requestAnimationFrame(moveToLatest);
      }
    };
    setChartWidth();
    window.addEventListener("resize", setChartWidth);
    return () => {
      window.removeEventListener("resize", setChartWidth);
    };
  }, [
    series,
    view.length,
    zoom,
    domainStart,
    domainEnd,
    fitFullRange,
    resetViewKey,
  ]);
  useEffect(() => {
    const node = chartRef.current;
    if (!node || !selectedRange || dragRef.current || !series.length) return;
    const first = Math.min(selectedRange[0], selectedRange[1]);
    const last = Math.max(selectedRange[0], selectedRange[1]);
    if (!series[first] || !series[last]) return;
    const syncSelection = () => {
      setVisibleStart(monthStart(series[first][0]));
      setVisibleEnd(monthEnd(series[last][0]));
    };
    syncSelection();
  }, [selectedRange, series]);
  const candidateSelection = drag ?? selectedRange;
  const activeSelection =
    candidateSelection &&
    candidateSelection.every((i) => i >= 0 && i < series.length)
      ? candidateSelection
      : null;
  const selectionText =
    activeSelection && series.length
      ? `${monthStart(series[Math.min(activeSelection[0], activeSelection[1])][0])} — ${monthEnd(series[Math.max(activeSelection[0], activeSelection[1])][0])}`
      : null;
  const resetZoom = () => {
    cancelDrag();
    setSelectedRange(null);
    setHovered(null);
    setRestoreRange(null);
    setZoom(null);
    setResetViewKey((value) => value + 1);
    resetChartRef.current = true;
    if (!allTransactions.length) return;
    setVisibleStart(domainStart);
    setVisibleEnd(domainEnd);
    setFitFullRange(false);
  };
  const chartViewWidth = fitFullRange ? 1000 : Math.max(1000, view.length * 90);
  const chartX = (i: number) =>
    view.length === 1
      ? chartViewWidth / 2
      : 35 + i * ((chartViewWidth - 70) / (view.length - 1));
  const [detailCategoryId, setDetailCategoryId] = useState<string | null>(null);
  const [detailSort, setDetailSort] = useState<
    "date" | "name" | "account" | "amount" | "category"
  >("date");
  const [detailDirection, setDetailDirection] = useState<"asc" | "desc">(
    "desc",
  );
  const detailIsUncategorized = detailCategoryId === "__uncategorized__";
  const detailCategory = categories.find(
    (c: Category) => c.id === detailCategoryId,
  );
  const [detailQuery, setDetailQuery] = useState("");
  const [detailMin, setDetailMin] = useState("");
  const [detailMax, setDetailMax] = useState("");
  const [detailSelected, setDetailSelected] = useState<string[]>([]);
  const [detailBulkCategory, setDetailBulkCategory] = useState("");
  const [detailBulkNotice, setDetailBulkNotice] = useState("");
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiNotice, setAiNotice] = useState("");
  useEffect(() => {
    setDetailSelected([]);
    setDetailBulkNotice("");
  }, [detailCategoryId, detailQuery, detailMin, detailMax, start, end]);
  const parseDetailAmount = (value: string) => {
    if (!value.trim()) return null;
    const amount = Number(value.replace(",", "."));
    return Number.isFinite(amount) ? amount : null;
  };
  const min = parseDetailAmount(detailMin);
  const maxAmount = parseDetailAmount(detailMax);
  const lower =
    min !== null && maxAmount !== null ? Math.min(min, maxAmount) : min;
  const upper =
    min !== null && maxAmount !== null ? Math.max(min, maxAmount) : maxAmount;
  const categoryTransactions = detailIsUncategorized
    ? transactions.filter((t: Transaction) => !t.categoryId)
    : detailCategoryId
      ? transactions.filter(
          (t: Transaction) => t.categoryId === detailCategoryId,
        )
      : transactions;
  const detailTransactions = categoryTransactions.filter(
    (t: Transaction) =>
      `${t.counterparty} ${t.description} ${t.counterpartyIban}`
        .toLocaleLowerCase()
        .includes(detailQuery.trim().toLocaleLowerCase()) &&
      (lower === null || Math.abs(t.amount) >= lower) &&
      (upper === null || Math.abs(t.amount) <= upper),
  );
  const detailTitle = detailIsUncategorized
    ? "Niet gecategoriseerd"
    : (detailCategory?.name ?? "Alle transacties");
  const detailSelectedIds = new Set(detailSelected);
  const selectedDetailTransactions = detailTransactions.filter(
    (t: Transaction) => detailSelectedIds.has(t.id),
  );
  const allDetailsSelected =
    detailTransactions.length > 0 &&
    selectedDetailTransactions.length === detailTransactions.length;
  const applyDetailCategory = () => {
    if (!detailBulkCategory || !selectedDetailTransactions.length) return;
    const categoryId =
      detailBulkCategory === "__uncategorized__" ? null : detailBulkCategory;
    const ids = new Set(
      selectedDetailTransactions.map((t: Transaction) => t.id),
    );
    setTransactions((items: Transaction[]) =>
      items.map((item) =>
        ids.has(item.id)
          ? {
              ...item,
              categoryId,
              suggestedCategoryId: categoryId,
              suggestionSource: categoryId ? "handmatig" : "onbekend",
              status: categoryId ? "confirmed" : "pending",
            }
          : item,
      ),
    );
    setDetailSelected([]);
    setDetailBulkNotice(
      categoryId === null
        ? `Categorie en bevestiging gewist voor ${ids.size} transacties. Deze staan weer bij Te beoordelen.`
        : `${ids.size} transacties handmatig toegewezen aan ${categories.find((c: Category) => c.id === categoryId)?.name}.`,
    );
  };
  const askChatGpt = () => {
    const question = aiQuestion.trim();
    if (!question || !detailTransactions.length) return;
    const maxContextTransactions = 500;
    const contextTransactions = sortedDetailTransactions.slice(
      0,
      maxContextTransactions,
    );
    const categoryTotals = new Map<string, { count: number; total: number }>();
    for (const transaction of detailTransactions) {
      const categoryName =
        categories.find((category: Category) => category.id === transaction.categoryId)
          ?.name ?? "Geen categorie";
      const current = categoryTotals.get(categoryName) ?? { count: 0, total: 0 };
      current.count += 1;
      current.total += transaction.amount;
      categoryTotals.set(categoryName, current);
    }
    const summary = [...categoryTotals.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "nl-NL"))
      .map(([name, value]) => `- ${name}: ${value.count} transacties, ${money.format(value.total)}`)
      .join("\n");
    const rows = contextTransactions
      .map(
        (transaction: Transaction) =>
          `${transaction.date} | ${transaction.counterparty} | ${transaction.description} | ${money.format(transaction.amount)} | ${categories.find((category: Category) => category.id === transaction.categoryId)?.name ?? "Geen categorie"}`,
      )
      .join("\n");
    const omitted = detailTransactions.length - contextTransactions.length;
    const prompt = [
      "Je bent mijn assistent voor persoonlijke financiële analyse. Analyseer uitsluitend de onderstaande transacties en verzin geen ontbrekende gegevens.",
      "",
      `Mijn vraag: ${question}`,
      "",
      `Periode: ${start} t/m ${end}`,
      `Aantal transacties: ${detailTransactions.length}`,
      `Totaalbedrag: ${money.format(detailTransactions.reduce((sum: number, transaction: Transaction) => sum + transaction.amount, 0))}`,
      "",
      "Samenvatting per categorie:",
      summary || "Geen categoriegegevens.",
      "",
      `Transacties (maximaal ${maxContextTransactions} regels):`,
      rows || "Geen transacties.",
      omitted > 0
        ? `\nLet op: ${omitted} transacties zijn niet als individuele regel opgenomen; gebruik daarvoor alleen de totalen hierboven.`
        : "",
      "",
      "Geef een helder antwoord in het Nederlands en vermeld wanneer een conclusie onzeker is.",
    ].join("\n");
    const chatWindow = window.open("https://chatgpt.com/", "_blank");
    void navigator.clipboard
      .writeText(prompt)
      .then(() => {
        setAiNotice(
          "De vraag en transacties staan op je klembord. Plak ze in ChatGPT.",
        );
      })
      .catch(() => {
        setAiNotice(
          chatWindow
            ? "ChatGPT is geopend, maar kopiëren naar het klembord lukte niet."
            : "Kopiëren naar het klembord lukte niet.",
        );
      });
  };
  const sortedDetailTransactions = [...detailTransactions].sort((a, b) => {
    const aValue =
      detailSort === "date"
        ? a.date
        : detailSort === "name"
          ? a.counterparty.toLocaleLowerCase()
          : detailSort === "account"
            ? a.counterpartyIban.toLocaleLowerCase()
            : detailSort === "category"
              ? (categories.find((c: Category) => c.id === a.categoryId)
                  ?.name ?? "Geen categorie")
              : a.amount;
    const bValue =
      detailSort === "date"
        ? b.date
        : detailSort === "name"
          ? b.counterparty.toLocaleLowerCase()
          : detailSort === "account"
            ? b.counterpartyIban.toLocaleLowerCase()
            : detailSort === "category"
              ? (categories.find((c: Category) => c.id === b.categoryId)
                  ?.name ?? "Geen categorie")
              : b.amount;
    const result =
      typeof aValue === "number" && typeof bValue === "number"
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), "nl-NL");
    return detailDirection === "asc" ? result : -result;
  });
  const [detailPage, setDetailPage] = useState(0);
  const detailPageCount = Math.max(
    1,
    Math.ceil(sortedDetailTransactions.length / MAX_VISIBLE_RESULTS),
  );
  const currentDetailPage = Math.min(detailPage, detailPageCount - 1);
  const pagedDetailTransactions = sortedDetailTransactions.slice(
    currentDetailPage * MAX_VISIBLE_RESULTS,
    (currentDetailPage + 1) * MAX_VISIBLE_RESULTS,
  );
  useEffect(
    () => setDetailPage(0),
    [
      detailCategoryId,
      detailSort,
      detailDirection,
      start,
      end,
      detailQuery,
      detailMin,
      detailMax,
    ],
  );
  return (
    <>
      <div className="metric-grid">
        <Metric label="Uitgaven" value={money.format(expenses)} tone="coral" />
        <Metric label="Inkomsten" value={money.format(income)} tone="green" />
        <Metric
          label="Niet gecategoriseerd"
          value={uncategorizedCount.toLocaleString("nl-NL")}
          tone="neutral"
        />
      </div>
      <section className="panel chart-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">UITGAVEN / MAAND</p>
            <h2>Uitgaven door de tijd</h2>
            <p className="muted">
              Sleep met de muis over de grafiek om een gebied te selecteren.
            </p>
          </div>
          <div className="filters">
            <label>
              Van{" "}
              <DateFilterInput
                value={start}
                onCommit={(value) => {
                  setStart(value);
                  setFitFullRange(false);
                  setRestoreRange(null);
                  setZoom(null);
                }}
              />
            </label>
            <label>
              Tot{" "}
              <DateFilterInput
                value={end}
                onCommit={(value) => {
                  setEnd(value);
                  setFitFullRange(false);
                  setRestoreRange(null);
                  setZoom(null);
                }}
              />
            </label>
            <select
              value={chartCat}
              onChange={(e) => {
                setChartCat(e.target.value);
                setZoom(null);
              }}
            >
              <option value="all">Alle categorieën</option>
              {categories
                .filter((c: Category) => !c.excludeFromSummary)
                .map((c: Category) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <div className="chart-compare-control">
              <span>Vergelijk met:</span>
              {[1, 2, 3].map((offset) => (
                <label key={offset}>
                  <input
                    type="checkbox"
                    checked={comparisonOffsets.includes(offset)}
                    onChange={() =>
                      setComparisonOffsets((current) =>
                        current.includes(offset)
                          ? current.filter((value) => value !== offset)
                          : [...current, offset].sort(),
                      )
                    }
                  />
                  Jaar -{offset}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="selection-status" aria-live="polite">
          {selectionText
            ? `Selectie: ${selectionText}`
            : "Sleep naar de rand om verder te selecteren."}
        </div>
        <div
          key={resetViewKey}
          ref={chartRef}
          className="chart interactive-chart"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={cancelDrag}
        >
          <svg
            className="line-chart"
            viewBox={`0 0 ${chartViewWidth} 220`}
            aria-label="Uitgaven per maand"
          >
            {activeSelection && (
              <rect
                className="selected-range"
                x={
                  chartX(Math.min(...activeSelection) - (zoom ? zoom[0] : 0)) -
                  35
                }
                y="0"
                width={
                  Math.abs(
                    chartX(activeSelection[1]) - chartX(activeSelection[0]),
                  ) + 70
                }
                height="205"
              />
            )}
            <line
              x1="20"
              y1="190"
              x2={chartViewWidth - 20}
              y2="190"
              className="chart-axis"
            />
            {view.map(([label, value], i) => {
              const x = chartX(i);
              const barCount = 1 + comparisonOffsets.length;
              const barWidth = Math.min(22, 48 / barCount);
              const groupWidth =
                barCount * barWidth + Math.max(0, barCount - 1) * 3;
              const currentHeight = (value / max) * 160;
              const tooltipX = Math.max(165, Math.min(chartViewWidth - 165, x));
              return (
                <g
                  key={label}
                  onPointerEnter={() => setHovered(i)}
                  onPointerLeave={() => setHovered(null)}
                >
                  <rect
                    x={x - groupWidth / 2}
                    y={190 - currentHeight}
                    width={barWidth}
                    height={currentHeight}
                    className="overview-bar current"
                  />
                  {comparisonOffsets.map((offset, comparisonIndex) => {
                    const comparisonValue =
                      comparisonValues[comparisonIndex][i];
                    const comparisonHeight = (comparisonValue / max) * 160;
                    return (
                      <rect
                        key={offset}
                        x={
                          x -
                          groupWidth / 2 +
                          (comparisonIndex + 1) * (barWidth + 3)
                        }
                        y={190 - comparisonHeight}
                        width={barWidth}
                        height={comparisonHeight}
                        className={`overview-bar previous previous-${offset}`}
                      />
                    );
                  })}
                  <rect
                    x={
                      x -
                      (fitFullRange ? 465 / Math.max(1, view.length - 1) : 35)
                    }
                    y="0"
                    width={
                      fitFullRange ? 930 / Math.max(1, view.length - 1) : 70
                    }
                    height="205"
                    className="hover-target"
                  />
                  {(!fitFullRange ||
                    i % Math.ceil(view.length / 12) === 0 ||
                    i === view.length - 1) && (
                    <text
                      x={x}
                      y="213"
                      textAnchor="middle"
                      className="chart-label"
                    >
                      {label.slice(2)}
                    </text>
                  )}
                </g>
              );
            })}
            {!drag &&
              hovered !== null &&
              view[hovered] &&
              (() => {
                const [label, value] = view[hovered];
                const tooltipX = Math.max(
                  165,
                  Math.min(chartViewWidth - 165, chartX(hovered)),
                );
                return (
                  <g className="chart-tooltip">
                    <rect
                      x={tooltipX - 155}
                      y="8"
                      width="310"
                      height={String(42 + comparisonOffsets.length * 15)}
                      rx="6"
                    />
                    <text x={tooltipX} y="25" textAnchor="middle">
                      {monthName(label)}
                    </text>
                    <text x={tooltipX} y="42" textAnchor="middle">
                      {label.slice(0, 4)}: {money.format(value)} (jaar:{" "}
                      {money.format(annualTotals[label.slice(0, 4)] || 0)})
                    </text>
                    {comparisonOffsets.map((offset, comparisonIndex) => {
                      const previousMonth = shiftMonths(
                        monthStart(label),
                        -12 * offset,
                      ).slice(0, 7);
                      return (
                        <text
                          key={offset}
                          x={tooltipX}
                          y={57 + comparisonIndex * 15}
                          textAnchor="middle"
                        >
                          {previousMonth.slice(0, 4)}:{" "}
                          {money.format(
                            comparisonValues[comparisonIndex][hovered],
                          )}{" "}
                          (jaar:{" "}
                          {money.format(
                            annualTotals[previousMonth.slice(0, 4)] || 0,
                          )}
                          )
                        </text>
                      );
                    })}
                  </g>
                );
              })()}
          </svg>
        </div>
        {series.length > 1 && (
          <div className="zoom-strip">
            <span>
              {selectionText
                ? `Selectie: ${selectionText}`
                : `${start} — ${end}`}
            </span>
            <button onClick={resetZoom}>Reset</button>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">CATEGORIEËN</p>
            <h2>Waar gaat je geld naartoe?</h2>
            <p className="muted">
              Klik op een categorie voor de onderliggende transacties.
            </p>
          </div>
          <span className="muted">
            {start} — {end}
          </span>
        </div>
        <div className="category-list">
          <div
            className="category-list-header"
            aria-label="Sorteer categorieën"
          >
            <span />
            {(
              [
                ["name", "Categorie"],
                ["count", "Aantal"],
                ["amount", "Bedrag"],
                ["percentage", "% uitgaven"],
              ] as const
            ).map(([field, label]) => (
              <button
                className="category-sort"
                key={field}
                onClick={() => sortCategories(field)}
              >
                {label} {categorySortArrow(field)}
              </button>
            ))}
          </div>
          {sortedCategoryRows.map((c: any) => {
            const isUncategorized = c.id === null;
            const categoryId = isUncategorized ? null : c.id;
            return (
              <div
                className={`category-row category-button ${isUncategorized ? "uncategorized-row" : ""} ${detailCategoryId === (isUncategorized ? "__uncategorized__" : c.id) ? "selected" : ""}`}
                key={isUncategorized ? "__uncategorized__" : c.id}
                onClick={() =>
                  setDetailCategoryId((current) => {
                    const selectedId = isUncategorized
                      ? "__uncategorized__"
                      : c.id;
                    return current === selectedId ? null : selectedId;
                  })
                }
              >
                <span className="dot" style={{ background: c.color }} />
                <strong>{c.name}</strong>
                <span className="category-count">{c.count} transacties</span>
                <b className={c.total >= 0 ? "income" : ""}>
                  {money.format(c.total)}
                </b>
                <div className="mini-bar" title={percentageLabel(categoryId)}>
                  <i
                    style={{
                      background: c.color,
                      width: `${Math.min(100, categoryPercentage(categoryId))}%`,
                    }}
                  />
                  <span className="mini-bar-tooltip">
                    {percentageLabel(categoryId)}
                  </span>
                </div>
              </div>
            );
          })}
          <div className="category-total-row">
            <strong>Totaal</strong>
            <b>{money.format(categoryTotal)}</b>
          </div>
        </div>
        {
          <div className="category-detail">
            <div className="detail-head">
              <div>
                <p className="eyebrow">DETAILOVERZICHT</p>
                <h3>{detailTitle}</h3>
                <p className="muted">
                  {detailTransactions.length} transacties binnen {start} — {end}
                </p>
              </div>
              <div className="detail-sort">
                {detailCategoryId && (
                  <button
                    className="small-muted"
                    onClick={() => setDetailCategoryId(null)}
                  >
                    Alle categorieën
                  </button>
                )}
              </div>
            </div>
            <div className="overview-transaction-filters">
              <input
                type="search"
                aria-label="Zoek naam, omschrijving of rekeningnummer"
                placeholder="Zoek naam, omschrijving of rekeningnummer…"
                value={detailQuery}
                onChange={(e) => setDetailQuery(e.target.value)}
              />
              <input
                type="text"
                inputMode="decimal"
                aria-label="Min bedrag"
                placeholder="Min bedrag"
                value={detailMin}
                onChange={(e) => setDetailMin(e.target.value)}
              />
              <input
                type="text"
                inputMode="decimal"
                aria-label="Max bedrag"
                placeholder="Max bedrag"
                value={detailMax}
                onChange={(e) => setDetailMax(e.target.value)}
              />
            </div>
            <div className="ai-question-box">
              <label htmlFor="ai-transaction-question">
                Vraag over deze transacties
              </label>
              <div className="ai-question-row">
                <input
                  id="ai-transaction-question"
                  type="text"
                  placeholder="Bijvoorbeeld: waar kan ik het meeste besparen?"
                  value={aiQuestion}
                  onChange={(e) => {
                    setAiQuestion(e.target.value);
                    setAiNotice("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") askChatGpt();
                  }}
                />
                <button
                  className="small-primary"
                  disabled={!aiQuestion.trim() || !detailTransactions.length}
                  onClick={askChatGpt}
                >
                  Vraag aan ChatGPT
                </button>
              </div>
              <p className="muted">
                Cashflow kopieert een samenvatting naar je klembord en opent ChatGPT.
                Je verstuurt de vraag zelf.
              </p>
              {aiNotice && <p className="ai-question-notice" role="status">{aiNotice}</p>}
            </div>
            <div className="bulk detail-bulk">
              <label>
                <input
                  type="checkbox"
                  aria-label="Alle zoekresultaten selecteren"
                  checked={allDetailsSelected}
                  disabled={!detailTransactions.length}
                  ref={(node) => {
                    if (node)
                      node.indeterminate =
                        selectedDetailTransactions.length > 0 &&
                        !allDetailsSelected;
                  }}
                  onChange={(e) =>
                    setDetailSelected(
                      e.target.checked
                        ? detailTransactions.map((t: Transaction) => t.id)
                        : [],
                    )
                  }
                />{" "}
                Alles selecteren ({detailTransactions.length}, alle pagina's)
              </label>
              <span>{selectedDetailTransactions.length} geselecteerd</span>
              <select
                aria-label="Categorie voor geselecteerde transacties"
                value={detailBulkCategory}
                onChange={(e) => setDetailBulkCategory(e.target.value)}
              >
                <option value="">Kies categorie…</option>
                <option value="__uncategorized__">Geen categorie</option>
                {categories.map((c: Category) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                className="small-primary"
                disabled={
                  !detailBulkCategory || !selectedDetailTransactions.length
                }
                onClick={applyDetailCategory}
              >
                Categorie toekennen
              </button>
            </div>
            {detailBulkNotice && <p role="status">{detailBulkNotice}</p>}
            {detailTransactions.length === 0 && (
              <p className="muted">Geen transacties gevonden.</p>
            )}
            {detailTransactions.length > MAX_VISIBLE_RESULTS && (
              <div className="pagination pagination-above-header">
                <button
                  className="small-muted"
                  disabled={currentDetailPage === 0}
                  onClick={() => setDetailPage(currentDetailPage - 1)}
                >
                  Vorige
                </button>
                <span>
                  Pagina {currentDetailPage + 1} van {detailPageCount}
                </span>
                <button
                  className="small-muted"
                  disabled={currentDetailPage >= detailPageCount - 1}
                  onClick={() => setDetailPage(currentDetailPage + 1)}
                >
                  Volgende pagina
                </button>
              </div>
            )}
            {detailTransactions.length > 0 && (
              <div
                className="detail-list-header"
                aria-label="Sorteer transacties"
              >
                <span />
                {(
                  [
                    ["date", "Datum"],
                    ["name", "Transactie"],
                    ["amount", "Bedrag"],
                    ["category", "Categorie"],
                  ] as const
                ).map(([field, label]) => (
                  <button
                    className="column-sort"
                    key={field}
                    onClick={() => {
                      if (detailSort === field) {
                        setDetailDirection((direction) =>
                          direction === "desc" ? "asc" : "desc",
                        );
                      } else {
                        setDetailSort(field);
                        setDetailDirection(field === "date" ? "desc" : "asc");
                      }
                    }}
                  >
                    {label}{" "}
                    {detailSort === field
                      ? detailDirection === "desc"
                        ? "↓"
                        : "↑"
                      : "↕"}
                  </button>
                ))}
              </div>
            )}
            <div className="detail-list">
              {pagedDetailTransactions.map((t: Transaction) => {
                const rule =
                  t.suggestionSource === "regel" ||
                  t.suggestionSource === "herkenning"
                    ? matchingRule(t, rules)
                    : null;
                return (
                  <div
                    className="detail-row"
                    key={t.id}
                    title={t.note ? `Opmerking: ${t.note}` : undefined}
                  >
                    <input
                      type="checkbox"
                      data-detail-checkbox
                      aria-label={`Selecteer ${t.counterparty || "transactie"} op ${date(t.date)}`}
                      checked={detailSelectedIds.has(t.id)}
                      onChange={(e) =>
                        setDetailSelected((ids) =>
                          e.target.checked
                            ? [...ids, t.id]
                            : ids.filter((id) => id !== t.id),
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key !== "Tab") return;
                        const boxes = Array.from(
                          document.querySelectorAll<HTMLInputElement>(
                            "[data-detail-checkbox]",
                          ),
                        );
                        const next =
                          boxes[
                            boxes.indexOf(e.currentTarget) +
                              (e.shiftKey ? -1 : 1)
                          ];
                        if (next) {
                          e.preventDefault();
                          next.focus();
                        }
                      }}
                    />
                    <span>{date(t.date)}</span>
                    <div>
                      <strong>
                        {t.counterparty || "Onbekende tegenpartij"}
                      </strong>
                      <small>
                        {t.counterpartyIban || "Geen tegenrekeningnummer"} ·{" "}
                        {t.description || "Geen omschrijving"}
                        {t.note && (
                          <span
                            className="transaction-note-indicator"
                            aria-label="Opmerking beschikbaar"
                            title={`Opmerking: ${t.note}`}
                          >
                            💬
                          </span>
                        )}
                      </small>
                      <em className="assignment-source">
                        <span
                          className={`assignment-dot ${t.suggestionSource === "handmatig" ? "manual" : rule ? "automatic" : "unknown"}`}
                          title={
                            t.suggestionSource === "handmatig"
                              ? "Handmatig toegewezen"
                              : rule
                                ? "Automatisch toegewezen via een regel"
                                : "Nog niet automatisch toegewezen"
                          }
                          aria-label={
                            t.suggestionSource === "handmatig"
                              ? "Handmatig toegewezen"
                              : rule
                                ? "Automatisch toegewezen via een regel"
                                : "Nog niet automatisch toegewezen"
                          }
                        />
                        {t.suggestionSource === "handmatig"
                          ? "Handmatig toegewezen"
                          : rule
                            ? "Automatisch toegewezen"
                            : "Niet automatisch toegewezen"}
                        {rule && (
                          <button
                            className="rule-link"
                            onClick={() => openRule(rule.id)}
                          >
                            Regel configureren
                          </button>
                        )}
                      </em>
                    </div>
                    <b className={t.amount >= 0 ? "income" : ""}>
                      {money.format(t.amount)}
                    </b>
                    <select
                      className="detail-category-select"
                      value={t.categoryId || ""}
                      title="Categorie overschrijven"
                      onChange={(e) => {
                        const categoryId = e.target.value || null;
                        setTransactions((items: Transaction[]) =>
                          items.map((item) =>
                            item.id === t.id
                              ? {
                                  ...item,
                                  categoryId,
                                  suggestedCategoryId: categoryId,
                                  suggestionSource: categoryId
                                    ? "handmatig"
                                    : "onbekend",
                                  status: categoryId ? "confirmed" : "pending",
                                }
                              : item,
                          ),
                        );
                      }}
                    >
                      <option value="">Geen categorie</option>
                      {categories.map((category: Category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            {detailTransactions.length > MAX_VISIBLE_RESULTS && (
              <div className="pagination">
                <button
                  className="small-muted"
                  disabled={currentDetailPage === 0}
                  onClick={() => setDetailPage(currentDetailPage - 1)}
                >
                  Vorige
                </button>
                <span>
                  Pagina {currentDetailPage + 1} van {detailPageCount}
                </span>
                <button
                  className="small-muted"
                  disabled={currentDetailPage >= detailPageCount - 1}
                  onClick={() => setDetailPage(currentDetailPage + 1)}
                >
                  Volgende pagina
                </button>
              </div>
            )}
            <div className="overall-total">
              <span>Totaal gevonden transacties (alle pagina's)</span>
              <strong>
                {money.format(
                  detailTransactions.reduce(
                    (sum: number, t: Transaction) => sum + t.amount,
                    0,
                  ),
                )}
              </strong>
            </div>
          </div>
        }
      </section>
    </>
  );
}

function YearComparison({
  transactions,
  categories,
  setTransactions,
}: {
  transactions: Transaction[];
  categories: Category[];
  setTransactions: React.Dispatch<React.SetStateAction<Transaction[]>>;
}) {
  const availableYears = [
    ...new Set(transactions.map((t) => t.date.slice(0, 4))),
  ].sort((a, b) => Number(b) - Number(a));
  const latestYear = availableYears[0] ?? String(new Date().getFullYear());
  const [year, setYear] = useState(latestYear);
  const [comparisonView, setComparisonView] = useState<"year" | "month">("year");
  const [comparisonYears, setComparisonYears] = useState<string[]>([]);
  const [monthlyComparisonYear, setMonthlyComparisonYear] = useState("");
  const comparisonRef = useRef<HTMLElement>(null);
  const [exportingPng, setExportingPng] = useState(false);
  const exportPng = async () => {
    if (!comparisonRef.current) return;
    setExportingPng(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      const canvas = await html2canvas(comparisonRef.current, {
        backgroundColor: "#f6f8f5",
        scale: 2,
        useCORS: true,
        logging: false,
        windowWidth: comparisonRef.current.scrollWidth,
        windowHeight: comparisonRef.current.scrollHeight,
      });
      const link = document.createElement("a");
      link.download = `jaarvergelijking-${year}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } finally {
      setExportingPng(false);
    }
  };
  useEffect(() => {
    if (availableYears.length && !availableYears.includes(year))
      setYear(latestYear);
  }, [availableYears.join(","), latestYear, year]);
  useEffect(() => {
    setComparisonYears((selected) =>
      selected.filter(
        (selectedYear) =>
          selectedYear !== year && availableYears.includes(selectedYear),
      ),
    );
  }, [year, availableYears.join(",")]);
  useEffect(() => {
    if (monthlyComparisonYear === year) setMonthlyComparisonYear("");
  }, [year, monthlyComparisonYear]);
  const summaryCategories = categories.filter((c) => !c.excludeFromSummary);
  const trendYears = [
    ...new Set(transactions.map((t) => t.date.slice(0, 4))),
  ].sort((a, b) => Number(a) - Number(b));
  const entries = [
    ...summaryCategories.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
    })),
    { id: "__uncategorized__", name: "Niet gecategoriseerd", color: "#a6b0ab" },
  ].filter((entry) =>
    transactions.some((t) => {
      const inYear =
        t.date.startsWith(year) ||
        comparisonYears.some((comparison) => t.date.startsWith(comparison));
      return (
        inYear &&
        (entry.id === "__uncategorized__"
          ? !t.categoryId
          : t.categoryId === entry.id)
      );
    }),
  );
  const trendEntries = [
    {
      id: "__all__",
      name: "Alle categorieën",
      color: "#3d8a71",
    },
    ...summaryCategories.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
    })),
    { id: "__uncategorized__", name: "Niet gecategoriseerd", color: "#a6b0ab" },
  ].filter((entry) =>
    entry.id === "__all__"
      ? transactions.some(
          (t) =>
            summaryCategories.some((c) => c.id === t.categoryId) ||
            !t.categoryId,
        )
      : transactions.some((t) =>
          entry.id === "__uncategorized__"
            ? !t.categoryId
            : t.categoryId === entry.id,
        ),
  );
  const [trendOrder, setTrendOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(YEAR_CHART_ORDER_STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [draggedTrendId, setDraggedTrendId] = useState<string | null>(null);
  const orderedTrendEntries = useMemo(() => {
    const byId = new Map(trendEntries.map((entry) => [entry.id, entry]));
    return [
      ...trendOrder
        .map((id) => byId.get(id))
        .filter((entry): entry is (typeof trendEntries)[number] =>
          Boolean(entry),
        ),
      ...trendEntries.filter((entry) => !trendOrder.includes(entry.id)),
    ];
  }, [trendEntries, trendOrder]);
  useEffect(() => {
    localStorage.setItem(
      YEAR_CHART_ORDER_STORAGE_KEY,
      JSON.stringify(orderedTrendEntries.map((entry) => entry.id)),
    );
  }, [orderedTrendEntries]);
  const moveTrendChart = (targetId: string) => {
    if (!draggedTrendId || draggedTrendId === targetId) return;
    const nextOrder = orderedTrendEntries.map((entry) => entry.id);
    const from = nextOrder.indexOf(draggedTrendId);
    const to = nextOrder.indexOf(targetId);
    if (from < 0 || to < 0) return;
    nextOrder.splice(from, 1);
    nextOrder.splice(to, 0, draggedTrendId);
    setTrendOrder(nextOrder);
    setDraggedTrendId(null);
  };
  useEffect(() => {
    if (!draggedTrendId) return;
    const edgeSize = 100;
    const maxStep = 24;
    const scrollWhileDragging = (event: DragEvent) => {
      const distanceFromTop = event.clientY;
      const distanceFromBottom = window.innerHeight - event.clientY;
      if (distanceFromTop < edgeSize) {
        window.scrollBy(
          0,
          -Math.min(maxStep, Math.ceil((edgeSize - distanceFromTop) / 4)),
        );
      } else if (distanceFromBottom < edgeSize) {
        window.scrollBy(
          0,
          Math.min(maxStep, Math.ceil((edgeSize - distanceFromBottom) / 4)),
        );
      }
    };
    window.addEventListener("dragover", scrollWhileDragging);
    return () => window.removeEventListener("dragover", scrollWhileDragging);
  }, [draggedTrendId]);
  const [trendSelection, setTrendSelection] = useState<{
    categoryId: string;
    year: string;
    transactionIds: string[];
  } | null>(null);
  const trendTransactions = trendSelection
    ? transactions.filter((t) => trendSelection.transactionIds.includes(t.id))
    : [];
  const trendCategoryName = trendSelection
    ? (trendEntries.find((entry) => entry.id === trendSelection.categoryId)
        ?.name ?? "Categorie")
    : "";
  const availableMonthsByYear = useMemo(() => {
    const months = new Map<string, Set<string>>();
    transactions.forEach((transaction) => {
      const year = transaction.date.slice(0, 4);
      const yearMonths = months.get(year) ?? new Set<string>();
      yearMonths.add(transaction.date.slice(5, 7));
      months.set(year, yearMonths);
    });
    return months;
  }, [transactions]);
  const trendAmount = (categoryId: string, selectedYear: string) => {
    const actualAmount = Math.abs(
      transactions
        .filter((t) => {
          if (!t.date.startsWith(selectedYear)) return false;
          if (categoryId === "__all__") {
            return (
              !t.categoryId ||
              summaryCategories.some((category) => category.id === t.categoryId)
            );
          }
          return categoryId === "__uncategorized__"
            ? !t.categoryId
            : t.categoryId === categoryId;
        })
        .reduce((sum, t) => sum + t.amount, 0),
    );
    const availableMonths = availableMonthsByYear.get(selectedYear)?.size ?? 0;
    return availableMonths > 0 && availableMonths < 12
      ? (actualAmount / availableMonths) * 12
      : actualAmount;
  };
  const [trendDetailSort, setTrendDetailSort] = useState<
    "date" | "name" | "description" | "amount" | "category"
  >("date");
  const [trendDetailDirection, setTrendDetailDirection] = useState<
    "asc" | "desc"
  >("desc");
  const sortedTrendTransactions = [...trendTransactions].sort((a, b) => {
    const categoryName = (transaction: Transaction) =>
      categories.find((category) => category.id === transaction.categoryId)
        ?.name ?? "Geen categorie";
    const aValue =
      trendDetailSort === "date"
        ? a.date
        : trendDetailSort === "name"
          ? a.counterparty.toLocaleLowerCase()
          : trendDetailSort === "description"
            ? a.description.toLocaleLowerCase()
            : trendDetailSort === "amount"
              ? a.amount
              : categoryName(a).toLocaleLowerCase();
    const bValue =
      trendDetailSort === "date"
        ? b.date
        : trendDetailSort === "name"
          ? b.counterparty.toLocaleLowerCase()
          : trendDetailSort === "description"
            ? b.description.toLocaleLowerCase()
            : trendDetailSort === "amount"
              ? b.amount
              : categoryName(b).toLocaleLowerCase();
    const result =
      typeof aValue === "number" && typeof bValue === "number"
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), "nl-NL");
    return trendDetailDirection === "asc" ? result : -result;
  });
  const sortTrendDetails = (
    field: "date" | "name" | "description" | "amount" | "category",
  ) => {
    if (trendDetailSort === field) {
      setTrendDetailDirection((direction) =>
        direction === "desc" ? "asc" : "desc",
      );
    } else {
      setTrendDetailSort(field);
      setTrendDetailDirection(field === "date" ? "desc" : "asc");
    }
  };
  const trendSortArrow = (
    field: "date" | "name" | "description" | "amount" | "category",
  ) =>
    trendDetailSort === field
      ? trendDetailDirection === "desc"
        ? "↓"
        : "↑"
      : "↕";
  const selectTrendPoint = (categoryId: string, selectedYear: string) => {
    const transactionIds = transactions
      .filter((t) => {
        if (!t.date.startsWith(selectedYear)) return false;
        if (categoryId === "__all__") {
          return (
            !t.categoryId ||
            summaryCategories.some((category) => category.id === t.categoryId)
          );
        }
        return categoryId === "__uncategorized__"
          ? !t.categoryId
          : t.categoryId === categoryId;
      })
      .map((t) => t.id);
    setTrendSelection({ categoryId, year: selectedYear, transactionIds });
  };
  const selectTrendMonthPoint = (categoryId: string, month: string) => {
    const selectedMonth = `${year}-${month}`;
    const transactionIds = transactions
      .filter((t) => {
        if (!t.date.startsWith(selectedMonth)) return false;
        if (categoryId === "__all__") {
          return (
            !t.categoryId ||
            summaryCategories.some((category) => category.id === t.categoryId)
          );
        }
        return categoryId === "__uncategorized__"
          ? !t.categoryId
          : t.categoryId === categoryId;
      })
      .map((t) => t.id);
    setTrendSelection({
      categoryId,
      year: selectedMonth,
      transactionIds,
    });
  };
  const trendDetail = trendSelection ? (
    <div className="panel trend-detail">
      <div className="detail-head">
        <div>
          <p className="eyebrow">TRANSACTIES</p>
          <h3>
            {trendCategoryName} —
            {trendSelection.year.length === 7
              ? ` ${monthLabel(trendSelection.year)}`
              : ` ${trendSelection.year}`}
          </h3>
          <p className="muted">
            {trendTransactions.length} transacties · totaal{" "}
            {money.format(
              Math.abs(trendTransactions.reduce((sum, t) => sum + t.amount, 0)),
            )}
          </p>
        </div>
        <button className="small-muted" onClick={() => setTrendSelection(null)}>
          Sluiten
        </button>
      </div>
      <div className="trend-transaction-list">
        <div className="trend-transaction-header">
          <button onClick={() => sortTrendDetails("date")}>
            Datum {trendSortArrow("date")}
          </button>
          <button onClick={() => sortTrendDetails("name")}>
            Transactie {trendSortArrow("name")}
          </button>
          <button onClick={() => sortTrendDetails("description")}>
            Omschrijving {trendSortArrow("description")}
          </button>
          <button onClick={() => sortTrendDetails("amount")}>
            Bedrag {trendSortArrow("amount")}
          </button>
          <button onClick={() => sortTrendDetails("category")}>
            Categorie {trendSortArrow("category")}
          </button>
        </div>
        {sortedTrendTransactions.map((t) => (
          <div className="trend-transaction-row" key={t.id}>
            <span>{date(t.date)}</span>
            <strong>{t.counterparty || "Onbekende tegenpartij"}</strong>
            <small>
              {t.description || "Geen omschrijving"}
              {t.note ? ` · ${t.note}` : ""}
            </small>
            <b>{money.format(t.amount)}</b>
            <select
              value={t.categoryId ?? ""}
              onChange={(event) => {
                const categoryId = event.target.value || null;
                setTransactions((items) =>
                  items.map((item) =>
                    item.id === t.id
                      ? {
                          ...item,
                          categoryId,
                          suggestedCategoryId: categoryId,
                          suggestionSource: categoryId
                            ? "handmatig"
                            : "onbekend",
                          status: categoryId ? "confirmed" : "pending",
                        }
                      : item,
                  ),
                );
              }}
            >
              <option value="">Geen categorie</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        ))}
        {!trendTransactions.length && (
          <p className="muted">Geen transacties gevonden.</p>
        )}
      </div>
    </div>
  ) : null;
  const months = Array.from({ length: 12 }, (_, i) =>
    String(i + 1).padStart(2, "0"),
  );
  const amount = (
    entryId: string,
    selectedYear: string,
    month?: string,
    direction: "income" | "expense" = "expense",
  ) =>
    transactions
      .filter(
        (t) =>
          t.date.startsWith(selectedYear) &&
          (!month || t.date.slice(5, 7) === month) &&
          (entryId === "__uncategorized__"
            ? !t.categoryId
            : t.categoryId === entryId),
      )
      .reduce(
        (sum, t) =>
          sum +
          (direction === "income"
            ? Math.max(0, t.amount)
            : Math.max(0, -t.amount)),
        0,
      );
  const total = (
    selectedYear: string,
    entryId?: string,
    direction: "income" | "expense" = "expense",
  ) =>
    transactions
      .filter(
        (t) =>
          t.date.startsWith(selectedYear) &&
          (entryId === undefined ||
            (entryId === "__uncategorized__"
              ? !t.categoryId
              : t.categoryId === entryId)),
      )
      .filter(
        (t) =>
          entryId !== undefined ||
          !t.categoryId ||
          summaryCategories.some((c) => c.id === t.categoryId),
      )
      .reduce(
        (sum, t) =>
          sum +
          (direction === "income"
            ? Math.max(0, t.amount)
            : Math.max(0, -t.amount)),
        0,
      );
  const visibleEntries = entries;
  return (
    <section
      id="year-comparison-top"
      className="year-comparison"
      ref={comparisonRef}
    >
      <div className="panel year-comparison-head">
        <div>
          <p className="eyebrow">TRENDS</p>
          <h2>Ontwikkeling van je financiën</h2>
          <p className="muted">
            Bekijk bedragen per categorie per jaar of per maand en vergelijk
            verschillende periodes met elkaar.
          </p>
        </div>
        <div className="filters year-filters">
          <div className="comparison-view-switch" role="group" aria-label="Grafiekweergave">
            <button
              className={comparisonView === "year" ? "active" : ""}
              onClick={() => setComparisonView("year")}
            >
              Per jaar
            </button>
            <button
              className={comparisonView === "month" ? "active" : ""}
              onClick={() => setComparisonView("month")}
            >
              Per maand
            </button>
          </div>
          <button
            className="small-primary png-export-button"
            data-html2canvas-ignore="true"
            onClick={exportPng}
            disabled={exportingPng}
          >
            {exportingPng ? "PNG maken…" : "PNG exporteren"}
          </button>
        </div>
      </div>
      {comparisonView === "year" && <section className="trend-section">
        <div className="panel trend-intro">
          <p className="eyebrow">ONTWIKKELING PER JAAR</p>
          <h2>Bedragen per categorie door de jaren heen</h2>
          <p className="muted">
            Elk punt toont het totale bedrag van één kalenderjaar. Klik op een
            punt om de bijbehorende transacties te bekijken.
          </p>
          <nav className="year-chart-links" aria-label="Ga naar categorie">
            {orderedTrendEntries.map((entry) => (
              <a key={entry.id} href={`#year-trend-${entry.id}`}>
                {entry.name}
              </a>
            ))}
          </nav>
        </div>
        {orderedTrendEntries.map((entry) => {
          const values = trendYears.map((selectedYear) =>
            trendAmount(entry.id, selectedYear),
          );
          const averageValues = values.map((value) => value / 12);
          return (
            <React.Fragment key={`trend-${entry.id}`}>
              <YearTrendChart
                entry={entry}
                anchorId={`year-trend-${entry.id}`}
                years={trendYears}
                values={values}
                averageValues={averageValues}
                selectedPoint={
                  trendSelection?.categoryId === entry.id
                    ? trendSelection.year
                    : null
                }
                onSelect={(selectedYear: string) =>
                  selectTrendPoint(entry.id, selectedYear)
                }
                draggable
                onDragStart={() => setDraggedTrendId(entry.id)}
                onDragOver={(event: React.DragEvent) => event.preventDefault()}
                onDrop={() => moveTrendChart(entry.id)}
              />
              {trendSelection?.categoryId === entry.id && trendDetail}
            </React.Fragment>
          );
        })}
      </section>}
      {comparisonView === "month" && <section className="trend-section monthly-trend-section">
        <div className="panel trend-intro monthly-trend-intro">
          <div>
            <p className="eyebrow">ONTWIKKELING PER MAAND</p>
            <h2>Bedragen per maand</h2>
            <p className="muted">
              Bekijk het geselecteerde jaar per maand en vergelijk optioneel met één vorig jaar.
              Klik op een maandpunt om de transacties te bekijken.
            </p>
            <nav className="year-chart-links" aria-label="Ga naar categorie">
              {orderedTrendEntries.map((entry) => (
                <a key={entry.id} href={`#month-trend-${entry.id}`}>
                  {entry.name}
                </a>
              ))}
            </nav>
          </div>
          <div className="filters monthly-trend-filters">
            <label>
              Jaar
              <select value={year} onChange={(event) => setYear(event.target.value)}>
                {availableYears.map((availableYear) => (
                  <option key={availableYear} value={availableYear}>
                    {availableYear}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Vergelijk met
              <select
                value={monthlyComparisonYear}
                onChange={(event) => setMonthlyComparisonYear(event.target.value)}
              >
                <option value="">Geen vergelijking</option>
                {availableYears
                  .filter((availableYear) => availableYear !== year)
                  .map((availableYear) => (
                    <option key={availableYear} value={availableYear}>
                      {availableYear}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </div>
        {orderedTrendEntries.map((entry) => (
          <React.Fragment key={`monthly-${entry.id}`}>
            <MonthlyCategoryChart
              entry={entry}
              anchorId={`month-trend-${entry.id}`}
              year={year}
              comparisonYear={monthlyComparisonYear}
              transactions={transactions}
              categories={summaryCategories}
              onSelect={(month: string) => selectTrendMonthPoint(entry.id, month)}
              selectedMonth={
                trendSelection?.categoryId === entry.id &&
                trendSelection.year.startsWith(`${year}-`)
                  ? trendSelection.year.slice(5)
                  : null
              }
            />
            {trendSelection?.categoryId === entry.id &&
              trendSelection.year.startsWith(`${year}-`) &&
              trendDetail}
          </React.Fragment>
        ))}
      </section>}
      {!trendEntries.length && (
        <div className="panel empty">
          <div>⌁</div>
          <h3>Geen transacties gevonden</h3>
          <p>Importeer transacties of kies een ander jaar.</p>
        </div>
      )}
    </section>
  );
}

function amountAll(
  transactions: Transaction[],
  categories: Category[],
  year: string,
  month?: string,
  direction: "income" | "expense" = "expense",
) {
  return transactions
    .filter(
      (t) =>
        t.date.startsWith(year) &&
        (!month || t.date.slice(5, 7) === month) &&
        (!t.categoryId ||
          categories.some(
            (c) => c.id === t.categoryId && !c.excludeFromSummary,
          )),
    )
    .reduce(
      (sum, t) =>
        sum +
        (direction === "income"
          ? Math.max(0, t.amount)
          : Math.max(0, -t.amount)),
      0,
    );
}

function MonthlyCategoryChart({
  entry,
  anchorId,
  year,
  comparisonYear,
  transactions,
  categories,
  onSelect,
  selectedMonth,
}: {
  entry: { id: string; name: string; color: string };
  anchorId: string;
  year: string;
  comparisonYear: string;
  transactions: Transaction[];
  categories: Category[];
  onSelect: (month: string) => void;
  selectedMonth: string | null;
}) {
  const months = Array.from({ length: 12 }, (_, index) =>
    String(index + 1).padStart(2, "0"),
  );
  const [hoveredMonth, setHoveredMonth] = useState<string | null>(null);
  const matchesEntry = (transaction: Transaction) => {
    if (entry.id === "__all__") {
      return (
        !transaction.categoryId ||
        categories.some((category) => category.id === transaction.categoryId)
      );
    }
    return entry.id === "__uncategorized__"
      ? !transaction.categoryId
      : transaction.categoryId === entry.id;
  };
  const valueFor = (selectedYear: string, month: string) =>
    Math.abs(
      transactions
        .filter(
          (transaction) =>
            transaction.date.startsWith(`${selectedYear}-${month}`) &&
            matchesEntry(transaction),
        )
        .reduce((sum, transaction) => sum + transaction.amount, 0),
    );
  const values = months.map((month) => valueFor(year, month));
  const comparisonValues = comparisonYear
    ? months.map((month) => valueFor(comparisonYear, month))
    : [];
  const average = values.reduce((sum, value) => sum + value, 0) / 12;
  const dataMax = Math.max(1, average, ...values, ...comparisonValues);
  const roughStep = dataMax / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalizedStep = roughStep / magnitude;
  const roundedStep =
    normalizedStep <= 1
      ? 1
      : normalizedStep <= 2
        ? 2
        : normalizedStep <= 5
          ? 5
          : 10;
  const tickStep = Math.max(1, roundedStep * magnitude);
  const max = Math.ceil(dataMax / tickStep) * tickStep;
  const width = 1000;
  const height = 260;
  const padding = { top: 28, right: 26, bottom: 44, left: 82 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const x = (index: number) =>
    padding.left + (index * chartWidth) / (months.length - 1);
  const y = (value: number) =>
    padding.top + chartHeight - (value / max) * chartHeight;
  const points = (series: number[]) =>
    series.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const ticks = Array.from(
    { length: Math.round(max / tickStep) + 1 },
    (_, index) => max - index * tickStep,
  );
  const hoveredIndex = hoveredMonth ? months.indexOf(hoveredMonth) : -1;
  const tooltipX = hoveredIndex < 0 ? 0 : Math.max(150, Math.min(width - 150, x(hoveredIndex)));
  const tooltipY =
    hoveredIndex < 0
      ? 0
      : Math.min(
          height - padding.bottom - 62,
          Math.max(8, y(values[hoveredIndex]) - 70),
        );
  return (
    <section id={anchorId} className="panel monthly-category-chart">
      <div className="monthly-chart-title">
        <span className="dot" style={{ background: entry.color }} />
        <h3>{entry.name}</h3>
        <strong>
          {year}: {money.format(values.reduce((sum, value) => sum + value, 0))}
        </strong>
      </div>
      <div className="monthly-chart-legend">
        <span>
          <i style={{ background: entry.color }} /> {year}
        </span>
        {comparisonYear && (
          <span>
            <i className="monthly-chart-comparison-line" /> {comparisonYear}
          </span>
        )}
        <span>
          <i className="monthly-chart-average-line" /> Gemiddelde per maand: {money.format(average)}
        </span>
      </div>
      <svg
        className="monthly-category-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Maandelijkse bedragen voor ${entry.name} in ${year}`}
      >
        {ticks.map((value) => (
          <g key={value}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(value)}
              y2={y(value)}
              className="trend-grid-line"
            />
            <text x={padding.left - 10} y={y(value) + 4} textAnchor="end">
              {money.format(value)}
            </text>
          </g>
        ))}
        <line
          x1={padding.left}
          x2={width - padding.right}
          y1={y(average)}
          y2={y(average)}
          className="monthly-average-line"
        />
        <polyline
          points={points(values)}
          fill="none"
          stroke={entry.color}
          className="trend-line"
        />
        {comparisonYear && (
          <polyline
            points={points(comparisonValues)}
            fill="none"
            stroke="#b8c9c1"
            className="monthly-comparison-line"
          />
        )}
        {months.map((month, index) => (
          <g key={month}>
            <circle
              cx={x(index)}
              cy={y(values[index])}
              r={selectedMonth === month || hoveredMonth === month ? 7 : 5}
              fill={entry.color}
              className="trend-point"
              onClick={() => onSelect(month)}
              onMouseEnter={() => setHoveredMonth(month)}
              onMouseLeave={() => setHoveredMonth(null)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(month);
                }
              }}
            />
            {comparisonYear && (
              <circle
                cx={x(index)}
                cy={y(comparisonValues[index])}
                r={hoveredMonth === month ? 6 : 4}
                fill="#b8c9c1"
                className="trend-point monthly-comparison-point"
                onClick={() => onSelect(month)}
                onMouseEnter={() => setHoveredMonth(month)}
                onMouseLeave={() => setHoveredMonth(null)}
              />
            )}
            <text x={x(index)} y={height - 14} textAnchor="middle">
              {month}
            </text>
          </g>
        ))}
        {hoveredIndex >= 0 && (
          <g className="year-trend-tooltip" pointerEvents="none">
            <rect x={tooltipX - 125} y={tooltipY} width="250" height={comparisonYear ? 61 : 47} rx="5" />
            <text x={tooltipX} y={tooltipY + 15} textAnchor="middle">
              {monthLabel(`${year}-${months[hoveredIndex]}`)}
            </text>
            <text x={tooltipX} y={tooltipY + 31} textAnchor="middle">
              {year}: {money.format(values[hoveredIndex])}
            </text>
            {comparisonYear && (
              <text x={tooltipX} y={tooltipY + 47} textAnchor="middle">
                {comparisonYear}: {money.format(comparisonValues[hoveredIndex])}
              </text>
            )}
          </g>
        )}
      </svg>
      <a className="year-chart-up" href="#year-comparison-top">
        ↑ Naar boven
      </a>
    </section>
  );
}

function YearTrendChart({
  entry,
  anchorId,
  years,
  values,
  averageValues,
  selectedPoint,
  onSelect,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  entry: { id: string; name: string; color: string };
  anchorId: string;
  years: string[];
  values: number[];
  averageValues: number[];
  selectedPoint: string | null;
  onSelect: (year: string) => void;
  draggable: boolean;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
}) {
  const [hoveredYear, setHoveredYear] = useState<string | null>(null);
  const width = 1000;
  const height = 230;
  const padding = { top: 24, right: 88, bottom: 42, left: 78 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const dataMax = Math.max(1, ...values);
  const roughStep = dataMax / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalizedStep = roughStep / magnitude;
  const roundedStep =
    normalizedStep <= 1
      ? 1
      : normalizedStep <= 2
        ? 2
        : normalizedStep <= 5
          ? 5
          : 10;
  const tickStep = Math.max(1, roundedStep * magnitude);
  const max = Math.ceil(dataMax / tickStep) * tickStep;
  const x = (index: number) =>
    years.length <= 1
      ? padding.left + chartWidth / 2
      : padding.left + (index * chartWidth) / (years.length - 1);
  const y = (value: number) =>
    padding.top + chartHeight - (value / max) * chartHeight;
  const points = values
    .map((value, index) => `${x(index)},${y(value)}`)
    .join(" ");
  const ticks = Array.from(
    { length: Math.round(max / tickStep) + 1 },
    (_, index) => max - index * tickStep,
  );
  const averageTicks = ticks.map((value) => Math.round(value / 12));
  return (
    <section
      id={anchorId}
      className="panel year-trend-panel"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        className="year-trend-title year-trend-drag-handle"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        title="Sleep om de grafiek te verplaatsen"
      >
        <span className="dot" style={{ background: entry.color }} />
        <h3>{entry.name}</h3>
        <span className="year-trend-drag-icon" aria-hidden="true">
          ⋮⋮
        </span>
        <strong>
          Totaal {money.format(values.reduce((sum, value) => sum + value, 0))}
        </strong>
      </div>
      <div className="year-trend-legend">
        <span>
          <i className="trend-legend-total" /> Totaal per jaar
        </span>
        <span className="trend-average-heading">Maandgemiddelde</span>
      </div>
      {years.length ? (
        <svg
          className="year-trend-svg"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Jaarlijkse bedragen voor ${entry.name}`}
        >
          {ticks.map((value) => (
            <g key={value}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y(value)}
                y2={y(value)}
                className="trend-grid-line"
              />
              <text x={padding.left - 10} y={y(value) + 4} textAnchor="end">
                {money.format(value)}
              </text>
            </g>
          ))}
          <line
            x1={width - padding.right}
            x2={width - padding.right}
            y1={padding.top}
            y2={padding.top + chartHeight}
            className="trend-average-axis-line"
          />
          {averageTicks.map((value) => (
            <text
              key={`average-${value}`}
              x={width - padding.right + 8}
              y={y(value * 12) + 4}
              textAnchor="start"
              className="trend-average-axis-label"
            >
              {money.format(value)}
            </text>
          ))}
          {points && (
            <polyline
              points={points}
              fill="none"
              stroke={entry.color}
              className="trend-line"
            />
          )}
          {values.map((value, index) => {
            const selected = selectedPoint === years[index];
            const hovered = hoveredYear === years[index];
            return (
              <g key={years[index]}>
                <circle
                  cx={x(index)}
                  cy={y(value)}
                  r={selected || hovered ? 7 : 5}
                  fill={entry.color}
                  className="trend-point"
                  onClick={() => onSelect(years[index])}
                  onMouseEnter={() => setHoveredYear(years[index])}
                  onMouseLeave={() => setHoveredYear(null)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(years[index]);
                    }
                  }}
                />
                <text x={x(index)} y={height - 14} textAnchor="middle">
                  {years[index]}
                </text>
              </g>
            );
          })}
          {hoveredYear && (
            <g className="year-trend-tooltip" pointerEvents="none">
              {(() => {
                const index = years.indexOf(hoveredYear);
                const tooltipX = Math.max(
                  padding.left + 90,
                  Math.min(width - padding.right - 90, x(index)),
                );
                const pointY = y(values[index]);
                const tooltipY = Math.min(
                  height - padding.bottom - 54,
                  Math.max(6, pointY < 78 ? pointY + 16 : pointY - 60),
                );
                return (
                  <>
                    <rect
                      x={tooltipX - 90}
                      y={tooltipY}
                      width="180"
                      height="48"
                      rx="5"
                    />
                    <text x={tooltipX} y={tooltipY + 15} textAnchor="middle">
                      {hoveredYear}
                    </text>
                    <text x={tooltipX} y={tooltipY + 31} textAnchor="middle">
                      Jaar: {money.format(values[index])}
                    </text>
                    <text x={tooltipX} y={tooltipY + 45} textAnchor="middle">
                      Gem. p/m: {money.format(averageValues[index])}
                    </text>
                  </>
                );
              })()}
            </g>
          )}
        </svg>
      ) : (
        <p className="muted">Geen jaarlijkse gegevens beschikbaar.</p>
      )}
      <a className="year-chart-up" href="#year-comparison-top">
        ↑ Naar categorieën
      </a>
    </section>
  );
}

function YearCategoryChart({
  entry,
  months,
  year,
  comparisonYears,
  amount: calculateAmount,
  total: calculateTotal,
  defaultDirection = "expense",
}: any) {
  const [chosenDirection, setChosenDirection] = useState<
    "income" | "expense" | null
  >(null);
  const direction = chosenDirection ?? defaultDirection;
  const amount = (id: string, selectedYear: string, month: string) =>
    calculateAmount(id, selectedYear, month, direction);
  const total = (selectedYear: string, id: string) =>
    calculateTotal(selectedYear, id, direction);
  const currentValues = months.map((month: string) =>
    amount(entry.id, year, month),
  );
  const comparisonValues = comparisonYears.map((selectedYear: string) =>
    months.map((month: string) => amount(entry.id, selectedYear, month)),
  );
  const max = Math.max(
    1,
    ...currentValues.map(Math.abs),
    ...comparisonValues.flat().map(Math.abs),
  );
  const comparisonColors = [
    "#c6d2cd",
    "#d2c3aa",
    "#bcc9d5",
    "#d0b9c8",
    "#c5bdd2",
    "#c7c9b7",
    "#b8c8c7",
    "#d1c3b4",
  ];
  const currentAverage = total(year, entry.id) / 12;
  const comparisonAverages = comparisonYears.map(
    (selectedYear: string) => total(selectedYear, entry.id) / 12,
  );
  const [hoveredMonth, setHoveredMonth] = useState<number | null>(null);
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => max * ratio);
  return (
    <section className="panel year-chart-panel">
      <div className="year-chart-title">
        <div>
          <span className="dot" style={{ background: entry.color }} />
          <h3>{entry.name}</h3>
          <select
            className="year-direction"
            aria-label={`Bedragtype voor ${entry.name}`}
            value={direction}
            onChange={(e) =>
              setChosenDirection(e.target.value as "income" | "expense")
            }
          >
            <option value="expense">Uitgaven</option>
            <option value="income">Inkomsten</option>
          </select>
        </div>
        <div className="year-totals">
          <span className="year-stat current-year-stat">
            {year}: <strong>{money.format(total(year, entry.id))}</strong>
            <small>gem. p/m {money.format(currentAverage)}</small>
          </span>
          {comparisonYears.map((selectedYear: string) => (
            <span className="year-stat" key={selectedYear}>
              {selectedYear}:{" "}
              <strong>{money.format(total(selectedYear, entry.id))}</strong>
              <small>
                gem. p/m{" "}
                {money.format(
                  comparisonAverages[comparisonYears.indexOf(selectedYear)],
                )}
              </small>
            </span>
          ))}
        </div>
      </div>
      <div className="year-legend">
        <span>
          <i className="legend-current" />
          {year}
        </span>
        {comparisonYears.map((selectedYear: string, index: number) => (
          <span key={selectedYear}>
            <i
              className="legend-comparison"
              style={{
                background: comparisonColors[index % comparisonColors.length],
              }}
            />
            {selectedYear}
          </span>
        ))}
      </div>
      <div className="year-chart-body">
        <div className="y-axis">
          {ticks.map((value) => (
            <span key={value}>{money.format(value)}</span>
          ))}
        </div>
        <div className="bar-chart">
          <div
            className="average-line current-average"
            style={{ bottom: `${18 + (currentAverage / max) * 182}px` }}
          >
            <span>gem. {money.format(currentAverage)}</span>
          </div>
          {months.map((month: string, index: number) => (
            <div
              className="bar-month"
              key={month}
              onMouseEnter={() => setHoveredMonth(index)}
              onMouseLeave={() => setHoveredMonth(null)}
            >
              {hoveredMonth === index && (
                <div className="bar-tooltip">
                  <strong>{monthLabel(`${year}-${month}`)}</strong>
                  <span>
                    {year}: {money.format(currentValues[index])}
                  </span>
                  {comparisonYears.map(
                    (selectedYear: string, comparisonIndex: number) => (
                      <span key={selectedYear}>
                        {selectedYear}:{" "}
                        {money.format(comparisonValues[comparisonIndex][index])}
                      </span>
                    ),
                  )}
                </div>
              )}
              <div className="bar-pair">
                <i
                  className="year-bar current"
                  style={{
                    height: `${Math.min(100, (Math.abs(currentValues[index]) / max) * 100)}%`,
                  }}
                  title={`${year}-${month}: ${money.format(currentValues[index])}`}
                />
                {comparisonYears.map(
                  (selectedYear: string, comparisonIndex: number) => (
                    <i
                      key={selectedYear}
                      className="year-bar comparison"
                      style={{
                        height: `${Math.min(100, (Math.abs(comparisonValues[comparisonIndex][index]) / max) * 100)}%`,
                        background:
                          comparisonColors[
                            comparisonIndex % comparisonColors.length
                          ],
                      }}
                      title={`${selectedYear}-${month}: ${money.format(comparisonValues[comparisonIndex][index])}`}
                    />
                  ),
                )}
              </div>
              <small>{month}</small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, tone }: any) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>geselecteerde periode</small>
    </div>
  );
}

function TransactionManager({
  transactions,
  categories,
  setTransactions,
}: any) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [cat, setCat] = useState("");
  const [filterMin, setFilterMin] = useState("");
  const [filterMax, setFilterMax] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [sortField, setSortField] = useState<
    "date" | "name" | "amount" | "category"
  >("date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const parseFilterAmount = (value: string) =>
    value.trim() ? Number(value.replace(",", ".")) : null;
  const parsedMin = parseFilterAmount(filterMin);
  const parsedMax = parseFilterAmount(filterMax);
  const bothAmounts =
    parsedMin !== null &&
    parsedMax !== null &&
    Number.isFinite(parsedMin) &&
    Number.isFinite(parsedMax);
  const amountMinimum = bothAmounts
    ? Math.min(parsedMin, parsedMax)
    : parsedMin;
  const amountMaximum = bothAmounts
    ? Math.max(parsedMin, parsedMax)
    : parsedMax;
  const matches = transactions.filter((t: Transaction) => {
    const textMatch = `${t.counterparty} ${t.description} ${t.counterpartyIban}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase());
    const categoryMatch =
      filterCategory === "all" ||
      (filterCategory === "uncategorized"
        ? !t.categoryId
        : t.categoryId === filterCategory);
    const typeMatch =
      filterType === "all" ||
      (filterType === "income" ? t.amount >= 0 : t.amount < 0);
    const amountMatch =
      (amountMinimum === null ||
        !Number.isFinite(amountMinimum) ||
        t.amount >= amountMinimum) &&
      (amountMaximum === null ||
        !Number.isFinite(amountMaximum) ||
        t.amount <= amountMaximum);
    return textMatch && categoryMatch && typeMatch && amountMatch;
  });
  const sortedMatches = [...matches].sort((a: Transaction, b: Transaction) => {
    const aValue =
      sortField === "date"
        ? a.date
        : sortField === "name"
          ? a.counterparty.toLocaleLowerCase()
          : sortField === "amount"
            ? a.amount
            : (categories
                .find((c: Category) => c.id === a.categoryId)
                ?.name.toLocaleLowerCase() ?? "Geen categorie");
    const bValue =
      sortField === "date"
        ? b.date
        : sortField === "name"
          ? b.counterparty.toLocaleLowerCase()
          : sortField === "amount"
            ? b.amount
            : (categories
                .find((c: Category) => c.id === b.categoryId)
                ?.name.toLocaleLowerCase() ?? "Geen categorie");
    const result =
      typeof aValue === "number" && typeof bValue === "number"
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), "nl-NL");
    return sortDirection === "asc" ? result : -result;
  });
  const sortColumn = (field: "date" | "name" | "amount" | "category") => {
    if (sortField === field)
      setSortDirection((direction) => (direction === "desc" ? "asc" : "desc"));
    else {
      setSortField(field);
      setSortDirection(field === "date" ? "desc" : "asc");
    }
    setPage(0);
  };
  const sortArrow = (field: "date" | "name" | "amount" | "category") =>
    sortField === field ? (sortDirection === "desc" ? "↓" : "↑") : "↕";
  const pageCount = Math.max(
    1,
    Math.ceil(sortedMatches.length / MAX_VISIBLE_RESULTS),
  );
  const currentPage = Math.min(page, pageCount - 1);
  const shown = sortedMatches.slice(
    currentPage * MAX_VISIBLE_RESULTS,
    (currentPage + 1) * MAX_VISIBLE_RESULTS,
  );
  const apply = () => {
    if (!cat) return;
    setTransactions((xs: Transaction[]) =>
      xs.map((t) =>
        selected.includes(t.id)
          ? {
              ...t,
              categoryId: cat,
              status: "confirmed",
              suggestionSource: "handmatig",
            }
          : t,
      ),
    );
    setSelected([]);
  };
  return (
    <section className="panel manager">
      <div className="panel-head">
        <div>
          <p className="eyebrow">TRANSACTIES</p>
          <h2>Achteraf aanpassen</h2>
          <p className="muted">
            Zoek op tegenrekening, tegenpartij of omschrijving en wijzig
            meerdere regels tegelijk.
          </p>
        </div>
        <input
          className="search"
          placeholder="Zoeken…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
      </div>
      <div className="manager-filters">
        <label>
          Min bedrag
          <input
            type="text"
            inputMode="decimal"
            placeholder="Geen"
            value={filterMin}
            onChange={(e) => {
              setFilterMin(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          Max bedrag
          <input
            type="text"
            inputMode="decimal"
            placeholder="Geen"
            value={filterMax}
            onChange={(e) => {
              setFilterMax(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          Categorie
          <select
            value={filterCategory}
            onChange={(e) => {
              setFilterCategory(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">Alle categorieën</option>
            <option value="uncategorized">Niet gecategoriseerd</option>
            {categories.map((c: Category) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select
            value={filterType}
            onChange={(e) => {
              setFilterType(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">Alle bedragen</option>
            <option value="expense">Uitgaven</option>
            <option value="income">Inkomsten</option>
          </select>
        </label>
      </div>
      <div className="manager-tools">
        <label>
          <input
            type="checkbox"
            checked={
              shown.length > 0 &&
              shown.every((t: Transaction) => selected.includes(t.id))
            }
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [
                      ...new Set([
                        ...selected,
                        ...shown.map((t: Transaction) => t.id),
                      ]),
                    ]
                  : selected.filter(
                      (id) => !shown.some((t: Transaction) => t.id === id),
                    ),
              )
            }
          />{" "}
          Alles selecteren
        </label>
        {selected.length > 0 && (
          <>
            <span>{selected.length} geselecteerd</span>
            <select value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Nieuwe categorie…</option>
              {categories.map((c: Category) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="small-primary" onClick={apply}>
              Wijzig categorie
            </button>
          </>
        )}
      </div>
      {sortedMatches.length > MAX_VISIBLE_RESULTS && (
        <div className="pagination">
          <button
            className="small-muted"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Vorige
          </button>
          <span>
            Pagina {currentPage + 1} van {pageCount}
          </span>
          <button
            className="small-muted"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Volgende pagina
          </button>
        </div>
      )}
      {shown.length > 0 && (
        <div className="transaction-list-header manager-list-header">
          <span />
          <button className="column-sort" onClick={() => sortColumn("date")}>
            Datum {sortArrow("date")}
          </button>
          <button className="column-sort" onClick={() => sortColumn("name")}>
            Naam {sortArrow("name")}
          </button>
          <span>Omschrijving</span>
          <button className="column-sort" onClick={() => sortColumn("amount")}>
            Bedrag {sortArrow("amount")}
          </button>
          <button
            className="column-sort"
            onClick={() => sortColumn("category")}
          >
            Categorie {sortArrow("category")}
          </button>
        </div>
      )}
      <div className="compact-list">
        {shown.map((t: Transaction) => (
          <div key={t.id} className="compact-row">
            <input
              type="checkbox"
              data-overview-row-checkbox="true"
              checked={selected.includes(t.id)}
              onChange={(e) =>
                setSelected((x: string[]) =>
                  e.target.checked
                    ? [...x, t.id]
                    : x.filter((id) => id !== t.id),
                )
              }
              onKeyDown={(e) => {
                if (e.key !== "Tab") return;
                const checkboxes = Array.from(
                  document.querySelectorAll<HTMLInputElement>(
                    '[data-overview-row-checkbox="true"]',
                  ),
                );
                const currentIndex = checkboxes.indexOf(e.currentTarget);
                const nextIndex = currentIndex + (e.shiftKey ? -1 : 1);
                const next = checkboxes[nextIndex];
                if (next) {
                  e.preventDefault();
                  next.focus();
                }
              }}
            />
            <span>{date(t.date)}</span>
            <strong>{t.counterparty || "Onbekend"}</strong>
            <small>
              {t.counterpartyIban || "Geen tegenrekening"} ·{" "}
              {t.description || "Geen omschrijving"}
            </small>
            <b>{money.format(t.amount)}</b>
            <select
              value={t.categoryId ?? ""}
              onChange={(e) =>
                setTransactions((xs: Transaction[]) =>
                  xs.map((x) =>
                    x.id === t.id
                      ? {
                          ...x,
                          categoryId: e.target.value,
                          status: "confirmed",
                          suggestionSource: "handmatig",
                        }
                      : x,
                  ),
                )
              }
            >
              <option value="">Geen categorie</option>
              {categories.map((c: Category) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {sortedMatches.length > MAX_VISIBLE_RESULTS && (
        <div className="pagination">
          <button
            className="small-muted"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Vorige
          </button>
          <span>
            Pagina {currentPage + 1} van {pageCount}
          </span>
          <button
            className="small-muted"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Volgende pagina
          </button>
        </div>
      )}
      <div className="overall-total">
        <span>Totaal gevonden transacties ({sortedMatches.length})</span>
        <strong>
          {money.format(
            sortedMatches.reduce(
              (sum: number, t: Transaction) => sum + t.amount,
              0,
            ),
          )}
        </strong>
      </div>
    </section>
  );
}

function Review({
  pending,
  query,
  setQuery,
  categories,
  selected,
  setSelected,
  setTransactions,
  confirm,
  addRule,
  bulkCat,
  setBulkCat,
  applyBulk,
}: any) {
  const [page, setPage] = useState(0);
  const [sortField, setSortField] = useState<
    "date" | "name" | "account" | "amount" | "category"
  >("date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [proposalCategories, setProposalCategories] = useState<
    Record<string, string>
  >({});
  const [ignoredProposalKeys, setIgnoredProposalKeys] = useState<string[]>(
    () => {
      try {
        const stored = localStorage.getItem(IGNORED_RULE_PROPOSALS_STORAGE_KEY);
        const parsed = stored ? JSON.parse(stored) : [];
        return Array.isArray(parsed)
          ? parsed.filter((key): key is string => typeof key === "string")
          : [];
      } catch {
        return [];
      }
    },
  );
  useEffect(() => {
    localStorage.setItem(
      IGNORED_RULE_PROPOSALS_STORAGE_KEY,
      JSON.stringify(ignoredProposalKeys),
    );
  }, [ignoredProposalKeys]);
  const [recentCategoryIds, setRecentCategoryIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(RECENT_CATEGORY_STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed)
        ? parsed
            .filter((id): id is string => typeof id === "string")
            .slice(0, 3)
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem(
      RECENT_CATEGORY_STORAGE_KEY,
      JSON.stringify(recentCategoryIds),
    );
  }, [recentCategoryIds]);
  const rememberCategory = (categoryId: string) => {
    if (!categoryId || categoryId === "__uncategorized__") return;
    setRecentCategoryIds((ids) =>
      [categoryId, ...ids.filter((id) => id !== categoryId)].slice(0, 3),
    );
  };
  const parseAmount = (value: string) => {
    if (!value.trim()) return null;
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const enteredAmounts = [
    parseAmount(minAmount),
    parseAmount(maxAmount),
  ].filter((value): value is number => value !== null);
  const minimum = enteredAmounts.length ? Math.min(...enteredAmounts) : null;
  const maximum = enteredAmounts.length ? Math.max(...enteredAmounts) : null;
  const matches = pending.filter((t: Transaction) => {
    const textMatches =
      `${t.counterpartyIban} ${t.counterparty} ${t.description}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase());
    return (
      textMatches &&
      (minimum === null || Math.abs(t.amount) >= minimum) &&
      (maximum === null || Math.abs(t.amount) <= maximum)
    );
  });
  const sortedMatches = [...matches].sort((a: Transaction, b: Transaction) => {
    const aValue =
      sortField === "date"
        ? a.date
        : sortField === "name"
          ? a.counterparty.toLocaleLowerCase()
          : sortField === "account"
            ? a.counterpartyIban.toLocaleLowerCase()
            : sortField === "amount"
              ? a.amount
              : (categories
                  .find((c: Category) => c.id === a.categoryId)
                  ?.name.toLocaleLowerCase() ?? "Geen categorie");
    const bValue =
      sortField === "date"
        ? b.date
        : sortField === "name"
          ? b.counterparty.toLocaleLowerCase()
          : sortField === "account"
            ? b.counterpartyIban.toLocaleLowerCase()
            : sortField === "amount"
              ? b.amount
              : (categories
                  .find((c: Category) => c.id === b.categoryId)
                  ?.name.toLocaleLowerCase() ?? "Geen categorie");
    const result =
      typeof aValue === "number" && typeof bValue === "number"
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), "nl-NL");
    return sortDirection === "asc" ? result : -result;
  });
  const pageCount = Math.max(
    1,
    Math.ceil(sortedMatches.length / MAX_VISIBLE_RESULTS),
  );
  const currentPage = Math.min(page, pageCount - 1);
  const visible = sortedMatches.slice(
    currentPage * MAX_VISIBLE_RESULTS,
    (currentPage + 1) * MAX_VISIBLE_RESULTS,
  );
  const ruleProposals = useMemo(() => {
    const groups = new Map<
      string,
      {
        name: string;
        field: "counterparty" | "description";
        count: number;
        sample: Transaction;
        suggestedIds: Set<string>;
      }
    >();
    const addCandidate = (
      field: "counterparty" | "description",
      value: string,
      transaction: Transaction,
    ) => {
      const name = value.trim();
      if (!name) return;
      const key = `${field}:${name.toLocaleLowerCase()}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        if (transaction.suggestedCategoryId)
          existing.suggestedIds.add(transaction.suggestedCategoryId);
      } else {
        groups.set(key, {
          name,
          field,
          count: 1,
          sample: transaction,
          suggestedIds: transaction.suggestedCategoryId
            ? new Set([transaction.suggestedCategoryId])
            : new Set(),
        });
      }
    };
    const ignoredWords = new Set([
      "geen",
      "omschrijving",
      "betaling",
      "betalingskenmerk",
      "betaalautomaat",
      "automaat",
      "pasnr",
      "rekening",
      "overboeking",
      "overschrijving",
      "incasso",
      "storting",
      "via",
      "naar",
      "voor",
      "met",
      "van",
      "aan",
    ]);
    pending.forEach((transaction: Transaction) => {
      addCandidate("counterparty", transaction.counterparty, transaction);
      const words = new Set(
        (transaction.description.match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]{3,}/g) ?? [])
          .map((word) => word.toLocaleLowerCase())
          .filter((word) => !ignoredWords.has(word)),
      );
      words.forEach((word) => addCandidate("description", word, transaction));
    });
    return [...groups.entries()]
      .filter(
        ([key, group]) =>
          group.count > 10 && !ignoredProposalKeys.includes(key),
      )
      .sort(([, a], [, b]) => b.count - a.count)
      .map(([key, group]) => ({
        key,
        ...group,
        suggestedCategoryId:
          group.suggestedIds.size === 1 ? [...group.suggestedIds][0] : "",
      }));
  }, [pending, ignoredProposalKeys]);
  const reviewTotal = pending.reduce(
    (sum: number, t: Transaction) => sum + t.amount,
    0,
  );
  return (
    <section className="panel review-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">REVIEW</p>
          <h2>Bevestig je transacties</h2>
          <p className="muted">
            Controleer de voorgestelde categorie. Je keuze wordt onthouden voor
            deze regel.
          </p>
          <p className="review-rule-help">
            Wil je dit automatisch onthouden? Kies een categorie, selecteer
            waarop je wilt matchen en klik daarna op{" "}
            <strong>Regel maken</strong>.
          </p>
          <p className="review-result-count">
            {matches.length.toLocaleString("nl-NL")} transacties getoond
          </p>
        </div>
        <div className="review-tools">
          <input
            className="search"
            placeholder="Zoek rekeningnummer of omschrijving…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
          <div className="review-amounts">
            <input
              type="text"
              inputMode="decimal"
              placeholder="Min bedrag"
              value={minAmount}
              onChange={(e) => {
                setMinAmount(e.target.value);
                setPage(0);
              }}
              title="Inclusief minimum bedrag, positief of negatief"
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Max bedrag"
              value={maxAmount}
              onChange={(e) => {
                setMaxAmount(e.target.value);
                setPage(0);
              }}
              title="Inclusief maximum bedrag, positief of negatief"
            />
          </div>
        </div>
      </div>
      {ruleProposals.length > 0 && (
        <div className="rule-proposals">
          <div className="rule-proposals-head">
            <div>
              <strong>Voorstellen voor automatische regels</strong>
              <p className="muted">
                Deze namen komen meer dan 10 keer voor bij openstaande
                transacties.
              </p>
            </div>
          </div>
          <div className="rule-proposal-list">
            {ruleProposals.map((proposal) => {
              const categoryId =
                proposalCategories[proposal.key] ??
                proposal.suggestedCategoryId;
              return (
                <div className="rule-proposal" key={proposal.key}>
                  <div>
                    <strong>
                      {proposal.field === "description"
                        ? "Omschrijving: "
                        : "Naam: "}
                      {proposal.name}
                    </strong>
                    <span>{proposal.count} transacties</span>
                  </div>
                  <select
                    aria-label={`Categorie voor voorstel ${proposal.name}`}
                    value={categoryId}
                    onChange={(event) =>
                      setProposalCategories((current) => ({
                        ...current,
                        [proposal.key]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Kies categorie…</option>
                    {categories.map((category: Category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="small-muted"
                    onClick={() => {
                      setQuery(proposal.name);
                      setPage(0);
                      window.setTimeout(() => {
                        document
                          .querySelector(".review-list-header")
                          ?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          });
                      }, 50);
                    }}
                  >
                    Bekijk transacties
                  </button>
                  <button
                    className="small-muted rule-proposal-ignore"
                    onClick={() =>
                      setIgnoredProposalKeys((keys) =>
                        keys.includes(proposal.key)
                          ? keys
                          : [...keys, proposal.key],
                      )
                    }
                  >
                    Negeren
                  </button>
                  <button
                    className="small-primary"
                    disabled={!categoryId}
                    onClick={() =>
                      addRule(
                        { ...proposal.sample, categoryId },
                        proposal.field,
                        false,
                      )
                    }
                  >
                    Regel maken
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {visible.length > 0 && (
        <div className="bulk">
          <label>
            <input
              type="checkbox"
              checked={
                visible.length > 0 &&
                visible.every((t: Transaction) => selected.includes(t.id))
              }
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [
                        ...new Set([
                          ...selected,
                          ...visible.map((t: Transaction) => t.id),
                        ]),
                      ]
                    : selected.filter(
                        (id: string) =>
                          !visible.some((t: Transaction) => t.id === id),
                      ),
                )
              }
            />{" "}
            Alles selecteren
          </label>
          {selected.length > 0 && (
            <>
              <span>{selected.length} geselecteerd</span>
              <select
                value={bulkCat}
                onChange={(e) => setBulkCat(e.target.value)}
              >
                <option value="">Kies categorie…</option>
                <option value="__uncategorized__">Geen categorie</option>
                {categories.map((c: Category) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button className="small-primary" onClick={applyBulk}>
                Pas toe
              </button>
            </>
          )}
        </div>
      )}
      {sortedMatches.length > MAX_VISIBLE_RESULTS && (
        <div className="pagination pagination-above-header">
          <button
            className="small-muted"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Vorige
          </button>
          <span>
            Pagina {currentPage + 1} van {pageCount}
          </span>
          <button
            className="small-muted"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Volgende pagina
          </button>
        </div>
      )}
      {visible.length > 0 && (
        <div className="transaction-list-header review-list-header">
          <span />
          <button
            className="column-sort"
            onClick={() => {
              if (sortField !== "date") {
                setSortField("date");
                setSortDirection("desc");
              } else {
                setSortDirection((direction) =>
                  direction === "desc" ? "asc" : "desc",
                );
              }
              setPage(0);
            }}
          >
            Datum{" "}
            {sortField === "date" && (sortDirection === "desc" ? "↓" : "↑")}
          </button>
          <button
            className="column-sort"
            onClick={() => {
              if (sortField === "name")
                setSortDirection((direction) =>
                  direction === "desc" ? "asc" : "desc",
                );
              else {
                setSortField("name");
                setSortDirection("asc");
              }
              setPage(0);
            }}
          >
            Transactie{" "}
            {sortField === "name"
              ? sortDirection === "desc"
                ? "↓"
                : "↑"
              : "↕"}
          </button>
          <button
            className="column-sort"
            onClick={() => {
              if (sortField === "amount")
                setSortDirection((direction) =>
                  direction === "desc" ? "asc" : "desc",
                );
              else {
                setSortField("amount");
                setSortDirection("asc");
              }
              setPage(0);
            }}
          >
            Bedrag{" "}
            {sortField === "amount"
              ? sortDirection === "desc"
                ? "↓"
                : "↑"
              : "↕"}
          </button>
          <button
            className="column-sort"
            onClick={() => {
              if (sortField === "category")
                setSortDirection((direction) =>
                  direction === "desc" ? "asc" : "desc",
                );
              else {
                setSortField("category");
                setSortDirection("asc");
              }
              setPage(0);
            }}
          >
            Categorie{" "}
            {sortField === "category"
              ? sortDirection === "desc"
                ? "↓"
                : "↑"
              : "↕"}
          </button>
          <span>Acties</span>
        </div>
      )}
      {pending.length === 0 ? (
        <div className="empty">
          <div>✓</div>
          <h3>Alles is bijgewerkt</h3>
          <p>Nieuwe transacties verschijnen hier na een import.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <div>⌕</div>
          <h3>Geen transacties gevonden</h3>
          <p>
            Probeer een ander rekeningnummer of een deel van de omschrijving.
          </p>
        </div>
      ) : (
        <div className="transaction-list">
          {visible.map((t: Transaction) => (
            <TransactionRow
              key={t.id}
              t={t}
              categories={categories}
              checked={selected.includes(t.id)}
              onCheck={(v: boolean) =>
                setSelected((x: string[]) =>
                  v ? [...x, t.id] : x.filter((id) => id !== t.id),
                )
              }
              setTransactions={setTransactions}
              recentCategoryIds={recentCategoryIds}
              onCategorySelected={rememberCategory}
              confirm={confirm}
              addRule={addRule}
            />
          ))}
        </div>
      )}
      {sortedMatches.length > MAX_VISIBLE_RESULTS && (
        <div className="pagination">
          <button
            className="small-muted"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Vorige
          </button>
          <span>
            Pagina {currentPage + 1} van {pageCount}
          </span>
          <button
            className="small-muted"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Volgende pagina
          </button>
        </div>
      )}
      <div className="overall-total">
        <span>Totaal te beoordelen (alle pagina's)</span>
        <strong>{money.format(reviewTotal)}</strong>
      </div>
    </section>
  );
}
function TransactionRow({
  t,
  categories,
  checked,
  onCheck,
  setTransactions,
  recentCategoryIds,
  onCategorySelected,
  confirm,
  addRule,
}: any) {
  const [cat, setCat] = useState(t.suggestedCategoryId || "");
  const [noteDraft, setNoteDraft] = useState(t.note || "");
  const recentCategories = recentCategoryIds
    .map((id: string) => categories.find((c: Category) => c.id === id))
    .filter((category: Category | undefined): category is Category =>
      Boolean(category),
    );
  const [ruleField, setRuleField] = useState<
    "counterparty" | "counterpartyIban" | "description"
  >("counterparty");
  const [truncated, setTruncated] = useState(false);
  const description = t.description || "Geen omschrijving";
  const descriptionRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = descriptionRef.current;
    if (!node) return;
    const check = () => setTruncated(node.scrollWidth > node.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [description]);
  return (
    <div className="transaction-row">
      <input
        type="checkbox"
        data-review-row-checkbox="true"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const checkboxes = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              '[data-review-row-checkbox="true"]',
            ),
          );
          const currentIndex = checkboxes.indexOf(e.currentTarget);
          const nextIndex = currentIndex + (e.shiftKey ? -1 : 1);
          const next = checkboxes[nextIndex];
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }}
      />
      <div className="transaction-date">{date(t.date)}</div>
      <div className="transaction-info">
        <strong>{t.counterparty || "Onbekende tegenpartij"}</strong>
        <span>{t.counterpartyIban || "Geen tegenrekeningnummer"}</span>
        <span ref={descriptionRef} title={truncated ? description : undefined}>
          {description}
        </span>
        <input
          className="transaction-note-input"
          placeholder="Opmerking…"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => {
            const note = noteDraft.trim();
            if (note === (t.note || "")) return;
            setTransactions((items: Transaction[]) =>
              items.map((item) =>
                item.id === t.id ? { ...item, note: note || undefined } : item,
              ),
            );
          }}
          title="Deze opmerking verschijnt in het overzicht bij hover"
        />
      </div>
      <div className="transaction-amount">{money.format(t.amount)}</div>
      <div className="suggestion">
        <small>
          Categorie:{" "}
          {t.suggestionSource === "regel"
            ? "AUTOMATISCHE REGEL"
            : t.suggestionSource === "herkenning"
              ? "HERKENNING"
              : "NOG ONBEKEND"}
        </small>
        <select
          value={cat}
          onChange={(e) => {
            setCat(e.target.value);
            if (e.target.value) onCategorySelected(e.target.value);
          }}
        >
          <option value="">Kies categorie…</option>
          {recentCategories.map((category: Category, index: number) => (
            <option key={`recent-${category.id}`} value={category.id}>
              {category.name} (recent gekozen{index < 3 ? ` #${index + 1}` : ""}
              )
            </option>
          ))}
          <option value="__uncategorized__">Geen categorie</option>
          {categories.map((c: Category) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row-actions">
        <button className="confirm" onClick={() => confirm([t.id], cat)}>
          ✓
        </button>
        <button
          className="rule"
          title={
            cat && cat !== "__uncategorized__"
              ? "Bewaar als automatische regel"
              : "Kies eerst een categorie"
          }
          disabled={!cat || cat === "__uncategorized__"}
          onClick={() => {
            if (cat && cat !== "__uncategorized__")
              addRule({ ...t, categoryId: cat }, ruleField, false);
          }}
        >
          ⚡ Regel maken
        </button>
        <select
          className="rule-mode"
          value={ruleField}
          onChange={(e) =>
            setRuleField(
              e.target.value as
                "counterparty" | "counterpartyIban" | "description",
            )
          }
          title="Waarop moet deze regel matchen?"
        >
          <option value="counterparty">Op naam (standaard)</option>
          <option value="counterpartyIban">Op rekening</option>
          <option value="description">Op omschrijving</option>
        </select>
      </div>
    </div>
  );
}

function Categories({
  categories,
  setCategories,
  rules,
  setRules,
  transactions,
  setTransactions,
  onClearTransactions,
}: any) {
  const [draftCategories, setDraftCategories] =
    useState<Category[]>(categories);
  const [newName, setNewName] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [saved]);
  useEffect(() => setDraftCategories(categories), [categories]);
  const dirty = JSON.stringify(draftCategories) !== JSON.stringify(categories);
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    const nextCategories = sortCategories([
      ...draftCategories,
      { id: uid("cat"), name, color: "#668f83", excludeFromSummary: false },
    ]);
    setDraftCategories(nextCategories);
    setCategories(nextCategories);
    void saveCategories(nextCategories);
    setSaved(true);
    setNewName("");
  };
  const update = (id: string, name: string) =>
    setDraftCategories((xs) =>
      xs.map((c) => (c.id === id ? { ...c, name } : c)),
    );
  const toggleSummary = (id: string) =>
    setDraftCategories((xs) =>
      xs.map((c) =>
        c.id === id ? { ...c, excludeFromSummary: !c.excludeFromSummary } : c,
      ),
    );
  const remove = (id: string) => {
    const linkedRules = rules.filter((r: Rule) => r.categoryId === id);
    if (linkedRules.length > 0) {
      setDeleteCandidate(id);
      return;
    }
    setDraftCategories((xs) => xs.filter((c) => c.id !== id));
  };
  const confirmRemove = () => {
    if (!deleteCandidate) return;
    const id = deleteCandidate;
    setDraftCategories((xs) => xs.filter((c) => c.id !== id));
    setRules((xs: Rule[]) => xs.filter((r) => r.categoryId !== id));
    setTransactions((xs: Transaction[]) =>
      xs.map((t) =>
        t.categoryId === id
          ? {
              ...t,
              categoryId: null,
              suggestedCategoryId: null,
              suggestionSource: "onbekend",
              status: "pending",
            }
          : t,
      ),
    );
    setDeleteCandidate(null);
  };
  const save = () => {
    setCategories(sortCategories(draftCategories));
    setSaved(true);
  };
  const cancel = () => {
    setDraftCategories(categories);
    setDeleteCandidate(null);
  };
  const candidate = draftCategories.find((c) => c.id === deleteCandidate);
  const linkedCount = deleteCandidate
    ? rules.filter((r: Rule) => r.categoryId === deleteCandidate).length
    : 0;
  const categoryImportCounts = useMemo(() => {
    const counts = new Map<string, number>();
    transactions.forEach((transaction: Transaction) => {
      if (transaction.categoryId) {
        counts.set(
          transaction.categoryId,
          (counts.get(transaction.categoryId) || 0) + 1,
        );
      }
    });
    return counts;
  }, [transactions]);
  return (
    <section className="panel categories-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">BEHEER</p>
          <h2>Categorieën</h2>
          <p className="muted">
            Beheer namen en voeg categorieën toe. Een nieuwe categorie wordt
            direct opgeslagen; overige wijzigingen worden pas actief na opslaan.
          </p>
        </div>
      </div>
      <div className="new-category category-create">
        <input
          placeholder="Nieuwe categorie…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="small-primary" onClick={add}>
          + Toevoegen
        </button>
      </div>
      {deleteCandidate && (
        <div className="category-warning">
          <strong>Let op: categorie verwijderen?</strong>
          <p>
            {candidate?.name} is gekoppeld aan {linkedCount} automatische regel
            {linkedCount === 1 ? "" : "s"}. Verwijderen haalt deze regels weg en
            maakt bijbehorende transacties ongecategoriseerd.
          </p>
          <button
            className="small-muted"
            onClick={() => setDeleteCandidate(null)}
          >
            Annuleren
          </button>
          <button className="delete-confirm" onClick={confirmRemove}>
            Verwijder categorie en regels
          </button>
        </div>
      )}
      <div className="category-management-list">
        {draftCategories.map((c) => (
          <div className="category-management-row" key={c.id}>
            <span className="dot" style={{ background: c.color }} />
            <DeferredCategoryNameInput
              value={c.name}
              onCommit={(name) => update(c.id, name)}
            />
            <label className="category-exclude">
              <input
                type="checkbox"
                checked={!!c.excludeFromSummary}
                onChange={() => toggleSummary(c.id)}
              />{" "}
              Niet in overzicht
            </label>
            <span className="category-rule-count">
              {categoryImportCounts.get(c.id) || 0} importregels
            </span>
            <button
              className="delete trash-button"
              title="Categorie verwijderen"
              aria-label="Categorie verwijderen"
              onClick={() => remove(c.id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7l1-3h4l1 3" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <div className="category-save-footer">
        {saved && <span className="save-confirmation">✓ Opgeslagen</span>}
        <button className="small-muted" disabled={!dirty} onClick={cancel}>
          Annuleren
        </button>
        <button className="small-primary" onClick={save}>
          Wijzigingen opslaan
        </button>
      </div>
      <div className="danger-zone">
        <strong>Gevarenzone</strong>
        <p>
          Wis alle geïmporteerde transacties en begin opnieuw. Categorieën en
          automatische regels blijven behouden.
        </p>
        {!confirmClear ? (
          <button
            className="danger-button"
            onClick={() => setConfirmClear(true)}
          >
            Alle transacties wissen
          </button>
        ) : (
          <div className="danger-confirmation">
            <strong>
              Let op: dit kan niet automatisch ongedaan worden gemaakt.
            </strong>
            <span>
              Alle transacties verdwijnen uit de lokale administratie.
            </span>
            <button
              className="small-muted"
              onClick={() => setConfirmClear(false)}
            >
              Annuleren
            </button>
            <button
              className="danger-button"
              onClick={() => {
                onClearTransactions();
                setConfirmClear(false);
              }}
            >
              Ja, alle transacties wissen
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
function RuleAmountFields({
  rule,
  updateRule,
}: {
  rule: Rule;
  updateRule: (id: string, update: Partial<Rule>) => void;
}) {
  return (
    <div className="rule-amount-range">
      <RuleAmountInput
        value={rule.minAmount}
        ariaLabel="Min bedrag"
        onCommit={(value) => updateRule(rule.id, { minAmount: value })}
      />
      <RuleAmountInput
        value={rule.maxAmount}
        ariaLabel="Max bedrag"
        onCommit={(value) => updateRule(rule.id, { maxAmount: value })}
      />
    </div>
  );
}

function RuleAmountInput({
  value,
  ariaLabel,
  onCommit,
}: {
  value?: number;
  ariaLabel: string;
  onCommit: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const parsed = draft === "" ? undefined : Math.max(0, Number(draft));
    onCommit(
      parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    );
  };
  return (
    <label>
      <input
        type="number"
        min="0"
        step="1"
        placeholder="Geen"
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    </label>
  );
}

function DeferredCategoryNameInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

function RuleValueInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      value={draft}
      placeholder="Waarde of regex, bijvoorbeeld .*Jumbo.*"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
    />
  );
}

function Rules({
  rules,
  categories,
  setRules,
  transactions,
  setTransactions,
  setNotice,
  focusRuleId,
}: any) {
  const [draftRules, setDraftRules] = useState<Rule[]>(rules);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [expandedRulePage, setExpandedRulePage] = useState(0);
  const [matchingSortDirection, setMatchingSortDirection] = useState<
    "asc" | "desc"
  >("desc");
  const [matchingSortField, setMatchingSortField] = useState<
    "date" | "name" | "account" | "description" | "amount" | "category"
  >("date");
  const [ruleSortField, setRuleSortField] = useState<
    | "priority"
    | "field"
    | "value"
    | "regex"
    | "minAmount"
    | "maxAmount"
    | "category"
  >("priority");
  const [ruleSortDirection, setRuleSortDirection] = useState<"asc" | "desc">(
    "asc",
  );
  const [newRuleField, setNewRuleField] = useState<Rule["field"] | "">("");
  const [newRuleValue, setNewRuleValue] = useState("");
  const [newRuleRegex, setNewRuleRegex] = useState(false);
  const [newRuleMin, setNewRuleMin] = useState("");
  const [newRuleMax, setNewRuleMax] = useState("");
  const [newRuleCategory, setNewRuleCategory] = useState("");
  const [newRuleError, setNewRuleError] = useState("");
  const deferredDraftRules = useDeferredValue(draftRules);
  const transactionsSignature = useMemo(
    () => transactionMatchSignature(transactions),
    [transactions],
  );
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [saved]);
  useEffect(() => setDraftRules(rules), [rules]);
  useEffect(() => {
    if (!focusRuleId) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector(`[data-rule-id="${focusRuleId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRuleId, rules, draftRules.length]);
  const dirty = JSON.stringify(draftRules) !== JSON.stringify(rules);
  const [matchingCounts, setMatchingCounts] = useState<Record<string, number>>(
    {},
  );
  useEffect(() => {
    let cancelled = false;
    const counts: Record<string, number> = {};
    const pendingRules: Rule[] = [];
    deferredDraftRules.forEach((rule) => {
      const field =
        rule.field ??
        (rule.counterpartyIban ? "counterpartyIban" : "description");
      const value =
        rule.value ??
        (field === "counterpartyIban"
          ? rule.counterpartyIban
          : rule.description) ??
        "";
      if (!rule.enabled || !value.trim()) {
        counts[rule.id] = 0;
        return;
      }
      const cacheKey = `${transactionsSignature}:${JSON.stringify(rule)}`;
      const cached = ruleMatchCountCache.get(cacheKey);
      if (cached !== undefined) {
        counts[rule.id] = cached;
      } else {
        pendingRules.push(rule);
      }
    });
    setMatchingCounts(counts);
    let index = 0;
    const calculateBatch = () => {
      if (cancelled) return;
      const started = performance.now();
      const batch: Record<string, number> = {};
      while (index < pendingRules.length && performance.now() - started < 24) {
        const rule = pendingRules[index++];
        const count = transactions.filter((t: Transaction) =>
          ruleMatchesTransaction(t, rule),
        ).length;
        if (ruleMatchCountCache.size > 5000) ruleMatchCountCache.clear();
        ruleMatchCountCache.set(
          `${transactionsSignature}:${JSON.stringify(rule)}`,
          count,
        );
        batch[rule.id] = count;
      }
      if (Object.keys(batch).length) {
        setMatchingCounts((current) => ({ ...current, ...batch }));
      }
      if (index < pendingRules.length) window.setTimeout(calculateBatch, 0);
    };
    const timer = window.setTimeout(calculateBatch, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deferredDraftRules, transactions, transactionsSignature]);
  const updateRule = (id: string, update: Partial<Rule>) => {
    setSaveError("");
    setDraftRules((xs) =>
      xs.map((x) => (x.id === id ? { ...x, ...update } : x)),
    );
  };
  const invalidRuleIds = new Set(
    draftRules
      .filter((r) => {
        const field =
          r.field ?? (r.counterpartyIban ? "counterpartyIban" : "description");
        const value =
          r.value ??
          (field === "counterpartyIban" ? r.counterpartyIban : r.description) ??
          "";
        const patterns = [value, r.counterpartyIban, r.description].filter(
          (pattern): pattern is string => !!pattern && pattern.trim() !== "",
        );
        return (
          r.regex === true &&
          patterns.some((pattern) => !isValidPattern(pattern, true))
        );
      })
      .map((r) => r.id),
  );
  const save = () => {
    if (draftRules.some((rule) => !rule.categoryId)) {
      setSaved(false);
      setSaveError(
        "Kies een categorie voor iedere nieuwe regel voordat je opslaat.",
      );
      return;
    }
    if (invalidRuleIds.size > 0) {
      setSaved(false);
      setSaveError(
        "Controleer de gemarkeerde regex: één of meer patronen zijn ongeldig.",
      );
      return;
    }
    const rulesToSave = priorityOrder(draftRules).map((rule, index) => ({
      ...rule,
      priority: index + 1,
    }));
    saveAndApplyRules(
      rulesToSave,
      "Automatische regels opgeslagen en toegepast.",
    );
  };
  const saveAndApplyRules = (rulesToSave: Rule[], message: string) => {
    setDraftRules(rulesToSave);
    setRules(rulesToSave);
    const nextTransactions = (transactions as Transaction[]).map((t) => {
      if (t.suggestionSource === "handmatig" && t.categoryId) return t;
      const suggestion = suggest(t, categories, rulesToSave);
      return {
        ...t,
        categoryId: suggestion.id,
        suggestedCategoryId: suggestion.id,
        suggestionSource: suggestion.source,
        status: suggestion.source === "regel" ? "confirmed" : "pending",
      } as Transaction;
    });
    const pendingCount = nextTransactions.filter(
      (t) => t.status === "pending",
    ).length;
    setTransactions(nextTransactions);
    setNotice(`${message} ${pendingCount} transacties wachten op bevestiging.`);
    setSaved(true);
  };
  const cancel = () => setDraftRules(rules);
  const priorityOrder = (items: Rule[]) =>
    [...items].sort((a, b) => {
      const aPriority = a.priority ?? items.indexOf(a) + 1;
      const bPriority = b.priority ?? items.indexOf(b) + 1;
      return aPriority - bPriority;
    });
  const moveRule = (ruleId: string, direction: -1 | 1) => {
    setSaveError("");
    setDraftRules((items) => {
      const ordered = priorityOrder(items);
      const currentIndex = ordered.findIndex((rule) => rule.id === ruleId);
      const nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= ordered.length)
        return items;
      [ordered[currentIndex], ordered[nextIndex]] = [
        ordered[nextIndex],
        ordered[currentIndex],
      ];
      return ordered.map((rule, index) => ({ ...rule, priority: index + 1 }));
    });
  };
  const addNewRule = () => {
    const value = newRuleValue.trim();
    const minAmount = newRuleMin.trim() ? Number(newRuleMin) : undefined;
    const maxAmount = newRuleMax.trim() ? Number(newRuleMax) : undefined;
    if (!newRuleField || !value || !newRuleCategory) {
      setNewRuleError(
        "Kies een veld, vul een waarde in en kies een categorie.",
      );
      return;
    }
    if (
      (minAmount !== undefined &&
        (!Number.isFinite(minAmount) || minAmount < 0)) ||
      (maxAmount !== undefined &&
        (!Number.isFinite(maxAmount) || maxAmount < 0))
    ) {
      setNewRuleError("Min en max bedrag moeten positieve bedragen zijn.");
      return;
    }
    if (newRuleRegex && !isValidPattern(value, true)) {
      setNewRuleError("De ingevulde regex is ongeldig.");
      return;
    }
    const rule: Rule = {
      id: uid("rule"),
      field: newRuleField,
      value,
      regex: newRuleRegex,
      minAmount,
      maxAmount,
      categoryId: newRuleCategory,
      enabled: true,
      priority:
        Math.max(0, ...draftRules.map((item) => item.priority ?? 0)) + 1,
    };
    const rulesToSave = priorityOrder([...draftRules, rule]).map(
      (item, index) => ({ ...item, priority: index + 1 }),
    );
    setDraftRules(rulesToSave);
    saveAndApplyRules(
      rulesToSave,
      "Nieuwe automatische regel opgeslagen en toegepast.",
    );
    setNewRuleField("");
    setNewRuleValue("");
    setNewRuleRegex(false);
    setNewRuleMin("");
    setNewRuleMax("");
    setNewRuleCategory("");
    setNewRuleError("");
  };
  const orderedRules = [...draftRules].sort((a, b) => {
    const priorityValue = (rule: Rule) =>
      priorityOrder(draftRules).findIndex((item) => item.id === rule.id) + 1;
    const value = (rule: Rule): string | number => {
      if (ruleSortField === "priority") return priorityValue(rule);
      if (ruleSortField === "field")
        return (
          rule.field ??
          (rule.counterpartyIban ? "counterpartyIban" : "description")
        );
      if (ruleSortField === "value")
        return rule.value ?? rule.counterpartyIban ?? rule.description ?? "";
      if (ruleSortField === "regex") return rule.regex ? 1 : 0;
      if (ruleSortField === "minAmount")
        return rule.minAmount ?? Number.NEGATIVE_INFINITY;
      if (ruleSortField === "maxAmount")
        return rule.maxAmount ?? Number.NEGATIVE_INFINITY;
      return (
        categories.find((c: Category) => c.id === rule.categoryId)?.name ?? ""
      );
    };
    const aValue = value(a);
    const bValue = value(b);
    const result =
      typeof aValue === "number" && typeof bValue === "number"
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), "nl", {
            sensitivity: "base",
          });
    return ruleSortDirection === "asc" ? result : -result;
  });
  const ruleSortButton = (field: typeof ruleSortField, label: string) => (
    <button
      className="column-sort"
      onClick={() => {
        if (ruleSortField === field) {
          setRuleSortDirection((direction) =>
            direction === "asc" ? "desc" : "asc",
          );
        } else {
          setRuleSortField(field);
          setRuleSortDirection("asc");
        }
      }}
    >
      {label}{" "}
      {ruleSortField === field
        ? ruleSortDirection === "asc"
          ? "↑"
          : "↓"
        : "↕"}
    </button>
  );
  return (
    <section className="panel rules-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">AUTOMATISERING</p>
          <h2>Automatische regels</h2>
          <p className="muted">
            Wijzigingen blijven eerst als concept staan. Sla ze expliciet op om
            ze actief te maken.
          </p>
        </div>
      </div>
      <div className="new-rule-form">
        <strong>Nieuwe regel</strong>
        <span className="muted">
          Wordt direct opgeslagen en toegepast op bestaande transacties.
        </span>
        <select
          aria-label="Veld voor nieuwe regel"
          value={newRuleField}
          onChange={(e) =>
            setNewRuleField(e.target.value as Rule["field"] | "")
          }
        >
          <option value="">Kies veld…</option>
          <option value="counterparty">Naam</option>
          <option value="counterpartyIban">Rekening</option>
          <option value="description">Omschrijving</option>
        </select>
        <input
          aria-label="Waarde voor nieuwe regel"
          placeholder="Waarde…"
          value={newRuleValue}
          onChange={(e) => setNewRuleValue(e.target.value)}
        />
        <label className="regex-toggle">
          <input
            type="checkbox"
            checked={newRuleRegex}
            onChange={(e) => setNewRuleRegex(e.target.checked)}
          />{" "}
          Regex
        </label>
        <input
          type="number"
          min="0"
          step="1"
          placeholder="Min bedrag"
          aria-label="Minimum bedrag"
          value={newRuleMin}
          onChange={(e) => setNewRuleMin(e.target.value)}
        />
        <input
          type="number"
          min="0"
          step="1"
          placeholder="Max bedrag"
          aria-label="Maximum bedrag"
          value={newRuleMax}
          onChange={(e) => setNewRuleMax(e.target.value)}
        />
        <select
          aria-label="Categorie voor nieuwe regel"
          value={newRuleCategory}
          onChange={(e) => setNewRuleCategory(e.target.value)}
        >
          <option value="">Kies categorie…</option>
          {categories.map((category: Category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <button className="small-primary" onClick={addNewRule}>
          Regel toevoegen
        </button>
        {newRuleError && <span className="rule-error">{newRuleError}</span>}
      </div>
      {draftRules.length === 0 ? (
        <div className="empty">
          <div>⚡</div>
          <h3>Nog geen actieve regels</h3>
          <p>
            De ingebouwde standaardregels zijn verwijderd. Bewaar een keuze
            vanuit de reviewlijst om een regel toe te voegen.
          </p>
        </div>
      ) : (
        <div className="rules-list">
          <div className="rule-column-headings">
            <span />
            {ruleSortButton("priority", "Prio")}
            <div className="rule-editor-heading">
              {ruleSortButton("field", "Veld")}
              {ruleSortButton("value", "Waarde")}
              {ruleSortButton("regex", "Regex")}
              {ruleSortButton("minAmount", "Min bedrag")}
              {ruleSortButton("maxAmount", "Max bedrag")}
            </div>
            {ruleSortButton("category", "Categorie")}
            <span>Actie</span>
          </div>
          {orderedRules.map((r: Rule, index: number) => {
            const priorityRules = priorityOrder(draftRules);
            const priorityIndex = priorityRules.findIndex(
              (rule) => rule.id === r.id,
            );
            const legacyComposite =
              !r.field && (r.counterpartyIban || r.description);
            const field =
              r.field ??
              (r.counterpartyIban ? "counterpartyIban" : "description");
            const value =
              r.value ??
              (field === "counterpartyIban"
                ? r.counterpartyIban
                : r.description) ??
              "";
            const matchingCount = matchingCounts[r.id] ?? null;
            const matchingCountValue = matchingCount ?? 0;
            const matchingCountLabel =
              matchingCount === null
                ? "Aantal wordt berekend…"
                : `${matchingCount} transacties voldoen`;
            const matchingPageCount = Math.max(
              1,
              Math.ceil(matchingCountValue / MAX_VISIBLE_RESULTS),
            );
            const currentMatchingPage = Math.min(
              expandedRulePage,
              matchingPageCount - 1,
            );
            const matchingTransactions =
              expandedRuleId === r.id
                ? transactions
                    .filter((t: Transaction) => matchingRule(t, [r]))
                    .sort((a: Transaction, b: Transaction) =>
                      (() => {
                        const value = (t: Transaction) =>
                          matchingSortField === "date"
                            ? t.date
                            : matchingSortField === "name"
                              ? t.counterparty.toLocaleLowerCase()
                              : matchingSortField === "account"
                                ? t.counterpartyIban.toLocaleLowerCase()
                                : matchingSortField === "description"
                                  ? t.description.toLocaleLowerCase()
                                  : matchingSortField === "category"
                                    ? (categories.find(
                                        (c: Category) => c.id === t.categoryId,
                                      )?.name ?? "Geen categorie")
                                    : t.amount;
                        const aValue = value(a);
                        const bValue = value(b);
                        const result =
                          typeof aValue === "number" &&
                          typeof bValue === "number"
                            ? aValue - bValue
                            : String(aValue).localeCompare(
                                String(bValue),
                                "nl-NL",
                              );
                        return matchingSortDirection === "asc"
                          ? result
                          : -result;
                      })(),
                    )
                    .slice(
                      currentMatchingPage * MAX_VISIBLE_RESULTS,
                      (currentMatchingPage + 1) * MAX_VISIBLE_RESULTS,
                    )
                : [];
            return (
              <React.Fragment key={r.id}>
                <div
                  data-rule-id={r.id}
                  className={`rule-row ${r.enabled ? "" : "disabled"} ${focusRuleId === r.id ? "focused" : ""} ${invalidRuleIds.has(r.id) ? "invalid" : ""} ${!r.categoryId ? "invalid-category" : ""} ${index > 0 && orderedRules[index - 1].categoryId !== r.categoryId ? "category-start" : ""}`}
                >
                  <button
                    className={`toggle ${r.enabled ? "on" : ""}`}
                    onClick={() => updateRule(r.id, { enabled: !r.enabled })}
                  >
                    <i />
                  </button>
                  <span className="rule-priority" title="Uitvoeringsprioriteit">
                    {priorityIndex + 1}
                  </span>
                  {legacyComposite ? (
                    <div>
                      <strong>Combinatieregel</strong>
                      <span>
                        Rekening én/of omschrijving ·{" "}
                        {r.counterpartyIban || r.description}
                      </span>
                      <label className="regex-toggle">
                        <input
                          type="checkbox"
                          checked={r.regex === true}
                          onChange={(e) =>
                            updateRule(r.id, { regex: e.target.checked })
                          }
                        />{" "}
                        Regex
                      </label>
                      <RuleAmountFields rule={r} updateRule={updateRule} />
                      {invalidRuleIds.has(r.id) && (
                        <span className="rule-error">Ongeldige regex</span>
                      )}
                      <button
                        className="rule-preview"
                        onClick={() =>
                          setExpandedRuleId((current) => {
                            if (current === r.id) return null;
                            setExpandedRulePage(0);
                            return r.id;
                          })
                        }
                      >
                        {matchingCountLabel}
                        {matchingCountValue > 0 &&
                          (expandedRuleId === r.id
                            ? " · verbergen"
                            : " · bekijken")}
                      </button>
                    </div>
                  ) : (
                    <div className="rule-editor">
                      <select
                        value={field}
                        onChange={(e) =>
                          updateRule(r.id, {
                            field: e.target.value as Rule["field"],
                          })
                        }
                      >
                        <option value="counterparty">Naam</option>
                        <option value="counterpartyIban">Rekening</option>
                        <option value="description">Omschrijving</option>
                      </select>
                      <RuleValueInput
                        value={value}
                        onCommit={(nextValue) =>
                          updateRule(r.id, { field, value: nextValue })
                        }
                      />
                      <label className="regex-toggle">
                        <input
                          type="checkbox"
                          checked={r.regex === true}
                          onChange={(e) =>
                            updateRule(r.id, { regex: e.target.checked })
                          }
                        />{" "}
                        Regex
                      </label>
                      <RuleAmountFields rule={r} updateRule={updateRule} />
                      {invalidRuleIds.has(r.id) && (
                        <span className="rule-error">Ongeldige regex</span>
                      )}
                      <button
                        className="rule-preview"
                        onClick={() =>
                          setExpandedRuleId((current) => {
                            if (current === r.id) return null;
                            setExpandedRulePage(0);
                            return r.id;
                          })
                        }
                      >
                        {matchingCountLabel}
                        {matchingCountValue > 0 &&
                          (expandedRuleId === r.id
                            ? " · verbergen"
                            : " · bekijken")}
                      </button>
                    </div>
                  )}
                  <select
                    value={r.categoryId}
                    onChange={(e) =>
                      updateRule(r.id, { categoryId: e.target.value })
                    }
                  >
                    <option value="">Kies categorie…</option>
                    {categories.map((c: Category) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <div className="rule-actions">
                    <button
                      className="priority-button"
                      disabled={priorityIndex === 0}
                      title="Regel eerder uitvoeren"
                      onClick={() => moveRule(r.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="priority-button"
                      disabled={priorityIndex === priorityRules.length - 1}
                      title="Regel later uitvoeren"
                      onClick={() => moveRule(r.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="delete trash-button"
                      title="Regel verwijderen"
                      aria-label="Regel verwijderen"
                      onClick={() =>
                        setDraftRules((xs) => xs.filter((x) => x.id !== r.id))
                      }
                    >
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7l1-3h4l1 3" />
                      </svg>
                    </button>
                  </div>
                </div>
                {expandedRuleId === r.id && (
                  <div className="rule-matches">
                    <div className="rule-matches-head">
                      <strong>
                        Transacties die aan deze regel voldoen
                        {matchingCountValue > MAX_VISIBLE_RESULTS &&
                          ` (pagina ${currentMatchingPage + 1} van ${matchingPageCount})`}
                      </strong>
                    </div>
                    {matchingCountValue > MAX_VISIBLE_RESULTS && (
                      <div className="pagination pagination-above-header">
                        <button
                          className="small-muted"
                          disabled={currentMatchingPage === 0}
                          onClick={() =>
                            setExpandedRulePage(currentMatchingPage - 1)
                          }
                        >
                          Vorige
                        </button>
                        <span>
                          Pagina {currentMatchingPage + 1} van{" "}
                          {matchingPageCount}
                        </span>
                        <button
                          className="small-muted"
                          disabled={
                            currentMatchingPage >= matchingPageCount - 1
                          }
                          onClick={() =>
                            setExpandedRulePage(currentMatchingPage + 1)
                          }
                        >
                          Volgende pagina
                        </button>
                      </div>
                    )}
                    <div className="rule-match-header">
                      {(
                        [
                          ["date", "Datum"],
                          ["name", "Transactie"],
                          ["account", "Rekening"],
                          ["description", "Omschrijving"],
                          ["amount", "Bedrag"],
                          ["category", "Categorie"],
                        ] as const
                      ).map(([field, label]) => (
                        <button
                          className="column-sort"
                          key={field}
                          onClick={() => {
                            if (matchingSortField === field) {
                              setMatchingSortDirection((direction) =>
                                direction === "desc" ? "asc" : "desc",
                              );
                            } else {
                              setMatchingSortField(field);
                              setMatchingSortDirection(
                                field === "date" ? "asc" : "asc",
                              );
                            }
                            setExpandedRulePage(0);
                          }}
                        >
                          {label}{" "}
                          {matchingSortField === field
                            ? matchingSortDirection === "desc"
                              ? "↓"
                              : "↑"
                            : "↕"}
                        </button>
                      ))}
                    </div>
                    {matchingTransactions.length === 0 ? (
                      <span>Geen transacties gevonden.</span>
                    ) : (
                      matchingTransactions.map((transaction: Transaction) => (
                        <div className="rule-match" key={transaction.id}>
                          <span>{date(transaction.date)}</span>
                          <strong>
                            {transaction.counterparty ||
                              "Onbekende tegenpartij"}
                          </strong>
                          <span>
                            {transaction.counterpartyIban ||
                              "Geen rekeningnummer"}
                          </span>
                          <span title={transaction.description}>
                            {transaction.description || "Geen omschrijving"}
                          </span>
                          <b>{money.format(transaction.amount)}</b>
                          <select
                            className="rule-match-category"
                            value={
                              transaction.categoryId ?? "__uncategorized__"
                            }
                            aria-label={`Categorie voor ${transaction.counterparty || "transactie"}`}
                            onChange={(e) => {
                              const categoryId =
                                e.target.value === "__uncategorized__"
                                  ? null
                                  : e.target.value;
                              const nextItems = transactions.map(
                                (item: Transaction) =>
                                  item.id === transaction.id
                                    ? {
                                        ...item,
                                        categoryId,
                                        suggestedCategoryId: categoryId,
                                        suggestionSource: categoryId
                                          ? "handmatig"
                                          : "onbekend",
                                        status: categoryId
                                          ? "confirmed"
                                          : "pending",
                                      }
                                    : item,
                              );
                              setTransactions(nextItems);
                              void saveTransactions(nextItems);
                            }}
                          >
                            <option value="__uncategorized__">
                              Geen categorie
                            </option>
                            {categories.map((category: Category) => (
                              <option key={category.id} value={category.id}>
                                {category.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))
                    )}
                    {matchingCountValue > MAX_VISIBLE_RESULTS && (
                      <div className="pagination">
                        <button
                          className="small-muted"
                          disabled={currentMatchingPage === 0}
                          onClick={() =>
                            setExpandedRulePage(currentMatchingPage - 1)
                          }
                        >
                          Vorige
                        </button>
                        <span>
                          Pagina {currentMatchingPage + 1} van{" "}
                          {matchingPageCount}
                        </span>
                        <button
                          className="small-muted"
                          disabled={
                            currentMatchingPage >= matchingPageCount - 1
                          }
                          onClick={() =>
                            setExpandedRulePage(currentMatchingPage + 1)
                          }
                        >
                          Volgende pagina
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
      <div className="rules-save-footer rules-actions rules-page-actions">
        {saved && <span className="save-confirmation">✓ Opgeslagen</span>}
        {saveError && <span className="rule-error-summary">{saveError}</span>}
        <button className="small-muted" disabled={!dirty} onClick={cancel}>
          Annuleren
        </button>
        <button className="small-primary" onClick={save}>
          Opslaan en toepassen
        </button>
      </div>
      <div className="rules-scroll-top">
        <button
          className="small-muted"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          ↑ Naar boven
        </button>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
