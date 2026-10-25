import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import * as apps from '../src/main/apps'
import { writePlist } from './plist'

const root = () => mkdtempSync(join(tmpdir(), 'll-apps-'))

function makeApp(dir: string, name: string, info: object | null = null, files: string[] = []): string {
  const app = join(dir, `${name}.app`)
  writePlist(join(app, 'Contents', 'Info.plist'), info ?? { CFBundleName: name })
  for (const rel of files) mkdirSync(join(app, 'Contents', rel), { recursive: true })
  return app
}

test('kind from frameworks', () => {
  const d = root()
  expect(apps.kind(makeApp(d, 'Obsidian', null, ['Frameworks/Electron Framework.framework']))).toBe('electron')
  expect(apps.kind(makeApp(d, 'Calibre', null, ['Frameworks/QtCore.framework']))).toBe('qt')
  expect(apps.kind(makeApp(d, 'GnuCash', null, ['Resources/lib/libgtk-3.0.dylib']))).toBe('gtk')
  expect(apps.kind(makeApp(d, 'Moneydance', null, ['PlugIns/jdk-21.jdk']))).toBe('java')
  expect(apps.kind(makeApp(d, 'Notes'))).toBe('native')
})

test('describe reads Info.plist', async () => {
  const app = makeApp(root(), 'GnuCash', {
    CFBundleName: 'Gnucash', CFBundleDisplayName: 'GnuCash', CFBundleIdentifier: 'org.gnucash.Gnucash',
    CFBundleShortVersionString: '5.17', CFBundleIconFile: 'gnucash',
  })
  expect(await apps.describe(app)).toEqual({
    name: 'GnuCash', bundle_id: 'org.gnucash.Gnucash', version: '5.17', path: app,
    icon: join(app, 'Contents', 'Resources', 'gnucash.icns'), kind: 'native',
  })
})

test('scan finds nested apps and skips broken ones', async () => {
  const d = root()
  makeApp(d, 'Zed')
  makeApp(join(d, 'Utilities'), 'Activity Monitor')
  makeApp(join(d, 'Zed.app', 'Contents', 'Frameworks'), 'Zed Helper') // inside a bundle
  mkdirSync(join(d, 'Broken.app'))
  expect((await apps.scan(d)).map((a) => a.name)).toEqual(['Activity Monitor', 'Zed'])
})

test('odd plist values and unreadable folders', async () => {
  const d = root()
  const app = makeApp(d, 'Odd', { CFBundleName: 3, CFBundleVersion: '', CFBundleIdentifier: ['x'] })
  expect(await apps.describe(app)).toEqual({ name: 'Odd', bundle_id: '', version: '', path: app, icon: '', kind: 'native' })
  mkdirSync(join(app, 'Contents', 'PlugIns'))
  chmodSync(join(app, 'Contents', 'PlugIns'), 0)
  try {
    expect(apps.kind(app)).toBe('native')
  } finally {
    chmodSync(join(app, 'Contents', 'PlugIns'), 0o755)
  }
})

test('a malformed plist is skipped', async () => {
  const d = root()
  makeApp(d, 'Good')
  mkdirSync(join(d, 'Bad.app', 'Contents'), { recursive: true })
  writeFileSync(join(d, 'Bad.app', 'Contents', 'Info.plist'), '<?xml version="1.0"?>\n<plist><dict><key>a</key>\x01</dict></plist>')
  expect((await apps.scan(d)).map((a) => a.name)).toEqual(['Good'])
})
