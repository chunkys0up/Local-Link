import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import './Shell.css'

import { api, onAttention, type Health, type Workflow } from './api'
import { GmailConnect } from './GmailConnect'
import logo from './assets/logo.png'
import { DataView } from './DataView'
import { captionWidth, prefersReducedMotion, PromptFlight, type Box, type Intro } from './Flight'
import { Home } from './Home'
import { WorkflowView } from './WorkflowView'

type View = { name: 'home' } | { name: 'workflow'; id: string } | { name: 'data' }

const DOT: Record<Workflow['status'], string> = {
  building: 'dot-info dot-live',
  ready: 'dot-ok',
  needs_attention: 'dot-ui',
  failed: 'dot-fail',
}

/** Online accounts: Gmail directly, or through Factory's connector. */
function Accounts({ open, gmail, onClose, onChanged }: { open: boolean; gmail: string | null; onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog ref={dialog} className="accounts" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="accounts-body">
        <div className="accounts-head">
          <div>
            <h2>Accounts</h2>
            <p className="muted small">
              Gmail connected in Factory (Settings › Connectors) works as is. Connecting it here as well makes searches direct and much faster, with no agent reading your mail.
            </p>
          </div>
          <button type="button" className="secondary small-button" onClick={onClose}>
            Done
          </button>
        </div>
        {gmail ? (
          <p className="small">
            <span className="text-ok">Gmail connected</span> <span className="muted">· {gmail}</span>{' '}
            <button type="button" className="link inline" onClick={() => api('/connectors/gmail', undefined, 'DELETE').then(onChanged)}>
              Disconnect
            </button>
          </p>
        ) : (
          <GmailConnect onConnected={onChanged} />
        )}
      </div>
    </dialog>
  )
}

/** The sidebar-panel icon: collapse when expanded, expand when collapsed. */
function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
    </svg>
  )
}

const SIDEBAR_KEY = 'sidebar-collapsed'
const NARROW = '(max-width: 760px)'

