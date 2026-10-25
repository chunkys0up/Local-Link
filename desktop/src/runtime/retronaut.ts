/**
 * The runtime generated workflow scripts import as ./retronaut.mjs.
 *
 *   import * as ll from './retronaut.mjs'
 *   await ll.workflow(async ({ step, state, log }) => {
 *     const mail = await step('Fetch work orders', () => ll.gmail.search('from:orders@acme.com'))
 *     const gnucash = ll.app('GnuCash')
 *     await step('Open the invoice importer', () => gnucash.menu(['File', 'Import', 'Import Bills & Invoices...']), { app: gnucash })
 *   })
 *
 * Steps report to the engine as "@@ll {json}" lines on stdout. When a step throws, the
 * runtime saves failure.json and a screenshot of the step's app (failure.jpg) in the
 * output folder, which is what the healing agent starts from.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'

import * as mac from '../shared/macos'

const API = process.env.RETRONAUT_API ?? 'http://127.0.0.1:8000'
const OUT = process.env.RETRONAUT_OUT ?? process.cwd()
const STATE_FILE = process.env.RETRONAUT_STATE ?? join(process.cwd(), 'state.json')
const TEST = process.env.RETRONAUT_TEST === '1'

function report(event: Record<string, unknown>): void {
  process.stdout.write(`@@ll ${JSON.stringify({ ts: Date.now() / 1000, ...event })}\n`)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function log(message: string, detail = ''): void {
  report({ type: 'log', message, detail })
}

/** True when the engine is running this script as the build's test run. */
export const isTest = TEST

// ---------- state: small JSON the workflow keeps between runs (e.g. processed IDs) ----------

function loadState(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export const state = {
  get<T>(key: string, fallback: T): T {
    const all = loadState()
    return key in all ? (all[key] as T) : fallback
  },
  set(key: string, value: unknown): void {
    const all = loadState()
    all[key] = value
    writeFileSync(STATE_FILE, JSON.stringify(all, null, 2))
  },
  /** Whether an item (e.g. a work-order number) was already handled by an earlier run. */
  done(set: string, id: string): boolean {
    return (state.get<string[]>(set, [])).includes(id)
  },
  markDone(set: string, id: string): void {
    const ids = state.get<string[]>(set, [])
    if (!ids.includes(id)) state.set(set, [...ids, id])
  },
}

// ---------- apps ----------

// While the person is using the mouse or keyboard, actions wait; the engine shows it.
mac.inputGuard.onWait = (waiting) => report({ type: 'ui', state: waiting ? 'paused' : 'resumed' })

export interface ClickOptions {
  /** Which window: exact title, a substring, or a RegExp. Defaults to the front window. */
  window?: string | RegExp
  button?: 'left' | 'right'
  count?: number
}

function matches(title: string, want: string | RegExp): boolean {
  return typeof want === 'string' ? title === want || title.includes(want) : want.test(title)
}

export class App {
  readonly ref: mac.AppRef

  constructor(name: string, bundleId?: string) {
    this.ref = { app: name, bundleId }
  }

  get name(): string {
    return this.ref.app
  }

  /** One UI action, shown on screen as Retronaut driving this app. */
  private async onScreen<T>(action: () => Promise<T>, label: string): Promise<T> {
    report({ type: 'ui', state: 'begin', app: this.name, label })
    try {
      return await action()
    } finally {
      report({ type: 'ui', state: 'end' })
    }
  }

  /** Bring the app to the front; throws rather than let clicks or keys land in another app. */
  async activate(): Promise<void> {
    await this.onScreen(() => this.bringForward(), `Bringing ${this.name} forward`)
  }

  private async bringForward(): Promise<void> {
    if (!(await mac.activate(this.ref))) {
      const now = await mac.frontmost().catch(() => ({ app: 'another app' }))
      throw new Error(`${this.name} couldn't be brought to the front (${now.app} is), so nothing was sent to it`)
    }
  }

  async windows(): Promise<mac.AppWindow[]> {
    return mac.windows(await mac.pidOf(this.ref))
  }

  /** The window whose title matches (front window if none given). Throws if absent. */
  async window(want?: string | RegExp): Promise<mac.AppWindow> {
    const wins = await this.windows()
    const win = want === undefined ? wins[0] : wins.find((w) => matches(w.title, want))
    if (!win) {
      const titles = wins.map((w) => JSON.stringify(w.title)).join(', ') || 'none'
      throw new Error(`${this.name}: no window ${want === undefined ? 'open' : `matching ${String(want)}`} (open: ${titles})`)
    }
    return win
  }

  /** Wait until a window whose title matches is on screen. */
  async waitForWindow(want: string | RegExp, timeoutMs = 10_000): Promise<mac.AppWindow> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const win = (await this.windows()).find((w) => matches(w.title, want))
      if (win) return win
      if (Date.now() > until) return this.window(want) // throws with the open titles
      await sleep(250)
    }
  }

  /** Wait until no window matching the title is open (e.g. a dialog closed). */
  async waitForWindowGone(want: string | RegExp, timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs
    while ((await this.windows()).some((w) => matches(w.title, want))) {
      if (Date.now() > until) throw new Error(`${this.name}: window matching ${String(want)} is still open`)
      await sleep(250)
    }
  }

  async menu(path: string[]): Promise<void> {
    await this.onScreen(async () => {
      await this.bringForward()
      await mac.chooseMenu(this.ref, path)
    }, `Choosing ${path.join(' › ')}`)
    await sleep(300)
  }

  /** Click at (x, y) points relative to a window's top-left. */
  async clickAt(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    await this.onScreen(async () => {
      await this.bringForward()
      const win = await this.window(opts.window)
      if (x < 0 || y < 0 || x >= win.w || y >= win.h) {
        throw new Error(`${this.name}: (${x}, ${y}) is outside window "${win.title}" (${win.w}x${win.h})`)
      }
      await mac.click(win.x + x, win.y + y, { button: opts.button, count: opts.count })
    }, `Clicking in “${typeof opts.window === 'string' ? opts.window : this.name}”`)
    await sleep(250)
  }

  async clickElement(path: string): Promise<void> {
    await this.onScreen(async () => {
      await this.bringForward()
      await mac.clickElement(this.ref, path)
    }, `Pressing ${path.split('/').pop()}`)
    await sleep(250)
  }

  async type(text: string): Promise<void> {
    await this.onScreen(async () => {
      await this.bringForward()
      await mac.typeText(text)
    }, `Typing “${text.replace(/\s+/g, ' ').slice(0, 47)}${text.length > 47 ? '…' : ''}”`)
  }

  async keys(...combos: string[]): Promise<void> {
    await this.onScreen(async () => {
      await this.bringForward()
      await mac.pressKeys(combos)
    }, `Pressing ${combos.join(' ')}`)
    await sleep(150)
  }

  /** Screenshot of the front window, saved as JPEG; returns the path. */
  async screenshot(path = join(OUT, `${this.name}-${Date.now()}.jpg`)): Promise<string> {
    const shot = await mac.screenshot({ ref: this.ref })
    writeFileSync(path, shot.jpeg)
    return path
  }
}

