import { useCallback, useEffect, useState, type FormEvent } from 'react'
import './App.css'

// 'lost' is set by the dashboard, not the runner: the run vanished (runner restarted)
// or the runner stopped answering.
type Status = 'running' | 'passed' | 'needs_human' | 'error' | 'lost'

type RunEvent = {
  i: number
  ts: number
  kind: 'info' | 'agent' | 'ok' | 'fail' | 'error' | 'denied'
  label: string
  detail: string
}

type ChangeFields = {
  date: string
  account: string
  amount: string
  side: 'debit' | 'credit'
  memo: string
}

type Change = {
  change: 'added' | 'changed' | 'deleted'
  source: string
  before: ChangeFields | null
  after: ChangeFields | null
}

type Changes = { added: number; changed: number; deleted: number; items: Change[] }

type RunSnapshot = {
  run_id: string
  app: string
  data_path: string
  status: Status
  gap: string[]
  rows_loaded: number | null
  used_cache: boolean
  changes: Changes | null
  ledger_id: string
  events: RunEvent[]
}

type InstalledApp = {
  name: string
  bundle_id: string
  version: string
  path: string
  icon: string
  kind: 'electron' | 'qt' | 'gtk' | 'java' | 'native'
}

const KIND_LABEL: Record<InstalledApp['kind'], string> = {
  electron: 'Electron',
  qt: 'Qt',
  gtk: 'GTK',
  java: 'Java',
  native: 'Native Mac',
}

// One ledger per source: the app plus its data path.
type LedgerInfo = { id: string; app: string; data_path: string; rows: number }

type LedgerRow = {
  app: string
  date: string
  account: string
  amount: string
  side: 'debit' | 'credit'
  memo: string
  source: string
  run_id: string
}

const BADGE: Record<Status | 'idle', string> = {
  idle: 'Not connected',
  running: 'Running…',
  passed: 'Pass',
  needs_human: 'Needs human',
  error: 'Error',
  lost: 'Run lost',
}

const ALERT: Record<'needs_human' | 'error' | 'lost', { title: string; body: string }> = {
  needs_human: {
    title: 'Needs human: books don’t reconcile',
    body: 'Still failing after one repair attempt. Nothing was loaded into the ledger.',
  },
  error: {
    title: 'Run failed',
    body: 'The run stopped with an error. Nothing was loaded into the ledger.',
  },
  lost: {
    title: 'Run lost',
    body: 'The dashboard lost track of this run. Nothing new was loaded. Start the runner if needed, then press Connect again.',
  },
}

const POLL_MS = 1000
const MAX_POLL_FAILURES = 5

class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

type EventItem = { type: 'event'; event: RunEvent } | { type: 'agent'; steps: RunEvent[] }

// Fold consecutive agent tool calls into one expandable row; pipeline steps,
// agent messages and anything that went wrong stay visible on their own.
function groupEvents(events: RunEvent[]): EventItem[] {
  const items: EventItem[] = []
  for (const event of events) {
    const isStep = event.kind === 'agent' && !event.label.endsWith(' says')
    const last = items[items.length - 1]
    if (!isStep) items.push({ type: 'event', event })
    else if (last?.type === 'agent') last.steps.push(event)
    else items.push({ type: 'agent', steps: [event] })
  }
  return items
}

