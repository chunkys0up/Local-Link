import { useCallback, useEffect, useState } from 'react'
import './App.css'
import './Shell.css'

import { api, onAttention, type Workflow } from './api'
import { DataView } from './DataView'
import { Home } from './Home'
import { WorkflowView } from './WorkflowView'

type View = { name: 'home' } | { name: 'workflow'; id: string } | { name: 'data' }

const DOT: Record<Workflow['status'], string> = {
  building: 'dot-info dot-live',
  ready: 'dot-ok',
  needs_attention: 'dot-ui',
  failed: 'dot-fail',
}

function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

export default function App() {
  const [view, setView] = useState<View>({ name: 'home' })
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [offline, setOffline] = useState(false)

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

  async function start(prompt: string) {
    const { workflow_id } = await api<{ workflow_id: string; job_id: string }>('/workflows', { prompt })
    await loadWorkflows()
    setView({ name: 'workflow', id: workflow_id })
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="drag" aria-hidden="true" />
        <div className="side-brand">
          <span className="brand-mark">
            <Mark />
          </span>
          <span className="side-name">Local Link</span>
        </div>
        <button type="button" className={`side-new${view.name === 'home' ? ' active' : ''}`} onClick={() => setView({ name: 'home' })}>
          <span aria-hidden="true">+</span> New workflow
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
                  onClick={() => setView({ name: 'workflow', id: w.id })}
                  title={w.goal}
                >
                  <span className={`dot ${DOT[w.status]}`} aria-hidden="true" />
                  <span className="side-item-name">{w.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <nav className="side-section side-bottom" aria-label="Data">
          <button type="button" className={`side-item${view.name === 'data' ? ' active' : ''}`} onClick={() => setView({ name: 'data' })}>
            <span className="side-glyph" aria-hidden="true">≡</span>
            <span className="side-item-name">Data &amp; read APIs</span>
          </button>
          {offline && <p className="side-empty small offline">Engine not reachable</p>}
        </nav>
      </aside>

      <main className="main">
        <div className="drag" aria-hidden="true" />
        {view.name === 'home' && <Home onStart={start} />}
        {view.name === 'workflow' && (
          <WorkflowView
            key={view.id}
            id={view.id}
            onChanged={loadWorkflows}
            onDeleted={() => {
              setView({ name: 'home' })
              void loadWorkflows()
            }}
          />
        )}
        {view.name === 'data' && <DataView />}
      </main>
    </div>
  )
}
