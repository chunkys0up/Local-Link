import { useEffect, useState } from 'react'

import { friendly, jobTitle, recentSteps, stepProgress } from './BuildCard'
import { api, pipHover, type JobSnapshot } from './api'

const POLL_MS = 800

type LiveJob = JobSnapshot & { title: string; expected_steps: number | null }

/**
 * The picture-in-picture: what the build or run is doing and its last three steps,
 * floating in a corner of the screen while one is going. Display only; clicks pass
 * through its window, and the window fades away while the pointer is over the card.
 */
export function Pip() {
  const [job, setJob] = useState<LiveJob | null>(null)

  useEffect(() => {
    document.body.classList.add('pip-body')
    let stopped = false
    const tick = async () => {
      try {
        const live = await api<LiveJob | null>('/live')
        if (!stopped) setJob(live)
      } catch {
        // the engine is restarting; keep the last card
      }
      if (!stopped) setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
    }
  }, [])

  if (!job) return null
  const progress = stepProgress(job, job.expected_steps)
  // The window ignores the mouse but still hears it move; Electron fades it while it's over the card.
  return (
    <div className="pip" onMouseEnter={() => pipHover(true)} onMouseLeave={() => pipHover(false)}>
      <div className="pip-title">
        <span className="brand-dot" aria-hidden="true" />
        <span className="pip-name">{job.title || 'Retronaut'}</span>
        <span className="pip-status">{jobTitle(job)}</span>
        {progress && <span className="pip-count">{progress}</span>}
      </div>
      <ul className="pip-steps" aria-label="Recent steps">
        {recentSteps(job, 3).map((e) => (
          <li key={e.i}>
            <span className={`dot dot-${e.kind}`} aria-hidden="true" />
            <span className="hint-text">{friendly(e)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
