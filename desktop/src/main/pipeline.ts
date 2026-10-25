/**
 * One connect run: saved extractor (if the data layout is unchanged) or the agent,
 * then the checker, one repair, then a row-by-row diff into the ledger.
 */

import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { Agent } from './agent'
import { find } from './apps'
import { check, type CheckResult } from './checker'
import { nodeCommand, provideRuntime } from './executor'
import * as layout from './layout'
import * as ledger from './ledger'
import { dirs } from './paths'
import { parseRow, type NormalizedRow } from './rows'
import { SERVER, computerServer, type AllowedApp } from './tools'

export const SCRIPT = 'extract.mjs'
const LAYOUT_FILE = 'layout.json'
const SCRIPT_TIMEOUT_MS = 120_000
const MAX_CHANGES_SHOWN = 500
const MAX_LAYOUT_LINES = 6

const PROMPT = `Connect to the local accounting app "{app}". Its data is at:

    {data_path}

Write an extractor that outputs normalized rows. A checker verifies your output, and
later runs compare it with earlier loads row by row (added, changed, deleted), so every
row needs a stable ID.

## Deliverable: extract.mjs in the working folder
Run as: node extract.mjs <data_path>
Prints to stdout a JSON array with one object per posting line (split), every
transaction included. Each object has exactly these keys:
- date: "YYYY-MM-DD"
- account: the account's full path from its top-level account, levels joined by ":"
  (e.g. "Expenses:Office:Rent"), with names exactly as the app shows them
- amount: positive decimal string with 2 places, e.g. "50.00"
- side: "debit" or "credit"
- memo: string, may be empty
- source: a unique, stable ID for this posting line built from the app's own IDs
  (e.g. "transactions/<transaction id>/splits/<split id>"). Never a row number or
  position: the same entry must get the same source on every run.
Do not drop, net, merge or adjust entries.

## What the rows must represent
Together the rows are a double-entry ledger of the app's books: each transaction's
debits equal its credits. Apps don't all store data that way, so before writing code,
work out from the data how this app models money. Where it already keeps balanced
postings, emit them as they are. Where it doesn't, derive the postings its records
imply, using only what the data says. Never invent amounts, accounts or categories;
leave anything the app hasn't assigned visibly unassigned instead of guessing. Make sure
nothing is counted twice, and that nothing the app treats as deleted or superseded is
included. Do the money math in integer cents (or by string), never in floats.

## Access
- The data path is READ-ONLY. Never create, modify, move or delete anything there.
  Open databases read-only (node:sqlite: new DatabaseSync(path, { readOnly: true })).
- Your working folder is {workspace}. Write files only there.
- Commands are limited to read-only ones, or \`node <script>.mjs\` for a script in the
  working folder. Anything else is refused.
- If an action is refused, don't stop: take an allowed route and keep going.

## Rules
- Node's standard library, plus ./retronaut.mjs in the working folder:
  import { readText, xml, sqlite } from './retronaut.mjs'
  readText(path) gunzips if needed; xml.parse(text) gives objects (attributes as "@name");
  sqlite(path) opens read-only.
- No network. Your script prints only JSON to stdout.
- Run it against the data path to confirm it works before you finish.
- Finish with a short summary of the data format and how your script works.

## Work fast
- Inspect the data with a few quick commands, write the script, run it, and stop.
- Don't build validation harnesses, probe suites or READMEs; the pipeline checks
  your output.
`

const REPAIR = `
## Previous attempt failed the checker
Your extract.mjs is already in the working folder. The checker rejected its output:
{differences}

Work out whether your script misreads the app's data, or whether the books themselves
have a real problem. Reason it out from the data: is part of how the app models money
missing from your script, or does the app itself hold the entries that way? Fix your
script only if it is wrong. Never hide, drop or alter entries to make the checks pass.
If your script is right, leave it and explain why in your summary.
`

