import { useEffect, useMemo, useRef, useState } from 'react'

// The runner, as seen from a terminal; the dashboard itself reaches it through the /api proxy.
const RUNNER = 'http://localhost:8000'
const MAX_SHOWN = 6000

type Row = { date: string; account: string; amount: string; side: 'debit' | 'credit'; memo: string; run_id: string }
type Source = { id: string; app: string; data_path: string }
type Example = { title: string; returns: string; path: string; body?: object }

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v))
  return q.toString().replace(/%3A/g, ':') // keep account paths readable
}

// Templated examples, filled in with real accounts, dates and memos from this ledger.
function examples(source: Source, rows: Row[]): Example[] {
  const id = encodeURIComponent(source.id)
  const dates = rows.map((r) => r.date).sort()
  const first = dates[0]
  const last = dates[dates.length - 1]
  const month = last?.slice(0, 7)
  const tops = rows.map((r) => r.account.split(':')[0])
  const expenseTop = tops.find((t) => /expense/i.test(t)) ?? mostCommon(tops)
  const leaf = mostCommon(rows.filter((r) => r.account.startsWith(`${expenseTop}:`)).map((r) => r.account)) ?? expenseTop
  const word = mostCommon(rows.map((r) => r.memo.split(/[\s#]+/)[0]).filter((w) => w && w.length > 2))
  const runId = mostCommon(rows.map((r) => r.run_id))

  return [
    {
      title: 'Rows in an account, in a date range',
      returns: 'Posting lines that match every filter (account includes its subaccounts), the total match count, and provenance: source file, the runs that loaded them, checker status.',
      path: `/ledger?${query({ ledger_id: source.id, account: expenseTop, from: month && `${month}-01`, to: last, min: 10, limit: 50 })}`,
    },
    {
      title: 'Search memos, accounts and source IDs',
      returns: 'Rows whose memo, account or source contains the text, case-insensitive.',
      path: `/ledger?${query({ ledger_id: source.id, search: word, limit: 50 })}`,
    },
    {
      title: 'One account, debits only',
      returns: 'Every debit posted to one account, oldest first.',
      path: `/ledger?${query({ ledger_id: source.id, account: leaf, side: 'debit' })}`,
    },
    {
      title: 'Balances as of a date',
      returns: 'Debits, credits and balance (debits minus credits) per account, counting rows up to that date.',
      path: `/ledgers/${id}/balances?${query({ as_of: last })}`,
    },
    {
      title: 'What a load changed',
      returns: 'Rows that run added, changed (with before and after) or deleted. Use since_run=<run id> for everything after a run, or since=<unix time>.',
      path: `/ledgers/${id}/changes?${query({ run_id: runId })}`,
    },
    {
      title: 'Run history',
      returns: 'Every run on this source: passed, needs_human or error, when, whether it reused the saved extractor, rows loaded.',
      path: `/ledgers/${id}/runs`,
    },
    {
      title: 'Flagged items',
      returns: 'Runs that stopped for a human, with the checker’s reasons, and suspense-type accounts that don’t net to zero.',
      path: `/ledgers/${id}/flags`,
    },
    {
      title: 'Monthly totals by account',
      returns: 'Debits, credits and net per month, accounts cut to two levels.',
      path: `/ledgers/${id}/monthly?${query({ account: expenseTop, depth: 1, from: first && `${first.slice(0, 7)}-01` })}`,
    },
    {
      title: 'Monthly totals by payee',
      returns: 'The same rollup grouped by memo, which is where the payee lives.',
      path: `/ledgers/${id}/monthly?${query({ by: 'payee', from: month && `${month}-01` })}`,
    },
    {
      title: 'Your own SQL (read-only)',
      returns: 'Columns and rows for one SELECT over the ledger, ledger_changes, ledger_source and runs tables. Anything that writes is refused.',
      path: `/ledgers/${id}/sql`,
      body: {
        query:
          'select account, side, count(*) as rows, sum(cast(amount as real)) as total from ledger group by account, side order by total desc limit 10',
      },
    },
  ]
}

function curl(ex: Example): string {
  const url = `'${RUNNER}${ex.path}'`
  if (!ex.body) return `curl ${url}`
  return `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(ex.body).replace(/'/g, "'\\''")}'`
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="secondary api-small"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          },
          () => {},
        )
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

function ExampleCard({ ex }: { ex: Example }) {
  const [result, setResult] = useState<{ status: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function tryIt() {
    setBusy(true)
    try {
      const res = await fetch(`/api${ex.path}`, ex.body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ex.body) }
        : undefined)
      const raw = await res.text()
      let text = raw
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2)
      } catch {
        // not JSON; show as is
      }
      setResult({ status: res.status, text: text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n…` : text })
    } catch (e) {
      setResult({ status: 0, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="api-example">
      <div className="api-example-head">
        <span className={`api-method api-${ex.body ? 'post' : 'get'}`}>{ex.body ? 'POST' : 'GET'}</span>
        <strong>{ex.title}</strong>
      </div>
      <p className="small muted">{ex.returns}</p>
      <pre className="api-code mono">{curl(ex)}</pre>
      <div className="api-actions">
        <CopyButton text={`${RUNNER}${ex.path}`} label="Copy URL" />
        <CopyButton text={curl(ex)} label="Copy curl" />
        <button type="button" className="api-small" onClick={tryIt} disabled={busy}>
          {busy ? 'Running…' : 'Try it'}
        </button>
      </div>
      {result && (
        <div className="api-result">
          <span className={`small ${result.status >= 200 && result.status < 300 ? 'text-added' : 'text-deleted'}`}>
            {result.status || 'Request failed'}
          </span>
          <pre className="api-code mono">{result.text}</pre>
        </div>
      )}
    </li>
  )
}

export function ApiPanel({ source, rows, onClose }: { source: Source; rows: Row[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useMemo(() => examples(source, rows), [source, rows])

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog ref={dialog} className="api-panel" onClose={onClose} aria-labelledby="api-title">
      <div className="api-panel-head">
        <div>
          <h2 id="api-title">Use the API</h2>
          <p className="small muted">
            {source.app} · <span className="mono">{source.data_path}</span>
          </p>
          <p className="small muted">
            Read-only queries against this ledger at <span className="mono">{RUNNER}</span>, ledger_id{' '}
            <span className="mono">{source.id}</span>. Examples use this ledger’s own accounts and dates.
          </p>
        </div>
        <button type="button" className="secondary api-small" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <ul className="api-examples">
        {list.map((ex) => (
          <ExampleCard key={ex.title} ex={ex} />
        ))}
      </ul>
    </dialog>
  )
}
