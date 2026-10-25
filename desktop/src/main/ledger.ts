/**
 * SQLite ledgers of rows that passed the checker, plus a history of every change.
 *
 * Each source (app + data path) gets its own ledger file in ledgers/. Each load is
 * diffed against what's already there, keyed on source: rows are added, changed or
 * deleted, and each change is recorded in ledger_changes. Amounts are stored as
 * 2-place decimal strings, the same files the Python runner wrote.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { dirs } from './paths'
import { money, toCents, type NormalizedRow, type Side } from './rows'

export const FIELDS = ['date', 'account', 'amount', 'side', 'memo'] as const

const SCHEMA = `
create table if not exists ledger (
    app text not null,
    source text not null,
    date text not null,
    account text not null,
    amount text not null,
    side text not null check (side in ('debit', 'credit')),
    memo text not null,
    run_id text not null,
    primary key (app, source)
);
create table if not exists ledger_changes (
    id integer primary key,
    app text not null,
    run_id text not null,
    change text not null check (change in ('added', 'changed', 'deleted')),
    source text not null,
    before text,
    after text,
    at real not null
);
create table if not exists ledger_source (
    id integer primary key check (id = 1),
    app text not null,
    data_path text not null
);
create table if not exists runs (
    run_id text primary key,
    status text not null,
    started real not null,
    finished real not null,
    used_cache integer not null,
    rows_loaded integer,
    gap text not null
);
`

export type Fields = { date: string; account: string; amount: string; side: Side; memo: string }
export type ChangeKind = 'added' | 'changed' | 'deleted'

export interface Change {
  change: ChangeKind
  source: string
  before: Fields | null
  after: Fields | null
}

export interface LedgerRow extends Fields {
  app: string
  source: string
  run_id: string
}

export interface RecordedRun {
  run_id: string
  status: string
  started: number
  finished: number
  used_cache: boolean
  rows_loaded: number | null
  gap: string[]
}

/** Seconds, like the Python runner's time.time(); overridable in tests. */
export const clock = { now: () => Date.now() / 1000 }

export function slug(app: string): string {
  return app.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
}

export function expand(path: string): string {
  return resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
}

/** Stable ID for one source: the app plus the resolved data path. */
export function ledgerId(app: string, dataPath: string): string {
  const hash = createHash('sha1').update(expand(dataPath)).digest('hex').slice(0, 8)
  return `${slug(app)}-${hash}`
}

export function pathFor(ledger: string): string {
  if (!/^[a-z0-9_-]+$/.test(ledger)) throw new RangeError(`bad ledger id: ${JSON.stringify(ledger)}`)
  return join(dirs.ledgers(), `${ledger}.db`)
}

export function connect(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  return db
}

function using<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = connect(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('begin')
  try {
    const result = fn()
    db.exec('commit')
    return result
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

/** Every ledger with its app, data path and row count, most recently loaded first. */
export function listLedgers(): { id: string; app: string; data_path: string; rows: number }[] {
  const dir = dirs.ledgers()
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const found = []
  for (const db of files) {
    const info = using(db, (conn) => ({
      source: conn.prepare('select app, data_path from ledger_source').get() as { app: string; data_path: string } | undefined,
      count: (conn.prepare('select count(*) n from ledger').get() as { n: number }).n,
    }))
    if (!info.source) continue // created by a diff but never loaded
    found.push({ id: db.split('/').pop()!.replace(/\.db$/, ''), app: info.source.app, data_path: info.source.data_path, rows: info.count })
  }
  return found
}

function fields(row: NormalizedRow): Fields {
  return { date: row.date, account: row.account, amount: money(row.cents), side: row.side, memo: row.memo }
}

function same(a: Fields, b: Fields): boolean {
  return FIELDS.every((f) => a[f] === b[f])
}

/** What loading these rows would change for this app. */
export function diff(app: string, rows: NormalizedRow[], dbPath: string): Change[] {
  const current = new Map<string, Fields>()
  using(dbPath, (db) => {
    for (const r of db.prepare('select * from ledger where app = ?').all(app) as unknown as LedgerRow[]) {
      current.set(r.source, { date: r.date, account: r.account, amount: r.amount, side: r.side, memo: r.memo })
    }
  })
  const incoming = new Map(rows.map((r) => [r.source, fields(r)]))
  const changes: Change[] = []
  for (const [source, after] of incoming) if (!current.has(source)) changes.push({ change: 'added', source, before: null, after })
  for (const [source, after] of incoming) {
    const before = current.get(source)
    if (before && !same(before, after)) changes.push({ change: 'changed', source, before, after })
  }
  for (const [source, before] of current) if (!incoming.has(source)) changes.push({ change: 'deleted', source, before, after: null })
  const order: Record<ChangeKind, number> = { changed: 0, deleted: 1, added: 2 }
  const key = (c: Change) => [order[c.change], (c.after ?? c.before)!.date, c.source] as const
  return changes.sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return 0
  })
}

