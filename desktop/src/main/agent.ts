/**
 * One droid session in its own folder, with Retronaut's permission policy, its events
 * forwarded to a job. Sessions are multi-turn: the engine sends a follow-up (a checker
 * or test failure) to the same session so the agent keeps what it learned.
 */

import {
  AutonomyLevel,
  DroidMessageType,
  createSession,
  type DroidMcpServerConfig,
  type DroidSession,
} from '@factory/droid-sdk/node'

type Base64ImageSource = { type: 'base64'; mediaType: 'image/jpeg' | 'image/png'; data: string }

import { makePermissionHandler, type Emit, type PolicyScope } from './policy'

export const AGENT_TIMEOUT_MS = 20 * 60 * 1000
const MAX_NUDGES = 2

const NUDGE = `Your last action was refused by the session policy: {reason}

That doesn't end the task. Take an allowed route (read-only commands, Retronaut's tools,
or a node script in the working folder) and keep going.`

export interface AuthRequest {
  serverName: string
  authUrl: string
  message: string
}

export interface AgentOptions {
  name: string // shown in events, e.g. "Builder agent"
  scope: PolicyScope
  emit: Emit
  mcpServers?: DroidMcpServerConfig[]
  /** A connector (MCP server) needs the user to sign in. */
  onAuthRequired?: (request: AuthRequest) => void
  /** Stop nudging once this is true (e.g. the deliverable exists). */
  done?: () => boolean
  /** droid's AskUser: put the questions to the user; null if they declined. */
  askUser?: (questions: AskUserQuestion[]) => Promise<string[] | null>
}

export interface AskUserQuestion {
  index: number
  topic: string
  question: string
  options: string[]
  multiSelect?: boolean
}

export function short(value: unknown, limit = 240): string {
  const text = String(typeof value === 'string' ? value : JSON.stringify(value)).split(/\s+/).join(' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function describeToolCall(input: unknown): string {
  const data = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'app']) {
    if (key in data) return short(key === 'app' ? JSON.stringify(data) : data[key])
  }
  return short(input)
}

export class Agent {
  private session: DroidSession | null = null
  private denials: string[] = []
  private closed = false

  constructor(private readonly opts: AgentOptions) {}

  private emit(kind: string, label: string, detail = '') {
    this.opts.emit(kind, `${this.opts.name}: ${label}`, detail)
  }

  async start(): Promise<void> {
    const handler = makePermissionHandler(this.opts.scope, (kind, label, detail) => {
      if (kind === 'denied') this.denials.push(detail ?? '')
      this.emit(kind, label, detail)
    })
    this.session = await createSession({
      cwd: this.opts.scope.scratch,
      autonomyLevel: AutonomyLevel.Off,
      mcpServers: this.opts.mcpServers,
      permissionHandler: (params) => handler(params as unknown as Record<string, unknown>) as never,
      askUserHandler: async ({ questions }) => {
        const answers = this.opts.askUser ? await this.opts.askUser(questions as AskUserQuestion[]) : null
        if (!answers) return { cancelled: true } as never
        return { answers: questions.map((q, i) => ({ index: q.index, question: q.question, answer: answers[i] ?? '' })) } as never
      },
    })
  }

  /** Send one prompt and stream the turn. Returns whether the turn finished cleanly. */
  async send(prompt: string, options: { images?: Base64ImageSource[] } = {}): Promise<boolean> {
    if (this.closed) throw new Error('the agent session was stopped')
    if (!this.session) await this.start()
    let success = false
    let text = prompt
    for (let nudge = 0; nudge <= MAX_NUDGES; nudge++) {
      const seen = this.denials.length
      success = await this.turn(text, nudge === 0 ? options.images : undefined)
      // A refused action can end droid's turn; send it back to work once more.
      if (this.denials.length === seen || this.opts.done?.() || nudge === MAX_NUDGES) break
      this.opts.emit('info', `${this.opts.name} stopped after a refused action`, 'asking it to continue another way')
      text = NUDGE.replace('{reason}', this.denials[this.denials.length - 1])
    }
    return success
  }

  private async turn(prompt: string, images?: Base64ImageSource[]): Promise<boolean> {
    const abort = AbortSignal.timeout(AGENT_TIMEOUT_MS)
    let success = false
    // Partial messages on, for the connector sign-in events; text deltas are ignored.
    const stream = this.session!.stream(prompt, { abortSignal: abort, includePartialMessages: true, ...(images?.length ? { images } : {}) })
    for await (const msg of stream) {
      switch (msg.type) {
        case DroidMessageType.ToolCall:
          this.emit('agent', msg.name, describeToolCall(msg.input))
          break
        case DroidMessageType.ToolResult:
          if (msg.isError) this.emit('agent', `${msg.toolName} error`, short(msg.content))
          break
        case DroidMessageType.Assistant:
          if (msg.text.trim()) this.emit('agent', 'says', short(msg.text, 600))
          break
        case DroidMessageType.McpAuthRequired:
          this.emit('connector', `${msg.serverName} needs you to sign in`, msg.message)
          this.opts.onAuthRequired?.({ serverName: msg.serverName, authUrl: msg.authUrl, message: msg.message })
          break
        case DroidMessageType.McpAuthCompleted:
          this.emit('connector', `${msg.serverName} sign-in ${msg.outcome}`, msg.message)
          break
        case DroidMessageType.Error:
          this.emit('error', 'error', short(msg.message))
          break
        case DroidMessageType.Result:
          success = msg.success
          if (!msg.success) this.emit('error', 'turn failed', short(`${msg.subtype} ${'error' in msg ? JSON.stringify(msg.error) : ''}`))
          break
      }
    }
    return success
  }

  async close(): Promise<void> {
    this.closed = true
    await this.session?.close().catch(() => {})
    this.session = null
  }
}
