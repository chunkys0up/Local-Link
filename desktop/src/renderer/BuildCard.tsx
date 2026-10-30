import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

import { live, type JobEvent, type JobSnapshot } from './api'
import { BUILD_PHASES, activeSeconds, buildPhase, phaseDurations } from './phases'

/**
 * Pausing a build: the current phase's sweep (a CSS animation on its ::after) eases to a stop
 * rather than halting; resuming picks it up again. (Shell.css dims it while paused.)
 */
function usePausedSweep(list: RefObject<HTMLOListElement | null>, paused: boolean): void {
  useEffect(() => {
    const dot = list.current?.querySelector<HTMLElement>('li.now .phase-dot')
    const sweep = dot?.getAnimations({ subtree: true }).find((a) => (a as CSSAnimation).animationName?.startsWith('phase-run'))
    if (!sweep) return
    if (!paused) {
      sweep.playbackRate = 1
      sweep.play()
      return
    }
    // Slow it to a stop over half a second (ease-out), then hold it there.
    const start = performance.now()
    let frame = requestAnimationFrame(function slow(now) {
      const t = Math.min(1, (now - start) / 500)
      sweep.playbackRate = (1 - t) ** 2
      if (t < 1) frame = requestAnimationFrame(slow)
      else sweep.pause()
    })
    return () => cancelAnimationFrame(frame)
  }, [list, paused])
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

/** The last few things it did that a person would care about. */
export function recentSteps(job: JobSnapshot, count: number): JobEvent[] {
  return job.events.filter((e) => !BOOKKEEPING.test(e.label) && (e.kind !== 'info' || e.label.startsWith('Test'))).slice(-count)
}

/** What the build or run is doing, in a couple of words. */
export function jobTitle(job: JobSnapshot): string {
  const running = live(job.status)
  if (running && job.paused) return 'Paused'
  if (job.kind === 'build') {
    if (!running) return job.status === 'passed' ? 'Workflow built' : 'Build stopped'
    return job.requests.some((r) => r.status === 'pending') ? 'Waiting for you' : `${BUILD_PHASES[buildPhase(job)].label}…`
  }
  if (!running) return job.status === 'passed' ? 'Run finished' : 'Run failed'
  return job.events.some((e) => e.label === 'Healing') ? 'Healing…' : 'Running…'
}

/**
 * "Step 3/6": a build's phase, or the script step a run is on, out of what the last good
 * run took (just "Step 3" until there's been one).
 */
export function stepProgress(job: JobSnapshot, expected: number | null): string | null {
  if (job.kind === 'build') return `Step ${buildPhase(job) + 1}/${BUILD_PHASES.length}`
  const at = job.events.reduce((most, e) => Math.max(most, Number(/^Step (\d+):/.exec(e.label)?.[1] ?? 0)), 0)
  if (!at) return null
  return expected ? `Step ${at}/${Math.max(at, expected)}` : `Step ${at}`
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The live build or run at a glance: what it's doing, its phase, the latest screenshot
 * and the last few actions.
 */
export function BuildCard({
  job,
  onStop,
  onPause,
  cardRef,
  bar,
}: {
  job: JobSnapshot
  onStop?: () => void
  onPause?: (paused: boolean) => void
  /** The card's element, e.g. for the send animation to land on. */
  cardRef?: (el: HTMLElement | null) => void
  /** Shown as the bar across the top of the page (a build), with this caption inside. */
  bar?: { caption: ReactNode }
}) {
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
  const recent = recentSteps(job, 4)
  const latest = job.events[job.events.length - 1]
  const elapsed = activeSeconds(job, job.started, running ? now : (job.finished ?? now)) // paused time doesn't count
  const title = jobTitle(job)

  const state = `${running ? 'build-live' : `build-${job.status}`}${running && job.paused ? ' build-paused' : ''}`
  const took = job.kind === 'build' ? phaseDurations(job, now) : []
  const phaseList = useRef<HTMLOListElement>(null)
  usePausedSweep(phaseList, running && Boolean(job.paused))
  const phases = job.kind === 'build' && (
    <ol className="phases" aria-label="Build progress" ref={phaseList}>
      {BUILD_PHASES.map((p, i) => (
        <li key={p.id} className={i < phase || job.status === 'passed' ? 'done' : i === phase && running ? 'now' : ''}>
          <span className="phase-dot" aria-hidden="true" />
          <span className="phase-label">
            {p.label}
            {took[i] != null && <span className="phase-time">{formatDuration(took[i]!)}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
  const content = (
    <>
      <div className="build-top">
        <div className={`blocks${running && !pending.length && !job.paused ? ' blocks-live' : ''}`} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="build-text">
          <h2>{title}</h2>
          <p className="muted small">
            {latest ? friendly(latest) : 'Starting the agent…'} · <span className="timer">{formatDuration(elapsed)}</span>
          </p>
        </div>
        {running && (onStop || onPause) && (
          <div className="build-controls">
            {onPause && job.kind === 'build' && (
              <button type="button" className="secondary" onClick={() => onPause(!job.paused)}>
                {job.paused ? 'Resume' : 'Pause'}
              </button>
            )}
            {onStop && (
              <button type="button" className="secondary stop" onClick={onStop}>
                Stop
              </button>
            )}
          </div>
        )}
      </div>

      {!bar && phases}

      {/* Not in the build bar, for now: it would change the bar's height as steps come in. */}
      {!bar && (shot || recent.length > 0) && (
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
    </>
  )

  if (bar) {
    return (
      <section ref={cardRef} className={`build build-bar ${state}`} aria-live="polite">
        <div className="build-bar-inner">
          {bar.caption}
          {content}
        </div>
        {/* The phases are the bar's bottom edge, each label above its segment. */}
        {phases}
      </section>
    )
  }
  return (
    <section ref={cardRef} className={`card build ${state}`} aria-live="polite">
      {content}
    </section>
  )
}