export default function App() {
  const [view, setView] = useState<View>({ name: 'home' })
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [offline, setOffline] = useState(false)
  const [gmail, setGmail] = useState<string | null>(null)
  const [accountsOpen, setAccountsOpen] = useState(false)
  const loadAccounts = useCallback(() => {
    api<Health>('/health')
      .then((h) => setGmail(h.gmail))
      .catch(() => {})
  }, [])
  useEffect(loadAccounts, [loadAccounts])
  // The sidebar can shrink to a strip of the logo and status dots; remembered per machine.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch {
      return false
    }
  })
  function collapse(next: boolean) {
    setCollapsed(next)
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
    } catch {
      // storage can be unavailable; the choice just isn't remembered
    }
  }
  // A narrow window has no room for the full sidebar: shrink it to the strip on the way
  // down (not remembered, so widening again keeps whatever was chosen).
  useEffect(() => {
    const narrow = window.matchMedia(NARROW)
    const onChange = () => narrow.matches && setCollapsed(true)
    onChange()
    narrow.addEventListener('change', onChange)
    return () => narrow.removeEventListener('change', onChange)
  }, [])
  // Sending a prompt: the home screen fades out around it while it flies to the build page.
  const [intro, setIntro] = useState<Intro | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null) // the caption the text lands on
  const [cardAnchor, setCardAnchor] = useState<HTMLElement | null>(null) // the progress card the box becomes

  const loadWorkflows = useCallback(async () => {
    try {
      setWorkflows((await api<{ workflows: Workflow[] }>('/workflows')).workflows)
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    void loadWorkflows()
    const timer = setInterval(loadWorkflows, 5000)
    return () => clearInterval(timer)
  }, [loadWorkflows])

  // A question, card or result needs the person: open that workflow.
  useEffect(
    () =>
      onAttention((id) => {
        void loadWorkflows()
        setView({ name: 'workflow', id })
      }),
    [loadWorkflows],
  )

  function go(next: View) {
    if (next.name !== 'workflow' || next.id !== intro?.id) setIntro(null)
    setLeaving(false)
    setView(next)
  }

  async function start(prompt: string, from?: Box) {
    const { workflow_id } = await api<{ workflow_id: string; job_id: string }>('/workflows', { prompt })
    void loadWorkflows()
    if (from && !prefersReducedMotion()) {
      setIntro({ id: workflow_id, prompt, from, width: captionWidth(from), landed: false })
      setLeaving(true)
      setTimeout(() => setLeaving(false), 900)
    }
    setView({ name: 'workflow', id: workflow_id })
  }

  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="drag" aria-hidden="true" />
        <div className="side-brand">
          {/* One element in both states, so the logo never moves; collapsed, it's the expand button. */}
          <button
            type="button"
            className="brand-button"
            onClick={collapsed ? () => collapse(false) : undefined}
            tabIndex={collapsed ? 0 : -1}
            aria-label={collapsed ? 'Expand sidebar' : undefined}
            title={collapsed ? 'Expand sidebar' : undefined}
          >
            <img className="brand-mark" src={logo} width={28} height={28} alt="" />
            <span className="brand-expand">
              <PanelIcon />
            </span>
          </button>
          <span className="side-name">
            <span className="retro">Retro</span>naut
          </span>
          <button type="button" className="side-toggle" onClick={() => collapse(true)} aria-label="Collapse sidebar" title="Collapse sidebar">
            <PanelIcon />
          </button>
        </div>
        <button
          type="button"
          className={`side-new${view.name === 'home' ? ' active' : ''}`}
          onClick={() => go({ name: 'home' })}
          aria-label="New workflow"
          title={collapsed ? 'New workflow' : undefined}
        >
          <span className="plus" aria-hidden="true">+</span>
          <span className="side-new-label">New workflow</span>
        </button>

        <nav className="side-section" aria-label="Workflows">
          <div className="side-label">Workflows</div>
          {workflows.length === 0 && <p className="side-empty muted small">Nothing automated yet.</p>}
          <ul>
            {workflows.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className={`side-item${view.name === 'workflow' && view.id === w.id ? ' active' : ''}`}
                  onClick={() => go({ name: 'workflow', id: w.id })}
                  title={collapsed ? w.title : w.goal}
                >
                  <span className={`dot ${DOT[w.status]}`} aria-hidden="true" />
                  <span className="side-item-name">{w.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <nav className="side-section side-bottom" aria-label="Data and accounts">
          <button type="button" className="side-item" onClick={() => setAccountsOpen(true)}>
            <span className="side-glyph" aria-hidden="true">@</span>
            <span className="side-item-name">Accounts</span>
            <span className="side-item-meta">{gmail ? 'Gmail' : 'Factory'}</span>
          </button>
          <button type="button" className={`side-item${view.name === 'data' ? ' active' : ''}`} onClick={() => go({ name: 'data' })}>
            <span className="side-glyph" aria-hidden="true">≡</span>
            <span className="side-item-name">Data &amp; read APIs</span>
          </button>
          {offline && <p className="side-empty small offline">Engine not reachable</p>}
        </nav>
      </aside>

      {/* The home screen's full glow, crossfading with the dimmer one behind other pages. */}
      <div className={`glow-layer${view.name === 'home' && !leaving ? ' on' : ''}`} aria-hidden="true" />

      <main className="main">
        <div className="drag" aria-hidden="true" />
        {(view.name === 'home' || leaving) && <Home onStart={start} leaving={leaving} />}
        {view.name === 'workflow' && (
          <WorkflowView
            key={view.id}
            id={view.id}
            intro={intro?.id === view.id ? intro : null}
            introAnchor={setAnchor}
            introCard={setCardAnchor}
            onChanged={loadWorkflows}
            onDeleted={() => {
              go({ name: 'home' })
              void loadWorkflows()
            }}
          />
        )}
        {view.name === 'data' && <DataView />}
      </main>

      {intro && !intro.landed && anchor && cardAnchor && view.name === 'workflow' && view.id === intro.id && (
        <PromptFlight intro={intro} anchor={anchor} card={cardAnchor} onLanded={() => setIntro((i) => (i ? { ...i, landed: true } : i))} />
      )}


      <Accounts open={accountsOpen} gmail={gmail} onClose={() => setAccountsOpen(false)} onChanged={loadAccounts} />
    </div>
  )
}
