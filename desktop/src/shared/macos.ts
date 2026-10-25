/**
 * macOS control with what the OS ships: JXA (osascript -l JavaScript) for windows,
 * accessibility, menus, keys and CoreGraphics mouse events, screencapture and sips for
 * screenshots. Shared by the agent's tools (main) and generated scripts (runtime).
 *
 * Coordinates are global screen points, top-left origin, the space CoreGraphics,
 * System Events and screencapture -R all use. Needs Accessibility and Screen
 * Recording for whichever app runs this (Local Link, or the terminal in dev).
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface AppWindow extends Rect {
  id: number
  title: string
  app: string
  pid: number
  layer: number
}

export interface AxNode {
  path: string
  role: string
  name: string
  value?: string
  frame?: Rect
  enabled?: boolean
  children?: number
}

export class PermissionError extends Error {}

/** Run a JXA function body with `a` (the JSON args) in scope; returns its JSON result. */
export async function jxa<T>(body: string, args: unknown = {}, timeoutMs = 20_000): Promise<T> {
  const script = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
const se = Application('System Events');
function procOf(a) {
  const ps = se.processes.whose(a.bundleId ? { bundleIdentifier: a.bundleId } : { name: a.app });
  if (!ps.length) throw new Error('not running: ' + (a.app || a.bundleId));
  return ps[0];
}
function run(argv) { const a = JSON.parse(argv[0]); const out = (() => { ${body} })(); return JSON.stringify(out === undefined ? null : out); }`
  try {
    const { stdout } = await exec('osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(args)], {
      timeout: timeoutMs,
      maxBuffer: 16 << 20,
    })
    return JSON.parse(stdout.trim() || 'null') as T
  } catch (e) {
    const text = String((e as { stderr?: string }).stderr || (e as Error).message)
    if (/assistive access|-25211|-1719|not allowed to send keystrokes|-1743/.test(text)) {
      throw new PermissionError(
        'macOS has not given Local Link Accessibility / Automation access. Turn it on in System Settings > Privacy & Security > Accessibility, then try again.',
      )
    }
    throw new Error(text.replace(/^.*execution error: (Error: )*/s, '').trim().slice(0, 400))
  }
}

export interface AppRef {
  app: string // process name, e.g. "GnuCash"
  bundleId?: string
}

// ---------- the input guard ----------
//
// Local Link drives the real mouse and keyboard, so it must not act while a person is
// using them: their input would interleave with its own. Before every action it checks
// how long the hardware has been idle and waits until the person has let go. Input
// Local Link itself just sent is told apart by time: anything up to ownInputUntil is ours.

export const QUIET_MS = 1200 // how long the person must be idle before Local Link acts
export const MAX_WAIT_MS = 120_000
const OWN_INPUT_SLACK_MS = 400 // our events can register a little after the call returns

let ownInputUntil = 0

/** Hooks a process installs to show that automation is waiting for the person. */
export const inputGuard: { enabled: boolean; onWait: (waiting: boolean) => void } = {
  enabled: true,
  onWait: () => {},
}

/** True if the latest input came from a person (not from us) and they're still active. */
export function userBusy(idleSeconds: number, now: number, ownUntil: number, quietMs = QUIET_MS): boolean {
  const lastInputAt = now - idleSeconds * 1000
  if (lastInputAt <= ownUntil) return false // our own click or keys, or older than them
  return idleSeconds * 1000 < quietMs
}

export async function secondsSinceInput(): Promise<number> {
  // HID system state, any input event type: real keyboard, mouse and trackpad activity.
  return jxa<number>(`return $.CGEventSourceSecondsSinceLastEventType(1, 4294967295)`)
}

/** Wait until the person has stopped using the mouse and keyboard. */
export async function waitForUserIdle(): Promise<void> {
  if (!inputGuard.enabled) return
  const until = Date.now() + MAX_WAIT_MS
  let waiting = false
  try {
    while (userBusy(await secondsSinceInput(), Date.now(), ownInputUntil)) {
      if (!waiting) {
        waiting = true
        inputGuard.onWait(true)
      }
      if (Date.now() > until) {
        throw new Error(`You were using the mouse or keyboard for ${MAX_WAIT_MS / 60000} minutes, so Local Link didn't act. Let go of them and run again.`)
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  } finally {
    if (waiting) inputGuard.onWait(false)
  }
}

