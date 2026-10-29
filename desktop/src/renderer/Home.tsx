import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'

import { api, inElectron, openPrivacy, type Health } from './api'
import arrow from './assets/arrow-up-right.svg'
import type { Box } from './Flight'

// Short teasers on the stage; picking one puts the whole prompt in the composer.
const SUGGESTIONS = [
  {
    label: 'Every friday, read my payments...',
    prompt: 'Every Friday, read the payments in my GnuCash checking account and email me a summary of anything over $1,000.',
  },
  {
    label: 'Copy new bills from Outlook into...',
    prompt: 'Copy new bills from my Outlook inbox into GnuCash as vendor bills.',
  },
  {
    label: 'Create matching invoices per job...',
    prompt: 'Every work order my vendor emails me, total it per work-order number and create a matching invoice in GnuCash for that customer.',
  },
]

// The glass tiles around the composer and suggestions, as [column, row] in a 12 × 8 grid.
const TILES: [number, number][] = [
  ...[1, 2, 11, 12].map((c): [number, number] => [c, 3]),
  ...[1, 2, 3, 10, 11, 12].map((c): [number, number] => [c, 4]),
  ...[5, 6, 7, 8].flatMap((r) => Array.from({ length: 12 }, (_, i): [number, number] => [i + 1, r])),
]

const at = (column: number, row: number, span = 1): CSSProperties => ({ gridColumn: `${column} / span ${span}`, gridRow: row })

/** A tile's blink: its own slow cycle, a start part-way through it, and how bright it gets. */
function blink(): CSSProperties {
  const duration = 5 + Math.random() * 9
  return {
    '--bit-duration': `${duration.toFixed(2)}s`,
    '--bit-delay': `${(-Math.random() * duration).toFixed(2)}s`,
    '--bit-peak': (0.35 + Math.random() * 0.65).toFixed(2),
  } as CSSProperties
}

const COMPOSER_INSET = 24 // the composer's distance from the edges of its slot
const BELOW_HERO = 32 // how close the growing composer may come to the subtitle

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

export function Home({ onStart, leaving = false }: { onStart: (prompt: string, from?: Box) => Promise<void>; leaving?: boolean }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const blinks = useMemo(() => TILES.map(blink), [])
  const hero = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const form = useRef<HTMLFormElement>(null)

  // The composer fills its slot, grows upwards with its text until it nears the
  // headline, then stops and scrolls inside.
  const fit = useCallback(() => {
    const text = box.current
    const card = form.current
    if (!text || !card || !slot.current || !hero.current) return
    text.style.height = '0px'
    const chrome = card.offsetHeight // padding, button row and gaps, without the text
    const content = text.scrollHeight
    const slotBox = slot.current.getBoundingClientRect()
    const stacked = getComputedStyle(card).position !== 'absolute' // small screens: no growing upwards
    const smallest = stacked ? 96 : slotBox.height - COMPOSER_INSET * 2 - chrome
    const tallest = stacked
      ? 280
      : slotBox.bottom - COMPOSER_INSET - (hero.current.getBoundingClientRect().bottom + BELOW_HERO) - chrome
    const height = Math.max(smallest, Math.min(content, Math.max(smallest, tallest)))
    text.style.height = `${height}px`
    text.style.overflowY = content > height ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(fit, [fit, prompt, error])
  useEffect(() => {
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  useEffect(() => {
    const load = () => api<Health>('/health').then(setHealth).catch(() => setHealth(null))
    load()
    // Permissions are granted in System Settings, outside the app; notice when that happens.
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = form.current?.getBoundingClientRect()
      await onStart(prompt.trim(), r && { left: r.left, top: r.top, width: r.width, height: r.height })
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

  // A click anywhere in the composer types into it, not just on the text area: its padding
  // and the row beside the button too. The caret goes to the end.
  function focusComposer(e: MouseEvent<HTMLFormElement>) {
    const text = box.current
    if (!text || e.target === text || (e.target as HTMLElement).closest('button, a, input')) return
    e.preventDefault() // keep the focus from leaving the text area
    text.focus()
    text.setSelectionRange(text.value.length, text.value.length)
  }

  function suggest(text: string) {
    setPrompt(text)
    box.current?.focus()
  }

  const ready = health && health.droid && health.api_key && health.accessibility !== false && health.screen_recording !== 'denied'

  return (
    <div className={`home${leaving ? ' leaving' : ''}`}>
      {health && !ready && (
        <section className="notice home-notice" aria-label="Before you start">
          <h2>Before you start</h2>
          <ul className="checks">
            <Check ok={Boolean(health.droid)} label="Droid CLI" detail={health.droid ? `version ${health.droid}` : 'Install it: curl -fsSL https://app.factory.ai/cli | sh'} />
            <Check ok={health.api_key} label="Factory API key" detail={health.api_key ? 'found' : `Add FACTORY_API_KEY to ${health.env_files[0]}`} />
            <Check
              ok={health.accessibility}
              label="Accessibility"
              detail={health.accessibility === null ? 'checked inside the app' : 'lets Retronaut click and type in your apps'}
              fix={inElectron ? { label: 'Open settings', run: () => openPrivacy('accessibility') } : undefined}
            />
            <Check
              ok={health.screen_recording === null ? null : health.screen_recording === 'granted'}
              label="Screen Recording"
              detail={health.screen_recording === null ? 'checked inside the app' : 'lets Retronaut see app windows'}
              fix={inElectron ? { label: 'Open settings', run: () => openPrivacy('screen') } : undefined}
            />
          </ul>
        </section>
      )}

      <div className="home-hero" ref={hero}>
        <h1>
          Let’s <span className="retro">Retro</span>automate your
          <br />
          legacy finance workflows.
        </h1>
        <p>
          Retronaut explores your apps and accounts, shows you its plan, then builds an automation that runs on your own software and repairs itself when anything changes.
        </p>
      </div>

      <div className="home-stage">
        {TILES.map(([c, r], i) => (
          <span
            key={`${c}-${r}`}
            className="tile"
            style={{ ...at(c, r), ...blinks[i], '--out-delay': `${(r - 3) * 45 + Math.abs(c - 6.5) * 12}ms` } as CSSProperties}
            aria-hidden="true"
          />
        ))}

        <div className="composer-slot" ref={slot}>
          <form className="composer" ref={form} onSubmit={submit} onMouseDown={focusComposer}>
            <textarea
              ref={box}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Take the work order emails that my vendor emails me, add up each order, and create the invoices in my accounting software"
              autoFocus
              aria-label="Describe the workflow to automate"
            />
            {error && <p className="request-error">{error}</p>}
            <div className="composer-foot">
              {prompt && <span className="hint">Enter to build · Shift+Enter for a new line</span>}
              <button type="submit" disabled={!prompt.trim() || busy}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? 'Starting…' : 'Build workflow'}
              </button>
            </div>
          </form>
        </div>

        {SUGGESTIONS.map((s, i) => (
          <button key={s.label} type="button" className="chip" style={at(4 + i * 2, 4, 2)} onClick={() => suggest(s.prompt)} title={s.prompt}>
            <span>{s.label}</span>
            <img src={arrow} width={20} height={20} alt="" />
          </button>
        ))}
      </div>
    </div>
  )
}
