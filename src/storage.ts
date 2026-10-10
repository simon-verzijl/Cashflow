import type { Category, Rule, Transaction } from "./types";

const DB = "cashflow-nl";
const VERSION = 1;
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      ["transactions", "categories", "rules"].forEach((s) => {
        if (!db.objectStoreNames.contains(s))
          db.createObjectStore(s, { keyPath: "id" });
      });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function all<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function putMany<T extends { id: string }>(store: string, items: T[]) {
  if (!items.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    items.forEach((i) => tx.objectStore(store).put(i));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export const loadAll = async () => ({
  transactions: await all<Transaction>("transactions"),
  categories: await all<Category>("categories"),
  rules: await all<Rule>("rules"),
});
export const saveTransactions = (x: Transaction[]) =>
  putMany("transactions", x);
let categoriesSaveChain: Promise<void> = Promise.resolve();

async function saveCategoriesNow(categories: Category[]) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("categories", "readwrite");
    const store = tx.objectStore("categories");
    // Reconcile the store instead of only upserting. This also removes
    // categories deleted by the user from IndexedDB.
    store.clear();
    categories.forEach((category) => store.put(category));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export function saveCategories(categories: Category[]) {
  // IndexedDB clear-and-replace writes must not overlap. Otherwise an older
  // queued write can finish after a newer one and make a newly added category
  // disappear again after a refresh.
  categoriesSaveChain = categoriesSaveChain.then(() =>
    saveCategoriesNow(categories),
  );
  return categoriesSaveChain;
}
export async function saveRules(rules: Rule[]) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("rules", "readwrite");
    const store = tx.objectStore("rules");
    store.clear();
    rules.forEach((rule) => store.put(rule));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function clearAll() {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ["transactions", "categories", "rules"],
      "readwrite",
    );
    ["transactions", "categories", "rules"].forEach((s) =>
      tx.objectStore(s).clear(),
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function replaceAll(data: {
  transactions: Transaction[];
  categories: Category[];
  rules: Rule[];
}) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ["transactions", "categories", "rules"],
      "readwrite",
    );
    ["transactions", "categories", "rules"].forEach((s) =>
      tx.objectStore(s).clear(),
    );
    data.transactions.forEach((item) =>
      tx.objectStore("transactions").put(item),
    );
    data.categories.forEach((item) => tx.objectStore("categories").put(item));
    data.rules.forEach((item) => tx.objectStore("rules").put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
