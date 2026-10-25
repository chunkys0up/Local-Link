/**
 * Whether Retronaut is driving an app's UI right now, for the on-screen frame. UI
 * actions (the agent's tools in this process, workflow scripts through their reports)
 * begin and end here; the frame shows from the first begin and hides a moment after
 * the last end, so a burst of actions reads as one stretch of "hands off".
 */

export interface UiState {
  active: boolean
  app: string
  jobId: string | null
  /** Waiting for the person to let go of the mouse and keyboard. */
  paused: boolean
  /** What's happening right now, e.g. "Typing the CSV path"; kept until the frame hides. */
  action: string
}

export const HIDE_AFTER_MS = 1500

type Listener = (state: UiState) => void

let depth = 0
let state: UiState = { active: false, app: '', jobId: null, paused: false, action: '' }
let hideTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<Listener>()

function publish(next: Partial<UiState>): void {
  const changed = Object.entries(next).some(([k, v]) => state[k as keyof UiState] !== v)
  state = { ...state, ...next }
  if (changed) for (const l of listeners) l(state)
}

export function onChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function current(): UiState {
  return state
}

export function begin(app: string, jobId: string | null, action = ''): void {
  depth++
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  publish({ active: true, app, jobId, ...(action ? { action } : {}) })
}

export function end(): void {
  depth = Math.max(0, depth - 1)
  if (depth > 0) return
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (depth === 0) publish({ active: false, paused: false, action: '' })
  }, HIDE_AFTER_MS)
}

export function paused(waiting: boolean): void {
  publish({ paused: waiting })
}

/** Run one UI action inside the frame. */
export async function during<T>(app: string, jobId: string | null, action: () => Promise<T>, label = ''): Promise<T> {
  begin(app, jobId, label)
  try {
    return await action()
  } finally {
    end()
  }
}

/** Testing aid. */
export function reset(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  depth = 0
  state = { active: false, app: '', jobId: null, paused: false, action: '' }
}

const KEY_NAMES: Record<string, string> = { return: '↵', enter: '↵', tab: 'Tab', escape: 'Esc', esc: 'Esc', space: 'Space', delete: '⌫', backspace: '⌫', up: '↑', down: '↓', left: '←', right: '→' }

/** "cmd+shift+g" -> "⌘⇧G", "down" -> "↓": how the pill shows keys. */
export function keyLabel(combo: string): string {
  const parts = combo.toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const mods = parts.map((m) => ({ cmd: '⌘', command: '⌘', shift: '⇧', alt: '⌥', option: '⌥', opt: '⌥', ctrl: '⌃', control: '⌃' })[m] ?? m).join('')
  return mods + (KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key))
}

/** Shorten typed text for the pill. */
export function typedLabel(text: string, max = 48): string {
  const one = text.replace(/\s+/g, ' ')
  return `Typing “${one.length > max ? `${one.slice(0, max - 1)}…` : one}”`
}
