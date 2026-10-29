/**
 * A job is one piece of agent or script work the UI follows: building a workflow,
 * running it, or healing it. It keeps an event log (polled with ?after=n), the
 * screenshots behind its events, and requests that wait on the user (allow an app,
 * connect an account, approve the plan).
 */

import { randomUUID } from 'node:crypto'

export type JobKind = 'build' | 'run' | 'heal'
export type JobStatus = 'running' | 'waiting' | 'passed' | 'failed' | 'error'

export interface JobEvent {
  i: number
  ts: number
  kind: string
  label: string
  detail: string
  image?: string
}

export type RequestKind = 'app' | 'connector' | 'plan' | 'question'

export interface UserRequest {
  id: string
  kind: RequestKind
  title: string
  reason: string
  data: Record<string, unknown>
  status: 'pending' | 'approved' | 'declined'
  feedback: string
  asked: number // seconds
  answered: number | null
}

const MAX_SHOTS = 60

export class Job {
  readonly id = `job_${randomUUID().slice(0, 8)}`
  readonly started = Date.now() / 1000
  status: JobStatus = 'running'
  finished: number | null = null
  events: JobEvent[] = []
  requests: UserRequest[] = []
  result: Record<string, unknown> | null = null
  private shots = new Map<number, Buffer>()
  private nextShot = 0
  private waiters = new Map<string, (r: UserRequest) => void>()
  private stoppers: (() => unknown)[] = []
  private wasStopped = false
  /** Paused by the user: the agent holds its next action until resumed. Builds only. */
  paused = false
  private resumers: (() => void)[] = []

  constructor(
    readonly kind: JobKind,
    readonly workflowId: string,
  ) {}

  emit = (kind: string, label: string, detail = '', image?: string): void => {
    this.events.push({ i: this.events.length, ts: Date.now() / 1000, kind, label, detail, ...(image ? { image } : {}) })
  }

  saveShot = (jpeg: Buffer): string => {
    const n = this.nextShot++
    this.shots.set(n, jpeg)
    this.shots.delete(n - MAX_SHOTS)
    return `/jobs/${this.id}/shots/${n}.jpg`
  }

  shot(n: number): Buffer | undefined {
    return this.shots.get(n)
  }

  /** Ask the user; resolves when they answer in the UI. */
  ask(kind: RequestKind, title: string, reason: string, data: Record<string, unknown> = {}): Promise<UserRequest> {
    const request: UserRequest = { id: `req_${randomUUID().slice(0, 8)}`, kind, title, reason, data, status: 'pending', feedback: '', asked: Date.now() / 1000, answered: null }
    this.requests.push(request)
    this.status = 'waiting'
    return new Promise((resolve) => {
      this.waiters.set(request.id, (answered) => {
        if (this.finished === null && !this.requests.some((r) => r.status === 'pending')) this.status = 'running'
        resolve(answered)
      })
    })
  }

  answer(requestId: string, approved: boolean, feedback = ''): UserRequest {
    const request = this.requests.find((r) => r.id === requestId)
    if (!request) throw new RangeError(`no request ${requestId}`)
    if (request.status !== 'pending') return request
    request.status = approved ? 'approved' : 'declined'
    request.feedback = feedback
    request.answered = Date.now() / 1000
    this.waiters.get(requestId)?.(request)
    this.waiters.delete(requestId)
    return request
  }

  /** Decline whatever is still waiting, e.g. when the job is stopped. */
  cancelRequests(): void {
    for (const r of this.requests) if (r.status === 'pending') this.answer(r.id, false, 'cancelled')
  }

  /** Something to end if the user stops the job: an agent session, a script process. */
  onStop(fn: () => unknown): void {
    this.stoppers.push(fn)
  }

  get stopped(): boolean {
    return this.wasStopped
  }

  /** The user pressed Pause: whatever the agent is doing finishes, then it waits. */
  pause(): void {
    if (this.finished !== null || this.paused || this.kind !== 'build') return
    this.paused = true
    this.emit('info', 'Paused', 'the builder waits before its next action until you resume')
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (this.finished === null) this.emit('info', 'Resumed', 'the builder carries on')
    for (const go of this.resumers.splice(0)) go()
  }

  /** Resolves at once, or when the job is resumed (or stopped). */
  whenRunning = (): Promise<void> => (this.paused ? new Promise((go) => this.resumers.push(go)) : Promise.resolve())

  /** The user pressed Stop: end everything the job started; nothing else is done. */
  async stop(): Promise<void> {
    if (this.finished !== null) return
    this.wasStopped = true
    this.paused = false
    for (const go of this.resumers.splice(0)) go()
    this.emit('fail', 'Stopped', `you stopped this ${this.kind === 'build' ? 'build' : 'run'}`)
    this.finish('failed', { error: 'Stopped by you' })
    for (const fn of this.stoppers) {
      try {
        await fn()
      } catch {
        // already gone
      }
    }
  }

  finish(status: Exclude<JobStatus, 'running' | 'waiting'>, result: Record<string, unknown> | null = null): void {
    if (this.finished !== null) return // stopped first; keep that outcome
    this.status = status
    this.result = result
    this.finished = Date.now() / 1000
    this.cancelRequests()
  }

  snapshot(after = 0) {
    return {
      job_id: this.id,
      kind: this.kind,
      workflow_id: this.workflowId,
      status: this.status,
      paused: this.paused,
      started: this.started,
      finished: this.finished,
      result: this.result,
      requests: this.requests,
      events: this.events.slice(after),
    }
  }
}

export const JOBS = new Map<string, Job>()

/** The newest build or run still going, for the frame and the picture-in-picture. */
export function liveJob(): Job | null {
  return [...JOBS.values()].reverse().find((j) => j.status === 'running' || j.status === 'waiting') ?? null
}

// ---------- asking for the person's attention ----------

type AttentionListener = (job: Job, why: string) => void
const attentionListeners = new Set<AttentionListener>()

/** Called (by Electron) when a job needs the person to look: bring the app forward. */
export function onAttention(listener: AttentionListener): () => void {
  attentionListeners.add(listener)
  return () => attentionListeners.delete(listener)
}

/**
 * A job needs the person now: a question or card is waiting and the agent has stopped,
 * or the job ended. Only call it when nothing is driving an app, or the app coming
 * forward would fight the automation for focus.
 */
export function needAttention(job: Job, why: string): void {
  for (const l of attentionListeners) l(job, why)
}

export function newJob(kind: JobKind, workflowId: string): Job {
  const job = new Job(kind, workflowId)
  JOBS.set(job.id, job)
  return job
}

export function anyRunning(): boolean {
  return [...JOBS.values()].some((j) => j.status === 'running' || j.status === 'waiting')
}
