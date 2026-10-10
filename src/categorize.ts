import type { Category, Rule, Transaction } from "./types";
const normalizedTextCache = new Map<string, string>();
const norm = (s: string) => {
  const cached = normalizedTextCache.get(s);
  if (cached !== undefined) return cached;
  const normalized = s
    .toLocaleLowerCase("nl-NL")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalizedTextCache.size > 50000) normalizedTextCache.clear();
  normalizedTextCache.set(s, normalized);
  return normalized;
};
const hasRegexOperators = (value: string) => /[.*+?()[\]{}|^$\\]/.test(value);
const patternCache = new Map<
  string,
  { search: string; expression: RegExp | null }
>();
export function isValidPattern(pattern: string, regex = true) {
  const search = norm(pattern);
  if (!regex || !hasRegexOperators(search)) return true;
  try {
    new RegExp(search);
    return true;
  } catch {
    return false;
  }
}
const matchesPattern = (text: string, pattern: string, regex = false) => {
  const value = norm(text);
  const cacheKey = `${regex ? "regex" : "text"}:${pattern}`;
  let cached = patternCache.get(cacheKey);
  if (!cached) {
    const search = norm(pattern);
    let expression: RegExp | null = null;
    if (regex) {
      try {
        expression = new RegExp(search);
      } catch {
        /* use text match below */
      }
    }
    cached = { search, expression };
    patternCache.set(cacheKey, cached);
  }
  if (!cached.search) return false;
  // Plain text is a case-insensitive substring match. Regex is opt-in per rule.
  return cached.expression
    ? cached.expression.test(value)
    : value.includes(cached.search);
};
const matchesAmount = (t: Transaction, rule: Rule) => {
  const minimum =
    typeof rule.minAmount === "number" && Number.isFinite(rule.minAmount)
      ? rule.minAmount
      : null;
  const maximum =
    typeof rule.maxAmount === "number" && Number.isFinite(rule.maxAmount)
      ? rule.maxAmount
      : null;
  if (minimum === null && maximum === null) return true;
  const lower =
    minimum !== null && maximum !== null ? Math.min(minimum, maximum) : minimum;
  const upper =
    minimum !== null && maximum !== null ? Math.max(minimum, maximum) : maximum;
  const absoluteAmount = Math.abs(t.amount);
  return (
    (lower === null || absoluteAmount >= lower) &&
    (upper === null || absoluteAmount <= upper)
  );
};
export function suggest(t: Transaction, categories: Category[], rules: Rule[]) {
  const enabled = rules
    .filter(
      (r) =>
        r.enabled &&
        (r.value?.trim() ||
          r.counterpartyIban?.trim() ||
          r.description?.trim()),
    )
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const rule of enabled) {
    const checks = [
      rule.counterpartyIban
        ? matchesPattern(t.counterpartyIban, rule.counterpartyIban, rule.regex)
        : null,
      rule.description
        ? matchesPattern(t.description, rule.description, rule.regex)
        : null,
    ].filter((v): v is boolean => v !== null);
    const legacy =
      rule.field && rule.value
        ? matchesPattern(t[rule.field], rule.value, rule.regex)
        : false;
    if (
      matchesAmount(t, rule) &&
      (legacy ||
        (checks.length > 0 &&
          (rule.matchMode === "all"
            ? checks.every(Boolean)
            : checks.some(Boolean))))
    )
      return { id: rule.categoryId, source: "regel" as const };
  }
  return { id: null, source: "onbekend" as const };
}

export function matchingRule(t: Transaction, rules: Rule[]) {
  const enabled = rules
    .filter(
      (r) =>
        r.enabled &&
        (r.value?.trim() ||
          r.counterpartyIban?.trim() ||
          r.description?.trim()),
    )
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const rule of enabled) {
    if (ruleMatchesTransaction(t, rule)) return rule;
  }
  return null;
}

export function ruleMatchesTransaction(t: Transaction, rule: Rule) {
  if (
    !rule.enabled ||
    !(
      rule.value?.trim() ||
      rule.counterpartyIban?.trim() ||
      rule.description?.trim()
    )
  )
    return false;
  const checks = [
    rule.counterpartyIban
      ? matchesPattern(t.counterpartyIban, rule.counterpartyIban, rule.regex)
      : null,
    rule.description
      ? matchesPattern(t.description, rule.description, rule.regex)
      : null,
  ].filter((v): v is boolean => v !== null);
  const legacy =
    rule.field && rule.value
      ? matchesPattern(t[rule.field], rule.value, rule.regex)
      : false;
  return (
    matchesAmount(t, rule) &&
    (legacy ||
      (checks.length > 0 &&
        (rule.matchMode === "all"
          ? checks.every(Boolean)
          : checks.some(Boolean))))
  );
}
