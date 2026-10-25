/**
 * Fingerprint of a data source's structure (not its values).
 *
 * A saved extractor is only trusted while the layout it was written against is
 * unchanged: SQLite tables and columns, XML element paths, CSV headers, JSON keys.
 */

import { openSync, readSync, closeSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'

const MAX_FILES = 200

export function describe(path: string): string[] {
  if (statSync(path).isDirectory()) {
    const files = walk(path).sort().slice(0, MAX_FILES)
    return files.flatMap((f) => describeFile(f).map((e) => `${relative(path, f)}: ${e}`)).sort()
  }
  return describeFile(path).sort()
}

/** [added, removed] structure entries. */
export function diff(before: string[], after: string[]): [string[], string[]] {
  const old = new Set(before)
  const now = new Set(after)
  return [[...now].filter((e) => !old.has(e)).sort(), [...old].filter((e) => !now.has(e)).sort()]
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function head(path: string, n: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    return buf.subarray(0, readSync(fd, buf, 0, n, 0))
  } finally {
    closeSync(fd)
  }
}

function describeFile(path: string): string[] {
  const start = head(path, 16)
  if (start.toString('latin1').startsWith('SQLite format 3\0')) {
    try {
      return sqlite(path)
    } catch {
      return ['unreadable sqlite database'] // corrupt or locked; the agent will see it too
    }
  }
  const ext = extname(path).toLowerCase()
  try {
    let bytes = readFileSync(path)
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes)
    const text = bytes.toString('utf8').replace(/^﻿/, '')
    const lead = text.trimStart()[0]
    if (lead === '<') return xmlPaths(text)
    if (lead === '{' || lead === '[') return jsonPaths(JSON.parse(text))
    if (ext === '.csv' || ext === '.tsv') {
      const header = text.split(/\r?\n/, 1)[0] ?? ''
      return [`csv columns(${splitCsvLine(header, ext === '.tsv' ? '\t' : ',').join(', ')})`]
    }
  } catch {
    // unreadable, or not what its first bytes suggested
  }
  return [`unrecognized file ${ext || '(no extension)'}`]
}

function sqlite(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const objects = db
      .prepare(
        "select type, name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name",
      )
      .all() as { type: string; name: string }[]
    return objects.map(({ type, name }) => {
      const columns = (db.prepare(`pragma table_info("${name.replace(/"/g, '""')}")`).all() as { name: string }[]).map((c) => c.name)
      return `${type} ${name}(${columns.join(', ')})`
    })
  } finally {
    db.close()
  }
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][^>]*>/g

/** Every element path in the document, e.g. "xml gnc-v2/gnc:book/gnc:account". */
export function xmlPaths(text: string): string[] {
  const paths = new Set<string>()
  const stack: string[] = []
  for (const m of text.matchAll(TAG)) {
    const [, closing, name, selfClosing] = m
    if (!name) continue // comment, CDATA, declaration
    if (closing) {
      stack.pop()
      continue
    }
    stack.push(name)
    paths.add(`xml ${stack.join('/')}`)
    if (selfClosing) stack.pop()
  }
  return [...paths].sort()
}

function jsonPaths(value: unknown, prefix = 'json $'): string[] {
  const entries = new Set([prefix])
  if (Array.isArray(value)) for (const child of value) jsonPaths(child, `${prefix}[]`).forEach((e) => entries.add(e))
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) jsonPaths(child, `${prefix}.${key}`).forEach((e) => entries.add(e))
  return [...entries].sort()
}

export function splitCsvLine(line: string, delimiter = ','): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted && c === '"' && line[i + 1] === '"') {
      field += '"'
      i++
    } else if (c === '"') {
      quoted = !quoted
    } else if (c === delimiter && !quoted) {
      out.push(field)
      field = ''
    } else {
      field += c
    }
  }
  out.push(field)
  return out
}
