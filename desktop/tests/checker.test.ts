import { expect, test } from 'vitest'

import { check } from '../src/main/checker'
import { toCents, type NormalizedRow, type Side } from '../src/main/rows'

const row = (account: string, amount: string, side: Side, source: string): NormalizedRow => ({
  date: '2026-10-01', account, cents: toCents(amount), side, memo: '', source, run_id: 'run_test',
})

const BALANCED = [
  row('Assets:Checking', '2500.00', 'debit', 't1/s1'),
  row('Income:Sales', '2500.00', 'credit', 't1/s2'),
  row('Expenses:Rent', '1800.00', 'debit', 't2/s1'),
  row('Assets:Checking', '1800.00', 'credit', 't2/s2'),
]

test('passes clean books', () => {
  expect(check(BALANCED).differences).toEqual([])
})

test('flags 50 dollars parked in suspense', () => {
  const rows = [...BALANCED, row('Expenses:Supplies', '50.00', 'debit', 't3/s1'), row('Suspense', '50.00', 'credit', 't3/s2')]
  expect(check(rows).differences).toEqual(['unexpected nonzero account Suspense: -50.00'])
})

test('flags unbalanced rows', () => {
  const rows = [...BALANCED, row('Expenses:Supplies', '50.00', 'debit', 't3/s1')]
  expect(check(rows).differences).toEqual(['debits 4,350.00 != credits 4,300.00 (off by 50.00)'])
})

test('flags duplicate source ids', () => {
  const rows = [...BALANCED.slice(0, 2), row('Expenses:Rent', '1800.00', 'debit', 't1/s1'), row('Assets:Checking', '1800.00', 'credit', 't1/s2')]
  expect(check(rows).differences).toEqual(['2 source IDs are used by more than one row: t1/s1, t1/s2'])
})

test('fails on no rows', () => {
  expect(check([]).differences).toEqual(['no rows were extracted'])
})
