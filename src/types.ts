export type Direction = "income" | "expense";

export interface Transaction {
  id: string;
  date: string;
  bookingDate: string;
  amount: number;
  balance: number | null;
  currency: string;
  counterpartyIban: string;
  counterparty: string;
  description: string;
  note?: string;
  code: string;
  raw: Record<string, string>;
  categoryId: string | null;
  suggestedCategoryId: string | null;
  suggestionSource: "regel" | "herkenning" | "onbekend" | "handmatig";
  status: "pending" | "confirmed" | "skipped";
  direction: Direction;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  system?: boolean;
  excludeFromSummary?: boolean;
}

export interface Rule {
  id: string;
  /** Lower numbers are evaluated first. */
  priority?: number;
  field?: "counterpartyIban" | "counterparty" | "description";
  value?: string;
  counterpartyIban?: string;
  description?: string;
  matchMode?: "any" | "all";
  regex?: boolean;
  minAmount?: number;
  maxAmount?: number;
  categoryId: string;
  enabled: boolean;
}
