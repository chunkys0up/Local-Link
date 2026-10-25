/**
 * Saved workflows, one folder each in workflows/<id>/:
 *   workflow.json  what it is: goal, plan, apps and connectors it uses, last outcome
 *   workflow.mjs   the script the builder wrote (healing rewrites it)
 *   state.json     what the script keeps between runs, e.g. work orders already invoiced
 *   history/       every earlier workflow.mjs, kept when a heal replaces it
 *   runs/<job>/    one folder per run: run.json (events, result), failure.json/.jpg
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Job } from './jobs'
import { dirs } from './paths'
import type { AllowedApp, Plan } from './tools'

export const SCRIPT = 'workflow.mjs'
export const STATE = 'state.json'

export type WorkflowStatus = 'building' | 'ready' | 'needs_attention' | 'failed'

export interface RunSummary {
  job_id: string
  kind: string
  status: string
  started: number
  finished: number | null
  summary: unknown
  error: string | null
  healed: boolean
}

export interface Workflow {
  id: string
  title: string
  goal: string
  status: WorkflowStatus
  created: number
  updated: number
  apps: AllowedApp[]
  connectors: string[]
  plan: Plan | null
  build_job: string | null
  runs: RunSummary[]
  heals: number
  note: string
}

export function folder(id: string): string {
  if (!/^wf_[a-z0-9]+$/.test(id)) throw new RangeError(`bad workflow id: ${JSON.stringify(id)}`)
  return join(dirs.workflows(), id)
}

/** A short title from the goal, until the builder names it from its plan. */
export function titleFrom(goal: string): string {
  const first = goal.trim().split(/[.\n]/)[0].trim()
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first || 'New workflow'
}

export function create(goal: string): Workflow {
  const now = Date.now() / 1000
  const wf: Workflow = {
    id: `wf_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    title: titleFrom(goal),
    goal: goal.trim(),
    status: 'building',
    created: now,
    updated: now,
    apps: [],
    connectors: [],
    plan: null,
    build_job: null,
    runs: [],
    heals: 0,
    note: '',
  }
  save(wf)
  return wf
}

export function save(wf: Workflow): Workflow {
  wf.updated = Date.now() / 1000
  mkdirSync(folder(wf.id), { recursive: true })
  writeFileSync(join(folder(wf.id), 'workflow.json'), JSON.stringify(wf, null, 2))
  return wf
}

export function get(id: string): Workflow | null {
  try {
    return JSON.parse(readFileSync(join(folder(id), 'workflow.json'), 'utf8'))
  } catch {
    return null
  }
}

export function list(): Workflow[] {
  if (!existsSync(dirs.workflows())) return []
  return readdirSync(dirs.workflows())
    .filter((name) => name.startsWith('wf_'))
    .map(get)
    .filter((w): w is Workflow => w !== null)
    .sort((a, b) => b.updated - a.updated)
}

export function update(id: string, change: (wf: Workflow) => void): Workflow {
  const wf = get(id)
  if (!wf) throw new RangeError(`no workflow ${id}`)
  change(wf)
  return save(wf)
}

/**
 * Builds live in memory, so a restart ends any that were going. Mark them, so they don't
 * show "building" forever. Called once when the engine starts, before any build begins.
 */
export function markInterrupted(): number {
  const stuck = list().filter((wf) => wf.status === 'building')
  for (const wf of stuck) {
    update(wf.id, (w) => {
      w.status = 'failed'
      w.note = 'Interrupted: Retronaut was restarted during the build. Delete it and build again.'
    })
  }
  return stuck.length
}

export function remove(id: string): void {
  rmSync(folder(id), { recursive: true, force: true })
}

export function script(id: string): string | null {
  const path = join(folder(id), SCRIPT)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Install a script (and the state its test run left) from an agent's working folder. */
export function install(id: string, workspace: string, reason: string): void {
  const dir = folder(id)
  const current = join(dir, SCRIPT)
  if (existsSync(current)) {
    mkdirSync(join(dir, 'history'), { recursive: true })
    copyFileSync(current, join(dir, 'history', `${Date.now()}-${reason}.mjs`))
  }
  copyFileSync(join(workspace, SCRIPT), current)
  if (existsSync(join(workspace, STATE))) copyFileSync(join(workspace, STATE), join(dir, STATE))
}

export function runDir(id: string, jobId: string): string {
  const dir = join(folder(id), 'runs', jobId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Keep a finished job's log next to the workflow, and its outcome in the run list. */
export function recordRun(job: Job, extra: { summary?: unknown; error?: string | null; healed?: boolean } = {}): void {
  writeFileSync(join(runDir(job.workflowId, job.id), 'run.json'), JSON.stringify(job.snapshot(), null, 2))
  update(job.workflowId, (wf) => {
    const run: RunSummary = {
      job_id: job.id,
      kind: job.kind,
      status: job.status,
      started: job.started,
      finished: job.finished,
      summary: extra.summary ?? null,
      error: extra.error ?? null,
      healed: extra.healed ?? false,
    }
    wf.runs = [run, ...wf.runs.filter((r) => r.job_id !== job.id)].slice(0, 50)
  })
}

/** A finished run's saved log, for runs from before this engine started. */
export function savedRun(id: string, jobId: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(folder(id), 'runs', jobId, 'run.json'), 'utf8'))
  } catch {
    return null
  }
}

export function reset(): void {
  rmSync(dirs.workflows(), { recursive: true, force: true })
}
