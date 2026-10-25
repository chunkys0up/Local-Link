import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { api, inElectron, openPrivacy, type Health } from './api'
import { GmailConnect } from './GmailConnect'

const EXAMPLES = [
  'Every work order my vendor emails me, total it per work-order number and create a matching invoice in GnuCash for that customer.',
  'Each Friday, read the payments in my GnuCash checking account and email me a summary of anything over $1,000.',
  'Copy new bills from my Outlook inbox into GnuCash as vendor bills.',
]

function Check({ ok, label, detail, fix }: { ok: boolean | null; label: string; detail: string; fix?: { label: string; run: () => void } }) {
  return (
    <li className={`check ${ok === null ? 'check-unknown' : ok ? 'check-ok' : 'check-bad'}`}>
      <span className="check-mark" aria-hidden="true">{ok === null ? '·' : ok ? '✓' : '!'}</span>
      <span className="check-text">
        <span className="check-label">{label}</span>
        <span className="muted small">{detail}</span>
      </span>
      {fix && !ok && (
        <button type="button" className="secondary small-button" onClick={fix.run}>
          {fix.label}
        </button>
      )}
    </li>
  )
}

export function Home({ onStart }: { onStart: (prompt: string) => Promise<void> }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const load = () => api<Health>('/health').then(setHealth).catch(() => setHealth(null))
    load()
    // Permissions are granted in System Settings, outside the app; notice when that happens.
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [])

  // Grow the box with what's typed, up to a limit.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`
  }, [prompt])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onStart(prompt.trim())
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const ready = health && health.droid && health.api_key && health.accessibility !== false && health.screen_recording !== 'denied'

  return (
    <div className="home">
      <div className="home-hero">
        <h1>What should Local Link automate?</h1>
        <p className="muted">
          Describe the work in your own words. Local Link explores your apps and accounts, shows you a plan, then writes an automation that runs on its own and repairs itself when an app changes.
        </p>
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          ref={box}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. Take the work orders Acme emails me, add up each order, and create the invoices in GnuCash"
          rows={3}
          autoFocus
          aria-label="Describe the workflow to automate"
        />
        <div className="composer-foot">
          <span className="muted small">Enter to start · Shift+Enter for a new line</span>
          <button type="submit" disabled={!prompt.trim() || busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? 'Starting…' : 'Build workflow'}
          </button>
        </div>
      </form>
      {error && <p className="request-error">{error}</p>}

      <div className="examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="example" onClick={() => setPrompt(ex)}>
            {ex}
          </button>
        ))}
      </div>

      {health && (
        <section className="card accounts" aria-label="Accounts">
          <div className="card-head">
            <h2>Accounts</h2>
            {health.gmail && (
              <span className="small">
                <span className="text-ok">Gmail connected</span> <span className="muted">· {health.gmail}</span>{' '}
                <button
                  type="button"
                  className="link inline"
                  onClick={() => api('/connectors/gmail', undefined, 'DELETE').then(() => setHealth({ ...health, gmail: null }))}
                >
                  Disconnect
                </button>
              </span>
            )}
          </div>
          {!health.gmail && (
            <>
              <p className="small muted">
                Gmail connected in Factory (Settings → Connectors) works as is. Connecting it here too makes searches direct and faster, with no agent reading your mail.
              </p>
              <GmailConnect compact onConnected={(email) => setHealth({ ...health, gmail: email })} />
            </>
          )}
        </section>
      )}

      {health && !ready && (
        <section className="card readiness" aria-label="Before you start">
          <h2>Before you start</h2>
          <ul className="checks">
            <Check ok={Boolean(health.droid)} label="Droid CLI" detail={health.droid ? `version ${health.droid}` : 'Install it: curl -fsSL https://app.factory.ai/cli | sh'} />
            <Check ok={health.api_key} label="Factory API key" detail={health.api_key ? 'found' : `Add FACTORY_API_KEY to ${health.env_files[0]}`} />
            <Check
              ok={health.accessibility}
              label="Accessibility"
              detail={health.accessibility === null ? 'checked inside the app' : 'lets Local Link click and type in your apps'}
              fix={inElectron ? { label: 'Open settings', run: () => openPrivacy('accessibility') } : undefined}
            />
            <Check
              ok={health.screen_recording === null ? null : health.screen_recording === 'granted'}
              label="Screen Recording"
              detail={health.screen_recording === null ? 'checked inside the app' : 'lets Local Link see app windows'}
              fix={inElectron ? { label: 'Open settings', run: () => openPrivacy('screen') } : undefined}
            />
          </ul>
        </section>
      )}
    </div>
  )
}
