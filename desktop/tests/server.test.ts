import { beforeAll, expect, test } from 'vitest'

import * as ledger from '../src/main/ledger'
import * as query from '../src/main/query'
import { toCents, type NormalizedRow, type Side } from '../src/main/rows'
import { handle } from '../src/main/server'

const LEDGER = 'gnucash-test'

const row = (source: string, date: string, account: string, amount: string, side: Side, memo = '', run_id = 'run_1'): NormalizedRow => ({
  source, date, account, cents: toCents(amount), side, memo, run_id,
})

function load(db: string, runId: string, rows: NormalizedRow[], at: number) {
  ledger.apply('gnucash', runId, ledger.diff('gnucash', rows, db), db, '/books.gnucash')
  ledger.recordRun(db, 'gnucash', '/books.gnucash', { run_id: runId, status: 'passed', started: at - 1, finished: at, used_cache: false, rows_loaded: rows.length, gap: [] })
}

const FIRST = [
  row('t1/a', '2026-04-01', 'Assets:Checking', '40000.00', 'debit', 'Opening balance'),
  row('t1/b', '2026-04-01', 'Equity:Opening Balances', '40000.00', 'credit', 'Opening balance'),
  row('t2/a', '2026-05-03', 'Expenses:Office:Supplies', '47.18', 'debit', 'STAPLES #0412'),
  row('t2/b', '2026-05-03', 'Assets:Checking', '47.18', 'credit', 'STAPLES #0412'),
  row('t3/a', '2026-05-20', 'Expenses:Office:Rent', '900.00', 'debit', 'Rent'),
  row('t3/b', '2026-05-20', 'Assets:Checking', '900.00', 'credit', 'Rent'),
  row('t4/a', '2026-06-10', 'Assets:Checking', '1200.00', 'debit', 'Invoice 17'),
  row('t4/b', '2026-06-10', 'Income:Sales', '1200.00', 'credit', 'Invoice 17'),
]

const get = async (url: string) => {
  const u = new URL(url, 'http://x')
  const [status, body] = await handle('GET', u.pathname, u.searchParams, {})
  return { status, body: body as Record<string, any> }
}
const post = async (url: string, body: Record<string, unknown>) => {
  const u = new URL(url, 'http://x')
  const [status, out] = await handle('POST', u.pathname, u.searchParams, body)
  return { status, body: out as Record<string, any> }
}

beforeAll(() => {
  const db = ledger.pathFor(LEDGER)
  const now = ledger.clock.now
  ledger.clock.now = () => 1000
  load(db, 'run_1', FIRST, 1000)
  ledger.clock.now = () => 2000
  const second = FIRST.filter((r) => !r.source.startsWith('t3/')).map((r) => ({ ...r, run_id: 'run_2' }))
  second[2] = { ...second[2], cents: 4781 } // t2/a edited
  load(db, 'run_2', second, 2000)
  ledger.clock.now = now
})

test('rows with filters and provenance', async () => {
  const { body } = await get(`/ledger?ledger_id=${LEDGER}&account=Expenses&search=staples`)
  expect(body.total).toBe(1)
  expect(body.rows[0].amount).toBe('47.81')
  expect(body.provenance.data_path).toBe('/books.gnucash')
  expect(body.provenance.checker_passed).toBe(true)
  expect(body.provenance.latest_run.run_id).toBe('run_2')
  expect(Object.keys(body.provenance.runs)).toEqual(['run_2'])
  expect((await get('/ledger?ledger_id=nope-1')).status).toBe(404)
  expect((await get('/ledger?ledger_id=../x')).status).toBe(400)
  expect((await get(`/api/ledger?ledger_id=${LEDGER}&min=47.81&max=47.81`)).body.total).toBe(1)
  expect((await get(`/ledger?ledger_id=${LEDGER}&from=June`)).status).toBe(422)
})

