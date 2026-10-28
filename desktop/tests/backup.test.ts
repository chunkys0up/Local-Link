import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'retronaut-backup-test-'))
process.env.RETRONAUT_BACKUPS = join(root, '.backups')
const ll = await import('../src/runtime/retronaut')

afterAll(() => rmSync(root, { recursive: true, force: true }))

test('a backup puts files and folders back exactly, removing what a test added', () => {
  const book = join(root, 'book.gnucash')
  const company = join(root, 'Company')
  const later = join(root, 'book.gnucash.LCK') // didn't exist at backup time
  writeFileSync(book, 'three customers, no invoices')
  mkdirSync(join(company, 'attachments'), { recursive: true })
  writeFileSync(join(company, 'data.db'), 'rows')
  writeFileSync(join(company, 'attachments', 'a.pdf'), 'pdf')

  expect(ll.backup.exists()).toBe(false)
  expect(ll.backup.save([book, company, later]).files).toBe(3)
  expect(ll.backup.exists()).toBe(true)

  // The "test" writes invoices, changes and adds files, and leaves a lock behind.
  writeFileSync(book, 'four wrong invoices dated 2020')
  writeFileSync(join(company, 'data.db'), 'changed rows')
  writeFileSync(join(company, 'attachments', 'b.pdf'), 'new')
  writeFileSync(later, 'lock')

  ll.backup.restore()
  expect(readFileSync(book, 'utf8')).toBe('three customers, no invoices')
  expect(readFileSync(join(company, 'data.db'), 'utf8')).toBe('rows')
  expect(existsSync(join(company, 'attachments', 'b.pdf'))).toBe(false)
  expect(existsSync(later)).toBe(false)
})

test('backups are kept by name, and a missing one fails loudly', () => {
  const file = join(root, 'ledger.qbw')
  writeFileSync(file, 'v1')
  ll.backup.save([file], { name: 'before-import' })
  writeFileSync(file, 'v2')
  ll.backup.restore({ name: 'before-import' })
  expect(readFileSync(file, 'utf8')).toBe('v1')
  expect(() => ll.backup.restore({ name: 'nope' })).toThrow(/no backup named "nope"/)
  expect(() => ll.backup.save(['relative/path'])).toThrow(/absolute/)
})
