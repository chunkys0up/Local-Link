/**
 * Local Link's in-process MCP tools for agent sessions: seeing and driving the apps the
 * user allowed (screenshot, ui_tree, menus, click, type_text, press_keys), and asking
 * the user for things (request_access, propose_plan). Every tool checks the app scope
 * itself, so the permission policy can allow the whole server.
 */

import { createSdkMcpServer, tool, type SdkMcpServer } from '@factory/droid-sdk/node'
import { z } from 'zod'

import * as mac from '../shared/macos'
import * as apps from './apps'
import * as gmail from './gmail'
import * as ui from './uiActivity'
import type { Emit } from './policy'

export const SERVER = 'locallink'

export interface AllowedApp extends mac.AppRef {
  path: string
}

export interface PlanStep {
  title: string
  how: string
  detail: string
}

export interface Plan {
  name: string
  summary: string
  steps: PlanStep[]
  apps: string[]
  connectors: string[]
}

/**
 * Something the agent asked the user. Tools never wait for the answer (droid gives up
 * on a tool call after about a minute): they queue the question and tell the agent to
 * end its turn, and the build loop resumes the session once the user has answered.
 */
export type Question =
  | { kind: 'app'; app: apps.InstalledApp; reason: string }
  | { kind: 'connector'; name: string; reason: string }
  | { kind: 'plan'; plan: Plan }

export interface ToolContext {
  emit: Emit
  /** Apps the agent may drive, by lowercased name. The build loop adds approved apps. */
  allowed: Map<string, AllowedApp>
  /** Keep a screenshot for the UI; returns its URL path. */
  saveShot: (jpeg: Buffer) => string
  /** Queue a question for the user; absent when the session can't ask (healing). */
  ask?: (question: Question) => void
  /** Names of apps with an access question still waiting for the user. */
  waitingFor?: () => Set<string>
  /** The job the on-screen frame's Stop button stops; none for connect runs. */
  jobId?: string
}

export const END_TURN = 'End your turn now with one short line; Local Link resumes you with their answer.'

type Result = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] })
const fail = (t: string): Result => ({ content: [{ type: 'text', text: t }], isError: true })

