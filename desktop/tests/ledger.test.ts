import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import * as ledger from '../src/main/ledger'
import { toCents, type NormalizedRow } from '../src/main/rows'

const row = (source: string, amount: string): NormalizedRow => ({
  date: '2026-10-01', account: 'Expenses:Rent', cents: toCents(amount), side: 'debit', memo: '', source, run_id: 'run_x',
})

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'll-ledger-')), 'ledger.db')

test('first load adds everything', () => {
  const db = tmpDb()
  expect(ledger.diff('app', [row('a', '1.00'), row('b', '2.00')], db).map((c) => c.change)).toEqual(['added', 'added'])
})

test('second load reports added, changed, deleted', () => {
  const db = tmpDb()
  ledger.apply('app', 'run_1', ledger.diff('app', [row('a', '1.00'), row('b', '2.00'), row('c', '3.00')], db), db)
  const changes = ledger.diff('app', [row('a', '1.00'), row('b', '20.00'), row('d', '4.00')], db)
  expect(changes.map((c) => [c.change, c.source])).toEqual([['changed', 'b'], ['deleted', 'c'], ['added', 'd']])
  expect(changes[0].before!.amount).toBe('2.00')
  expect(changes[0].after!.amount).toBe('20.00')
})

test('ledger ids are stable per app and resolved path', () => {
  expect(ledger.ledgerId('GnuCash', '/tmp/../tmp/books.gnucash')).toBe(ledger.ledgerId('GnuCash', '/tmp/books.gnucash'))
  expect(ledger.ledgerId('My App!', '/x')).toMatch(/^my-app-[0-9a-f]{8}$/)
  expect(() => ledger.pathFor('../x')).toThrow(RangeError)
})