const UI = `
## UI automation is enabled for this run
{why} You may also drive the app's own interface, but only "{app}", with Retronaut's
tools: screenshot, list_menu, choose_menu, press_keys, type_text, click.
Screenshots are lower confidence than data: use them to navigate, not as the source of
numbers. Prefer the app's own export: open its File/Export (or Reports) menu and export
to CSV, QIF or similar, saving into {workspace}. GTK apps such as GnuCash expose only
their menu bar to accessibility, not their dialogs; inside a dialog use keys (Tab,
Return, typing a path, cmd+shift+g in file pickers) and check with a screenshot. Then
write extract.mjs so it can redo the whole thing on its own (import { app } from
'./retronaut.mjs' to drive the same export), wait for the file, and parse it. It must
still output every posting line with stable source IDs from the app's data.
`

export interface UiScope {
  app: string
  why: string
}

export function buildPrompt(app: string, dataPath: string, workspace: string, error: string[] | null, ui: UiScope | null): string {
  let prompt = PROMPT.replace('{app}', app).replace('{data_path}', dataPath).replaceAll('{workspace}', workspace)
  if (error?.length) prompt += REPAIR.replace('{differences}', error.map((d) => `- ${d}`).join('\n'))
  if (ui) prompt += UI.replace('{why}', ui.why).replace('{app}', ui.app).replaceAll('{workspace}', workspace)
  return prompt
}

export type RunStatus = 'running' | 'passed' | 'needs_human' | 'error'

export class Run {
  status: RunStatus = 'running'
  events: { i: number; ts: number; kind: string; label: string; detail: string; image?: string }[] = []
  gap: string[] = []
  rows_loaded: number | null = null
  used_cache = false
  changes: Record<string, unknown> | null = null
  readonly ledger_id: string
  private shots = new Map<number, Buffer>()

  constructor(
    readonly id: string,
    readonly app: string,
    readonly data_path: string,
    readonly allow_ui = false, // UI automation from the first attempt, not only on repair
  ) {
    this.ledger_id = ledger.ledgerId(app, data_path)
  }

  emit = (kind: string, label: string, detail = '', image?: string): void => {
    this.events.push({ i: this.events.length, ts: Date.now() / 1000, kind, label, detail, ...(image ? { image } : {}) })
  }

  saveShot = (jpeg: Buffer): string => {
    this.shots.set(this.shots.size, jpeg)
    return `/runs/${this.id}/shots/${this.shots.size - 1}.jpg`
  }

  shot(n: number): Buffer | undefined {
    return this.shots.get(n)
  }

  snapshot(after = 0) {
    return {
      run_id: this.id,
      app: this.app,
      data_path: this.data_path,
      status: this.status,
      gap: this.gap,
      rows_loaded: this.rows_loaded,
      used_cache: this.used_cache,
      allow_ui: this.allow_ui,
      changes: this.changes,
      ledger_id: this.ledger_id,
      events: this.events.slice(after),
    }
  }
}

export const RUNS = new Map<string, Run>()

export function newRun(app: string, dataPath: string, allowUi = false): Run {
  const run = new Run(`run_${randomUUID().slice(0, 8)}`, app, dataPath, allowUi)
  RUNS.set(run.id, run)
  return run
}

export function latestRun(): Run | null {
  return [...RUNS.values()].pop() ?? null
}

export function anyRunning(): boolean {
  return [...RUNS.values()].some((r) => r.status === 'running')
}

/** Testing aid: forget runs, saved extractors, the ledger and its history. */
export function reset(): void {
  RUNS.clear()
  rmSync(dirs.cache(), { recursive: true, force: true })
  ledger.reset()
}

function runScript(script: string, dataPath: string): Promise<unknown> {
  const node = nodeCommand()
  return new Promise((resolve, reject) => {
    execFile(
      node.command,
      [basename(script), dataPath],
      { cwd: join(script, '..'), env: { ...process.env, ...node.env }, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 256 << 20 },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr).trim().split('\n').slice(-5)
          const why = error.killed ? `timed out after ${SCRIPT_TIMEOUT_MS / 1000}s` : `exited ${error.code}`
          return reject(new Error(`${SCRIPT} ${why}: ${tail.join(' | ')}`))
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          reject(new Error(`${SCRIPT} did not print valid JSON: ${(e as Error).message}`))
        }
      },
    )
  })
}

