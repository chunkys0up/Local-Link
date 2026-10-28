import { useCallback, useEffect, useMemo, useState } from 'react'

import { BuildCard, formatDuration } from './BuildCard'
import type { Intro } from './Flight'
import { api, live, openExternal, type JobEvent, type JobSnapshot, type Plan, type RunSummary, type UserRequest, type Workflow } from './api'

const POLL_MS = 900

const STATUS_LABEL: Record<Workflow['status'], string> = {
  building: 'Building',
  ready: 'Ready',
  needs_attention: 'Needs attention',
  failed: 'Build failed',
}

const HOW_LABEL: Record<string, string> = {
  connector: 'Account',
  file: 'Data file',
  menu: 'Menus',
  keyboard: 'Keyboard',
  accessibility: 'Accessibility',
  coordinates: 'Clicks',
  compute: 'Compute',
  verify: 'Check',
}

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function summaryText(summary: unknown): string {
  if (!summary || typeof summary !== 'object') return summary ? String(summary) : ''
  return Object.entries(summary as Record<string, unknown>)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}

// ---------- requests that wait on the user ----------

const BACKUP_LABEL: Record<string, string> = {
  files: 'Copies its data files',
  app: "Uses the app's own backup",
  export: 'Exports and re-imports',
  none: 'No backup',
}

function PlanSteps({ plan }: { plan: Plan }) {
  return (
    <>
      <PlanList plan={plan} />
      {plan.backup && (
        <div className={`plan-backup${plan.backup.method === 'none' ? ' plan-backup-none' : ''}`}>
          <div className="plan-title">
            Before each test <span className="how how-backup">{BACKUP_LABEL[plan.backup.method] ?? plan.backup.method}</span>
          </div>
          <div className="muted small">
            {plan.backup.method === 'none'
              ? `${plan.backup.detail} Tests will change your data with no automatic undo.`
              : `${plan.backup.detail} If a test fails, Retronaut restores this backup.`}
          </div>
        </div>
      )}
    </>
  )
}