test('changes since a run', async () => {
  const changes = (await get(`/ledgers/${LEDGER}/changes?since_run=run_1`)).body.changes
  expect(changes.map((c: any) => [c.change, c.source]).sort()).toEqual([['changed', 't2/a'], ['deleted', 't3/a'], ['deleted', 't3/b']])
  expect((await get(`/ledgers/${LEDGER}/changes?since=0`)).body.changes).toHaveLength(11)
  expect((await get(`/ledgers/${LEDGER}/changes?since_run=run_9`)).status).toBe(404)
})

test('flags list failed runs and suspect accounts', async () => {
  ledger.recordRun(ledger.pathFor(LEDGER), 'gnucash', '/books.gnucash', {
    run_id: 'run_3', status: 'needs_human', started: 2999, finished: 3000, used_cache: true, rows_loaded: null,
    gap: ['unexpected nonzero account Expenses:Unknown: 50.00'],
  })
  const flags = (await get(`/ledgers/${LEDGER}/flags`)).body
  expect(flags.runs.map((r: any) => r.run_id)).toEqual(['run_3'])
  expect(flags.runs[0].gap).toEqual(['unexpected nonzero account Expenses:Unknown: 50.00'])
  expect(flags.suspect_accounts).toEqual([])
  expect((await get(`/ledgers/${LEDGER}/runs`)).body.runs.map((r: any) => r.status)).toEqual(['needs_human', 'passed', 'passed'])
})

test('a first run needing a human still lists the source', () => {
  ledger.recordRun(ledger.pathFor('app-1'), 'app', '/x.db', { run_id: 'r', status: 'needs_human', started: 1, finished: 2, used_cache: false, rows_loaded: null, gap: ['debits != credits'] })
  expect(ledger.listLedgers().find((l) => l.id === 'app-1')).toEqual({ id: 'app-1', app: 'app', data_path: '/x.db', rows: 0 })
})

test('monthly by account and by payee', async () => {
  expect((await get(`/ledgers/${LEDGER}/monthly?account=Expenses&depth=0`)).body.months).toEqual([
    { month: '2026-05', account: 'Expenses', debits: '47.81', credits: '0.00', net: '47.81', rows: 1 },
  ])
  expect((await get(`/ledgers/${LEDGER}/monthly?by=payee&from=2026-06-01`)).body.months).toEqual([
    { month: '2026-06', payee: 'Invoice 17', debits: '1200.00', credits: '1200.00', net: '0.00', rows: 2 },
  ])
})

test('balances as of a date', async () => {
  const accounts = Object.fromEntries((await get(`/ledgers/${LEDGER}/balances?as_of=2026-05-31`)).body.accounts.map((a: any) => [a.account, a]))
  expect(accounts['Assets:Checking'].balance).toBe('39952.82')
  expect(accounts['Income:Sales']).toBeUndefined()
})

test('sql reads only', async () => {
  const ok = await post(`/ledgers/${LEDGER}/sql`, { query: 'select status, count(*) n from runs group by status' })
  expect(ok.status).toBe(200)
  expect(ok.body.rows).toEqual([['needs_human', 1], ['passed', 2]])
  for (const sql of [
    'delete from ledger',
    "update ledger set amount = '0'",
    'select 1; delete from ledger',
    'with t as (select 1) delete from ledger',
    "attach database '/tmp/x.db' as x",
    'pragma writable_schema = on',
  ]) expect((await post(`/ledgers/${LEDGER}/sql`, { query: sql })).status, sql).toBe(400)
  expect((await get(`/ledger?ledger_id=${LEDGER}`)).body.total).toBe(6)
})

test('run_sql truncates', () => {
  const result = query.runSql(ledger.pathFor(LEDGER), 'select * from ledger', 2)
  expect(result.rows).toHaveLength(2)
  expect(result.truncated).toBe(true)
})

test('unknown routes and methods', async () => {
  expect((await get('/nope')).status).toBe(404)
  expect((await post('/ledgers', {})).status).toBe(405)
  expect((await post('/workflows', {})).status).toBe(422)
})