/** Run the extractor and check its output. */
export async function evaluate(run: Run, workspace: string, dataPath: string): Promise<[CheckResult, NormalizedRow[]]> {
  const script = join(workspace, SCRIPT)
  if (!existsSync(script)) return [{ passed: false, differences: [`missing script: ${SCRIPT}`] }, []]
  let rows: NormalizedRow[]
  try {
    const raw = await runScript(script, dataPath)
    if (!Array.isArray(raw)) throw new Error(`${SCRIPT} must print a JSON array`)
    rows = raw.map((r, i) => parseRow(r, run.id, i))
    run.emit('info', 'Extractor produced rows', `${rows.length} rows in the normalized format`)
  } catch (e) {
    const message = (e as Error).message.split(/\s+/).join(' ').slice(0, 500)
    run.emit('fail', 'Extractor failed', message)
    return [{ passed: false, differences: [message] }, []]
  }
  const result = check(rows)
  if (result.passed) run.emit('ok', 'Checker passed', `debits = credits · ${rows.length} rows · source IDs unique`)
  else run.emit('fail', 'Checker failed', result.differences.join('; '))
  return [result, rows]
}

function summarizeLayoutChange(added: string[], removed: string[]): string {
  const lines = [...added.map((a) => `+ ${a}`), ...removed.map((r) => `− ${r}`)]
  const more = lines.length - MAX_LAYOUT_LINES
  return lines.slice(0, MAX_LAYOUT_LINES).join(' · ') + (more > 0 ? ` · …and ${more} more` : '')
}

function finishPass(run: Run, workspace: string, structure: string[], rows: NormalizedRow[]): void {
  const cache = join(dirs.cache(), ledger.slug(run.app))
  mkdirSync(cache, { recursive: true })
  copyFileSync(join(workspace, SCRIPT), join(cache, SCRIPT))
  writeFileSync(join(cache, LAYOUT_FILE), JSON.stringify(structure, null, 1))

  const db = ledger.pathFor(run.ledger_id)
  const changes = ledger.diff(run.app, rows, db)
  ledger.apply(run.app, run.id, changes, db, ledger.expand(run.data_path))
  const counts = { added: 0, changed: 0, deleted: 0 }
  for (const c of changes) counts[c.change]++
  run.changes = { ...counts, items: changes.slice(0, MAX_CHANGES_SHOWN) }
  run.rows_loaded = rows.length
  run.status = 'passed'
  const detail = changes.length
    ? `+${counts.added} added · ~${counts.changed} changed · −${counts.deleted} deleted`
    : 'no changes since the last load'
  run.emit('ok', 'Ledger updated', `${detail} (${rows.length} rows now)`)
}

/** UI automation is the last rung: on the repair attempt, or from the start if opted in. */
export function uiScope(run: Run, attempt: number): UiScope | null {
  const app = basename(run.app).replace(/\.app$/i, '')
  if (run.allow_ui && attempt === 1) return { app, why: 'The user turned on UI automation for this run.' }
  if (attempt === 2) return { app, why: "Reading the data directly didn't produce rows the checker accepts." }
  return null
}

async function runAgent(run: Run, workspace: string, dataPath: string, error: string[] | null, ui: UiScope | null): Promise<void> {
  const allowed = new Map<string, AllowedApp>()
  if (ui) {
    const found = await find(ui.app)
    allowed.set(ui.app.toLowerCase(), { app: found?.name ?? ui.app, bundleId: found?.bundle_id || undefined, path: found?.path ?? run.app })
  }
  const agent = new Agent({
    name: 'Extractor agent',
    emit: run.emit,
    scope: { scratch: workspace, servers: ui ? [SERVER] : [] },
    mcpServers: ui ? [computerServer({ emit: run.emit, allowed, saveShot: run.saveShot })] : [],
    done: () => existsSync(join(workspace, SCRIPT)),
  })
  try {
    await agent.send(buildPrompt(run.app, dataPath, workspace, error, ui))
  } finally {
    await agent.close()
  }
}

