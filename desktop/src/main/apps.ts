/** Installed Mac apps: name, bundle ID, version, path, icon, and what each is built with. */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { readPlist } from './plist'

export const APPS_DIR = '/Applications'

export type AppKind = 'electron' | 'qt' | 'gtk' | 'java' | 'native'

export interface InstalledApp {
  name: string
  bundle_id: string
  version: string
  path: string
  icon: string
  kind: AppKind
}

function list(folder: string): string[] {
  try {
    return readdirSync(folder)
  } catch {
    return [] // missing, or not readable (common under /System)
  }
}

/** .app bundles in a folder and one level of subfolders (e.g. Utilities), not inside apps. */
function bundlesIn(folder: string): string[] {
  const found: string[] = []
  for (const name of list(folder)) {
    const path = join(folder, name)
    if (name.endsWith('.app')) found.push(path)
    else if (isDir(path)) found.push(...list(path).filter((n) => n.endsWith('.app')).map((n) => join(path, n)))
  }
  return found
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** electron | qt | gtk | java | native, from the frameworks and libraries it ships. */
export function kind(app: string): AppKind {
  const contents = join(app, 'Contents')
  const names = new Set([
    ...list(join(contents, 'Frameworks')),
    ...list(join(contents, 'Resources', 'lib')),
    ...list(join(contents, 'PlugIns')),
  ])
  const any = (test: (n: string) => boolean) => [...names].some(test)
  if (names.has('Electron Framework.framework')) return 'electron'
  if (any((n) => n.startsWith('Qt') || n.startsWith('libQt'))) return 'qt'
  if (any((n) => n.startsWith('libgtk-') || n.startsWith('libgdk-'))) return 'gtk'
  if (isDir(join(contents, 'Java')) || any((n) => /jdk|jre/i.test(n))) return 'java'
  return 'native'
}

/** One app's details from Contents/Info.plist, or null if it isn't a readable bundle. */
export async function describe(app: string): Promise<InstalledApp | null> {
  const info = await readPlist(join(app, 'Contents', 'Info.plist'))
  if (!info || 'strings' in info) return null

  // Some apps ship odd plists (numbers, empty values), so keep only real strings.
  const text = (...keys: string[]) => {
    for (const k of keys) {
      const v = info[k]
      if (typeof v === 'string' && v.trim()) return v
    }
    return ''
  }

  let icon = text('CFBundleIconFile')
  if (icon && !extname(icon)) icon += '.icns'
  return {
    name: text('CFBundleDisplayName', 'CFBundleName') || basename(app, '.app'),
    bundle_id: text('CFBundleIdentifier'),
    version: text('CFBundleShortVersionString', 'CFBundleVersion'),
    path: app,
    icon: icon ? join(app, 'Contents', 'Resources', icon) : '',
    kind: kind(app),
  }
}

/** Every app in /Applications (and its subfolders like Utilities), sorted by name. */
export async function scan(folder = APPS_DIR): Promise<InstalledApp[]> {
  const described = await Promise.all(
    bundlesIn(folder).map((path) => (existsSync(join(path, 'Contents')) ? describe(path).catch(() => null) : null)),
  )
  const found = described.filter((a): a is InstalledApp => a !== null)
  const fold = (s: string) => s.toLocaleLowerCase()
  return found.sort((a, b) => fold(a.name).localeCompare(fold(b.name)) || a.path.localeCompare(b.path))
}

/** The installed app whose name or bundle name matches, e.g. "gnucash" -> GnuCash.app. */
export async function find(name: string): Promise<InstalledApp | null> {
  const want = name.trim().replace(/\.app$/i, '').toLowerCase()
  const apps = await scan()
  return (
    apps.find((a) => a.name.toLowerCase() === want || basename(a.path, '.app').toLowerCase() === want) ??
    apps.find((a) => a.name.toLowerCase().includes(want)) ??
    null
  )
}
