import { useEffect, useState } from 'react'

import { BuildCard } from './BuildCard'
import { api, type JobSnapshot } from './api'

const POLL_MS = 800

/**
 * The picture-in-picture: the live build card, floating in a corner of the screen while
 * a build or run is going. Display only; clicks pass through its window.
 */
export function Pip() {
  const [job, setJob] = useState<(JobSnapshot & { title: string }) | null>(null)

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
    <div className="pip">
      <div className="pip-title">
        <span className="brand-dot" aria-hidden="true" />
        <span className="pip-name">{job.title || 'Local Link'}</span>
        <span className="pip-kind">{job.kind === 'build' ? 'Building' : 'Running'}</span>
      </div>
      <BuildCard job={job} compact />
    </div>
  )
}
