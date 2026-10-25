import { useEffect, useState } from 'react'

import { live, type JobEvent, type JobSnapshot } from './api'

// ---------- the build's phases, worked out from its events ----------

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

/** A tool call as a person would describe it. */
export function friendly(e: JobEvent): string {
  const label = e.label.replace(/^(Builder|Healer|Extractor agent): /, '')
  if (e.kind === 'ui' || e.kind === 'step' || e.kind === 'ok' || e.kind === 'fail' || e.kind === 'info') return e.label
  if (/^says$/.test(label)) return e.detail
  if (/^(Read|LS|Glob|Grep)\b/.test(label)) return `Looking at ${e.detail.split('/').pop() || 'files'}`
  if (/^Execute\b/.test(label)) return `Running ${e.detail.split(' ').slice(0, 3).join(' ')}`
  if (/^(Create|Edit|ApplyPatch|MultiEdit)\b/.test(label)) return `Writing ${e.detail.split('/').pop() || 'code'}`
  if (/^ToolSearch\b/.test(label)) return 'Looking for the right tools'
  if (/gmail|mail|message|thread/i.test(label)) return 'Reading your email'
  // Retronaut's own tools (named locallink___ in runs from before the rename).
  if (/^(retronaut|locallink)___/.test(label)) return label.replace(/^(retronaut|locallink)___/, '').replace(/_/g, ' ')
  return label
}

// Agent calls that only organise its own work; not worth showing as "what it's doing".
const BOOKKEEPING = /: (TodoWrite|Script|ToolSearch|(retronaut|locallink)___\w+)( error)?$/

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The live build or run at a glance: what it's doing, its phase, the latest screenshot
 * and the last few actions. In the app, and (compact) in the picture-in-picture.
 */
export function BuildCard({ job, onStop, compact = false }: { job: JobSnapshot; onStop?: () => void; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  const running = live(job.status)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [running])

  const pending = job.requests.filter((r) => r.status === 'pending')
  const phase = job.kind === 'build' ? buildPhase(job) : -1
  const shot = [...job.events].reverse().find((e) => e.image)
  const recent = job.events.filter((e) => !BOOKKEEPING.test(e.label) && (e.kind !== 'info' || e.label.startsWith('Test'))).slice(compact ? -3 : -4)
  const latest = job.events[job.events.length - 1]
  const elapsed = (running ? now : (job.finished ?? now)) - job.started
  const title =
    job.kind === 'build'
      ? running
        ? pending.length
          ? 'Waiting for you'
          : `${BUILD_PHASES[phase].label}…`
        : job.status === 'passed'
          ? 'Workflow built'
          : 'Build stopped'
      : running
        ? job.events.some((e) => e.label === 'Healing')
          ? 'Healing…'
          : 'Running…'
        : job.status === 'passed'
          ? 'Run finished'
          : 'Run failed'

  return (
    <section className={`card build ${running ? 'build-live' : `build-${job.status}`}${compact ? ' compact' : ''}`} aria-live="polite">
      <div className="build-top">
        <div className={`orb${running && !pending.length ? ' orb-live' : ''}`} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="build-text">
          <h2>{title}</h2>
          <p className="muted small">
            {latest ? friendly(latest) : 'Starting the agent…'} · <span className="mono">{formatDuration(elapsed)}</span>
          </p>
        </div>
        {running && onStop && (
          <button type="button" className="secondary stop" onClick={onStop}>
            Stop
          </button>
        )}
      </div>

      {job.kind === 'build' && (
        <ol className="phases" aria-label="Build progress">
          {BUILD_PHASES.map((p, i) => (
            <li key={p.id} className={i < phase || job.status === 'passed' ? 'done' : i === phase && running ? 'now' : ''}>
              <span className="phase-dot" aria-hidden="true" />
              {p.label}
            </li>
          ))}
        </ol>
      )}

      {(shot || recent.length > 0) && (
        <div className="hints">
          {shot && (
            <figure className="hint-shot">
              <img src={`/api${shot.image}`} alt={shot.label} />
              <figcaption className="small muted">{shot.label}</figcaption>
            </figure>
          )}
          <ul className="hint-list" aria-label="Recent actions">
            {recent.map((e) => (
              <li key={e.i}>
                <span className={`dot dot-${e.kind}`} aria-hidden="true" />
                <span className="hint-text">{friendly(e)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
