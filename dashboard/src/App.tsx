import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import './App.css'
import { ApiPanel } from './ApiPanel'

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

// Status of the latest run, shown in the header.
const BADGE: Record<Status | 'idle', string> = {
  idle: 'No runs yet',
  running: 'Running…',
  passed: 'Last run passed',
  needs_human: 'Needs review',
  error: 'Last run failed',
  lost: 'Run lost',
}

const BADGE_HINT: Record<Status | 'idle', string> = {
  idle: 'Connect an app to start a run.',
  running: 'The agent is extracting and checking the books.',
  passed: 'The books reconciled and the rows were loaded into the ledger.',
  needs_human: 'The books did not reconcile after one repair attempt. Nothing was loaded.',
  error: 'The run stopped with an error. Nothing was loaded.',
  lost: 'The dashboard lost track of the run.',
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

// A ledger row as shown in the sheet, marked with what the last load did to it.
type DisplayRow = {
  key: string
  fields: ChangeFields
  source: string
  run_id: string
  change?: Change
  // Running balance of the selected account(s), in cents, up to and including this row
  balance?: number
}

// Amounts are summed as integer cents so balances stay exact.
function toCents(amount: string): number {
  return Math.round(Number(amount) * 100)
}

function signedCents(row: Pick<ChangeFields, 'amount' | 'side'>): number {
  return row.side === 'debit' ? toCents(row.amount) : -toCents(row.amount)
}

const MONEY = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function formatMoney(amount: string): string {
  return amount ? MONEY.format(toCents(amount) / 100) : ''
}

// A balance as an amount and the side it sits on, the way GnuCash shows it.
function formatBalance(cents: number): string {
  if (cents === 0) return '0.00'
  return `${MONEY.format(Math.abs(cents) / 100)} ${cents > 0 ? 'Dr' : 'Cr'}`
}

// Account names are paths like "Assets:Current Assets:Checking Account".
const ACCOUNT_SEP = ':'

type AccountNode = { name: string; path: string; children: AccountNode[]; balance: number; count: number }

// The chart of accounts, rebuilt from the account paths in the ledger, with each
// account's balance including everything below it.
function buildAccountTree(rows: LedgerRow[]): { root: AccountNode; byPath: Map<string, AccountNode> } {
  const root: AccountNode = { name: 'All accounts', path: '', children: [], balance: 0, count: 0 }
  const byPath = new Map([['', root]])
  for (const row of rows) {
    const cents = signedCents(row)
    root.balance += cents
    root.count += 1
    let parent = root
    const parts = row.account.split(ACCOUNT_SEP)
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join(ACCOUNT_SEP)
      let node = byPath.get(path)
      if (!node) {
        node = { name, path, children: [], balance: 0, count: 0 }
        byPath.set(path, node)
        parent.children.push(node)
      }
      node.balance += cents
      node.count += 1
      parent = node
    })
  }
  const sort = (node: AccountNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    node.children.forEach(sort)
  }
  sort(root)
  return { root, byPath }
}