/** Apply a diff atomically and record it in the change history. */
export function apply(app: string, runId: string, changes: Change[], dbPath: string, dataPath = ''): void {
  const now = clock.now()
  using(dbPath, (db) =>
    transaction(db, () => {
      db.prepare('insert or replace into ledger_source (id, app, data_path) values (1, ?, ?)').run(app, dataPath)
      const del = db.prepare('delete from ledger where app = ? and source = ?')
      const put = db.prepare(
        'insert or replace into ledger (app, source, date, account, amount, side, memo, run_id) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      const log = db.prepare(
        'insert into ledger_changes (app, run_id, change, source, before, after, at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      for (const c of changes) {
        if (c.change === 'deleted') del.run(app, c.source)
        else put.run(app, c.source, ...FIELDS.map((f) => c.after![f]), runId)
      }
      for (const c of changes) {
        log.run(app, runId, c.change, c.source, c.before && JSON.stringify(c.before), c.after && JSON.stringify(c.after), now)
      }
    }),
  )
}

/** SQL matching an account and every account below it ("Expenses" -> "Expenses:Rent"). */
function under(account: string): [string, SQLInputValue[]] {
  return ["(account = ? or substr(account, 1, length(?) + 1) = ? || ':')", [account, account, account]]
}

export interface RowQuery {
  account?: string
  date_from?: string
  date_to?: string
  search?: string
  side?: Side
  min_amount?: number // cents
  max_amount?: number
  run_id?: string
  limit?: number // -1 for all
  offset?: number
}

/** Rows matching every filter given, oldest first, plus how many match in total. */
export function queryRows(dbPath: string, q: RowQuery = {}): [LedgerRow[], number] {
  if (!existsSync(dbPath)) return [[], 0]
  const where: string[] = []
  const params: SQLInputValue[] = []
  if (q.account) {
    const [clause, args] = under(q.account)
    where.push(clause)
    params.push(...args)
  }
  if (q.date_from) where.push('date >= ?'), params.push(q.date_from)
  if (q.date_to) where.push('date <= ?'), params.push(q.date_to)
  if (q.search) {
    // instr instead of LIKE so % and _ in the search text are taken literally
    where.push('(instr(lower(memo), lower(?)) or instr(lower(account), lower(?)) or instr(lower(source), lower(?)))')
    params.push(q.search, q.search, q.search)
  }
  if (q.side) where.push('side = ?'), params.push(q.side)
  if (q.min_amount !== undefined) where.push('cast(round(cast(amount as real) * 100) as integer) >= ?'), params.push(q.min_amount)
  if (q.max_amount !== undefined) where.push('cast(round(cast(amount as real) * 100) as integer) <= ?'), params.push(q.max_amount)
  if (q.run_id) where.push('run_id = ?'), params.push(q.run_id)
  const clause = where.length ? ` where ${where.join(' and ')}` : ''
  return using(dbPath, (db) => {
    const total = (db.prepare(`select count(*) n from ledger${clause}`).get(...params) as { n: number }).n
    const rows = db
      .prepare(`select app, date, account, amount, side, memo, source, run_id from ledger${clause} order by date, app, source limit ? offset ?`)
      .all(...params, q.limit ?? 1000, q.offset ?? 0) as unknown as LedgerRow[]
    return [rows.map((r) => ({ ...r })), total]
  })
}

