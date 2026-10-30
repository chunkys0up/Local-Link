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
import { JOBS, liveJob } from './jobs'
import * as ui from './uiActivity'

const PIP = { width: 320, height: 170, margin: 14, opacity: 0.9 }
// A MacBook's built-in display has rounded corners; the frame follows its edge (external
// displays are square). The corners are a fixed size on the panel, so they're set in the
// panel's own pixels and turned into points for the current scaling ("More Space" makes a
// point fewer pixels). Matched by eye on a 14-inch MacBook Pro (M4 Pro).
const CORNERS_PX = { top: 40, bottom: 40 }
const POLL_MS = 1000

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --accent: #ff4608; --glow: rgba(255, 70, 8, 0.45); }
  body.paused { --accent: #fbbf24; --glow: rgba(251, 191, 36, 0.4); }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 13px/1.3 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; -webkit-user-select: none; cursor: default; }
  .frame { position: fixed; inset: 0; border-radius: var(--top-r, 0) var(--top-r, 0) var(--bottom-r, 0) var(--bottom-r, 0); opacity: 0;
    transition: opacity .3s, border-color .25s, border-width .25s, box-shadow .25s; }
  /* A build or run is going: a quiet reminder. Its border is a ring (masked to the edge)
     lit by one radial glow, brightest at its centre, whose centre circles the edge of the
     screen (orbit, written for the screen's size below). */
  @property --gx { syntax: '<length>'; inherits: false; initial-value: 0px; }
  @property --gy { syntax: '<length>'; inherits: false; initial-value: 0px; }
  .frame::before { content: ''; position: absolute; inset: 0; padding: 5px; border-radius: inherit; opacity: 0;
    background: radial-gradient(circle 700px at var(--gx) var(--gy), rgb(255, 190, 140), rgba(255, 125, 54, 0.85) 30%, rgba(255, 110, 40, 0.3));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
    transition: opacity .3s; }
  body.session .frame { opacity: 1; box-shadow: inset 0 0 22px rgba(255, 70, 8, 0.22);
    transition: opacity .3s, border-color .25s, border-width .25s, box-shadow 2.2s ease-out; }
  /* When it appears, the ring draws itself on first: a glowing line traced clockwise around
     the edge from the top-left corner (an SVG rounded rect, so it follows the corners at one
     even speed), a bright tip leading, on a gentle, fairly even ease-out. As it closes, the
     glows shrink away (they narrow to nothing rather than fade), and the thin line hands over
     to the ring, whose glow then circles on. */
  body.session .frame::before { opacity: 1; animation: orbit 8s linear 2.2s infinite; }
  body.drawing .frame::before { animation: ring-in .5s ease-out 2.2s both, orbit 8s linear 2.2s infinite; }
  @keyframes ring-in { from { opacity: 0; } }
  body.on .frame::before { opacity: 0; }
  .draw { position: fixed; inset: 0; width: 100%; height: 100%; overflow: visible; opacity: 0; pointer-events: none; }
  body.drawing .draw { opacity: 1; animation: draw-fade-in .5s ease-out both; } /* the line fades in as it starts */
  @keyframes draw-fade-in { from { opacity: 0; } }
  body.on .draw { display: none; }
  .draw rect { x: 2.5px; y: 2.5px; width: calc(100% - 5px); height: calc(100% - 5px); rx: max(0px, calc(var(--top-r, 0px) - 2.5px));
    fill: none; stroke-width: 5px; stroke-linecap: round; }
  .draw .halo { stroke: rgb(255, 120, 50); stroke-width: 14px; filter: blur(10px); opacity: .55; }
  .draw .line { stroke: rgba(255, 125, 54, 0.75); }
  .draw .head { stroke: rgb(255, 205, 160); stroke-dasharray: 70 930; }
  .draw .head-halo { stroke: rgb(255, 170, 110); stroke-width: 12px; stroke-dasharray: 90 910; filter: blur(7px); opacity: .7; }
  body.drawing .draw .halo { stroke-dasharray: 1000 1000;
    animation: draw-on 2.2s cubic-bezier(0.32, 0.4, 0.62, 0.88) both, shrink-glow .9s ease-in-out 1.7s both; }
  body.drawing .draw .line { stroke-dasharray: 1000 1000;
    animation: draw-on 2.2s cubic-bezier(0.32, 0.4, 0.62, 0.88) both, hand-over .5s ease-out 2.2s both; }
  body.drawing .draw .head { animation: draw-head 2.2s cubic-bezier(0.32, 0.4, 0.62, 0.88) both, shrink-tip .6s ease-in 1.6s both; }
  body.drawing .draw .head-halo { animation: draw-head-halo 2.2s cubic-bezier(0.32, 0.4, 0.62, 0.88) both, shrink-glow .6s ease-in 1.6s both; }
  @keyframes draw-on { from { stroke-dashoffset: 1000; } to { stroke-dashoffset: 0; } }
  @keyframes draw-head { from { stroke-dashoffset: 70; } to { stroke-dashoffset: -930; } }
  @keyframes draw-head-halo { from { stroke-dashoffset: 90; } to { stroke-dashoffset: -910; } }
  @keyframes shrink-tip { to { stroke-width: 0; } }
  @keyframes shrink-glow { to { stroke-width: 0; filter: blur(0); } }
  @keyframes hand-over { to { opacity: 0; } }
  /* Driving an app right now: hands off. */
  body.on .frame { opacity: 1; border: 6px solid var(--accent); box-shadow: inset 0 0 36px 8px var(--glow); }
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
  <svg class="draw" aria-hidden="true">
    <rect class="halo" pathLength="1000" /><rect class="line" pathLength="1000" />
    <rect class="head-halo" pathLength="1000" /><rect class="head" pathLength="1000" />
  </svg>
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
  // The draw-on plays once, when a session first shows the frame (not each time the frame
  // comes back from "hands off").
  let wasSession = false
  let drawn = null
  const drawOn = () => {
    clearTimeout(drawn)
    document.body.classList.remove('drawing')
    void document.body.offsetWidth // restart the animations
    document.body.classList.add('drawing')
    drawn = setTimeout(() => document.body.classList.remove('drawing'), 2800)
  }
  window.render = (s) => {
    drawOrbit()
    if (s.session && !wasSession) drawOn()
    wasSession = s.session
    document.body.classList.toggle('session', s.session)
    document.body.classList.toggle('on', s.active)
    document.body.classList.toggle('paused', s.paused)
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
  const payload = JSON.stringify({ ...state, session, top, corners: cornerRadii(d) })
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
  // Builds and runs live in the engine; check for one each second.
  setInterval(() => {
    const now = liveJob() !== null
    if (now === session) return
    session = now
    if (!session) display = null
    render()
  }, POLL_MS)
}
