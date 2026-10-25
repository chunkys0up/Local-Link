import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { expect, test } from 'vitest'

import * as layout from '../src/main/layout'

const dir = () => mkdtempSync(join(tmpdir(), 'll-layout-'))

test('sqlite tables and columns', () => {
  const path = join(dir(), 'books.db')
  const db = new DatabaseSync(path)
  db.exec('create table splits (guid text, value_num integer); create view v as select guid from splits')
  db.close()
  expect(layout.describe(path)).toEqual(['table splits(guid, value_num)', 'view v(guid)'])
})

test('gzipped xml element paths, a layout change shows up in the diff', () => {
  const path = join(dir(), 'books.gnucash')
  writeFileSync(path, gzipSync('<?xml version="1.0"?><gnc-v2><gnc:book version="2.0.0"><gnc:account/><!-- c --></gnc:book></gnc-v2>'))
  const before = layout.describe(path)
  expect(before).toEqual(['xml gnc-v2', 'xml gnc-v2/gnc:book', 'xml gnc-v2/gnc:book/gnc:account'])
  writeFileSync(path, gzipSync('<gnc-v2><gnc:book><gnc:transaction><trn:splits/></gnc:transaction></gnc:book></gnc-v2>'))
  const [added, removed] = layout.diff(before, layout.describe(path))
  expect(added).toEqual(['xml gnc-v2/gnc:book/gnc:transaction', 'xml gnc-v2/gnc:book/gnc:transaction/trn:splits'])
  expect(removed).toEqual(['xml gnc-v2/gnc:book/gnc:account'])
})

test('csv headers, json keys, and folders', () => {
  const d = dir()
  writeFileSync(join(d, 'a.csv'), '﻿Date,"Payee, name",Amount\n2026-10-01,x,1\n')
  writeFileSync(join(d, 'b.json'), '{"accounts": [{"id": 1, "name": "x"}]}')
  writeFileSync(join(d, '.hidden'), 'x')
  expect(layout.describe(d)).toEqual([
    'a.csv: csv columns(Date, Payee, name, Amount)',
    'b.json: json $',
    'b.json: json $.accounts',
    'b.json: json $.accounts[]',
    'b.json: json $.accounts[].id',
    'b.json: json $.accounts[].name',
  ])
})

test('the test-data csv', () => {
  expect(layout.describe(join(__dirname, '..', '..', 'test-data', 'actual-test.csv'))).toEqual([
    'csv columns(Date, Payee, Category, Notes, Amount)',
  ])
})
