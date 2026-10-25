import { expect, test } from 'vitest'

import { money, parseRow, toCents } from '../src/main/rows'

test('amounts become exact cents and back', () => {
  expect(toCents('47.18')).toBe(4718)
  expect(toCents('50')).toBe(5000)
  expect(toCents(0.1)).toBe(10)
  expect(money(4718)).toBe('47.18')
  expect(money(-5000)).toBe('-50.00')
  expect(money(435000, true)).toBe('4,350.00')
  expect(() => toCents('-1.00')).toThrow()
  expect(() => toCents('1.005')).toThrow()
})

test('rows are validated strictly', () => {
  const good = { date: '2026-10-01', account: 'Expenses:Rent', amount: '900.00', side: 'debit', memo: '', source: 't/1' }
  expect(parseRow(good, 'run_1', 0)).toEqual({ ...good, amount: undefined, cents: 90000, run_id: 'run_1' } as never)
  expect(() => parseRow({ ...good, extra: 1 }, 'r', 3)).toThrow(/row 3/)
  expect(() => parseRow({ ...good, date: '2026-02-30' }, 'r', 0)).toThrow(/date/)
  expect(() => parseRow({ ...good, side: 'both' }, 'r', 0)).toThrow(/side/)
  expect(() => parseRow({ ...good, source: '' }, 'r', 0)).toThrow(/source/)
})
