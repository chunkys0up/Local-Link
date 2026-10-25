/** Property lists (XML or binary) read through macOS's own plutil. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The plist as JSON values, or null if it's missing or unreadable. Values JSON can't
 * hold (dates, data) make plutil refuse the whole file; then only its strings are
 * returned, under a "strings" key, which is all the callers look for.
 */
export async function readPlist(path: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', '--', path], { maxBuffer: 32 << 20 })
    const value = JSON.parse(stdout)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    try {
      const { stdout } = await run('plutil', ['-convert', 'xml1', '-o', '-', '--', path], { maxBuffer: 32 << 20 })
      const strings = [...stdout.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescapeXml(m[1]))
      return { strings }
    } catch {
      return null
    }
  }
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