export async function execute(run: Run): Promise<void> {
  let workspace: string | null = null
  try {
    const dataPath = ledger.expand(run.data_path)
    if (!existsSync(dataPath)) throw new Error(`data path does not exist: ${dataPath}`)
    // A fresh temp folder outside the project, deleted when the run ends, so the agent
    // never sees earlier runs' work. realpath because macOS temp paths sit behind the
    // /var -> /private/var symlink.
    workspace = realpathSync(mkdtempSync(join(tmpdir(), `retronaut-${run.id}-`)))
    provideRuntime(workspace)
    run.emit('info', 'Connect requested', `app=${run.app} · data=${dataPath} · run=${run.id}`)

    const structure = layout.describe(dataPath)
    run.emit('info', 'Read data layout', `${structure.length} structure entries (tables, columns, fields)`)

    let error: string[] | null = null
    const cache = join(dirs.cache(), ledger.slug(run.app))
    if (existsSync(join(cache, SCRIPT)) && existsSync(join(cache, LAYOUT_FILE))) {
      const [added, removed] = layout.diff(JSON.parse(readFileSync(join(cache, LAYOUT_FILE), 'utf8')), structure)
      if (added.length || removed.length) {
        run.emit('fail', 'Data layout changed', summarizeLayoutChange(added, removed))
        run.emit('info', 'Not trusting the saved extractor', 'rewriting it with the agent')
      } else {
        copyFileSync(join(cache, SCRIPT), join(workspace, SCRIPT))
        run.emit('info', 'Data layout unchanged', `reusing the saved extractor from cache/${ledger.slug(run.app)}`)
        const [result, rows] = await evaluate(run, workspace, dataPath)
        if (result.passed) {
          run.used_cache = true
          finishPass(run, workspace, structure, rows)
          return
        }
        run.emit('info', 'Saved extractor broke', 'falling back to the agent')
        error = result.differences
      }
    }

    for (const attempt of [1, 2]) {
      run.emit('info', attempt === 1 ? 'Extractor agent started' : 'Repair: rerunning the agent with the error', `read-only: ${dataPath}`)
      const ui = uiScope(run, attempt)
      if (ui) run.emit('ui', 'UI automation enabled', `Retronaut's tools on ${ui.app} only`)
      try {
        await runAgent(run, workspace, dataPath, error, ui)
      } catch (e) {
        // still check whatever script it left behind
        run.emit('error', 'Extractor agent session crashed', `${(e as Error).name}: ${(e as Error).message}`)
      }
      const [result, rows] = await evaluate(run, workspace, dataPath)
      if (result.passed) {
        finishPass(run, workspace, structure, rows)
        return
      }
      error = result.differences
    }

    run.status = 'needs_human'
    run.gap = error ?? []
    run.emit('fail', 'Needs human', 'still failing after one repair; nothing loaded')
  } catch (e) {
    // surface anything unexpected to the dashboard
    run.status = 'error'
    run.gap = [`${(e as Error).name}: ${(e as Error).message}`]
    run.emit('error', 'Run crashed', run.gap[0])
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true })
    record(run)
  }
}

/** Persist the run's outcome next to its ledger, for provenance and flagged runs. */
function record(run: Run): void {
  try {
    ledger.recordRun(ledger.pathFor(run.ledger_id), run.app, ledger.expand(run.data_path), {
      run_id: run.id,
      status: run.status,
      started: run.events[0]?.ts ?? Date.now() / 1000,
      finished: Date.now() / 1000,
      used_cache: run.used_cache,
      rows_loaded: run.rows_loaded,
      gap: run.gap,
    })
  } catch (e) {
    // never let bookkeeping hide the run's own result
    run.emit('error', "Couldn't record the run", `${(e as Error).name}: ${(e as Error).message}`)
  }
}
