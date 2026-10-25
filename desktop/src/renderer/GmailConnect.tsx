import { useState, type FormEvent } from 'react'

import { api, openExternal } from './api'

const APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords'

/**
 * Connect Gmail with an app password. It goes to the engine, which checks it against
 * Gmail and keeps it in the macOS keychain; the page never stores it.
 */
export function GmailConnect({ onConnected, compact = false }: { onConnected: (email: string) => void; compact?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api<{ email: string }>('/connectors/gmail', { email, app_password: password })
      setPassword('')
      onConnected(res.email)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={`gmail-connect${compact ? ' compact' : ''}`} onSubmit={submit}>
      <div className="gmail-fields">
        <input type="email" required placeholder="you@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" aria-label="Gmail address" />
        <input
          type="password"
          required
          placeholder="App password (16 letters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          aria-label="Google app password"
        />
        <button type="submit" disabled={busy || !email || !password}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Checking…' : 'Connect Gmail'}
        </button>
      </div>
      <p className="small muted">
        Use an app password, not your Google password.{' '}
        <button type="button" className="link inline" onClick={() => openExternal(APP_PASSWORDS_URL)}>
          Create one
        </button>{' '}
        (needs 2-Step Verification). Local Link only reads mail, and keeps the password in your Mac's keychain.
      </p>
      {error && <p className="request-error">{error}</p>}
    </form>
  )
}