/** Run one input action: wait for the person to let go, act, and mark the input as ours. */
async function asUser<T>(action: () => Promise<T>): Promise<T> {
  await waitForUserIdle()
  try {
    return await action()
  } finally {
    ownInputUntil = Date.now() + OWN_INPUT_SLACK_MS
  }
}

const WAIT_FRONT = `for (let i = 0; i < 20; i++) { const f = se.processes.whose({ frontmost: true }); if (f.length && (a.bundleId ? f[0].bundleIdentifier() === a.bundleId : f[0].name() === a.app)) return true; delay(0.1); } return false`

/**
 * Bring the app to the front (launching it if needed) and wait until it is frontmost.
 * macOS often ignores a background process's request to activate another app while the
 * user is in a third one, so this escalates: the app's own activate, then System Events
 * (Accessibility), then LaunchServices (what the Dock does).
 */
export async function activate(ref: AppRef): Promise<boolean> {
  return asUser(() => bringToFront(ref))
}

async function bringToFront(ref: AppRef): Promise<boolean> {
  const steps = [
    `const app = a.bundleId ? Application(a.bundleId) : Application(a.app); app.activate();`,
    `procOf(a).frontmost = true;`,
  ]
  for (const step of steps) {
    try {
      if (await jxa<boolean>(`${step} ${WAIT_FRONT}`, ref)) return true
    } catch (e) {
      if (e instanceof PermissionError) throw e
    }
  }
  await exec('open', ref.bundleId ? ['-b', ref.bundleId] : ['-a', ref.app]).catch(() => {})
  return jxa<boolean>(WAIT_FRONT, ref)
}

export async function frontmost(): Promise<{ app: string; bundleId: string; pid: number }> {
  return jxa(`const p = se.processes.whose({ frontmost: true })[0]; return { app: p.name(), bundleId: p.bundleIdentifier() || '', pid: p.unixId() }`)
}

/**
 * On-screen windows from the window server, front to back. Works for apps (like GTK
 * ones) that expose little to accessibility. Optionally only one app's (by pid).
 */
export async function windows(pid?: number): Promise<AppWindow[]> {
  const all = await jxa<AppWindow[]>(
    `const info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
     return info.map(w => ({ id: w.kCGWindowNumber, title: w.kCGWindowName || '', app: w.kCGWindowOwnerName || '', pid: w.kCGWindowOwnerPID,
       layer: w.kCGWindowLayer, x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height }))`,
  )
  return all.filter((w) => w.layer === 0 && w.w > 40 && w.h > 40 && (pid === undefined || w.pid === pid))
}

export async function pidOf(ref: AppRef): Promise<number> {
  return jxa<number>(`return procOf(a).unixId()`, ref)
}

/** The app's frontmost normal window, or null. */
export async function frontWindow(ref: AppRef): Promise<AppWindow | null> {
  const wins = await windows(await pidOf(ref))
  return wins[0] ?? null
}

export interface Shot {
  jpeg: Buffer
  width: number // image pixels
  height: number
  region: Rect // screen points the image covers
  window: AppWindow | null
}

