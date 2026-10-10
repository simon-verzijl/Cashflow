# Cashflow

Cashflow is a local-first personal finance app for importing bank transactions, assigning categories, and exploring spending and income over time. The interface is in Dutch.

## Features

- Import Rabobank CSV exports and Nationale-Nederlanden PDF statements.
- Review transactions and assign categories manually or with reusable automatic rules.
- Search, filter, sort, and bulk-update transactions.
- Explore totals and trends by date and category, with clickable charts and PNG export.
- Export and restore a JSON backup of the app's data.
- Use the app in a browser or as a standalone macOS app.

## Run locally

Requirements: Node.js and npm.

```bash
npm install
npm run dev
```

Vite prints the local address in the terminal (typically `http://localhost:5173`). To create and serve a production build:

```bash
npm run build
npm run preview
```

## macOS app

Run the Electron app locally:

```bash
npm run app
```

Build a macOS DMG and ZIP package:

```bash
npm run app:mac
```

Packages are written to `dist/`. The current build target is Apple Silicon (`arm64`). The app is not signed or notarized, so macOS may require you to open it via Control-click → **Open** the first time.

## Your data and privacy

Transactions, categories, rules, and preferences are stored locally in the browser's IndexedDB and local storage. There is no Cashflow account, application server, cloud sync, or upload of financial data.

The browser version and macOS app have separate local storage profiles; data does not move between them automatically. The macOS DMG/ZIP contains the application, not your financial data. Use **Export/Import** in Cashflow to create a JSON backup or restore data.

## Development

```bash
npm run build
```

The build runs TypeScript compilation and the Vite production build. There is currently no automated test suite. See [`AGENTS.md`](AGENTS.md) for development conventions and [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for a detailed implementation handoff.

## Technology

- React and TypeScript
- Vite
- IndexedDB for local persistence
- Electron for the macOS desktop wrapper
- `html2canvas` for chart export

