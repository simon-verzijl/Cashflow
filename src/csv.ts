import type { Transaction } from './types'

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted }
    else if (c === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const clean = (s = '') => s.replace(/^\uFEFF/, '').trim()
const money = (s: string) => Number(clean(s).replace('+', '').replace('.', '').replace(',', '.')) || 0

export function decodeBankCsv(bytes: ArrayBuffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('windows-1252').decode(bytes) }
}

export function parseRaboCsv(text: string): Transaction[] {
  const rows = parseCsv(text); const headers = rows.shift()?.map(clean) ?? []
  return rows.map((values, index) => {
    const raw = Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
    const description = [raw['Omschrijving-1'], raw['Omschrijving-2'], raw['Omschrijving-3']].filter(Boolean).join(' ').trim()
    const amount = money(raw.Bedrag)
    const id = [raw.Volgnr, raw.Datum, raw.Bedrag, raw['Tegenrekening IBAN/BBAN'], raw['Naam tegenpartij'], description].join('|')
    return { id: id || `row-${index}`, date: raw.Datum, bookingDate: raw.Rentedatum || raw.Datum, amount, balance: raw['Saldo na trn'] ? money(raw['Saldo na trn']) : null, currency: raw.Munt || 'EUR', counterpartyIban: raw['Tegenrekening IBAN/BBAN'] || '', counterparty: raw['Naam tegenpartij'] || raw['Naam uiteindelijke partij'] || '', description, code: raw.Code || '', raw, categoryId: null, suggestedCategoryId: null, suggestionSource: 'onbekend', status: 'pending', direction: amount >= 0 ? 'income' : 'expense' }
  })
}
