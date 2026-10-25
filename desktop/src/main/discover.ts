/**
 * Candidate data files for an installed app, for the user to confirm before a run.
 *
 * No agent involved: the engine looks where apps usually keep their data and lists
 * what it finds. The user picks one, and only that path is given to the agent.
 */

import { execFile } from 'node:child_process'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, relative } from 'node:path'
import { promisify } from 'node:util'

import { readPlist } from './plist'

const run = promisify(execFile)

export const DATA_SUFFIXES = new Set(['.sqlite', '.sqlite3', '.db', '.json', '.xml', '.csv', '.gnucash', '.ledger', '.qif', '.ofx'])
const MAX_CANDIDATES = 25
const MAX_FILES_PER_FOLDER = 500
const SPOTLIGHT_TIMEOUT_MS = 10_000

export interface Candidate {
  path: string
  reason: string
  size: number
  modified: number
}

/** File extensions the app says it opens (CFBundleDocumentTypes). */
export function documentExtensions(info: Record<string, unknown>): Set<string> {
  const docs = Array.isArray(info.CFBundleDocumentTypes) ? info.CFBundleDocumentTypes : []
  const out = new Set<string>()
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue
    const exts = (doc as Record<string, unknown>).CFBundleTypeExtensions
    for (const ext of Array.isArray(exts) ? exts : []) {
      if (typeof ext === 'string' && ext && ext !== '*') out.add(ext.toLowerCase().replace(/^\./, ''))
    }
  }
  return out
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Existing file paths mentioned anywhere in a preferences value. */
export function pathsIn(value: unknown, home = homedir()): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => pathsIn(v, home))
  if (value && typeof value === 'object') return Object.values(value).flatMap((v) => pathsIn(v, home))
  if (typeof value === 'string') {
    let text = value.startsWith('file://') ? decodeURIComponent(value.slice(7)) : value
    if (text.startsWith('~/')) text = join(home, text.slice(2))
    if (text.startsWith('/') && isFile(text)) return [text]
  }
  return []
}

export const spotlight = {
  async extensions(extensions: Set<string>, home: string): Promise<string[]> {
    if (!extensions.size) return []
    const query = [...extensions].sort().map((ext) => `kMDItemFSName == '*.${ext}'c`).join(' || ')
    try {
      const { stdout } = await run('mdfind', ['-onlyin', home, query], { timeout: SPOTLIGHT_TIMEOUT_MS })
      return stdout.split('\n').filter(Boolean)
    } catch {
      return []
    }
  },
}

function dataFiles(folder: string): string[] {
  const found: string[] = []
  const visit = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // e.g. a sandboxed container we aren't allowed to read
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES_PER_FOLDER) return
      const full = join(dir, e.name)
      if (e.isDirectory()) visit(full)
      else if (e.isFile() && DATA_SUFFIXES.has(extname(e.name).toLowerCase())) found.push(full)
    }
  }
  visit(folder)
  return found
}

/** Likely data files for the app, most recently modified first. */
export async function candidates(appPath: string, home = homedir(), useSpotlight = true): Promise<Candidate[]> {
  const info = (await readPlist(join(appPath, 'Contents', 'Info.plist'))) ?? {}
  const bundleId = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : ''
  const name = typeof info.CFBundleName === 'string' && info.CFBundleName.trim() ? info.CFBundleName : basename(appPath, '.app')
  const extensions = documentExtensions(info)

  const found: [string, string][] = []
  if (bundleId) {
    const prefs = await readPlist(join(home, 'Library', 'Preferences', `${bundleId}.plist`))
    if (prefs) found.push(...pathsIn(prefs, home).map((p): [string, string] => [p, "named in the app's preferences"]))
  }
  if (useSpotlight) {
    found.push(...(await spotlight.extensions(extensions, home)).map((p): [string, string] => [p, 'file type the app opens']))
  }
  const folders = [join(home, 'Library', 'Application Support', name)]
  if (bundleId) {
    folders.push(join(home, 'Library', 'Application Support', bundleId), join(home, 'Library', 'Containers', bundleId, 'Data'))
  }
  for (const folder of folders) {
    found.push(...dataFiles(folder).map((p): [string, string] => [p, `in ${relative(home, folder)}`]))
  }

  const results = new Map<string, Candidate>()
  for (const [path, reason] of found) {
    try {
      const resolved = realpathSync(path)
      if (results.has(resolved)) continue
      const stat = statSync(resolved)
      if (!stat.isFile()) continue
      results.set(resolved, { path: resolved, reason, size: stat.size, modified: stat.mtimeMs / 1000 })
    } catch {
      continue
    }
  }
  return [...results.values()].sort((a, b) => b.modified - a.modified).slice(0, MAX_CANDIDATES)
}
