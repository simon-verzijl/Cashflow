#!/bin/zsh

set -e

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is niet gevonden. Installeer eerst Node.js."
  read -r "REPLY?Druk op Enter om dit venster te sluiten..."
  exit 1
fi

echo "Cashflow wordt gestart..."
echo "Open daarna http://localhost:5173 in je browser."
echo
npm run dev