/** Screenshot of the app's front window (or the whole main screen), scaled to maxWidth px. */
export async function screenshot(opts: { ref?: AppRef; maxWidth?: number } = {}): Promise<Shot> {
  const maxWidth = opts.maxWidth ?? 1280
  const dir = mkdtempSync(join(tmpdir(), 'local-link-shot-'))
  try {
    const raw = join(dir, 'raw.png')
    const out = join(dir, 'shot.jpg')
    const win = opts.ref ? await frontWindow(opts.ref) : null
    let region: Rect
    if (win) {
      await exec('screencapture', ['-x', '-o', '-l', String(win.id), raw])
      region = { x: win.x, y: win.y, w: win.w, h: win.h }
    } else {
      const screen = await jxa<Rect>(`const f = $.NSScreen.mainScreen.frame; return { x: 0, y: 0, w: f.size.width, h: f.size.height }`)
      await exec('screencapture', ['-x', '-m', raw])
      region = screen
    }
    const [rawWidth] = await imageSize(raw)
    const resample = rawWidth > maxWidth ? ['--resampleWidth', String(maxWidth)] : []
    await exec('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', ...resample, raw, '--out', out])
    const [width, height] = await imageSize(out)
    return { jpeg: readFileSync(out), width, height, region, window: win }
  } catch (e) {
    if (/could not create image|cannot run without|screen recording/i.test(String((e as Error).message))) {
      throw new PermissionError('macOS has not given Local Link Screen Recording access. Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording.')
    }
    throw e
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function imageSize(path: string): Promise<[number, number]> {
  const { stdout } = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path])
  return [Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]), Number(/pixelHeight: (\d+)/.exec(stdout)?.[1])]
}

/** Image pixel -> screen point for a screenshot. */
export function toScreen(shot: Pick<Shot, 'width' | 'region'>, x: number, y: number): { x: number; y: number } {
  const scale = shot.region.w / shot.width
  return { x: Math.round(shot.region.x + x * scale), y: Math.round(shot.region.y + y * scale) }
}

export async function click(x: number, y: number, opts: { button?: 'left' | 'right'; count?: number } = {}): Promise<void> {
  await asUser(() => jxa(
    `const p = $.CGPointMake(a.x, a.y); const right = a.button === 'right';
     const send = (type, n) => { const e = $.CGEventCreateMouseEvent(null, type, p, right ? 1 : 0); $.CGEventSetIntegerValueField(e, 1, n); $.CGEventPost(0, e); };
     send(5, 1); delay(0.05);
     for (let n = 1; n <= a.count; n++) { send(right ? 3 : 1, n); delay(0.03); send(right ? 4 : 2, n); delay(0.06); }`,
    { x, y, button: opts.button ?? 'left', count: opts.count ?? 1 },
  ))
}

/** Type text into the frontmost app, as if from the keyboard. */
export async function typeText(text: string): Promise<void> {
  await asUser(() => jxa(`const parts = a.text.split('\\n'); parts.forEach((part, i) => { if (part) se.keystroke(part); if (i < parts.length - 1) se.keyCode(36); delay(0.02); })`, { text }))
}

const KEY_CODES: Record<string, number> = {
  return: 36, enter: 76, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
}
const MODIFIERS: Record<string, string> = {
  cmd: 'command down', command: 'command down', shift: 'shift down',
  alt: 'option down', option: 'option down', opt: 'option down', ctrl: 'control down', control: 'control down',
}

/** A key combo like "cmd+shift+g", "tab", "return". */
export function parseCombo(combo: string): { key: string; code?: number; using: string[] } {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.pop()
  if (!key) throw new Error(`empty key combo ${JSON.stringify(combo)}`)
  const using = parts.map((m) => {
    if (!MODIFIERS[m]) throw new Error(`unknown modifier ${JSON.stringify(m)} in ${JSON.stringify(combo)}`)
    return MODIFIERS[m]
  })
  if (KEY_CODES[key] !== undefined) return { key, code: KEY_CODES[key], using }
  if ([...key].length !== 1) throw new Error(`unknown key ${JSON.stringify(key)} in ${JSON.stringify(combo)}`)
  return { key, using }
}

export async function pressKeys(combos: string[]): Promise<void> {
  const parsed = combos.map(parseCombo)
  await asUser(() => jxa(
    `a.keys.forEach(k => { const o = k.using.length ? { using: k.using } : {}; if (k.code !== undefined) se.keyCode(k.code, o); else se.keystroke(k.key, o); delay(0.08); })`,
    { keys: parsed },
  ))
}

