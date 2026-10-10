# Project context and handoff notes

This file is a practical handoff summary for colleagues or AI agents continuing the Cashflow NL project. Read it together with `AGENTS.md` before making changes.

## Product

Cashflow NL is a Dutch, local-first browser app for importing bank transactions, reviewing categories, managing automatic categorisation rules, and analysing spending. Data is stored locally in IndexedDB; there is currently no server, login, sync, or upload of financial data.

The UI is intentionally Dutch. Keep new visible labels Dutch unless the user asks otherwise.

## Main pages

- **Overzicht**: monthly spending chart, date/category filters, category totals, uncategorised totals, and transaction detail views.
- **Te beoordelen**: pending transactions with search, amount filters, sorting, selection, pagination, confirmation, and rule creation.
- **Achteraf aanpassen**: bulk category changes with text/category/type/amount filtering, sorting, pagination, and an overall total.
- **Automatische regels**: draft-based rule editing, manual rule creation, enable/disable controls, regex validation, absolute min/max amount matching, rule application, and expandable matching-transaction previews.
- **Categorieën**: category management, exclusion from summaries/graphs, save/apply feedback, and a red danger zone for deleting all transactions.
- **Jaarvergelijking**: annual trend line charts per category plus monthly trend line charts for the selected year, an optional comparison year, clickable month/year points, monthly-average lines, transaction details, hover values, y-axis scales, drag reordering, and PNG export.
- **Export/Import**: Rabo CSV and Nationale-Nederlanden PDF import, plus JSON backup/restore. Restore asks for confirmation before overwriting local data. Duplicate transactions are skipped during import.

## Important current behaviour

- Pagination uses `MAX_VISIBLE_RESULTS = 250`. Long lists have previous/next controls above and below where applicable.
- Totals are calculated over all matching transactions, not just the current page.
- Individual transaction deletion is intentionally unavailable. Deleting all transactions requires an explicit red warning flow.
- Manual categorisation has priority over automatic rules.
- Automatic rule changes are drafts until **Opslaan en toepassen** is pressed. Saving immediately applies active rules to eligible existing transactions.
- Rule matching supports name, account number, description, optional regex, and optional absolute min/max amount. Matching is case-insensitive.
- Invalid regex patterns must be rejected before saving.
- Long descriptions use a hover title only when the visible text is actually truncated.

## Chart architecture and caution

The overview chart is in `Overview` inside `src/main.tsx`. It uses a full monthly `domainStart`–`domainEnd` series with zero-value months, horizontal scrolling, drag selection, auto-scroll while dragging, and year comparison bars.

There are separate concepts:

- `start` / `end`: visible Van/Tot dates and the range used for summaries.
- `domainStart` / `domainEnd`: the complete timeline available to the chart.
- `fitFullRange`: whether the chart is fitted to the full domain or remains horizontally scrollable.
- `zoom`, `selectedRange`, and the chart scroll position: viewport/selection state.

Do not make category filtering redefine the chart domain; users must still be able to scroll to all years. Also be careful when changing reset behaviour: the intended existing behaviour is that reset returns the viewport to the latest 12 months while keeping earlier years available by scrolling. Keep the popup tooltip rendered after the bars so later bars cannot paint over it; its background is intentionally semi-transparent.

## Data and source map

- `src/main.tsx`: app state, page components, overview chart, import/export UI, pagination, and most interaction logic.
- `src/types.ts`: `Transaction`, `Category`, and `Rule` types.
- `src/storage.ts`: typed IndexedDB persistence and full replacement for restore.
- `src/categorize.ts`: built-in suggestions and automatic-rule matching.
- `src/csv.ts`: Rabo CSV decoding/parsing.
- `src/nnPdf.ts`: Nationale-Nederlanden PDF parsing.
- `src/data.ts`: default categories.
- `src/styles.css`, `src/extra.css`: styling.
- `run.command`: executable macOS helper to start the Vite dev server by double-clicking.

## Local commands

```bash
npm install
npm run dev
npm run build
npm run preview
```

Always run `npm run build` after source changes. There is no automated test suite; manually verify affected screens with the included `RABO-export-2018-2026-NL26RABO0369978927.csv` and `NN export - Rekeningafschrift NN.pdf` when relevant.

## Known handoff risks

- `src/main.tsx` is large and contains several closely related pagination/date states; inspect surrounding state and effects before editing.
- The overview chart intentionally has separate domain and viewport logic. Small changes to `start`, `end`, `domainStart`, `domainEnd`, or `fitFullRange` can affect scrolling, reset, category filters, and summary totals simultaneously.
- IndexedDB data persists across refreshes. Avoid destructive test actions unless explicitly requested and clearly confirmed.
- Production build warns that the generated JavaScript/PDF worker chunks exceed 500 kB; this is currently a warning, not a build failure.

## Desktop packaging (macOS)

The project can also be packaged as a standalone Electron macOS app. This is a thin local wrapper around the same Vite production build; it does not add a server or upload data.

- `electron/main.cjs` creates the native window and loads `dist/index.html`.
- `build/icon.svg` is the editable source artwork for the Cashflow app icon.
- `build/icon.icns` is the generated macOS icon used by electron-builder.
- `vite.config.ts` must keep `base: './'`. Electron loads the app through `file://`; absolute `/assets/...` paths result in a blank window.
- `package.json` contains:
  - `npm run app`: build and launch the Electron app locally.
  - `npm run app:mac`: build an Apple Silicon DMG and ZIP in `dist/`.
- Current packaged artifacts are arm64-only (`Cashflow-1.0.0-arm64.dmg` and `Cashflow-1.0.0-arm64-mac.zip`). Add an x64/universal target if Intel Mac support is needed.
- The app is currently unsigned/not notarized. macOS may require ctrl-click → **Open** the first time.
- Electron app data is stored in the app's local IndexedDB profile, separate from the browser's profile. The DMG/ZIP contains application code/assets only, not financial data.
- There is no automatic updater yet. Updating currently means installing a newly generated DMG over the existing app. Removing/replacing the `.app` does not intentionally clear Electron's user-data directory.
- The header currently shows `Cashflow v1.0`.

When changing packaging, verify both `npm run build` and `npm run app:mac`, and test the actual packaged executable under `dist/mac-arm64/Cashflow.app` before handing over a DMG.
