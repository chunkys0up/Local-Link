/**
 * Read-side helpers for the HTTP API, on top of ledger.ts's queryRows, balances and changes:
 * provenance, flagged runs, monthly rollups and read-only SQL.
 */

import { existsSync } from 'node:fs'
import { DatabaseSync, constants } from 'node:sqlite'

import { SUSPECT_ACCOUNT } from './checker'
import * as ledger from './ledger'
import { money, toCents } from './rows'

export const MAX_SQL_ROWS = 1000
const FLAGGED = ['needs_human', 'error']

export class NotFound extends Error {}

/** The ledger's file, or NotFound. A malformed id throws RangeError. */
export function existing(ledgerId: string): string {
  const db = ledger.pathFor(ledgerId)
  if (!existsSync(db)) throw new NotFound(`no ledger ${JSON.stringify(ledgerId)}`)
  return db
}

/**
 * Where rows came from: the source file, the runs that loaded them, the latest run.
 *
 * Every row in a ledger passed the checker when it was loaded; runs that failed it
 * loaded nothing and show up under flags instead.
 */
export function provenance(db: string, runIds: Set<string>) {
  const source = (() => {
    const conn = ledger.connect(db)
    try {
      return conn.prepare('select app, data_path from ledger_source').get() as { app: string; data_path: string } | undefined
    } finally {
      conn.close()
    }
  })()
  const recorded = new Map(ledger.runs(db, { limit: 1000 }).map((r) => [r.run_id, r]))
  return {
    app: source?.app ?? '',
    data_path: source?.data_path ?? '',
    checker_passed: true,
    latest_run: recorded.values().next().value ?? null,
    runs: Object.fromEntries([...runIds].sort().map((id) => [id, recorded.get(id) ?? null])),
  }
}

/**
 * What needs a human: runs that stopped at needs_human or error (with the checker's
 * reasons), and suspense-type accounts that don't net to zero.
 */
export function flags(db: string) {
  const suspect = ledger.balances(db).filter((b) => SUSPECT_ACCOUNT.test(b.account) && toCents(b.balance.replace('-', '')) !== 0)
  return { runs: ledger.runs(db, { status: FLAGGED }), suspect_accounts: suspect }
}

/**
 * Debits, credits and net per month per account (or per payee, i.e. memo).
 *
 * depth cuts account paths to that many levels below the top (0 = "Expenses").
 */
export function monthly(
  db: string,
  opts: { by?: 'account' | 'payee'; account?: string; depth?: number; date_from?: string; date_to?: string } = {},
) {
  const by = opts.by ?? 'account'
  const [rows] = ledger.queryRows(db, { account: opts.account, date_from: opts.date_from, date_to: opts.date_to, limit: -1 })
  const groups = new Map<string, { month: string; key: string; debits: number; credits: number; rows: number }>()
  for (const r of rows) {
    const key =
      by === 'payee'
        ? r.memo.trim() || '(no memo)'
        : opts.depth === undefined
          ? r.account
          : r.account.split(':').slice(0, opts.depth + 1).join(':')
    const month = r.date.slice(0, 7)
    const id = JSON.stringify([month, key])
    const g = groups.get(id) ?? { month, key, debits: 0, credits: 0, rows: 0 }
    if (r.side === 'debit') g.debits += toCents(r.amount)
    else g.credits += toCents(r.amount)
    g.rows++
    groups.set(id, g)
  }
  return [...groups.values()]
    .sort((a, b) => (a.month !== b.month ? (a.month < b.month ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((g) => ({
      month: g.month,
      [by]: g.key,
      debits: money(g.debits),
      credits: money(g.credits),
      net: money(g.debits - g.credits),
      rows: g.rows,
    }))
}

/** When a run finished, to list the changes made after it. */
export function sinceRun(db: string, runId: string): number {
  const recorded = ledger.runs(db, { limit: 1000 }).find((r) => r.run_id === runId)
  if (recorded) return recorded.finished
  const conn = ledger.connect(db) // runs loaded before run history was kept
  try {
    const at = (conn.prepare('select max(at) at from ledger_changes where run_id = ?').get(runId) as { at: number | null }).at
    if (at === null) throw new NotFound(`no run ${JSON.stringify(runId)} in this ledger`)
    return at
  } finally {
    conn.close()
  }
}

const READ_ACTIONS = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE])

/**
 * One SELECT (or WITH ... SELECT) against a ledger, opened read-only. Anything else
 * is refused: by the statement check, the read-only connection, and an authorizer.
 */
export function runSql(db: string, query: string, limit = 500) {
  const text = query.trim().replace(/;+\s*$/, '').trim()
  if (!/^(select|with)\b/is.test(text)) throw new RangeError('only SELECT queries are allowed')
  if (text.includes(';')) throw new RangeError('only one statement is allowed')
  const max = Math.max(0, Math.min(limit, MAX_SQL_ROWS))
  const conn = new DatabaseSync(db, { readOnly: true })
  try {
    conn.exec('pragma query_only = on')
    conn.setAuthorizer((action) => (READ_ACTIONS.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY))
    let statement
    try {
      statement = conn.prepare(text)
    } catch (e) {
      throw new RangeError(`query failed: ${(e as Error).message}`)
    }
    const columns = statement.columns().map((c) => c.name)
    const rows: unknown[][] = []
    statement.setReturnArrays(true)
    for (const row of statement.iterate()) {
      if (rows.length > max) break
      rows.push(row as unknown as unknown[])
    }
    return { columns, rows: rows.slice(0, max), truncated: rows.length > max }
  } finally {
    conn.close()
  }
}
