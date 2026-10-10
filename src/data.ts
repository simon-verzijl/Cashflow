import type { Category } from './types'

export const defaultCategories: Category[] = [
  ['Boodschappen', '#2f806f'], ['Auto', '#df8d3e'], ['Wonen', '#7a6db5'],
  ['Nutsvoorzieningen', '#d85c5c'], ['Verzekeringen', '#4e78aa'], ['Gezondheid', '#c65ca2'],
  ['Abonnementen', '#4d9aa0'], ['Vervoer', '#806c54'], ['Vrije tijd', '#e2b04c'],
  ['Kleding', '#b76d52'], ['Persoonlijk', '#5d879c'], ['Inkomsten', '#32825f'], ['Overig', '#89918c']
].map(([name, color], index) => ({ id: `cat-${index + 1}`, name, color, system: true }))
