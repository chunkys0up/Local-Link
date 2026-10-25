/**
 * What an agent session may do, decided per permission request.
 *
 * Writes only inside the session's own folder; commands only if droid rates them
 * read-only, or if they run a .mjs/.js script from that folder with node. UI control
 * goes through Local Link's own tools (computer.ts), which check the app scope
 * themselves, never through shell osascript/screencapture/cliclick. Connector tools
 * (Gmail, ...) are allowed when the caller's toolFilter says so.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** (kind, label, detail, image URL path) */
export type Emit = (kind: string, label: string, detail?: string, image?: string) => void
type Mapping = Record<string, unknown>

export interface PolicyScope {
  scratch: string
  /** MCP servers whose tools may run (our own in-process tools). */
  servers?: string[]
  /** For other MCP / connector tools: whether this tool may run, or a reason it may not. */
  toolFilter?: (toolName: string, serverName: string) => string | null
  /** Whether droid's AskUser questions go to the user (a session with someone to ask). */
  askUser?: boolean
}

const NODE = /^node(?:\d+)?$/
const SCRIPT_SUFFIXES = ['.mjs', '.js', '.cjs']
const UI_TOOLS = ['osascript', 'screencapture', 'cliclick']
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

function expand(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export function inside(path: unknown, root: string): boolean {
  if (typeof path !== 'string' || !path) return false
  const p = expand(path)
  const full = resolve(isAbsolute(p) ? p : join(root, p))
  return full === root || full.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** Shell words, with operators (&&, ;, |, >, ...) as their own tokens. null if unparseable. */
export function shellTokens(command: string): string[] | null {
  const tokens: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  const push = () => {
    if (has) tokens.push(cur)
    cur = ''
    has = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else cur += c
      // A quoted $( or backtick still runs in double quotes; flag it.
      if (quote === '"' && (c === '`' || (c === '$' && command[i + 1] === '('))) return null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < command.length) {
      cur += command[++i]
      has = true
    } else if (/\s/.test(c)) {
      push()
    } else if ('|&;<>()`'.includes(c)) {
      push()
      let op = c
      while (i + 1 < command.length && '|&;<>'.includes(command[i + 1]) && op.length < 2) op += command[++i]
      tokens.push(op)
    } else {
      if (c === '$' && command[i + 1] === '(') return null
      cur += c
      has = true
    }
  }
  if (quote) return null
  push()
  return tokens
}

/**
 * True if the command only cds around and runs .mjs/.js scripts that live in scratch
 * with node: segments joined by && or ;, no pipes, redirects or subshells.
 */
export function runsScratchScripts(command: string, scratch: string): boolean {
  const tokens = shellTokens(command)
  if (!tokens) return false
  const segments: string[][] = [[]]
  for (const t of tokens) {
    if (t === '&&' || t === ';') segments.push([])
    else if (/^[|&;<>()`]+$/.test(t)) return false
    else segments[segments.length - 1].push(t)
  }
  let cwd = scratch
  let ran = false
  for (const parts of segments) {
    if (!parts.length) continue
    if (parts[0] === 'cd' && parts.length === 2) {
      const target = expand(parts[1])
      cwd = resolve(isAbsolute(target) ? target : join(cwd, target))
      continue
    }
    if (parts[0] === 'npx' || parts[0] === 'env') return false
    if (parts.length < 2 || !NODE.test(parts[0].split('/').pop()!)) return false
    const script = expand(parts[1])
    if (!SCRIPT_SUFFIXES.some((s) => script.endsWith(s))) return false
    if (!inside(isAbsolute(script) ? script : join(cwd, script), scratch)) return false
    ran = true
  }
  return ran
}

function isUiCommand(command: string): boolean {
  return UI_TOOLS.some((tool) => new RegExp(`(^|[\\s;&|/(])${tool}\\b`).test(command))
}

/** Why the policy refuses one confirmation from droid, or null to allow it. */
export function denyReason(confirmation: Mapping, scope: PolicyScope): string | null {
  const { scratch } = scope
  const kind = confirmation.type
  if (kind === 'exec') {
    const command = String(confirmation.fullCommand ?? confirmation.command ?? '')
    // Checked before the read-only shortcut, whatever droid rates them.
    if (isUiCommand(command)) {
      return `drive apps with Local Link's computer tools (screenshot, click, type_text, press_keys, choose_menu), not shell UI commands (tried ${JSON.stringify(command)})`
    }
    if (confirmation.impactLevel === 'low') return null
    if (runsScratchScripts(command, scratch)) return null
    return `only read-only commands, or running a node script from the working folder, are allowed (tried ${JSON.stringify(command)})`
  }
  let paths: unknown[]
  if (kind === 'edit' || kind === 'create') {
    paths = [confirmation.filePath]
  } else if (kind === 'apply_patch') {
    paths = [confirmation.filePath]
    for (const f of (confirmation.files as Mapping[] | undefined) ?? []) paths.push(f.filePath, f.moveTo)
    for (const m of String(confirmation.patchContent ?? '').matchAll(PATCH_PATH)) paths.push(m[1])
    paths = paths.filter(Boolean)
    if (!paths.length) paths = [null]
  } else if (kind === 'exit_spec_mode') {
    return null
  } else if (kind === 'ask_user') {
    return scope.askUser ? null : 'there is no one to ask in this session; decide from the data, or fail with a clear message'
  } else if (kind === 'mcp_tool') {
    const tool = String(confirmation.actualToolName ?? confirmation.toolName ?? '')
    const server = String(confirmation.serverName ?? '')
    if (scope.servers?.includes(server)) return null
    if (scope.toolFilter) return scope.toolFilter(tool, server)
    return `${tool || 'that'} tool is not allowed in this session`
  } else {
    return `${String(kind)} actions are not allowed in this session`
  }
  const outside = paths.filter((p) => !inside(p, scratch)).map(String)
  if (outside.length) return `writes are only allowed inside ${scratch} (tried ${outside.join(', ')})`
  return null
}

/** Each thing droid wants approved, unpacking calls batched inside a Script. */
export function* confirmations(raw: Mapping): Generator<Mapping> {
  for (const toolUse of (raw.toolUses as Mapping[] | undefined) ?? []) {
    const details = (toolUse.details as Mapping | undefined) ?? {}
    if (details.type === 'script') {
      for (const call of (details.calls as Mapping[] | undefined) ?? []) {
        // Calls without a confirmation (reads, todos) need no approval.
        if (call.confirmation) yield call.confirmation as Mapping
      }
    } else {
      yield details
    }
  }
}

export interface PolicyDecision {
  selectedOption: 'proceed_once' | 'cancel'
  comment?: string
}

export function makePermissionHandler(scope: PolicyScope, emit: Emit) {
  return (raw: Mapping): PolicyDecision => {
    const offered = ((raw.options as Mapping[] | undefined) ?? []).map((o) => o.value)
    for (const confirmation of confirmations(raw)) {
      const reason = denyReason(confirmation, scope)
      if (reason) {
        emit('denied', 'Blocked agent action', reason)
        return { selectedOption: 'cancel', comment: reason }
      }
    }
    return { selectedOption: offered.includes('proceed_once') ? 'proceed_once' : 'cancel' }
  }
}
