import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import type { Transaction } from './types'

type PdfTextItem = { str: string; transform: number[] }
type PdfLine = { text: string; items: PdfTextItem[] }

const amountPattern = /^[−-]?\d[\d.]*,\d{2}$/
const datePattern = /^\d{2}-\d{2}-\d{4}$/
const labelPattern = /^(Betaalmethode|Via|IBAN|Kenmerk|Valutadatum):/

GlobalWorkerOptions.workerSrc = workerUrl

const parseAmount = (value: string) => Number(value.replace('−', '-').replace('.', '').replace(',', '.'))
const parseDate = (value: string) => { const [day, month, year] = value.split('-'); return `${year}-${month}-${day}` }

function linesFromItems(items: PdfTextItem[]): PdfLine[] {
  const groups: PdfTextItem[][] = []
  for (const item of items.filter(item => item.str.trim())) {
    const y = item.transform[5]
    const group = groups.find(candidate => Math.abs(candidate[0].transform[5] - y) < 2)
    if (group) group.push(item); else groups.push([item])
  }
  return groups.sort((a, b) => b[0].transform[5] - a[0].transform[5]).map(group => {
    const sorted = group.sort((a, b) => a.transform[4] - b.transform[4])
    return { text: sorted.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim(), items: sorted }
  })
}

export async function parseNnPdf(bytes: ArrayBuffer): Promise<Transaction[]> {
  const document = await getDocument({ data: new Uint8Array(bytes) }).promise
  const result: Transaction[] = []
  let current: { date: string; counterparty: string; type: string; amount: number; description: string; iban: string } | null = null
  let descriptionParts: string[] = []
  let inDescription = false
  const finish = () => {
    if (!current) return
    const description = descriptionParts.join(' ').replace(/^Omschrijving:\s*/i, '').trim() || current.counterparty
    const raw = { bron: 'Nationale-Nederlanden PDF', type: current.type }
    result.push({ id: ['nn-pdf', current.date, current.amount, current.counterparty, current.iban, description].join('|'), date: current.date, bookingDate: current.date, amount: current.amount, balance: null, currency: 'EUR', counterpartyIban: current.iban, counterparty: current.counterparty, description, code: current.type, raw, categoryId: null, suggestedCategoryId: null, suggestionSource: 'onbekend', status: 'pending', direction: current.amount >= 0 ? 'income' : 'expense' })
    current = null
    descriptionParts = []
    inDescription = false
  }
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    for (const line of linesFromItems(content.items as PdfTextItem[])) {
      const dateItem = line.items.find(item => item.transform[4] < 125 && datePattern.test(item.str.trim()))
      const amountItem = line.items.find(item => item.transform[4] > 470 && amountPattern.test(item.str.trim()))
      if (dateItem && amountItem) {
        finish()
        const detailItems = line.items.filter(item => item.transform[4] >= 125 && item.transform[4] < 390)
        const typeItems = line.items.filter(item => item.transform[4] >= 390 && item.transform[4] < 480)
        current = { date: parseDate(dateItem.str.trim()), counterparty: detailItems.map(item => item.str).join(' ').trim(), type: typeItems.map(item => item.str).join(' ').trim(), amount: parseAmount(amountItem.str.trim()), description: '', iban: '' }
        continue
      }
      if (!current) continue
      const text = line.text
      if (/^Omschrijving:/i.test(text)) { descriptionParts = [text]; inDescription = true; continue }
      if (/^IBAN:/i.test(text)) { current.iban = text.replace(/^IBAN:\s*/i, '').replace(/\s+/g, ''); inDescription = false; continue }
      if (labelPattern.test(text)) { inDescription = false; continue }
      if (inDescription && line.items.some(item => item.transform[4] >= 125)) descriptionParts.push(text)
    }
  }
  finish()
  return result
}
