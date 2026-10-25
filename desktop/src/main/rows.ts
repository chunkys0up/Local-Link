/** The one row shape every extractor must produce, with money kept as integer cents. */

import { z } from 'zod'

export type Side = 'debit' | 'credit'

export interface NormalizedRow {
  date: string // YYYY-MM-DD
  account: string
  cents: number // >= 0
  side: Side
  memo: string
  source: string
  run_id: string
}

const AMOUNT = /^\d+(\.\d{1,2})?$/

/** "47.18" (or 47.18) -> 4718. Throws on negatives or more than 2 decimal places. */
export function toCents(value: string | number): number {
  const text = typeof value === 'number' ? String(value) : value.trim()
  if (!AMOUNT.test(text)) throw new Error(`amount must be a positive decimal with at most 2 places, got ${JSON.stringify(value)}`)
  const [whole, frac = ''] = text.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}

/** 4718 -> "47.18", -5000 -> "-50.00" */
export function money(cents: number, grouped = false): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const text = grouped ? whole.toLocaleString('en-US') : String(whole)
  return `${sign}${text}.${String(abs % 100).padStart(2, '0')}`
}

function isRealDate(text: string): boolean {
  const d = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text
}

const RowSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').refine(isRealDate, 'not a real date'),
    account: z.string().min(1),
    amount: z.union([z.string(), z.number()]),
    side: z.enum(['debit', 'credit']),
    memo: z.string().default(''),
    source: z.string().min(1),
  })
  .strict()

/** Validate one extractor row; throws with the row's index and what's wrong. */
export function parseRow(raw: unknown, runId: string, index: number): NormalizedRow {
  const parsed = RowSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`row ${index}: ${issue.path.join('.') || 'row'}: ${issue.message}`)
  }
  const r = parsed.data
  let cents: number
  try {
    cents = toCents(r.amount)
  } catch (e) {
    throw new Error(`row ${index}: ${(e as Error).message}`)
  }
  return { date: r.date, account: r.account, cents, side: r.side, memo: r.memo, source: r.source, run_id: runId }
}