function lastStepText(steps: RunEvent[]): string {
  const last = steps[steps.length - 1]
  return `${last.label} · ${last.detail}`
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function EventRow({ event, start }: { event: RunEvent; start: number }) {
  return (
    <li>
      <span className={`dot dot-${event.kind}`} aria-hidden="true" />
      <div className="event-body">
        <div className="event-label">{event.label}</div>
        {event.detail && <div className="mono muted small event-detail">{event.detail}</div>}
      </div>
      <span className="mono muted small event-time">+{formatDuration(event.ts - start)}</span>
    </li>
  )
}

const CHANGE_SIGN = { added: '+', changed: '~', deleted: '−' } as const
const FIELD_NAMES = ['date', 'account', 'amount', 'side', 'memo'] as const
const OPEN_CHANGES_UP_TO = 20

function describeRow(r: ChangeFields): string {
  return `${r.date} · ${r.account} · ${r.side} ${r.amount}${r.memo ? ` · ${r.memo}` : ''}`
}

// GitHub-style view of what a load did to the ledger: + added, ~ changed, − deleted.
function ChangesPanel({ changes }: { changes: Changes }) {
  const total = changes.added + changes.changed + changes.deleted
  return (
    <section className="card changes" aria-labelledby="changes-h">
      <div className="card-head">
        <h2 id="changes-h">Changes in this load</h2>
        <span className="mono change-counts">
          <span className="diff-added-text">+{changes.added} added</span>
          <span className="diff-changed-text">~{changes.changed} changed</span>
          <span className="diff-deleted-text">−{changes.deleted} deleted</span>
        </span>
      </div>
      {total === 0 ? (
        <p className="muted">No changes since the last load.</p>
      ) : (
        <details open={total <= OPEN_CHANGES_UP_TO}>
          <summary className="small">
            {total} {total === 1 ? 'row' : 'rows'} affected
          </summary>
          <ul className="diff">
            {changes.items.map((c) => {
              const row = (c.after ?? c.before) as ChangeFields
              return (
                <li key={`${c.change}:${c.source}`} className={`diff-${c.change}`}>
                  <span className="diff-sign mono" aria-label={c.change}>
                    {CHANGE_SIGN[c.change]}
                  </span>
                  <div className="diff-body">
                    <div>{describeRow(row)}</div>
                    {c.change === 'changed' && c.before && c.after && (
                      <ul className="diff-fields small">
                        {FIELD_NAMES.filter((f) => c.before![f] !== c.after![f]).map((f) => (
                          <li key={f}>
                            {f}: <del>{c.before![f] || '(empty)'}</del> → <ins>{c.after![f] || '(empty)'}</ins>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mono muted small event-detail">{c.source}</div>
                  </div>
                </li>
              )
            })}
          </ul>
          {changes.items.length < total && (
            <p className="muted small">
              Showing the first {changes.items.length} of {total}.
            </p>
          )}
        </details>
      )}
    </section>
  )
}

// Searchable list of the apps the runner found on this machine.
function AppPicker({ onPick }: { onPick: (app: InstalledApp) => void }) {
  const [apps, setApps] = useState<InstalledApp[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getJson<{ apps: InstalledApp[] }>('/api/apps')
      .then((data) => setApps(data.apps))
      .catch((e: Error) => setError(e.message))
  }, [])

  const q = query.trim().toLowerCase()
  const shown = (apps ?? []).filter(
    (a) => !q || [a.name, a.bundle_id, KIND_LABEL[a.kind]].some((v) => v.toLowerCase().includes(q)),
  )

  return (
    <div className="app-picker">
      <input
        placeholder="Search installed apps"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search installed apps"
        autoFocus
      />
      {error && <p className="request-error">{error}</p>}
      {!apps && !error && <p className="muted small">Scanning this Mac…</p>}
      {apps && (
        <ul className="app-list">
          {shown.map((a) => (
            <li key={a.path}>
              <button type="button" className="app-item" onClick={() => onPick(a)}>
                <span className="app-name">{a.name}</span>
                <span className="muted small">{a.version}</span>
                <span className={`kind kind-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                <span className="mono muted small app-path">{a.path}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="muted small">No apps match.</li>}
        </ul>
      )}
    </div>
  )
}

type DataCandidate = { path: string; reason: string; size: number; modified: number }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Data files the runner found for the picked app. Nothing is read until one is chosen.
function DataCandidates({ app, selected, onPick }: { app: InstalledApp; selected: string; onPick: (path: string) => void }) {
  const [found, setFound] = useState<DataCandidate[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setFound(null)
    setError(null)
    getJson<{ candidates: DataCandidate[] }>(`/api/apps/data?path=${encodeURIComponent(app.path)}`)
      .then((data) => setFound(data.candidates))
      .catch((e: Error) => setError(e.message))
  }, [app.path])

  return (
    <div className="app-picker">
      <span className="muted small">Data files found for {app.name}. Pick one, or type a path above.</span>
      {error && <p className="request-error">{error}</p>}
      {!found && !error && <p className="muted small">Looking for data files…</p>}
      {found && (
        <ul className="app-list">
          {found.map((c) => (
            <li key={c.path}>
              <button
                type="button"
                className={`app-item${c.path === selected ? ' app-item-selected' : ''}`}
                onClick={() => onPick(c.path)}
              >
                <span className="mono app-name">{c.path.split('/').pop()}</span>
                <span className="muted small">{formatSize(c.size)}</span>
                <span className="muted small">{new Date(c.modified * 1000).toLocaleString()}</span>
                <span className="kind">{c.reason}</span>
                <span className="mono muted small app-path">{c.path}</span>
              </button>
            </li>
          ))}
          {found.length === 0 && <li className="muted small">No data files found. Type the path above.</li>}
        </ul>
      )}
    </div>
  )
}

function App() {
  const [app, setApp] = useState('gnucash')
  const [dataPath, setDataPath] = useState('')
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<InstalledApp | null>(null)
  const [run, setRun] = useState<RunSnapshot | null>(null)
  const [ledgers, setLedgers] = useState<LedgerInfo[]>([])
  const [ledgerId, setLedgerId] = useState<string | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [requestError, setRequestError] = useState<string | null>(null)

  // Refresh the list of ledgers, then show `show` (or keep the current one, or the newest).
  const loadLedgers = useCallback(async (show?: string) => {
    const data = await getJson<{ ledgers: LedgerInfo[] }>('/api/ledgers')
    setLedgers(data.ledgers)
    setLedgerId((current) => {
      const ids = data.ledgers.map((l) => l.id)
      if (show && ids.includes(show)) return show
      return current && ids.includes(current) ? current : (ids[0] ?? null)
    })
  }, [])

  useEffect(() => {
    if (!ledgerId) {
      setLedger([])
      return
    }
    getJson<{ rows: LedgerRow[] }>(`/api/ledger?ledger_id=${encodeURIComponent(ledgerId)}`)
      .then((data) => setLedger(data.rows))
      .catch((e: Error) => setRequestError(e.message))
  }, [ledgerId, ledgers])

  // Show the latest run and its ledger on first load.
  useEffect(() => {
    getJson<RunSnapshot>('/api/events')
      .then((latest) => {
        setRun(latest)
        return loadLedgers(latest.ledger_id)
      })
      .catch(() => loadLedgers())
      .catch((e: Error) => setRequestError(e.message))
  }, [loadLedgers])

  // Poll while a run is in progress; refresh the ledger when it ends. Runs live in
  // the runner's memory, so stop if the run disappears or the runner stays unreachable.
  const runId = run?.run_id
  const running = run?.status === 'running'

  // Tick once a second while a run is going so the timer counts up live.
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [running])
  const events = run?.events ?? []
  const start = events[0]?.ts ?? 0
  const elapsed = events.length === 0 ? null : (running ? Math.max(now, events[events.length - 1].ts) : events[events.length - 1].ts) - start
  useEffect(() => {
    if (!runId || !running) return
    let failures = 0
    const markLost = (reason: string) =>
      setRun((prev) => (prev && prev.run_id === runId ? { ...prev, status: 'lost', gap: [reason] } : prev))

    const timer = setInterval(async () => {
      try {
        const next = await getJson<RunSnapshot>(`/api/events?run_id=${runId}`)
        failures = 0
        setRequestError(null)
        setRun(next)
        if (next.status !== 'running') await loadLedgers(next.ledger_id)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          markLost('The runner no longer knows this run (it was probably restarted).')
          return
        }
        failures += 1
        if (failures >= MAX_POLL_FAILURES) {
          markLost(`Couldn't reach the runner ${failures} times in a row. Is it running on port 8000?`)
        } else {
          setRequestError(`Can't reach the runner, retrying… (${(e as Error).message})`)
        }
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [runId, running, loadLedgers])

  async function connect(e: FormEvent) {
    e.preventDefault()
    setRequestError(null)
    try {
      const { run_id } = await getJson<{ run_id: string }>('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app, data_path: dataPath }),
      })
      setRun(await getJson<RunSnapshot>(`/api/events?run_id=${run_id}`))
    } catch (err) {
      setRequestError((err as Error).message)
    }
  }

  async function clearData() {
    if (!window.confirm('Clear every ledger, its change history and saved extractors? (testing only)')) return
    setRequestError(null)
    try {
      await getJson('/api/reset', { method: 'POST' })
      setRun(null)
      setLedgers([])
      setLedgerId(null)
    } catch (err) {
      setRequestError((err as Error).message)
    }
  }

  const status = run?.status ?? 'idle'

  return (
    <main className="page">
      <header className="header">
        <div>
          <h1>Local Link</h1>
          <p className="muted">Connect a local accounting app, extract its books, check them, load the ledger.</p>
        </div>
        <span className={`badge badge-${status}`}>{BADGE[status]}</span>
      </header>

      <form className="card connect" onSubmit={connect}>
        <h2>Connect an app</h2>
        <div className="fields">
          <label className="field">
            <span>App name</span>
            <input
              value={app}
              onChange={(e) => {
                setApp(e.target.value)
                setPicked(null)
              }}
              required
            />
          </label>
          <label className="field field-wide">
            <span>Data path (read-only to the agent)</span>
            <input
              className="mono"
              value={dataPath}
              onChange={(e) => setDataPath(e.target.value)}
              placeholder="/Users/you/Documents/books.gnucash"
              required
            />
          </label>
          <div className="actions">
            <button type="submit" disabled={running}>
              {running ? 'Connecting…' : 'Connect'}
            </button>
            <button type="button" className="secondary" onClick={() => setPicking((v) => !v)}>
              {picking ? 'Close app list' : 'Pick installed app'}
            </button>
            <button type="button" className="secondary" onClick={clearData} disabled={running}>
              Clear data
            </button>
          </div>
        </div>
        {picked && (
          <p className="muted small">
            {picked.name} {picked.version} · {KIND_LABEL[picked.kind]} ·{' '}
            <span className="mono">{picked.bundle_id}</span>
          </p>
        )}
        {picked && !picking && <DataCandidates app={picked} selected={dataPath} onPick={setDataPath} />}
        {picking && (
          <AppPicker
            onPick={(a) => {
              setApp(a.name)
              setPicked(a)
              setPicking(false)
            }}
          />
        )}
        {requestError && <p className="request-error">{requestError}</p>}
      </form>

      {(status === 'needs_human' || status === 'error' || status === 'lost') && run && (
        <section className="alert" role="alert">
          <h2>{ALERT[status].title}</h2>
          <p>{ALERT[status].body}</p>
          <ul className="mono">
            {run.gap.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      )}

      {run?.changes && <ChangesPanel changes={run.changes} />}

      <div className="columns">
        <section className="card events">
          <div className="card-head">
            <h2>Live events</h2>
            <span className="mono muted small run-id">{run?.run_id}</span>
          </div>
          {elapsed !== null && (
            <div className="timer" role="timer" aria-live="off">
              <span className="muted small">{running ? 'Elapsed' : 'Took'}</span>
              <span className="mono timer-value">{formatDuration(elapsed)}</span>
              {run?.used_cache && <span className="muted small">reused the saved extractor</span>}
            </div>
          )}
          <ul className="legend small muted" aria-label="Legend">
            <li><span className="dot dot-info" aria-hidden="true" />Pipeline step</li>
            <li><span className="dot dot-agent" aria-hidden="true" />Agent activity</li>
            <li><span className="dot dot-ok" aria-hidden="true" />Passed</li>
            <li><span className="dot dot-fail" aria-hidden="true" />Failed or blocked</li>
          </ul>
          {!run && <p className="muted">No run yet. Press Connect to start the agent.</p>}
          <ol>
            {groupEvents(run?.events ?? []).map((item, idx, items) =>
              item.type === 'event' ? (
                <EventRow key={item.event.i} event={item.event} start={start} />
              ) : (
                <li key={item.steps[0].i} className="agent-group">
                  <span className="dot dot-agent" aria-hidden="true" />
                  <details>
                    <summary>
                      <span className="event-label">
                        {running && idx === items.length - 1 ? 'Agent working…' : 'Agent steps'}
                      </span>{' '}
                      <span className="muted small">
                        {item.steps.length} {item.steps.length === 1 ? 'step' : 'steps'}
                      </span>
                      <span className="mono muted small event-detail">
                        {lastStepText(item.steps)}
                      </span>
                    </summary>
                    <ol className="agent-steps">
                      {item.steps.map((ev) => (
                        <EventRow key={ev.i} event={ev} start={start} />
                      ))}
                    </ol>
                  </details>
                </li>
              ),
            )}
          </ol>
        </section>

        <section className="card ledger">
          <div className="card-head">
            <div className="card-title">
              <h2>Ledger</h2>
              <span className="muted small">{ledger.length} rows</span>
            </div>
            {ledgers.length > 0 && (
              <select
                className="ledger-picker mono small"
                aria-label="Ledger"
                value={ledgerId ?? ''}
                onChange={(e) => setLedgerId(e.target.value)}
              >
                {ledgers.map((l) => (
                  <option key={l.id} value={l.id} title={l.data_path}>
                    {l.app} · {l.data_path.split('/').pop()} ({l.rows})
                  </option>
                ))}
              </select>
            )}
          </div>
          {ledger.length === 0 ? (
            <p className="empty">Nothing loaded. Rows appear here only after the checker passes.</p>
          ) : (
            <div className="table-scroll">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Account</th>
                    <th className="num">Amount</th>
                    <th>Dr/Cr</th>
                    <th>Memo</th>
                    <th>Source</th>
                    <th>Run ID</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((r) => (
                    <tr key={`${r.app}/${r.source}`}>
                      <td data-label="Date" className="mono">{r.date}</td>
                      <td data-label="Account">{r.account}</td>
                      <td data-label="Amount" className="mono num">{r.amount}</td>
                      <td data-label="Dr/Cr">{r.side === 'debit' ? 'Debit' : 'Credit'}</td>
                      <td data-label="Memo">{r.memo}</td>
                      <td data-label="Source" className="muted">{r.source}</td>
                      <td data-label="Run ID" className="mono muted">{r.run_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

export default App
