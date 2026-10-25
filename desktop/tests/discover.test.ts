import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

import * as discover from '../src/main/discover'
import { writePlist } from './plist'

test('document extensions', () => {
  const info = { CFBundleDocumentTypes: [{ CFBundleTypeExtensions: ['gnucash', '.XAC', '*'] }, {}] }
  expect(discover.documentExtensions(info)).toEqual(new Set(['gnucash', 'xac']))
})

test('candidates from preferences and support folders', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'll-discover-')))
  const home = join(tmp, 'home')
  const app = join(tmp, 'GnuCash.app')
  writePlist(join(app, 'Contents', 'Info.plist'), {
    CFBundleName: 'GnuCash', CFBundleIdentifier: 'org.gnucash.Gnucash',
    CFBundleDocumentTypes: [{ CFBundleTypeExtensions: ['gnucash'] }],
  })
  const book = join(home, 'Documents', 'books.gnucash')
  mkdirSync(join(home, 'Documents'), { recursive: true })
  writeFileSync(book, 'x')
  writePlist(join(home, 'Library', 'Preferences', 'org.gnucash.Gnucash.plist'), { history: { file0: `file://${book}` }, missing: '/nope/gone.gnucash' })
  const support = join(home, 'Library', 'Application Support', 'GnuCash', 'state.db')
  mkdirSync(join(support, '..'), { recursive: true })
  writeFileSync(support, 'x')
  writeFileSync(join(support, '..', 'notes.txt'), 'not data')
  utimesSync(book, 1, 1)

  const spotted: Set<string>[] = []
  vi.spyOn(discover.spotlight, 'extensions').mockImplementation(async (exts) => (spotted.push(exts), [book]))
  const found = await discover.candidates(app, home)

  expect(spotted).toEqual([new Set(['gnucash'])])
  expect(found.map((c) => [c.path, c.reason])).toEqual([
    [support, 'in Library/Application Support/GnuCash'],
    [book, "named in the app's preferences"],
  ])
})
