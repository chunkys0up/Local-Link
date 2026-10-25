/**
 * What's on screen while Local Link works, outside its own window:
 *
 * - The frame: a border around the display. Dull while a build or run is going (so you
 *   know automation is about), bright with a pill naming the action while Local Link is
 *   actually driving an app. Only the pill's Stop button catches clicks.
 * - The picture-in-picture: the live build card (phase, latest screenshot, recent steps)
 *   in the top-right corner, for the whole build or run. Clicks pass through it.
 *
 * Neither window ever takes focus, so neither can steal input meant for the app being
 * driven, and the agent's screenshots capture only that app's window. Electron only.
 */

import { BrowserWindow, ipcMain, screen, type Display } from 'electron'
import { join } from 'node:path'

import * as mac from '../shared/macos'
import { JOBS, liveJob } from './jobs'
import * as ui from './uiActivity'

const PIP = { width: 380, height: 330, margin: 14 }
const POLL_MS = 1000

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --accent: #2563eb; --glow: rgba(37, 99, 235, 0.45); }
  body.paused { --accent: #d97706; --glow: rgba(217, 119, 6, 0.45); }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 13px/1.3 -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; -webkit-user-select: none; cursor: default; }
  .frame { position: fixed; inset: 0; border-radius: 12px; opacity: 0;
    transition: opacity .3s, border-color .25s, border-width .25s, box-shadow .25s; }
  /* A build or run is going: a quiet reminder. */
  body.session .frame { opacity: 1; border: 3px solid rgba(100, 116, 139, 0.45); box-shadow: none; }
  /* Driving an app right now: hands off. */
  body.on .frame { opacity: 1; border: 6px solid var(--accent); box-shadow: inset 0 0 36px 8px var(--glow); }
  .pill { position: fixed; left: 50%; top: var(--top, 10px); transform: translate(-50%, -6px);
    display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 14px; border-radius: 999px;
    background: rgba(17, 24, 39, 0.92); color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.25), 0 0 0 1px var(--accent);
    opacity: 0; transition: opacity .25s, transform .25s; white-space: nowrap; pointer-events: none; }
  body.on .pill { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 0 var(--glow); animation: pulse 1.4s infinite; }
  @keyframes pulse { 70% { box-shadow: 0 0 0 8px rgba(0,0,0,0); } 100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); } }
  .muted { color: rgba(255,255,255,.65); }
  .action { display: inline-block; max-width: 46vw; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
  button { font: inherit; font-weight: 600; color: #fff; background: rgba(255,255,255,.14); border: 0;
    border-radius: 999px; padding: 4px 12px; cursor: pointer; }
  button:hover { background: #dc2626; }
  button[hidden] { display: none; }
</style></head><body>
  <div class="frame"></div>
  <div class="pill" id="pill"><span class="dot"></span><span id="text"></span><button id="stop">Stop</button></div>
<script>
  const pill = document.getElementById('pill'), text = document.getElementById('text'), stop = document.getElementById('stop')
  // The window ignores the mouse except over the pill, so clicks reach the app beneath.
  pill.addEventListener('mouseenter', () => window.localLink.overlay.hover(true))
  pill.addEventListener('mouseleave', () => window.localLink.overlay.hover(false))
  stop.addEventListener('click', () => window.localLink.overlay.stop())
  window.render = (s) => {
    document.body.classList.toggle('session', s.session)
    document.body.classList.toggle('on', s.active)
    document.body.classList.toggle('paused', s.paused)
    document.documentElement.style.setProperty('--top', s.top + 'px')
    text.innerHTML = s.paused
      ? 'Paused <span class="muted">· waiting for you to let go of the mouse and keyboard</span>'
      : '<b></b> <span class="action"></span> <span class="muted">· hands off</span>'
    if (!s.paused) {
      text.querySelector('b').textContent = s.action ? (s.app || 'App') + ':' : 'Local Link is using ' + (s.app || 'an app')
      text.querySelector('.action').textContent = s.action || ''
    }
    stop.hidden = !s.jobId
  }
</script></body></html>`

const PANEL = {
  type: 'panel', // an NSPanel: showing it never activates Local Link
  frame: false,
  transparent: true,
  hasShadow: false,
  focusable: false,
  resizable: false,
  movable: false,
  skipTaskbar: true,
  show: false,
  // macOS otherwise keeps windows clear of the menu bar and the Dock.
  enableLargerThanScreen: true,
  webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
} as const

let frame: BrowserWindow | null = null
let pip: BrowserWindow | null = null
let rendererUrl = ''
let display: Display | null = null
let session = false
let hideTimer: ReturnType<typeof setTimeout> | null = null

function floating(win: BrowserWindow): BrowserWindow {
  win.setAlwaysOnTop(true, 'screen-saver')
  // skipTransformProcessType: without it, macOS briefly turns Local Link into a background
  // app, which hides its windows and Dock icon. The cost: nothing over full-screen spaces.
  win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  return win
}

function frameWindow(): BrowserWindow {
  if (frame && !frame.isDestroyed()) return frame
  frame = floating(new BrowserWindow(PANEL))
  void frame.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`)
  return frame
}

