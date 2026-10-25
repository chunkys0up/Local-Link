// Writes small XML property lists for tests.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function value(v: unknown): string {
  if (typeof v === 'string') return `<string>${esc(v)}</string>`
  if (typeof v === 'number') return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>'
  if (Array.isArray(v)) return `<array>${v.map(value).join('')}</array>`
  return `<dict>${Object.entries(v as object).map(([k, x]) => `<key>${esc(k)}</key>${value(x)}`).join('')}</dict>`
}

export function writePlist(path: string, data: object): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${value(data)}</plist>\n`)
}