function PlanList({ plan }: { plan: Plan }) {
  return (
    <ol className="plan-steps">
      {plan.steps.map((s, i) => (
        <li key={i}>
          <span className="plan-num">{i + 1}</span>
          <div className="plan-body">
            <div className="plan-title">
              {s.title} <span className={`how how-${s.how}`}>{HOW_LABEL[s.how] ?? s.how}</span>
            </div>
            <div className="muted small">{s.detail}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function RequestCard({ request, onAnswer }: { request: UserRequest; onAnswer: (approved: boolean, feedback?: string) => Promise<void> }) {
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const answer = async (approved: boolean, text?: string) => {
    setBusy(true)
    try {
      await onAnswer(approved, text)
    } finally {
      setBusy(false)
    }
  }

  if (request.kind === 'plan') {
    const plan = request.data.plan as Plan
    return (
      <section className="card request request-plan" aria-label="Review the plan">
        <div className="request-head">
          <span className="request-icon" aria-hidden="true">✦</span>
          <div>
            <h2>Here's the plan</h2>
            <p className="muted">{plan.summary}</p>
          </div>
        </div>
        <PlanSteps plan={plan} />
        <textarea
          className="feedback"
          placeholder="Anything to change? (optional)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
        />
        <div className="request-actions">
          <button type="button" className="secondary" disabled={busy || !feedback.trim()} onClick={() => answer(false, feedback)}>
            Send changes
          </button>
          <button type="button" disabled={busy} onClick={() => answer(true, feedback)}>
            Approve plan
          </button>
        </div>
      </section>
    )
  }

  if (request.kind === 'question') {
    return <QuestionCard request={request} onAnswer={answer} busy={busy} />
  }

  if (request.kind === 'connector') {
    const url = String(request.data.url ?? '')
    const name = String(request.data.connector ?? '')
    return (
      <section className="card request" aria-label={request.title}>
        <div className="request-head">
          <span className="request-icon connector" aria-hidden="true">@</span>
          <div>
            <h2>{request.title}</h2>
            <p className="muted">{request.reason}</p>
            <p className="small muted">
              Retronaut uses Factory's {name || 'account'} connector: you sign in once, and Factory keeps the access token. Nothing is sent or changed without being part of your plan.
            </p>
          </div>
        </div>
        <div className="request-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => answer(false)}>
            Not now
          </button>
          {url && (
            <button type="button" className="secondary" onClick={() => openExternal(url)}>
              Open sign-in
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => answer(true)}>
            I've connected it
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="card request" aria-label={request.title}>
      <div className="request-head">
        <span className="request-icon" aria-hidden="true">⌘</span>
        <div>
          <h2>{request.title}</h2>
          <p className="muted">{request.reason}</p>
          <p className="small muted">
            Retronaut will open it, read its windows and data, and click and type only inside it.
            {request.data.kind === 'gtk' && ' It mostly uses menus and the keyboard here, since this app shows little to accessibility.'}
          </p>
        </div>
      </div>
      <div className="request-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => answer(false)}>
          Don't allow
        </button>
        <button type="button" disabled={busy} onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    </section>
  )
}

type Asked = { index: number; topic: string; question: string; options: string[]; multiSelect?: boolean }

/** droid's AskUser: one or more questions, each with options and room for your own answer. */
function QuestionCard({ request, onAnswer, busy }: { request: UserRequest; onAnswer: (approved: boolean, feedback?: string) => Promise<void>; busy: boolean }) {
  const asked = (request.data.questions as Asked[] | undefined) ?? []
  const [answers, setAnswers] = useState<string[]>(() => asked.map(() => ''))
  const set = (i: number, value: string) => setAnswers((prev) => prev.map((a, j) => (j === i ? value : a)))
  const toggle = (i: number, option: string) => {
    const picked = answers[i] ? answers[i].split('; ') : []
    set(i, (picked.includes(option) ? picked.filter((p) => p !== option) : [...picked, option]).join('; '))
  }
  return (
    <section className="card request" aria-label={request.title}>
      <div className="request-head">
        <span className="request-icon" aria-hidden="true">?</span>
        <div>
          <h2>The builder has {asked.length === 1 ? 'a question' : 'some questions'}</h2>
        </div>
      </div>
      {asked.map((q, i) => (
        <div key={q.index} className="question">
          <div className="question-text">{q.question}</div>
          <div className="options">
            {q.options.map((o) => {
              const chosen = q.multiSelect ? answers[i].split('; ').includes(o) : answers[i] === o
              return (
                <button key={o} type="button" className={`option${chosen ? ' chosen' : ''}`} onClick={() => (q.multiSelect ? toggle(i, o) : set(i, o))}>
                  {o}
                </button>
              )
            })}
          </div>
          <input
            className="feedback"
            placeholder="Or write your own answer"
            value={q.options.includes(answers[i]) ? '' : answers[i]}
            onChange={(e) => set(i, e.target.value)}
          />
        </div>
      ))}
      <div className="request-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => onAnswer(false)}>
          Skip
        </button>
        <button type="button" disabled={busy || answers.some((a) => !a.trim())} onClick={() => onAnswer(true, JSON.stringify(answers))}>
          Answer
        </button>
      </div>
    </section>
  )
}

// ---------- activity ----------

function EventList({ events, start }: { events: JobEvent[]; start: number }) {
  return (
    <ol className="activity">
      {events.map((e) => (
        <li key={e.i}>
          <span className={`dot dot-${e.kind}`} aria-hidden="true" />
          <div className="event-body">
            <div className="event-label">{e.label}</div>
            {e.detail && <div className="mono muted small event-detail">{e.detail}</div>}
            {e.image && <img className="event-shot" src={`/api${e.image}`} alt={e.label} loading="lazy" />}
          </div>
          <span className="mono muted small event-time">+{formatDuration(e.ts - start)}</span>
        </li>
      ))}
    </ol>
  )
}

/** The live job: what the agent is doing right now, and what it needs from the user. */
function JobPanel({
  job,
  onAnswer,
  onStop,
  onPause,
  spring = false,
}: {
  job: JobSnapshot
  onAnswer: (r: UserRequest, approved: boolean, feedback?: string) => Promise<void>
  onStop: () => Promise<void>
  onPause: (paused: boolean) => Promise<void>
  /** Arriving from the send animation: the cards spring in, one after another. */
  spring?: boolean
}) {
  const [open, setOpen] = useState(false)
  const running = live(job.status)
  const pending = job.requests.filter((r) => r.status === 'pending')

  return (
    <div className={`job${spring ? ' springing' : ''}`}>
      <BuildCard job={job} onStop={onStop} onPause={onPause} />

      {pending.map((r) => (
        <RequestCard key={r.id} request={r} onAnswer={(approved, feedback) => onAnswer(r, approved, feedback)} />
      ))}

      {!running && job.result?.error != null && (
        <section className={`alert${job.result.review ? "" : " alert-error"}`} role="alert">
          <div className="alert-body">
            <h2>{job.result.review ? 'Needs your review' : job.kind === 'build' ? 'The build needs a human' : 'This run needs a human'}</h2>
            {job.result.review === true && <p className="small">The workflow stopped on purpose: this needs your decision, so nothing was healed or retried.</p>}
            <p className="mono small">{String(job.result.error)}</p>
          </div>
        </section>
      )}

      <section className={`card events${open ? ' open' : ''}`} aria-label="Activity">
        <button type="button" className="events-bar" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="events-bar-name">Activity</span>
          <span className="events-bar-latest muted">{job.events.length} events</span>
          <span className="events-bar-chevron" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
        {open && <EventList events={job.events} start={job.started} />}
      </section>
    </div>
  )
}

function RunRow({ wfId, run }: { wfId: string; run: RunSummary }) {
  const [detail, setDetail] = useState<JobSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const toggle = async () => {
    setOpen(!open)
    if (!detail) setDetail(await api<JobSnapshot>(`/workflows/${wfId}/runs/${run.job_id}`).catch(() => null))
  }
  const ok = run.status === 'passed'
  return (
    <li className="run">
      <button type="button" className="run-row" onClick={toggle} aria-expanded={open}>
        <span className={`dot ${ok ? 'dot-ok' : 'dot-fail'}`} aria-hidden="true" />
        <span className="run-kind">{run.kind === 'build' ? 'Build + test run' : run.healed ? 'Run · healed' : 'Run'}</span>
        <span className="muted small run-what">{ok ? summaryText(run.summary) : run.error}</span>
        <span className="muted small run-when">{when(run.started)}</span>
      </button>
      {open && detail && <EventList events={detail.events.filter((e) => e.kind !== 'agent')} start={detail.started} />}
    </li>
  )
}

export function WorkflowView({
  id,
  intro = null,
  introAnchor,
  onChanged,
  onDeleted,
}: {
  id: string
  /** Set when this page is the end of the send animation. */
  intro?: Intro | null
  /** The caption the flying prompt lands on. */
  introAnchor?: (el: HTMLElement | null) => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const [wf, setWf] = useState<Workflow | null>(null)
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showScript, setShowScript] = useState(false)

  const loadWorkflow = useCallback(async () => {
    const next = await api<Workflow>(`/workflows/${id}`)
    setWf(next)
    return next
  }, [id])

  // On open: the workflow, and its build job if that's still going.
  useEffect(() => {
    setJob(null)
    setShowScript(false)
    loadWorkflow()
      .then(async (w) => {
        const latest = w.runs[0]?.job_id ?? w.build_job
        const candidate = w.status === 'building' ? w.build_job : latest
        if (candidate) {
          const snap = await api<JobSnapshot>(`/jobs/${candidate}`).catch(() => null)
          if (snap && live(snap.status)) setJob(snap)
        }
      })
      .catch((e: Error) => setError(e.message))
  }, [id, loadWorkflow])

  // Follow the live job; refresh the workflow when it ends.
  const jobId = job?.job_id
  const jobLive = live(job?.status)
  useEffect(() => {
    if (!jobId || !jobLive) return
    let stopped = false
    const tick = async () => {
      try {
        // The whole snapshot each time: it's local, and a few hundred events at most.
        const snap = await api<JobSnapshot>(`/jobs/${jobId}`)
        if (stopped) return
        setJob(snap)
        if (!live(snap.status)) {
          await loadWorkflow()
          onChanged()
          return
        }
        // The plan and connectors land on the workflow while building.
        if (snap.requests.some((r) => r.status === 'pending')) void loadWorkflow()
      } catch (e) {
        setError((e as Error).message)
      }
      if (!stopped) setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
    }
  }, [jobId, jobLive, loadWorkflow, onChanged])

  async function answer(r: UserRequest, approved: boolean, feedback = '') {
    if (!job) return
    const updated = await api<UserRequest>(`/jobs/${job.job_id}/requests/${r.id}`, { approved, feedback })
    setJob((prev) => (prev ? { ...prev, requests: prev.requests.map((x) => (x.id === updated.id ? updated : x)), status: 'running' } : prev))
  }

  async function stop() {
    if (!job) return
    setJob(await api<JobSnapshot>(`/jobs/${job.job_id}/stop`, {}))
    await loadWorkflow()
    onChanged()
  }

  async function pause(paused: boolean) {
    if (!job) return
    setJob(await api<JobSnapshot>(`/jobs/${job.job_id}/${paused ? 'pause' : 'resume'}`, {}))
  }

  async function run() {
    setError(null)
    try {
      const { job_id } = await api<{ job_id: string }>(`/workflows/${id}/run`, {})
      setJob(await api<JobSnapshot>(`/jobs/${job_id}`))
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove() {
    try {
      await api(`/workflows/${id}`, undefined, 'DELETE')
      onDeleted()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const lastRun = useMemo(() => wf?.runs.find((r) => r.kind === 'run'), [wf])

  // While it builds, the prompt sits at the top as a dim caption, the title comes after.
  const building = wf ? wf.status === 'building' : intro !== null
  const caption = building && (
    <p
      className="build-caption"
      ref={introAnchor}
      style={{ ...(intro ? { width: intro.width } : {}), visibility: intro && !intro.landed ? 'hidden' : undefined }}
    >
      {wf?.goal ?? intro?.prompt}
    </p>
  )

  if (!wf) {
    return (
      <div className="page workflow">
        {caption}
        {error ? <p className="request-error">{error}</p> : !intro && <p className="muted">Loading…</p>}
      </div>
    )
  }

  const busy = live(job?.status)
  return (
    <div className={`page workflow${building ? ' is-building' : ''}`}>
      {caption}
      {!building && (
      <header className="view-head">
        <div className="view-title">
          <h1>{wf.title}</h1>
          <p className="muted goal">“{wf.goal}”</p>
        </div>
        <div className="view-actions">
          <span className={`badge badge-wf-${wf.status}`} role="status">
            <span className="badge-dot" aria-hidden="true" />
            {busy && job?.kind === 'run' ? 'Running' : STATUS_LABEL[wf.status]}
          </span>
          {wf.status !== 'building' && wf.script && (
            <button type="button" onClick={run} disabled={busy}>
              {busy && job?.kind === 'run' && <span className="spinner" aria-hidden="true" />}
              Run now
            </button>
          )}
        </div>
      </header>
      )}

      {error && <p className="request-error">{error}</p>}

      {job && (!intro || intro.landed) && <JobPanel job={job} onAnswer={answer} onStop={stop} onPause={pause} spring={intro !== null} />}

      {wf.status !== 'building' && (
        <div className="wf-grid">
          <section className="card">
            <div className="card-head">
              <h2>How it works</h2>
              <span className="muted small">
                {[...wf.apps.map((a) => a.app), ...wf.connectors.map((c) => c[0].toUpperCase() + c.slice(1))].join(' · ')}
              </span>
            </div>
            {wf.plan ? <PlanSteps plan={wf.plan} /> : <p className="muted small">{wf.note || 'No plan was recorded.'}</p>}
            {wf.script && (
              <div className="script">
                <button type="button" className="link" onClick={() => setShowScript(!showScript)}>
                  {showScript ? 'Hide the script' : 'Show the script'}
                </button>
                {showScript && <pre className="code">{wf.script}</pre>}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Runs</h2>
              <span className="muted small">
                {lastRun ? `Last run ${when(lastRun.started)}` : 'Not run yet'}
                {wf.heals > 0 && ` · healed itself ${wf.heals}×`}
              </span>
            </div>
            {wf.runs.length === 0 ? (
              <p className="muted small">No runs yet.</p>
            ) : (
              <ul className="runs">
                {wf.runs.map((r) => (
                  <RunRow key={r.job_id} wfId={wf.id} run={r} />
                ))}
              </ul>
            )}
            {!busy && (
              <button type="button" className="link danger" onClick={remove}>
                Delete workflow
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
