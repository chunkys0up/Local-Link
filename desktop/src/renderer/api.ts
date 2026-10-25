// The engine's API as the renderer sees it (always under /api), and the shapes it returns.

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d: { detail?: string }) => d.detail)
      .catch(() => res.statusText)
    throw new ApiError(res.status, detail || `${res.status}`)
  }
  return res.json() as Promise<T>
}

/** Electron's preload bridge; absent when the UI is opened in a plain browser. */
type Bridge = {
  openExternal: (url: string) => Promise<void>
  openPrivacy: (pane: 'accessibility' | 'screen') => Promise<void>
  onAttention: (listener: (workflowId: string) => void) => () => void
  pipHover: (over: boolean) => void
}
const bridge = (window as unknown as { retronaut?: Bridge }).retronaut

export function openExternal(url: string): void {
  if (bridge) void bridge.openExternal(url)
  else window.open(url, '_blank', 'noopener')
}

export function openPrivacy(pane: 'accessibility' | 'screen'): void {
  if (bridge) void bridge.openPrivacy(pane)
}

export const inElectron = Boolean(bridge)

/** Tell the picture-in-picture's window the pointer is over it, or has left. */
export function pipHover(over: boolean): void {
  bridge?.pipHover(over)
}

/** When the engine needs the person on a workflow's page (Electron only). */
export function onAttention(listener: (workflowId: string) => void): () => void {
  return bridge ? bridge.onAttention(listener) : () => {}
}

export type Health = {
  droid: string | null
  api_key: boolean
  accessibility: boolean | null
  screen_recording: string | null
  gmail: string | null
  env_files: string[]
}

export type PlanStep = { title: string; how: string; detail: string }
export type Plan = { name?: string; summary: string; steps: PlanStep[]; apps: string[]; connectors: string[] }

export type WorkflowStatus = 'building' | 'ready' | 'needs_attention' | 'failed'

export type RunSummary = {
  job_id: string
  kind: 'build' | 'run' | 'heal'
  status: string
  started: number
  finished: number | null
  summary: unknown
  error: string | null
  healed: boolean
}

export type Workflow = {
  id: string
  title: string
  goal: string
  status: WorkflowStatus
  created: number
  updated: number
  apps: { app: string; bundleId?: string; path: string }[]
  connectors: string[]
  plan: Plan | null
  build_job: string | null
  runs: RunSummary[]
  heals: number
  note: string
  script?: string | null
}

export type JobEvent = { i: number; ts: number; kind: string; label: string; detail: string; image?: string }

export type UserRequest = {
  id: string
  kind: 'app' | 'connector' | 'plan' | 'question'
  title: string
  reason: string
  data: Record<string, unknown>
  status: 'pending' | 'approved' | 'declined'
  feedback: string
}

export type JobStatus = 'running' | 'waiting' | 'passed' | 'failed' | 'error'

export type JobSnapshot = {
  job_id: string
  kind: 'build' | 'run' | 'heal'
  workflow_id: string
  status: JobStatus
  started: number
  finished: number | null
  result: Record<string, unknown> | null
  requests: UserRequest[]
  events: JobEvent[]
}

export const live = (status: JobStatus | undefined) => status === 'running' || status === 'waiting'
