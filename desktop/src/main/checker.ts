/** Fixed checker: verifies extracted rows before anything is loaded. */

import { money, type NormalizedRow } from './rows'

const MAX_LISTED = 5

// Accounts that should net to zero in healthy books.
export const SUSPECT_ACCOUNT = /suspense|clearing|uncategori[sz]ed|unknown|imbalance|orphan|ask my accountant/i

export interface CheckResult {
  passed: boolean
  differences: string[]
}

export function check(rows: NormalizedRow[]): CheckResult {
  const differences: string[] = []

  if (rows.length === 0) differences.push('no rows were extracted')

  let debits = 0
  let credits = 0
  for (const r of rows) {
    if (r.side === 'debit') debits += r.cents
    else credits += r.cents
  }
  if (debits !== credits) {
    differences.push(
      `debits ${money(debits, true)} != credits ${money(credits, true)} (off by ${money(Math.abs(debits - credits), true)})`,
    )
  }

  // Loads are diffed row by row on source, so it must identify exactly one row.
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1)
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([s]) => s)
  if (duplicates.length) {
    const listed = duplicates.slice(0, MAX_LISTED).join(', ')
    const more = duplicates.length > MAX_LISTED ? ` and ${duplicates.length - MAX_LISTED} more` : ''
    differences.push(`${duplicates.length} source IDs are used by more than one row: ${listed}${more}`)
  }

  const balances = new Map<string, number>()
  for (const r of rows) balances.set(r.account, (balances.get(r.account) ?? 0) + (r.side === 'debit' ? r.cents : -r.cents))
  for (const [account, balance] of [...balances].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (balance !== 0 && SUSPECT_ACCOUNT.test(account)) {
      differences.push(`unexpected nonzero account ${account}: ${money(balance, true)}`)
    }
  }

  return { passed: differences.length === 0, differences }
}