function pipWindow(): BrowserWindow {
  if (pip && !pip.isDestroyed()) return pip
  pip = floating(new BrowserWindow({ ...PANEL, width: PIP.width, height: PIP.height }))
  void pip.loadURL(`${rendererUrl.replace(/#.*$/, '')}#pip`)
  return pip
}

function place(): void {
  const d = display ?? screen.getPrimaryDisplay()
  frameWindow().setBounds(d.bounds)
  pipWindow().setBounds({
    x: d.workArea.x + d.workArea.width - PIP.width - PIP.margin,
    y: d.workArea.y + PIP.margin,
    width: PIP.width,
    height: PIP.height,
  })
}

/** Move to the display the app's front window is on (the primary display until we know). */
async function followApp(app: string): Promise<void> {
  let next = screen.getPrimaryDisplay()
  try {
    const front = await mac.frontWindow({ app })
    if (front) next = screen.getDisplayMatching({ x: front.x, y: front.y, width: front.w, height: front.h })
  } catch {
    // window lookup failed; the primary display is a fine place for the frame
  }
  if (display?.id === next.id) return
  display = next
  place()
}

function render(): void {
  const state = ui.current()
  const w = frameWindow()
  const d = display ?? screen.getPrimaryDisplay()
  // Just below the menu bar, clear of a MacBook's camera notch.
  const top = d.workArea.y - d.bounds.y + 10
  const payload = JSON.stringify({ ...state, session, top })
  const draw = () => void w.webContents.executeJavaScript(`window.render && window.render(${payload})`).catch(() => {})
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', draw)
  else draw()

  const visible = state.active || session
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  if (visible) {
    if (!display) place()
    if (!w.isVisible()) w.showInactive()
  } else {
    hideTimer = setTimeout(() => w.hide(), 350) // let the fade finish
  }
  const p = pipWindow()
  if (session && !p.isVisible()) p.showInactive()
  if (!session && p.isVisible()) p.hide()
}

export function installOverlay(url: string): void {
  rendererUrl = url
  ipcMain.on('overlay-hover', (_event, over: boolean) => {
    frame?.setIgnoreMouseEvents(!over, { forward: true })
  })
  ipcMain.on('overlay-stop', () => {
    const jobId = ui.current().jobId ?? liveJob()?.id
    if (jobId) void JOBS.get(jobId)?.stop()
  })
  let lastApp = ''
  ui.onChange((state) => {
    if (state.active && state.app !== lastApp) void followApp(state.app)
    lastApp = state.active ? state.app : ''
    render()
  })
  // Builds and runs live in the engine; check for one each second.
  setInterval(() => {
    const now = liveJob() !== null
    if (now === session) return
    session = now
    if (!session) display = null
    render()
  }, POLL_MS)
}