export function computerServer(ctx: ToolContext): SdkMcpServer {
  const lastShot = new Map<string, mac.Shot>()

  function resolveApp(name: string): AllowedApp {
    const app = ctx.allowed.get(name.trim().replace(/\.app$/i, '').toLowerCase())
    if (app) return app
    const allowed = [...ctx.allowed.values()].map((a) => a.app).join(', ') || 'none yet'
    if (ctx.waitingFor?.().has(name.trim().replace(/\.app$/i, '').toLowerCase())) {
      throw new Error(`The user hasn't answered whether ${name} may be used yet. ${END_TURN}`)
    }
    throw new Error(
      ctx.ask
        ? `${name} isn't allowed yet. Call request_access with kind "app" first. Allowed: ${allowed}.`
        : `Only these apps may be driven in this session: ${allowed}.`,
    )
  }

  /** Run a tool body, turning thrown errors into tool errors the agent can read. */
  const guarded =
    <I>(body: (input: I) => Promise<Result>) =>
    async (input: I): Promise<Result> => {
      try {
        return await body(input)
      } catch (e) {
        return fail((e as Error).message)
      }
    }

  async function front(app: AllowedApp): Promise<void> {
    await mac.activate(app)
    const now = await mac.frontmost()
    if (app.bundleId ? now.bundleId !== app.bundleId : now.app !== app.app) {
      throw new Error(
        `${app.app} didn't come to the front (${now.app} is frontmost), so nothing was sent. If a dialog in ${app.app} is waiting, or this keeps happening, ask the user (AskUser) to click ${app.app}'s window.`,
      )
    }
  }

  /** One UI action: inside the on-screen frame, with the app brought to the front first. */
  async function onScreen<T>(app: AllowedApp, action: () => Promise<T>, label: string): Promise<T> {
    mac.inputGuard.onWait = (waiting) => {
      ui.paused(waiting)
      if (waiting) ctx.emit('ui', 'Waiting for you', 'paused until you let go of the mouse and keyboard')
    }
    return ui.during(
      app.app,
      ctx.jobId ?? null,
      async () => {
        await front(app)
        return action()
      },
      label,
    )
  }

  const appArg = z.string().describe('App name, e.g. "GnuCash"')

  const tools = [
    tool('list_apps', 'Apps installed on this Mac (name, kind, bundle id) and which ones you may drive.', {}, guarded(async () => {
      const installed = await apps.scan()
      const lines = installed.map((a) => `${a.name} (${a.kind}${a.bundle_id ? `, ${a.bundle_id}` : ''})${ctx.allowed.has(a.name.toLowerCase()) ? ' [allowed]' : ''}`)
      return text(lines.join('\n'))
    }), { annotations: { readOnlyHint: true } }),

    tool(
      'request_access',
      `Ask the user for something the workflow needs: kind "app" to drive a local app's UI, kind "connector" for an online account (e.g. "gmail", "outlook"). Reading a data file the user named needs no request. The answer comes back when you end your turn.`,
      { kind: z.enum(['app', 'connector']), name: z.string(), reason: z.string().describe('One sentence the user sees, e.g. "To read work-order emails from your vendor."') },
      guarded(async ({ kind, name, reason }) => {
        if (!ctx.ask) return fail(kind === 'app' ? 'App access is fixed for this session.' : 'Connectors are not available in this session.')
        if (kind === 'app') {
          const found = await apps.find(name)
          if (!found) return fail(`No installed app matches ${JSON.stringify(name)}. Use list_apps.`)
          const key = found.name.toLowerCase()
          if (ctx.allowed.has(key)) return text(`${found.name} is already allowed.`)
          if (ctx.waitingFor?.().has(key)) return text(`Already asked about ${found.name}. ${END_TURN}`)
          ctx.emit('request', `Asking to use ${found.name}`, reason)
          ctx.ask({ kind: 'app', app: found, reason })
          return text(`Asked the user to allow ${found.name}. You can keep exploring anything that doesn't need it, then ${END_TURN[0].toLowerCase()}${END_TURN.slice(1)}`)
        }
        if (/gmail|google/i.test(name) && gmail.connectedAccount()) {
          return text(`Gmail (${gmail.connectedAccount()}) is already connected. Explore it with gmail_search; scripts use ll.gmail.search.`)
        }
        ctx.emit('request', `Asking to connect ${name}`, reason)
        ctx.ask({ kind: 'connector', name: name.toLowerCase(), reason })
        return text(`Asked the user to connect ${name}. ${END_TURN}`)
      }),
    ),

    tool(
      'screenshot',
      "Screenshot of the app's front window (it is brought to the front). Coordinates you pass to click are pixels in the latest screenshot of that app.",
      { app: appArg },
      guarded(async ({ app }) => {
        const target = resolveApp(app)
        const shot = await onScreen(target, () => mac.screenshot({ ref: target }), 'Looking at the window')
        lastShot.set(target.app, shot)
        const url = ctx.saveShot(shot.jpeg)
        ctx.emit('ui', `Screenshot of ${target.app}`, shot.window?.title || '', url)
        const where = shot.window
          ? `window "${shot.window.title}" at screen (${shot.region.x}, ${shot.region.y}), ${shot.region.w}x${shot.region.h} points`
          : 'the main screen'
        return {
          content: [
            { type: 'image', data: shot.jpeg.toString('base64'), mimeType: 'image/jpeg' },
            { type: 'text', text: `${shot.width}x${shot.height} px image of ${where}.` },
          ],
        }
      }),
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'gmail_search',
      "Search the user's connected Gmail with Gmail query syntax (e.g. 'subject:\"work order\" newer_than:30d'). Read only. Returns full plain-text bodies, newest first.",
      { query: z.string(), max: z.number().int().min(1).max(50).optional() },
      guarded(async ({ query, max }) => {
        if (!gmail.connectedAccount()) {
          return fail('Local Link has no direct Gmail connection. If gmail__ connector tools are in your deferred tools, use those (read only); otherwise call request_access with kind "connector" and name "gmail".')
        }
        const messages = await gmail.search(query, max ?? 10)
        ctx.emit('connector', `Searched Gmail`, `${query} · ${messages.length} found`)
        return text(messages.length ? JSON.stringify(messages, null, 1) : 'No messages match.')
      }),
      { annotations: { readOnlyHint: true } },
    ),

    tool('list_windows', "The app's on-screen windows (dialogs are separate windows), front to back, in screen points.", { app: appArg }, guarded(async ({ app }) => {
      const target = resolveApp(app)
      const wins = await mac.windows(await mac.pidOf(target))
      return text(wins.length ? wins.map((w) => `"${w.title}" x=${w.x} y=${w.y} w=${w.w} h=${w.h}`).join('\n') : 'No on-screen windows.')
    }), { annotations: { readOnlyHint: true } }),

    tool(
      'ui_tree',
      "The app's accessibility tree (roles, names, values, frames). Many apps (GTK ones like GnuCash) expose little here; use menus, keys and screenshots then.",
      { app: appArg, limit: z.number().int().min(10).max(400).optional() },
      guarded(async ({ app, limit }) => {
        const nodes = await mac.axTree(resolveApp(app), { limit })
        if (!nodes.length) return text('Nothing exposed to accessibility (no windows, or the app hides its widgets).')
        return text(nodes.map((n) => `${n.path} [${n.role}] ${JSON.stringify(n.name)}${n.value ? ` = ${JSON.stringify(n.value)}` : ''}${n.enabled === false ? ' (disabled)' : ''}`).join('\n'))
      }),
      { annotations: { readOnlyHint: true } },
    ),

    tool('list_menu', 'Menu bar menus, or the items under a menu path like ["File", "Import"].', { app: appArg, path: z.array(z.string()).default([]) }, guarded(async ({ app, path }) => {
      const items = await mac.menuItems(resolveApp(app), path)
      return text(items.map((i) => `${i.name}${i.submenu && path.length ? ' >' : ''}${i.enabled ? '' : ' (disabled)'}`).join('\n'))
    }), { annotations: { readOnlyHint: true } }),

    tool('choose_menu', 'Click a menu item by path, e.g. ["File", "Import", "Import Bills & Invoices..."].', { app: appArg, path: z.array(z.string()).min(2) }, guarded(async ({ app, path }) => {
      const target = resolveApp(app)
      await onScreen(target, () => mac.chooseMenu(target, path), `Choosing ${path.join(' › ')}`)
      ctx.emit('ui', `Menu ${path.join(' › ')}`, target.app)
      return text(`Chose ${path.join(' > ')}. Take a screenshot to see the result.`)
    })),

    tool(
      'click',
      'Click at a point in the latest screenshot of the app (image pixels). Returns the point relative to the window it hit, which is what scripts should use.',
      { app: appArg, x: z.number(), y: z.number(), button: z.enum(['left', 'right']).optional(), count: z.number().int().min(1).max(3).optional() },
      guarded(async ({ app, x, y, button, count }) => {
        const target = resolveApp(app)
        const shot = lastShot.get(target.app)
        if (!shot) return fail(`Take a screenshot of ${target.app} first; click coordinates are pixels in it.`)
        const point = mac.toScreen(shot, x, y)
        const hit = (await mac.windows(await mac.pidOf(target))).find(
          (w) => point.x >= w.x && point.x < w.x + w.w && point.y >= w.y && point.y < w.y + w.h,
        )
        if (!hit) return fail(`(${x}, ${y}) is not on a ${target.app} window, so nothing was clicked.`)
        await onScreen(target, () => mac.click(point.x, point.y, { button, count }), `Clicking in “${hit.title || target.app}”`)
        const rx = point.x - hit.x
        const ry = point.y - hit.y
        ctx.emit('ui', `Click in ${target.app}`, `"${hit.title}" at (${rx}, ${ry})`)
        return text(`Clicked window "${hit.title}" at (${rx}, ${ry}) relative to its top-left, in points. In a script: app.clickAt(${rx}, ${ry}, { window: ${JSON.stringify(hit.title)} }).`)
      }),
    ),

    tool('click_element', 'Press an element from ui_tree by its path (e.g. "window 1/button 3").', { app: appArg, path: z.string() }, guarded(async ({ app, path }) => {
      const target = resolveApp(app)
      await onScreen(target, () => mac.clickElement(target, path), `Pressing ${path.split('/').pop()}`)
      ctx.emit('ui', `Press ${path}`, target.app)
      return text(`Pressed ${path}.`)
    })),

    tool('type_text', 'Type text into the app (it is brought to the front first). Newlines press Return.', { app: appArg, text: z.string() }, guarded(async ({ app, text: value }) => {
      const target = resolveApp(app)
      await onScreen(target, () => mac.typeText(value), ui.typedLabel(value))
      ctx.emit('ui', `Type into ${target.app}`, value.length > 80 ? `${value.slice(0, 79)}…` : value)
      return text(`Typed ${value.length} characters.`)
    })),

    tool(
      'press_keys',
      'Press keys in order, e.g. ["tab", "tab", "cmd+a", "return"]. Names: return, tab, space, delete, escape, up/down/left/right, home, end, pageup, pagedown, f1-f12, or one character, with cmd/shift/alt/ctrl+.',
      { app: appArg, keys: z.array(z.string()).min(1) },
      guarded(async ({ app, keys }) => {
        const target = resolveApp(app)
        keys.forEach(mac.parseCombo) // reject bad names before anything is sent
        await onScreen(target, () => mac.pressKeys(keys), `Pressing ${keys.map(ui.keyLabel).join(' ')}`)
        ctx.emit('ui', `Keys in ${target.app}`, keys.join(' '))
        return text(`Pressed ${keys.join(', ')}.`)
      }),
    ),
  ]

  if (ctx.ask) {
    const ask = ctx.ask
    tools.push(
      tool(
        'propose_plan',
        'Show the user your plan before writing the workflow script. Their approval or feedback comes back when you end your turn; on feedback, revise and propose again.',
        {
          name: z.string().describe('A short name for the workflow, 2 to 5 words, e.g. "Work orders to invoices".'),
          summary: z.string().describe('Two or three sentences: what the workflow does, start to finish.'),
          steps: z
            .array(
              z.object({
                title: z.string(),
                how: z.enum(['connector', 'file', 'menu', 'keyboard', 'accessibility', 'coordinates', 'compute', 'verify']),
                detail: z.string(),
              }),
            )
            .min(1),
          apps: z.array(z.string()).default([]),
          connectors: z.array(z.string()).default([]),
        },
        guarded(async (plan) => {
          ctx.emit('plan', 'Plan ready for review', plan.summary)
          ask({ kind: 'plan', plan })
          return text(`The plan is in front of the user. Don't write workflow.mjs yet. ${END_TURN}`)
        }),
      ),
    )
  }

  return createSdkMcpServer({ name: SERVER, tools })
}