export function app(name: string, bundleId?: string): App {
  return new App(name, bundleId)
}

// ---------- engine API: connectors, ledgers ----------

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { detail?: string }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.detail ?? ''}`.trim())
  return data
}

export interface EmailMessage {
  id: string
  thread_id: string
  from: string
  to: string
  subject: string
  date: string
  body: string
}

export const gmail = {
  /** Messages matching a Gmail search query, newest first, with full plain-text bodies. */
  async search(query: string, opts: { max?: number } = {}): Promise<EmailMessage[]> {
    const { messages } = await api<{ messages: EmailMessage[] }>('/connectors/gmail/search', { query, max: opts.max ?? 25 })
    return messages
  },
}

export const ledger = {
  get: <T = unknown>(path: string) => api<T>(path),
}

// ---------- files ----------

/** A file's text, gunzipped if it is gzip-compressed (GnuCash's default XML is). */
export function readText(path: string): string {
  const bytes = readFileSync(path)
  return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8')
}

export const xml = {
  parse(text: string): Record<string, unknown> {
    return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: true }).parse(text)
  },
}

export function sqlite(path: string, opts: { readOnly?: boolean } = {}): DatabaseSync {
  return new DatabaseSync(path, { readOnly: opts.readOnly ?? true })
}

export const csv = {
  stringify(rows: (string | number)[][]): string {
    const cell = (v: string | number) => {
      const s = String(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n'
  },
}

// ---------- stopping for a person ----------

/** A deliberate stop: the data needs a person's decision. Not a breakage, so never healed. */
export class NeedsReview extends Error {
  readonly review = true
}

/**
 * Stop the run for a person to decide, e.g. a later visit for an invoice already posted, a
 * customer the book doesn't have, an email in an unknown format. Use it instead of throwing
 * for business situations; throw for breakages (a missing window, a moved button), which
 * Retronaut heals.
 */
export function needsReview(reason: string): never {
  throw new NeedsReview(reason)
}

// ---------- steps ----------

let currentApp: App | null = null
let stepCount = 0

export async function step<T>(name: string, fn: () => Promise<T> | T, opts: { app?: App } = {}): Promise<T> {
  const index = ++stepCount
  currentApp = opts.app ?? currentApp
  report({ type: 'step', index, name, status: 'running' })
  const started = Date.now()
  try {
    const result = await fn()
    report({ type: 'step', index, name, status: 'ok', ms: Date.now() - started })
    return result
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    ;(error as Error & { step?: { index: number; name: string; app?: string } }).step ??= { index, name, app: opts.app?.name }
    report({ type: 'step', index, name, status: 'failed', ms: Date.now() - started, error: error.message, review: error instanceof NeedsReview })
    throw error
  }
}

export interface WorkflowContext {
  step: typeof step
  state: typeof state
  log: typeof log
  isTest: boolean
}

/** Run the workflow body; report its result, or a failure report the engine can heal from. */
export async function workflow(body: (ctx: WorkflowContext) => Promise<unknown>): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  try {
    const summary = await body({ step, state, log, isTest })
    report({ type: 'result', ok: true, summary: summary ?? null })
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    const failed = (error as Error & { step?: { index: number; name: string; app?: string } }).step
    const review = (error as Error & { review?: boolean }).review === true
    const failure: Record<string, unknown> = { step: failed ?? null, error: error.message, review, stack: error.stack?.split('\n').slice(0, 8).join('\n') }
    const target = currentApp
    if (target) {
      try {
        failure.windows = (await target.windows()).map((w) => ({ title: w.title, x: w.x, y: w.y, w: w.w, h: w.h }))
        failure.screenshot = await target.screenshot(join(OUT, 'failure.jpg'))
      } catch (shotError) {
        failure.screenshot_error = (shotError as Error).message
      }
    }
    writeFileSync(join(OUT, 'failure.json'), JSON.stringify(failure, null, 2))
    report({ type: 'result', ok: false, review, error: error.message, step: failed ?? null })
    process.exitCode = 1
  }
}

