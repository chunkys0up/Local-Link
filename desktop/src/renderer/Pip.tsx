import { useEffect, useState } from 'react'

import { friendly, jobTitle, recentSteps } from './BuildCard'
import { api, type JobSnapshot } from './api'

const POLL_MS = 800

/**
 * The picture-in-picture: what the build or run is doing and its last three steps,
 * floating in a corner of the screen while one is going. Display only; clicks pass
 * through its window, and it fades away while the pointer is over it.
 */
export function Pip() {
  const [job, setJob] = useState<(JobSnapshot & { title: string }) | null>(null)
  // The window ignores the mouse but still hears it move, so hovering can hide the card.
  const [away, setAway] = useState(false)

  useEffect(() => {
    document.body.classList.add('pip-body')
    let stopped = false
    const tick = async () => {
      try {
        const live = await api<(JobSnapshot & { title: string }) | null>('/live')
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
  return (
    <div className={`pip${away ? ' away' : ''}`} onMouseEnter={() => setAway(true)} onMouseLeave={() => setAway(false)}>
      <div className="pip-title">
        <span className="brand-dot" aria-hidden="true" />
        <span className="pip-name">{job.title || 'Retronaut'}</span>
        <span className="pip-status">{jobTitle(job)}</span>
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