export interface Balance {
  account: string
  debits: string
  credits: string
  balance: string
  rows: number
}

/** Debit and credit totals per account, and the balance (debits minus credits). */
export function balances(dbPath: string, opts: { account?: string; as_of?: string } = {}): Balance[] {
  if (!existsSync(dbPath)) return []
  const where: string[] = []
  const params: SQLInputValue[] = []
  if (opts.account) {
    const [clause, args] = under(opts.account)
    where.push(clause)
    params.push(...args)
  }
  if (opts.as_of) where.push('date <= ?'), params.push(opts.as_of)
  const clause = where.length ? ` where ${where.join(' and ')}` : ''
  const totals = new Map<string, { debits: number; credits: number; rows: number }>()
  using(dbPath, (db) => {
    for (const r of db.prepare(`select account, amount, side from ledger${clause}`).all(...params) as { account: string; amount: string; side: Side }[]) {
      const t = totals.get(r.account) ?? { debits: 0, credits: 0, rows: 0 }
      if (r.side === 'debit') t.debits += toCents(r.amount)
      else t.credits += toCents(r.amount)
      t.rows++
      totals.set(r.account, t)
    }
  })
  // Summed in integer cents and returned as strings so cents stay exact
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account, t]) => ({ account, debits: money(t.debits), credits: money(t.credits), balance: money(t.debits - t.credits), rows: t.rows }))
}

/** The change history, newest first. since: only changes recorded after this Unix time. */
export function changes(
  dbPath: string,
  opts: { run_id?: string; change?: ChangeKind; since?: number; limit?: number } = {},
): { run_id: string; change: ChangeKind; source: string; before: Fields | null; after: Fields | null; at: number }[] {
  if (!existsSync(dbPath)) return []
  const where: string[] = []
  const params: SQLInputValue[] = []
  if (opts.since !== undefined) where.push('at > ?'), params.push(opts.since)
  if (opts.run_id) where.push('run_id = ?'), params.push(opts.run_id)
  if (opts.change) where.push('change = ?'), params.push(opts.change)
  const clause = where.length ? ` where ${where.join(' and ')}` : ''
  return using(dbPath, (db) =>
    (
      db
        .prepare(`select run_id, change, source, before, after, at from ledger_changes${clause} order by at desc, id desc limit ?`)
        .all(...params, opts.limit ?? 1000) as { run_id: string; change: ChangeKind; source: string; before: string | null; after: string | null; at: number }[]
    ).map((r) => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null })),
  )
}

/** Keep the outcome of every run on this source, including ones that loaded nothing. */
export function recordRun(dbPath: string, app: string, dataPath: string, run: RecordedRun): void {
  using(dbPath, (db) => {
    // A source whose first run needs a human still gets listed, with 0 rows.
    db.prepare('insert or ignore into ledger_source (id, app, data_path) values (1, ?, ?)').run(app, dataPath)
    db.prepare(
      'insert or replace into runs (run_id, status, started, finished, used_cache, rows_loaded, gap) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(run.run_id, run.status, run.started, run.finished, run.used_cache ? 1 : 0, run.rows_loaded, JSON.stringify(run.gap))
  })
}

/** Recorded runs, newest first, optionally only those with one of the given statuses. */
export function runs(dbPath: string, opts: { status?: string[]; limit?: number } = {}): RecordedRun[] {
  if (!existsSync(dbPath)) return []
  const status = opts.status ?? []
  const clause = status.length ? ` where status in (${status.map(() => '?').join(', ')})` : ''
  return using(dbPath, (db) =>
    (db.prepare(`select * from runs${clause} order by finished desc limit ?`).all(...status, opts.limit ?? 100) as Record<string, never>[]).map(
      (r) => ({ ...(r as unknown as RecordedRun), used_cache: Boolean(r.used_cache), gap: JSON.parse(r.gap) }),
    ),
  )
}

export function reset(): void {
  rmSync(dirs.ledgers(), { recursive: true, force: true })
}