/** Menu items of the app's menu bar, or under a menu path like ["File", "Import"]. */
export async function menuItems(ref: AppRef, path: string[] = []): Promise<{ name: string; enabled: boolean; submenu: boolean }[]> {
  return jxa(
    `const bar = procOf(a).menuBars[0];
     if (!a.path.length) return bar.menuBarItems().map(i => ({ name: i.name(), enabled: true, submenu: true }));
     let menu = bar.menuBarItems.byName(a.path[0]).menus[0];
     for (const name of a.path.slice(1)) menu = menu.menuItems.byName(name).menus[0];
     return menu.menuItems().filter(i => i.name()).map(i => ({ name: i.name(), enabled: i.enabled(), submenu: i.menus().length > 0 }))`,
    { ...ref, path },
  )
}

/** Click a menu item by its path, e.g. ["File", "Import", "Import Bills & Invoices..."]. */
export async function chooseMenu(ref: AppRef, path: string[]): Promise<void> {
  if (path.length < 2) throw new Error('a menu path needs at least a menu and an item')
  await asUser(() => jxa(
    `const bar = procOf(a).menuBars[0];
     let item = bar.menuBarItems.byName(a.path[0]);
     for (const name of a.path.slice(1)) item = item.menus[0].menuItems.byName(name);
     if (!item.enabled()) throw new Error('menu item is disabled: ' + a.path.join(' > '));
     item.click(); return true`,
    { ...ref, path },
  ))
}

/**
 * The accessibility tree of the app's windows, breadth-first, up to `limit` nodes.
 * Each node has a path ("window 1/group 2/button 3") clickElement accepts.
 */
export async function axTree(ref: AppRef, opts: { limit?: number; depth?: number } = {}): Promise<AxNode[]> {
  return jxa(
    `const p = procOf(a); const out = []; const queue = [];
     p.windows().forEach((w, i) => queue.push([w, 'window ' + (i + 1), 0]));
     const get = (f) => { try { const v = f(); return v === null || v === undefined ? '' : v; } catch (e) { return ''; } };
     while (queue.length && out.length < a.limit) {
       const [el, path, depth] = queue.shift();
       const kids = depth < a.depth ? get(() => el.uiElements()) || [] : [];
       const pos = get(() => el.position()); const size = get(() => el.size());
       const node = { path, role: get(() => el.role()), name: get(() => el.name()) || get(() => el.title()) || get(() => el.description()) };
       const value = get(() => el.value()); if (value !== '' && typeof value !== 'object') node.value = String(value).slice(0, 200);
       if (pos && size) node.frame = { x: pos[0], y: pos[1], w: size[0], h: size[1] };
       const enabled = get(() => el.enabled()); if (enabled === false) node.enabled = false;
       if (kids.length) node.children = kids.length;
       out.push(node);
       const counts = {};
       kids.forEach(k => { const r = (get(() => k.role()) || 'element').replace(/^AX/, '').toLowerCase(); counts[r] = (counts[r] || 0) + 1; queue.push([k, path + '/' + r + ' ' + counts[r], depth + 1]); });
     }
     return out`,
    { ...ref, limit: opts.limit ?? 150, depth: opts.depth ?? 8 },
    60_000,
  )
}

/** Press (AXPress) the element at an axTree path; falls back to clicking its center. */
export async function clickElement(ref: AppRef, path: string): Promise<Rect | null> {
  const frame = await asUser(() => jxa<Rect | null>(
    `const p = procOf(a); const parts = a.path.split('/');
     const m = /^window (\\d+)$/.exec(parts[0]); if (!m) throw new Error('path must start with "window N"');
     let el = p.windows[Number(m[1]) - 1];
     for (const part of parts.slice(1)) {
       const [, role, n] = /^(.*) (\\d+)$/.exec(part) || [];
       if (!role) throw new Error('bad path part: ' + part);
       const matches = el.uiElements().filter(k => { try { return (k.role() || '').replace(/^AX/, '').toLowerCase() === role; } catch (e) { return false; } });
       el = matches[Number(n) - 1]; if (!el) throw new Error('no element at ' + part);
     }
     try { el.actions.byName('AXPress').perform(); return null; } catch (e) {}
     const pos = el.position(), size = el.size(); return { x: pos[0], y: pos[1], w: size[0], h: size[1] }`,
    { ...ref, path },
  ))
  if (frame) await click(frame.x + frame.w / 2, frame.y + frame.h / 2)
  return frame
}
