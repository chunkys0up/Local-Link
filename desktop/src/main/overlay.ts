/**
 * What's on screen while Retronaut works, outside its own window:
 *
 * - The frame: a border around the display. Dull while a build or run is going (so you
 *   know automation is about), bright with a pill naming the action while Retronaut is
 *   actually driving an app. Only the pill's Stop button catches clicks.
 * - The picture-in-picture: what the build or run is doing and its last three steps, in
 *   the top-right corner, for the whole build or run. Clicks pass through it, and it
 *   fades away while the pointer is over it.
 *
 * Neither window ever takes focus, so neither can steal input meant for the app being
 * driven, and the agent's screenshots capture only that app's window. Electron only.
 */

import { BrowserWindow, ipcMain, screen, type Display } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import * as mac from '../shared/macos'
import { JOBS, liveJob, onJobsChange } from './jobs'
import * as ui from './uiActivity'

const PIP = { width: 320, height: 170, margin: 14, opacity: 0.9 }
// A MacBook's built-in display has rounded corners; the frame follows its edge (external
// displays are square). The corners are a fixed size on the panel, so they're set in the
// panel's own pixels and turned into points for the current scaling ("More Space" makes a
// point fewer pixels). Matched by eye on a 14-inch MacBook Pro (M4 Pro).
const CORNERS_PX = { top: 40, bottom: 30 } // its bottom corners are tighter than its top ones

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --accent: #ff4608; --glow: rgba(255, 70, 8, 0.45); }
  body.paused { --accent: #fbbf24; --glow: rgba(251, 191, 36, 0.4); }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 13px/1.3 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; -webkit-user-select: none; cursor: default; }
  /* The frame rests 8px past the screen's edges (its border 8px thicker to match), so its
     arrival can spring a little inward without uncovering the edge. */
  .frame { position: fixed; inset: -8px; border-radius: calc(var(--top-r, 0px) + 8px) calc(var(--top-r, 0px) + 8px) calc(var(--bottom-r, 0px) + 8px) calc(var(--bottom-r, 0px) + 8px); opacity: 0;
    transition: opacity .3s, border-color .25s, border-width .25s, box-shadow .25s; }
  /* A build or run is going: a quiet reminder. Its border is a ring (masked to the edge)
     lit by one radial glow, brightest at its centre, whose centre travels around the
     edge of the screen (the orbit keyframes are written for the screen's size below). */
  @property --gx { syntax: '<length>'; inherits: false; initial-value: 0px; }
  @property --gy { syntax: '<length>'; inherits: false; initial-value: 0px; }
  @property --glow-r { syntax: '<length>'; inherits: false; initial-value: 700px; }
  .frame::before { content: ''; position: absolute; inset: 0; padding: 13px; border-radius: inherit; opacity: 0;
    background: radial-gradient(circle var(--glow-r) at var(--gx) var(--gy), rgb(255, 190, 140), rgba(255, 125, 54, 0.85) 30%, rgba(255, 110, 40, 0.3));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
    transition: opacity .3s; animation: orbit 8s linear infinite; }
  body.session .frame { opacity: 1; box-shadow: inset 0 0 22px 8px rgba(255, 70, 8, 0.22);
    animation: frame-in 3.1s linear(0, 0.0272, 0.0995, 0.2033, 0.3264, 0.4582, 0.5898, 0.7145, 0.8272, 0.9245, 1.0048, 1.0675, 1.1131, 1.1429, 1.1588, 1.163, 1.1577, 1.1453, 1.128, 1.1077, 1.0862, 1.0648, 1.0446, 1.0265, 1.0109, 0.9981, 0.9881, 0.981, 0.9763, 0.974, 0.9735, 0.9744, 0.9766, 0.9795, 0.9828, 0.9863, 0.9898, 0.993, 0.996, 0.9985, 1.0005, 1.0021, 1.0032, 1.0039, 1) both, frame-fade 1s cubic-bezier(0.33, 1, 0.68, 1) .45s backwards; }
  /* Appearing, it closes in from just past the screen's edges (the same 12px on every side,
     not a scale, which would reach further out on the long sides) on a slow, heavy spring,
     about 2px inward (its peak at 1.05s) and back, fading in from the moment its ring comes on screen (0.45s, the
     ring starting just past the edge) over 1s. */
  @keyframes frame-in { from { inset: -20px; } }
  @keyframes frame-fade { from { opacity: 0; } }
  /* Appearing, the whole ring starts as bright as the glow's centre, then the brightness
     condenses into the moving glow (its radius shrinking from far past the screen to 700px)
     as the frame swings back from its overshoot (35% of 3s: the spring's peak). */
  body.session .frame::before { opacity: 1; animation: orbit 8s linear infinite, glow-in 3s ease-in-out both; }
  @keyframes glow-in { 0%, 35% { --glow-r: 9000px; } }
  body.on .frame::before { opacity: 0; }
  /* The build is paused: the glow stops where it is and fades away, leaving the plain ring
     (::after, under it), and the whole frame dims a little; unpausing reverses both, the glow
     moving on from where it stopped. The plain ring only shows while paused, so it doesn't
     brighten the glowing ring's dim stretches. */
  .frame::before { z-index: 1; }
  .frame::after { content: ''; position: absolute; inset: 0; padding: 13px; border-radius: inherit; z-index: 0;
    background: rgba(255, 110, 40, 0.3); opacity: 0; transition: opacity .8s ease-in-out;
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
  body.held .frame::after { opacity: 1; }
  body.session .frame, body.session .frame::before { transition: opacity .8s ease-in-out, border-color .25s, border-width .25s, box-shadow .8s ease-in-out; }
  body.held .frame { opacity: .7; box-shadow: inset 0 0 22px 8px rgba(255, 70, 8, 0.12); }
  body.held .frame::before { opacity: 0; animation-play-state: paused; }
  /* Driving an app right now: hands off. */
  body.on .frame { opacity: 1; border: 14px solid var(--accent); box-shadow: inset 0 0 36px 16px var(--glow); }
  .pill { position: fixed; left: 50%; top: var(--top, 10px); transform: translate(-50%, -6px);
    display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 14px; border-radius: 999px;
    background: rgba(28, 28, 27, 0.94); color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.25), 0 0 0 1px var(--accent);
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
  // The glow's path: clockwise along the screen's edge from the top-left, each side taking
  // time in proportion to its length, so it moves at one speed all the way round. Redrawn
  // whenever the frame updates: the window starts small and hidden, then fills the screen.
  const orbit = document.createElement('style')
  document.head.appendChild(orbit)
  let orbitFor = ''
  const drawOrbit = () => {
    const w = innerWidth, h = innerHeight, p = 2 * (w + h)
    if (!w || !h || orbitFor === w + 'x' + h) return
    orbitFor = w + 'x' + h
    const at = (d) => (100 * d / p).toFixed(3) + '%'
    orbit.textContent = '@keyframes orbit {' +
      '0%, 100% { --gx: 0vw; --gy: 0vh }' +
      at(w) + ' { --gx: 100vw; --gy: 0vh }' +
      at(w + h) + ' { --gx: 100vw; --gy: 100vh }' +
      at(2 * w + h) + ' { --gx: 0vw; --gy: 100vh } }'
  }
  drawOrbit()
  addEventListener('resize', drawOrbit)
  const pill = document.getElementById('pill'), text = document.getElementById('text'), stop = document.getElementById('stop')
  // The window ignores the mouse except over the pill, so clicks reach the app beneath.
  pill.addEventListener('mouseenter', () => window.retronaut.overlay.hover(true))
  pill.addEventListener('mouseleave', () => window.retronaut.overlay.hover(false))
  stop.addEventListener('click', () => window.retronaut.overlay.stop())
  window.render = (s) => {
    drawOrbit()
    document.body.classList.toggle('session', s.session)
    document.body.classList.toggle('on', s.active)
    document.body.classList.toggle('paused', s.paused)
    document.body.classList.toggle('held', s.held)
    document.documentElement.style.setProperty('--top', s.top + 'px')
    document.documentElement.style.setProperty('--top-r', s.corners.top + 'px')
    document.documentElement.style.setProperty('--bottom-r', s.corners.bottom + 'px')
    text.innerHTML = s.paused
      ? 'Paused <span class="muted">· waiting for you to let go of the mouse and keyboard</span>'
      : '<b></b> <span class="action"></span> <span class="muted">· hands off</span>'
    if (!s.paused) {
      text.querySelector('b').textContent = s.action ? (s.app || 'App') + ':' : 'Retronaut is using ' + (s.app || 'an app')
      text.querySelector('.action').textContent = s.action || ''
    }
    stop.hidden = !s.jobId
  }
</script></body></html>`

const PANEL = {
  type: 'panel', // an NSPanel: showing it never activates Retronaut
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
let held = false // the live build is paused
let hideTimer: ReturnType<typeof setTimeout> | null = null

function floating(win: BrowserWindow): BrowserWindow {
  win.setAlwaysOnTop(true, 'screen-saver')
  // skipTransformProcessType: without it, macOS briefly turns Retronaut into a background
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
  pip = floating(new BrowserWindow({ ...PANEL, width: PIP.width, height: PIP.height, opacity: PIP.opacity }))
  void pip.loadURL(`${rendererUrl.replace(/#.*$/, '')}#pip`)
  return pip
}

// The whole window fades (a CSS fade leaves the card's glass behind), from wherever
// it is now, so moving in and out quickly never jumps.
let pipFade: ReturnType<typeof setInterval> | null = null
function fadePip(to: number): void {
  if (pipFade) clearInterval(pipFade)
  const win = pip
  if (!win || win.isDestroyed()) return
  const from = win.getOpacity()
  const started = Date.now()
  pipFade = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / 220)
    if (!win.isDestroyed()) win.setOpacity(from + (to - from) * (1 - (1 - t) ** 2))
    if (t === 1 && pipFade) clearInterval(pipFade)
  }, 16)
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

// The built-in panel's width in pixels (e.g. 3024), read once; null until known.
let panelWidth: number | null = null
async function readPanelWidth(): Promise<void> {
  try {
    const { stdout } = await promisify(execFile)('system_profiler', ['SPDisplaysDataType'], { timeout: 15_000 })
    // The built-in panel's own section (the GPU's also says "Built-In", but has no resolution).
    const builtIn = stdout.split(/\n(?=\s{8}\S)/).find((block) => /Resolution:/.test(block) && /Built-in|Internal/i.test(block)) ?? ''
    const width = Number(/Resolution:\s*(\d+)\s*x\s*\d+/.exec(builtIn)?.[1])
    if (width > 0) panelWidth = width
  } catch {
    // cornerRadii falls back to the display's scale factor
  }
}

/** The frame's corner radii in points on this display. */
function cornerRadii(d: Display): { top: number; bottom: number } {
  if (!d.internal) return { top: 0, bottom: 0 }
  const pixelsPerPoint = panelWidth ? panelWidth / d.size.width : d.scaleFactor
  const points = (px: number) => Math.round((px / pixelsPerPoint) * 10) / 10
  return { top: points(CORNERS_PX.top), bottom: points(CORNERS_PX.bottom) }
}

function render(): void {
  const state = ui.current()
  const w = frameWindow()
  const d = display ?? screen.getPrimaryDisplay()
  // Just below the menu bar, clear of a MacBook's camera notch.
  const top = d.workArea.y - d.bounds.y + 10
  const payload = JSON.stringify({ ...state, session, held, top, corners: cornerRadii(d) })
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
  if (session && !p.isVisible()) {
    p.setOpacity(PIP.opacity)
    p.showInactive()
  }
  if (!session && p.isVisible()) p.hide()
}

export function installOverlay(url: string): void {
  rendererUrl = url
  void readPanelWidth().then(render)
  ipcMain.on('overlay-hover', (_event, over: boolean) => {
    frame?.setIgnoreMouseEvents(!over, { forward: true })
  })
  ipcMain.on('pip-hover', (_event, over: boolean) => fadePip(over ? 0 : PIP.opacity))
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
  // Builds and runs live in the engine, in this process: it says when one starts, ends, or is
  // paused or resumed, and the frame follows at once.
  const syncJobs = () => {
    const live = liveJob()
    const now = live !== null
    const pausedNow = live?.paused ?? false
    if (now === session && pausedNow === held) return
    session = now
    held = pausedNow
    if (!session) display = null
    render()
  }
  onJobsChange(syncJobs)
  syncJobs()
}