function isUnder(account: string, selected: string): boolean {
  return !selected || account === selected || account.startsWith(selected + ACCOUNT_SEP)
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// The account tree beside the sheet. Top-level accounts start open.
function AccountTree({ root, selected, onSelect }: { root: AccountNode; selected: string; onSelect: (path: string) => void }) {
  // Accounts the user opened or closed, relative to the default
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set())

  function toggle(path: string) {
    setFlipped((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }

  function renderNode(node: AccountNode, depth: number): ReactNode {
    const open = node.children.length > 0 && (depth <= 1) !== flipped.has(node.path)
    const isSelected = node.path === selected
    return (
      <li key={node.path}>
        <div
          className={`tree-row${isSelected ? ' selected' : ''}`}
          style={{ paddingLeft: 8 + Math.max(0, depth - 1) * 14 }}
          onClick={() => onSelect(node.path)}
        >
          {depth > 0 && node.children.length > 0 ? (
            <button
              type="button"
              className="tree-toggle"
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
              onClick={(e) => {
                e.stopPropagation()
                toggle(node.path)
              }}
            >
              <Chevron />
            </button>
          ) : (
            depth > 0 && <span className="tree-toggle" aria-hidden="true" />
          )}
          <button type="button" className="tree-name" aria-current={isSelected || undefined} title={node.path || undefined}>
            {node.name}
          </button>
          <span className="tree-balance mono">{depth === 0 ? `${node.count} rows` : formatBalance(node.balance)}</span>
        </div>
        {(open || depth === 0) && node.children.length > 0 && <ul>{node.children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <nav className="account-tree" aria-label="Accounts">
      <ul className="tree">{renderNode(root, 0)}</ul>
    </nav>
  )
}

// A cell's value; for a changed row, the old value is shown struck through before it.
function Cell({
  row,
  field,
  show = (v) => v,
}: {
  row: DisplayRow
  field: 'date' | 'account' | 'memo'
  show?: (value: string) => string
}) {
  const c = row.change
  const value = row.fields[field]
  if (c?.change !== 'changed' || !c.before || c.before[field] === value) return <>{show(value)}</>
  return (
    <span className="cell-changed">
      <del>{c.before[field] ? show(c.before[field]) : '(empty)'}</del> {show(value)}
    </span>
  )
}

// The amount if the row sits on this side; for a changed row, the old amount on this side too.
function AmountCell({ row, side }: { row: DisplayRow; side: ChangeFields['side'] }) {
  const now = row.fields.side === side ? row.fields.amount : ''
  const before = row.change?.change === 'changed' && row.change.before?.side === side ? row.change.before.amount : ''
  if (!before || before === now) return <>{formatMoney(now)}</>
  return (
    <span className="cell-changed">
      <del>{formatMoney(before)}</del> {formatMoney(now)}
    </span>
  )
}

type SelectOption = { value: string; label: ReactNode; display: ReactNode }

// A pick-one dropdown that looks like the search fields (no typing).
function Select({
  id,
  label,
  value,
  options,
  onChange,
  className,
}: {
  id: string
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const current = options.findIndex((o) => o.value === value)

  function openList() {
    setOpen(true)
    setActive(Math.max(current, 0))
  }

  function choose(i: number) {
    if (options[i]) onChange(options[i].value)
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) openList()
      else setActive((a) => (e.key === 'ArrowDown' ? Math.min(a + 1, options.length - 1) : Math.max(a - 1, 0)))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (open) choose(active)
      else openList()
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div
      className={`combobox select${className ? ` ${className}` : ''}`}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        type="button"
        id={id}
        className="select-button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{options[current]?.display}</span>
        <svg className="select-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul id={`${id}-list`} role="listbox" aria-label={label} className="combobox-list">
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === current}
              className={`combobox-option${i === active ? ' active' : ''}${i === current ? ' selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type ComboboxProps<T> = {
  id: string
  value: string
  onChange: (value: string) => void
  // null while loading
  items: T[] | null
  filter: (item: T, query: string) => boolean
  itemKey: (item: T) => string
  itemValue: (item: T) => string
  renderItem: (item: T) => ReactNode
  onSelect?: (item: T) => void
  empty: string
  loading: string
  error?: string | null
  placeholder?: string
  className?: string
}

// A text field with a search dropdown. Free text is always allowed; picking a
// suggestion just fills the field in.
function Combobox<T>({
  id,
  value,
  onChange,
  items,
  filter,
  itemKey,
  itemValue,
  renderItem,
  onSelect,
  empty,
  loading,
  error,
  placeholder,
  className,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false)
  // What was typed since the dropdown opened; until then every suggestion shows.
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(-1)

  const q = (query ?? '').trim().toLowerCase()
  const shown = (items ?? []).filter((item) => !q || filter(item, q))
  // Typing something that matches nothing is fine (it's a custom value), so hide the list.
  const visible = open && !(q && items && items.length > 0 && shown.length === 0)

  function close() {
    setOpen(false)
    setQuery(null)
    setActive(-1)
  }

  function choose(item: T) {
    onChange(itemValue(item))
    onSelect?.(item)
    close()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, shown.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && visible && shown[active]) {
      e.preventDefault()
      choose(shown[active])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      close()
    }
  }

  return (
    <div
      className="combobox"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close()
      }}
    >
      <input
        id={id}
        className={className}
        role="combobox"
        aria-expanded={visible}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={visible && active >= 0 ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        required
        onChange={(e) => {
          onChange(e.target.value)
          setQuery(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {visible && (
        <ul id={`${id}-list`} role="listbox" className="combobox-list">
          {error ? (
            <li className="combobox-note combobox-error">{error}</li>
          ) : items === null ? (
            <li className="combobox-note">{loading}</li>
          ) : shown.length === 0 ? (
            <li className="combobox-note">{empty}</li>
          ) : (
            shown.map((item, i) => (
              <li
                key={itemKey(item)}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`combobox-option${i === active ? ' active' : ''}`}
                // Keep focus in the input so blur doesn't close the list before the click lands
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item)}
              >
                {renderItem(item)}
              </li>
            ))
          )}
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

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

function App() {
  const [app, setApp] = useState('')
  const [dataPath, setDataPath] = useState('')
  const [apps, setApps] = useState<InstalledApp[] | null>(null)
  const [appsError, setAppsError] = useState<string | null>(null)
  // Data files found for one app, keyed by the app's path so stale results are ignored.
  const [found, setFound] = useState<{ appPath: string; candidates: DataCandidate[] | null; error: string | null } | null>(null)
  const [run, setRun] = useState<RunSnapshot | null>(null)
  const [ledgers, setLedgers] = useState<LedgerInfo[]>([])
  const [ledgerId, setLedgerId] = useState<string | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [requestError, setRequestError] = useState<string | null>(null)
  const [changesOnly, setChangesOnly] = useState(false)
  const [apiOpen, setApiOpen] = useState(false)
  // Live events start as a one-line bar; the choice is remembered in this browser
  const [eventsOpen, setEventsOpen] = useState(() => {
    try {
      return localStorage.getItem('events-open') === '1'
    } catch {
      return false
    }
  })

  function toggleEvents() {
    const next = !eventsOpen
    setEventsOpen(next)
    try {
      localStorage.setItem('events-open', next ? '1' : '0')
    } catch {
      // Private windows can refuse storage; the bar still works for this visit
    }
  }
  // Selected account path in the tree; '' is every account
  const [account, setAccount] = useState('')

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
    // Ask for every row so the account balances add up
    const limit = Math.max(1000, ledgers.find((l) => l.id === ledgerId)?.rows ?? 0)
    getJson<{ rows: LedgerRow[] }>(`/api/ledger?ledger_id=${encodeURIComponent(ledgerId)}&limit=${limit}`)
      .then((data) => setLedger(data.rows))
      .catch((e: Error) => setRequestError(e.message))
  }, [ledgerId, ledgers])

  useEffect(() => {
    getJson<{ apps: InstalledApp[] }>('/api/apps')
      .then((data) => setApps(data.apps))
      .catch((e: Error) => setAppsError(e.message))
  }, [])

  // The installed app the name field refers to, whether picked or typed.
  const picked = apps?.find((a) => a.name.toLowerCase() === app.trim().toLowerCase()) ?? null
  const pickedPath = picked?.path

  // Nothing is read from these files until one is chosen and Connect is pressed.
  useEffect(() => {
    if (!pickedPath) return
    getJson<{ candidates: DataCandidate[] }>(`/api/apps/data?path=${encodeURIComponent(pickedPath)}`)
      .then((data) => setFound({ appPath: pickedPath, candidates: data.candidates, error: null }))
      .catch((e: Error) => setFound({ appPath: pickedPath, candidates: [], error: e.message }))
  }, [pickedPath])
  const candidates = !picked ? [] : found?.appPath === picked.path ? found.candidates : null

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

  const status = run?.status ?? 'idle'

  // The newest line of the feed, shown in the collapsed bar
  const eventItems = groupEvents(events)
  const lastItem = eventItems[eventItems.length - 1]
  const latest = !lastItem
    ? null
    : lastItem.type === 'event'
      ? { kind: lastItem.event.kind, label: lastItem.event.label, ts: lastItem.event.ts }
      : { kind: 'agent', label: running ? 'Agent working…' : 'Agent steps', ts: lastItem.steps[lastItem.steps.length - 1].ts }

  // What the latest load did, if it was a load into the ledger on screen.
  const lastLoad = run?.changes && run.ledger_id === ledgerId ? run.changes : null
  const lastLoadTotal = lastLoad ? lastLoad.added + lastLoad.changed + lastLoad.deleted : 0
  const showChangesOnly = changesOnly && lastLoadTotal > 0
  const changeBySource = new Map((lastLoad?.items ?? []).map((c) => [c.source, c]))
  const ledgerBySource = new Map(ledger.map((r) => [r.source, r]))
  const tree = useMemo(() => buildAccountTree(ledger), [ledger])
  // Fall back to every account if the selected one isn't in this ledger
  const selected = tree.byPath.has(account) ? account : ''
  const selectedNode = tree.byPath.get(selected) ?? tree.root
  const selectedIsLeaf = selected !== '' && selectedNode.children.length === 0
  const allRows: DisplayRow[] = showChangesOnly
    ? (lastLoad?.items ?? []).map((c) => ({
        key: `${c.change}:${c.source}`,
        fields: (c.after ?? c.before) as ChangeFields,
        source: c.source,
        run_id: ledgerBySource.get(c.source)?.run_id ?? '',
        change: c,
      }))
    : ledger.map((r) => ({ key: `${r.app}/${r.source}`, fields: r, source: r.source, run_id: r.run_id, change: changeBySource.get(r.source) }))
  const rows = allRows.filter((r) => isUnder(r.fields.account, selected))
  const crumbs = selected ? selected.split(ACCOUNT_SEP) : []
  // Accounts under the selection, named relative to it
  const relativeAccount = (path: string) => (selected ? path.slice(selected.length + 1) : path)
  // Summed across every account the running balance just drifts around zero, so only show it for a selection
  const showBalance = !showChangesOnly && selected !== ''
  // Running balance down the sheet (rows arrive sorted by date)
  if (showBalance) {
    let running = 0
    for (const r of rows) {
      running += signedCents(r.fields)
      r.balance = running
    }
  }

  return (
    <main className="page">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </span>
          <div>
            <h1>Local Link</h1>
            <p className="muted">Connect a local accounting app, extract its books, check them, load the ledger.</p>
          </div>
        </div>
        <span className={`badge badge-${status}`} role="status" title={BADGE_HINT[status]}>
          <span className="badge-dot" aria-hidden="true" />
          {BADGE[status]}
        </span>
      </header>

      <form className="card connect" onSubmit={connect} aria-label="Connect an app">
        <div className="fields">
          <div className="field">
            <label className="field-label" htmlFor="app">Connect an app</label>
            <Combobox
              id="app"
              value={app}
              onChange={setApp}
              items={apps}
              filter={(a, q) => [a.name, a.bundle_id, KIND_LABEL[a.kind]].some((v) => v.toLowerCase().includes(q))}
              itemKey={(a) => a.path}
              itemValue={(a) => a.name}
              renderItem={(a) => (
                <>
                  <span className="option-main">{a.name}</span>
                  <span className="option-meta">{a.version}</span>
                  <span className="option-tag">{KIND_LABEL[a.kind]}</span>
                </>
              )}
              onSelect={() => setDataPath('')}
              placeholder="Search installed apps"
              loading="Scanning this Mac…"
              empty="No installed apps found. Type the app name."
              error={appsError}
            />
          </div>
          <div className="field field-wide">
            <label className="field-label" htmlFor="data-path">Data path <span className="muted">· read-only to the agent</span></label>
            <Combobox
              id="data-path"
              className="mono"
              value={dataPath}
              onChange={setDataPath}
              items={candidates}
              filter={(c, q) => c.path.toLowerCase().includes(q)}
              itemKey={(c) => c.path}
              itemValue={(c) => c.path}
              renderItem={(c) => (
                <>
                  <span className="option-main mono">{fileName(c.path)}</span>
                  <span className="option-meta">
                    {formatSize(c.size)} · {new Date(c.modified * 1000).toLocaleDateString()}
                  </span>
                  <span className="option-tag">{c.reason}</span>
                  <span className="option-sub">{c.path}</span>
                </>
              )}
              placeholder={picked ? `Search ${picked.name} data files, or type a path` : '/Users/you/Documents/books.gnucash'}
              loading={`Looking for ${picked?.name ?? 'app'} data files…`}
              empty={picked ? `No data files found for ${picked.name}. Type the path.` : 'Pick an installed app to see its data files, or type a path.'}
              error={found?.appPath === picked?.path ? found?.error : null}
            />
          </div>
          <div className="actions">
            <button type="submit" disabled={running}>
              {running && <span className="spinner" aria-hidden="true" />}
              {running ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
        {requestError && <p className="request-error">{requestError}</p>}
      </form>

      {(status === 'needs_human' || status === 'error' || status === 'lost') && run && (
        <section className={`alert${status === 'error' ? ' alert-error' : ''}`} role="alert">
          <div className="alert-body">
            <h2>{ALERT[status].title}</h2>
            <p>{ALERT[status].body}</p>
            <ul className="mono">
              {run.gap.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className={`card events${eventsOpen && run ? ' open' : ''}`} aria-label="Live events">
        <button
          type="button"
          className="events-bar"
          aria-expanded={eventsOpen && !!run}
          aria-controls="events-list"
          onClick={toggleEvents}
          disabled={!run}
        >
          <span className="events-bar-name">Live events</span>
          {latest ? (
            <span className="events-bar-latest">
              <span className={`dot dot-${latest.kind}${running ? ' dot-live' : ''}`} aria-hidden="true" />
              <span className="events-bar-label">{latest.label}</span>
              <span className="mono muted small events-bar-time">+{formatDuration(latest.ts - start)}</span>
            </span>
          ) : (
            <span className="events-bar-latest muted">No run yet. Press Connect to start the agent.</span>
          )}
          {elapsed !== null && (
            <span className="events-bar-meta">
              {running ? 'Elapsed' : 'Took'} <span className="mono">{formatDuration(elapsed)}</span> · {events.length} events
            </span>
          )}
          {run && (
            <span className="events-bar-chevron" aria-hidden="true">
              <Chevron />
            </span>
          )}
        </button>
        {eventsOpen && run && (
          <>
            <div className="events-meta small">
              <ul className="legend muted" aria-label="Legend">
                <li><span className="dot dot-info" aria-hidden="true" />Pipeline step</li>
                <li><span className="dot dot-agent" aria-hidden="true" />Agent activity</li>
                <li><span className="dot dot-ok" aria-hidden="true" />Passed</li>
                <li><span className="dot dot-fail" aria-hidden="true" />Failed or blocked</li>
              </ul>
              <span className="muted">
                {run.used_cache && 'Reused saved extractor · '}
                <span className="mono">{run.run_id}</span>
              </span>
            </div>
            <ol id="events-list">
              {eventItems.map((item, idx, items) =>
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
                        <span className="mono muted small event-detail">{lastStepText(item.steps)}</span>
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
          </>
        )}
      </section>

      {apiOpen && ledgerId && (() => {
        const source = ledgers.find((l) => l.id === ledgerId)
        return source ? <ApiPanel source={source} rows={ledger} onClose={() => setApiOpen(false)} /> : null
      })()}

      <div className="workspace">
        <section className="card ledger">
          {/* One compact row: what this is and what the last load did, then the filters */}
          <div className="ledger-head">
            <div className="ledger-title">
              <h2>Ledger</h2>
              <span className="count">{ledger.length}</span>
              {lastLoad && (
                <span className="small muted ledger-load">
                  Last load
                  <span className="mono load-counts">
                    <span className="text-added" title="added">+{lastLoad.added}</span>
                    <span className="text-changed" title="changed">~{lastLoad.changed}</span>
                    <span className="text-deleted" title="deleted">−{lastLoad.deleted}</span>
                  </span>
                  {lastLoad.items.length < lastLoadTotal && <span>· marking the first {lastLoad.items.length}</span>}
                </span>
              )}
            </div>
            <div className="ledger-controls">
              {lastLoad && (
                <label className="toggle small">
                  <input
                    type="checkbox"
                    checked={showChangesOnly}
                    disabled={lastLoadTotal === 0}
                    onChange={(e) => setChangesOnly(e.target.checked)}
                  />
                  Changes only
                </label>
              )}
              {ledgerId && (
                <button type="button" className="secondary api-open" onClick={() => setApiOpen(true)}>
                  Use API
                </button>
              )}
              {ledgers.length > 0 && (
              <Select
                id="ledger"
                label="Ledger"
                className="ledger-select"
                value={ledgerId ?? ''}
                onChange={(id) => {
                  setLedgerId(id)
                  setAccount('')
                }}
                options={ledgers.map((l) => ({
                  value: l.id,
                  display: (
                    <>
                      {l.app} · <span className="mono">{fileName(l.data_path)}</span>
                    </>
                  ),
                  label: (
                    <>
                      <span className="option-main">{l.app}</span>
                      <span className="option-meta mono">{fileName(l.data_path)}</span>
                      <span className="option-tag">{l.rows} rows</span>
                      <span className="option-sub">{l.data_path}</span>
                    </>
                  ),
                }))}
              />
              )}
            </div>
          </div>
          {ledger.length === 0 && !showChangesOnly ? (
            <p className="empty">
              <strong>Nothing loaded</strong>
              <span className="small">Rows appear here only after the checker passes.</span>
            </p>
          ) : (
            <div className="ledger-body">
              <AccountTree root={tree.root} selected={selected} onSelect={setAccount} />
              <div className="register">
                <div className="register-head">
                  <nav className="crumbs" aria-label="Selected account">
                    {crumbs.length === 0 ? (
                      <span className="crumb-current">All accounts</span>
                    ) : (
                      <button type="button" className="crumb" onClick={() => setAccount('')}>
                        All accounts
                      </button>
                    )}
                    {crumbs.map((name, i) => {
                      const path = crumbs.slice(0, i + 1).join(ACCOUNT_SEP)
                      return (
                        <span key={path} className="crumb-part">
                          <span className="crumb-sep" aria-hidden="true">›</span>
                          {i === crumbs.length - 1 ? (
                            <span className="crumb-current" aria-current="true">{name}</span>
                          ) : (
                            <button type="button" className="crumb" onClick={() => setAccount(path)}>
                              {name}
                            </button>
                          )}
                        </span>
                      )
                    })}
                  </nav>
                  {selected && (
                    <span
                      className="register-balance"
                      title={selectedNode.balance === 0 ? undefined : selectedNode.balance > 0 ? 'Debit balance' : 'Credit balance'}
                    >
                      {/* Separate pieces so the gaps match; one mono string spaces "Cr" wider than "Balance" */}
                      <span className="muted">Balance</span>
                      <span className="mono">{MONEY.format(Math.abs(selectedNode.balance) / 100)}</span>
                      {selectedNode.balance !== 0 && <span className="mono">{selectedNode.balance > 0 ? 'Dr' : 'Cr'}</span>}
                    </span>
                  )}
                </div>
                {rows.length === 0 ? (
                  <p className="empty small">{showChangesOnly ? 'No changes in this account.' : 'No entries in this account.'}</p>
                ) : (
                  <div className="table-scroll">
                    <table className="ledger-table">
                      <thead>
                        <tr>
                          <th className="col-date">Date</th>
                          {!selectedIsLeaf && <th className="col-account account-cell">Account</th>}
                          <th>Memo</th>
                          <th className="num col-amount">Debit</th>
                          <th className="num col-amount">Credit</th>
                          {showBalance && <th className="num col-balance">Balance</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr
                            key={r.key}
                            className={r.change ? `row-${r.change.change}` : undefined}
                            title={`${r.source}${r.run_id ? `\nLoaded by ${r.run_id}` : ''}`}
                          >
                            <td data-label="Date" className="mono">
                              {r.change && <span className="visually-hidden">{r.change.change}: </span>}
                              <Cell row={r} field="date" />
                            </td>
                            {!selectedIsLeaf && (
                              <td data-label="Account" className="account-cell">
                                <Cell row={r} field="account" show={relativeAccount} />
                              </td>
                            )}
                            <td data-label="Memo">
                              <div>
                                <Cell row={r} field="memo" />
                                {/* On a narrow sheet the account rides under the memo instead of in its own column */}
                                {!selectedIsLeaf && (
                                  <span className="memo-account">
                                    <Cell row={r} field="account" show={relativeAccount} />
                                  </span>
                                )}
                              </div>
                            </td>
                            <td data-label="Debit" className="mono num"><AmountCell row={r} side="debit" /></td>
                            <td data-label="Credit" className="mono num"><AmountCell row={r} side="credit" /></td>
                            {showBalance && (
                              <td data-label="Balance" className="mono num balance">
                                {r.balance !== undefined && formatBalance(r.balance)}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

export default App
