/**
 * A build's phases, worked out from its event log: which one it's in, when it entered
 * each, and how long each took. Pure, so it runs in tests as well as the page.
 */

import type { JobSnapshot } from './api'

export const BUILD_PHASES = [
  { id: 'understand', label: 'Understanding' },
  { id: 'connect', label: 'Connecting' },
  { id: 'explore', label: 'Exploring' },
  { id: 'plan', label: 'Planning' },
  { id: 'write', label: 'Writing' },
  { id: 'test', label: 'Testing' },
] as const
type PhaseId = (typeof BUILD_PHASES)[number]['id']

export function buildPhase(job: JobSnapshot): number {
  let phase = 0
  const reach = (id: PhaseId) => (phase = Math.max(phase, BUILD_PHASES.findIndex((p) => p.id === id)))
  for (const r of job.requests) {
    if (r.kind === 'app' || r.kind === 'connector') reach('connect')
    if (r.kind === 'plan') reach(r.status === 'approved' ? 'write' : 'plan')
  }
  for (const e of job.events) {
    if (e.kind === 'request' || e.kind === 'connector') reach('connect')
    else if (e.kind === 'ui' || /ToolSearch|gmail|mail/i.test(e.label)) reach('explore')
    else if (e.kind === 'plan') reach('plan')
    else if (e.kind === 'step' || e.label.startsWith('Test run')) reach('test')
  }
  return phase
}

const phaseIndex = (id: PhaseId) => BUILD_PHASES.findIndex((p) => p.id === id)

/**
 * When the build entered each phase (seconds; null if it hasn't): the time of the event
 * that first moved it there, walking the log in order like buildPhase does. Writing starts
 * when the plan was approved. Logs from before approvals were timed: the builder's first
 * action after it went quiet, waiting on the plan (a pause of PAUSE seconds or more).
 */
const PAUSE = 10

export function phaseStarts(job: JobSnapshot): (number | null)[] {
  const starts: (number | null)[] = BUILD_PHASES.map(() => null)
  starts[0] = job.started
  let phase = 0
  const reach = (id: PhaseId, ts: number) => {
    const next = phaseIndex(id)
    for (let i = phase + 1; i <= next; i++) starts[i] = ts
    phase = Math.max(phase, next)
  }
  const plan = job.requests.find((r) => r.kind === 'plan' && r.status === 'approved')
  const approvedAt = plan?.answered ?? null
  let planShown: number | null = null
  let previous = job.started
  for (const e of job.events) {
    const quietBefore = e.ts - previous
    previous = e.ts
    if (approvedAt !== null && e.ts >= approvedAt) reach('write', approvedAt)
    if (e.kind === 'request' || e.kind === 'connector') reach('connect', e.ts)
    else if (e.kind === 'plan') {
      reach('plan', e.ts)
      planShown = e.ts
    } else if (e.kind === 'step' || e.label.startsWith('Test run')) reach('test', e.ts)
    else if (plan && approvedAt === null && planShown !== null && e.kind === 'agent' && quietBefore >= PAUSE) reach('write', e.ts)
    else if (e.kind === 'ui' || /ToolSearch|gmail|mail/i.test(e.label)) reach('explore', e.ts)
  }
  if (approvedAt !== null) reach('write', approvedAt)
  return starts
}

/** Seconds from `from` to `to` that the build wasn't paused (time paused doesn't count). */
export function activeSeconds(job: JobSnapshot, from: number, to: number): number {
  let paused = 0
  for (const [start, end] of job.pauses ?? []) {
    const a = Math.max(start, from)
    const b = Math.min(end ?? to, to)
    if (b > a) paused += b - a
  }
  return Math.max(0, to - from - paused)
}

/**
 * How long each phase took, or has taken so far (seconds, leaving out time paused); null for
 * phases not reached, or passed through without time of their own.
 */
export function phaseDurations(job: JobSnapshot, now: number): (number | null)[] {
  const starts = phaseStarts(job)
  const current = job.status === 'passed' ? BUILD_PHASES.length - 1 : buildPhase(job)
  const running = job.status === 'running' || job.status === 'waiting'
  const end = running ? now : (job.finished ?? now)
  return starts.map((start, i) => {
    if (start === null || i > current) return null
    const next = starts.slice(i + 1).find((t): t is number => t !== null)
    const took = activeSeconds(job, start, i < current && next !== undefined ? next : end)
    return i < current && took < 1 ? null : Math.max(0, took)
  })
}
