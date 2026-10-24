import { useCallback, useEffect, useState, type FormEvent } from 'react'
import './App.css'

type Status = 'running' | 'passed' | 'needs_human' | 'error'

type RunEvent = {
  i: number
  ts: number
  kind: 'info' | 'agent' | 'ok' | 'fail' | 'error' | 'denied'
  label: string
  detail: string
}

type RunSnapshot = {
  run_id: string
  app: string
  data_path: string
  status: Status
  gap: string[]
  rows_loaded: number | null
  used_cache: boolean
  events: RunEvent[]
}

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
}

const POLL_MS = 1000

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

function App() {
  const [app, setApp] = useState('gnucash')
  const [dataPath, setDataPath] = useState('')
  const [run, setRun] = useState<RunSnapshot | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [requestError, setRequestError] = useState<string | null>(null)

  const loadLedger = useCallback(async () => {
    const data = await getJson<{ rows: LedgerRow[] }>('/api/ledger')
    setLedger(data.rows)
  }, [])

  // Show the latest run and the ledger on first load.
  useEffect(() => {
    getJson<RunSnapshot>('/api/events').then(setRun).catch(() => {})
    loadLedger().catch((e: Error) => setRequestError(e.message))
  }, [loadLedger])

  // Poll while a run is in progress; refresh the ledger when it ends.
  const runId = run?.run_id
  const running = run?.status === 'running'
  useEffect(() => {
    if (!runId || !running) return
    const timer = setInterval(async () => {
      try {
        const next = await getJson<RunSnapshot>(`/api/events?run_id=${runId}`)
        setRun(next)
        if (next.status !== 'running') await loadLedger()
      } catch (e) {
        setRequestError((e as Error).message)
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [runId, running, loadLedger])

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
            <input value={app} onChange={(e) => setApp(e.target.value)} required />
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
          <button type="submit" disabled={running}>
            {running ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        {requestError && <p className="request-error">{requestError}</p>}
      </form>

      {(status === 'needs_human' || status === 'error') && run && (
        <section className="alert" role="alert">
          <h2>{status === 'needs_human' ? 'Needs human: books don’t reconcile' : 'Run failed'}</h2>
          <p>
            {status === 'needs_human'
              ? 'Still failing after one repair attempt. Nothing was loaded into the ledger.'
              : 'The run stopped with an error. Nothing was loaded into the ledger.'}
          </p>
          <ul className="mono">
            {run.gap.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="columns">
        <section className="card events">
          <div className="card-head">
            <h2>Live events</h2>
            <span className="mono muted small">{run?.run_id}</span>
          </div>
          {!run && <p className="muted">No run yet. Press Connect to start the agent.</p>}
          <ol>
            {run?.events.map((ev) => (
              <li key={ev.i}>
                <span className={`dot dot-${ev.kind}`} aria-hidden="true" />
                <div>
                  <div className="event-label">{ev.label}</div>
                  {ev.detail && <div className="mono muted small event-detail">{ev.detail}</div>}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="card ledger">
          <div className="card-head">
            <h2>Ledger</h2>
            <span className="muted small">{ledger.length} rows</span>
          </div>
          {ledger.length === 0 ? (
            <p className="empty">Nothing loaded. Rows appear here only after the checker passes.</p>
          ) : (
            <div className="table-scroll">
              <table>
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
                  {ledger.map((r, idx) => (
                    <tr key={idx}>
                      <td className="mono">{r.date}</td>
                      <td>{r.account}</td>
                      <td className="mono num">{r.amount}</td>
                      <td>{r.side === 'debit' ? 'Debit' : 'Credit'}</td>
                      <td>{r.memo}</td>
                      <td className="muted">{r.source}</td>
                      <td className="mono muted">{r.run_id}</td>
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
