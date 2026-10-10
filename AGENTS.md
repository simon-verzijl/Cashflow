# AGENTS.md

## Project overview

Cashflow NL is a local-first Dutch React/TypeScript webapp for importing and categorising bank transactions. It runs in the browser without an account or server. Transaction, category, and rule data are stored in IndexedDB and should not leave the browser.

The app is intentionally structured so a backend/API can be added later, but the current application is client-only.

For a fuller product and implementation handoff, read [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md).

## Development

Run from the project root (`/Users/simon/Cashflow`):

```bash
npm install
npm run dev
npm run build
npm run preview
```

`npm run build` runs TypeScript compilation followed by the Vite production build. Always run it after changes. There is currently no automated test suite; use the local app for manual verification.

Use `apply_patch` for source edits. Keep the app’s visible language Dutch unless the user explicitly asks for another language.

## Source layout

- `src/main.tsx` — main React entry point and most page/component UI. It contains the overview, review page, transaction manager, rules page, categories page, and year comparison page.
- `src/types.ts` — `Transaction`, `Category`, and `Rule` types.
- `src/storage.ts` — typed IndexedDB persistence (`transactions`, `categories`, and `rules` stores).
- `src/categorize.ts` — automatic rule matching and category suggestions.
- `src/csv.ts` — Rabo CSV decoding/parsing, including Dutch amounts and encodings.
- `src/nnPdf.ts` — Nationale-Nederlanden PDF statement parsing.
- `src/data.ts` — default category definitions.
- `src/styles.css` and `src/extra.css` — global and feature-specific styling.

## Data and categorisation rules

Transactions retain their original imported fields as well as the current categorisation state. Important fields include `categoryId`, `suggestedCategoryId`, `suggestionSource`, `status`, `counterpartyIban`, `counterparty`, and `description`.

Categorisation precedence:

1. A manual categorisation (`suggestionSource === "handmatig"`) must never be overwritten by automatic matching.
2. Enabled user rules are applied next.
3. Built-in recognition can suggest a category.
4. Otherwise the transaction remains uncategorised/pending.

Automatic rules can match by name (`counterparty`), account (`counterpartyIban`), description, or legacy composite fields. Regex is opt-in per rule. All matching is currently case-insensitive, including regex matching; do not reintroduce a case-sensitivity setting without an explicit product decision.

Rules are edited as drafts on the rules page. The user must click **Opslaan en toepassen** before changes become active. Saving applies the active rules immediately to all non-manually categorised transactions and updates the pending count. Invalid regex patterns must block saving and show a Dutch error.

## Important UI behaviour

- The review page and transaction manager show at most 250 rows per page. Totals must be calculated over all matching transactions, not just the visible page.
- Review and transaction-manager search supports text and min/max amount filters. An empty minimum or maximum means unbounded; the two entered values are order-independent.
- Keyboard selection of rows is intentionally customised so Tab moves between row checkboxes, allowing `spatie / tab / spatie` multi-selection.
- Categories can be excluded from dashboard summaries and graphs via `excludeFromSummary` (for example private bank transfers).
- Deleting individual transactions is not supported. There is a clearly warned action for deleting all transactions and starting over.
- Categories can be removed only after a warning when rules or transactions refer to them.
- Long descriptions should only receive a hover title when the text is actually truncated.

## Overview chart

The overview monthly chart is a horizontally scrollable block/bar chart. Its monthly series must cover the complete `domainStart`–`domainEnd` range, including zero-value months. This is important: filtering by category must not shorten the scrollable timeline.

The chart supports:

- dragging left or right to select a range;
- auto-scroll while dragging near either edge;
- zoom/reset while keeping the full timeline scrollable;
- comparison bars for year -1, -2, and -3;
- hover month title plus monthly values and full-year totals;
- live Van/Tot dates that follow the visible/selected range.

There are two different date concepts in the overview:

- `start`/`end` are the user-visible selected dates and drive summaries.
- `domainStart`/`domainEnd` define the full chart timeline. Do not replace the domain with the selected category’s first/last transaction date.

When changing reset or scroll behaviour, verify both that the viewport shows the latest 12 months after reset and that the user can still scroll back to earlier years.

## Year comparison page

The year comparison page displays full calendar years per category using grouped monthly bars, optional comparison years, y-axis values, hover values, annual totals, monthly averages, and PNG export via `html2canvas`. Excluded categories must not be included in totals or charts.

## Import and privacy

Supported imports include:

- Rabo CSV exports, including Dutch decimal formatting and UTF-8/Windows-1252 data.
- Nationale-Nederlanden PDF account statements.

Keep imports local. Do not add network calls or upload financial data without an explicit user request and a separate backend design.

## Verification checklist

After a meaningful change:

1. Run `npm run build`.
2. Manually verify the affected page with realistic data from the included Rabo CSV/PDF fixtures when relevant.
3. Check that manual categories are preserved.
4. Check totals against all filtered rows, not only the current page.
5. Check both empty and large datasets, especially chart scrolling and pagination.
6. Check Dutch labels and accessible form controls.

Avoid changing unrelated user data in IndexedDB while testing. If test data must be cleared, use the app’s explicit red warning flow and make the scope clear.
