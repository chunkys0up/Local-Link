/**
 * Online accounts, through Factory's managed connectors (Gmail, Outlook, ...). Factory
 * holds the OAuth tokens, so the only way to them is a droid session. Saved workflow
 * scripts reach them through the engine (POST /connectors/gmail/search), which runs
 * one tightly scoped turn with structured output and nothing else allowed.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AutonomyLevel, OutputFormatType, run } from '@factory/droid-sdk/node'

import { makePermissionHandler, type Emit } from './policy'

export const FACTORY_CONNECTORS_URL = 'https://app.factory.ai/settings/connectors'

const READ_VERB = /(^|[_\-.\s])(search|read|get|list|fetch|find|query|lookup)/i
const WRITE_VERB = /(send|delete|trash|remove|modify|update|create|draft|label|archive|move|reply|forward|mark)/i

/** Connector tools that only read: allowed. Anything that sends or changes: refused. */
export function readOnlyConnectorTools(toolName: string, serverName: string): string | null {
  const name = `${serverName} ${toolName}`
  if (WRITE_VERB.test(toolName)) return `${toolName} changes the account; only reading is allowed here`
  if (READ_VERB.test(toolName) || READ_VERB.test(name)) return null
  return `${toolName} is not a read-only connector tool`
}

export interface EmailMessage {
  id: string
  thread_id: string
  from: string
  to: string
  subject: string
  date: string
  body: string
}

const EMAIL_SCHEMA = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          thread_id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          date: { type: 'string', description: 'ISO 8601' },
          body: { type: 'string', description: 'Full plain-text body, HTML converted to text, nothing summarized' },
        },
        required: ['id', 'thread_id', 'from', 'to', 'subject', 'date', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['messages'],
  additionalProperties: false,
}

/**
 * The agent writes dates as it likes ("…T23:45:59-07:00" one time, "…T06:45:59.000Z" the
 * next), so the same email would look changed between runs. Always return UTC ISO.
 */
export function utc(date: string): string {
  const t = Date.parse(date)
  return Number.isNaN(t) ? date : new Date(t).toISOString()
}

export async function gmailSearch(query: string, max: number, emit: Emit = () => {}): Promise<EmailMessage[]> {
  const dir = mkdtempSync(join(tmpdir(), 'local-link-gmail-'))
  try {
    const handler = makePermissionHandler({ scratch: dir, toolFilter: readOnlyConnectorTools }, emit)
    const result = await run(
      `Use the Gmail connector to search the user's mailbox with this exact Gmail query:

    ${query}

Return up to ${max} matching messages, newest first. For each, give its message id,
thread id, from, to, subject, date (ISO 8601) and the complete plain-text body, copied
exactly (convert HTML to text; never summarize, translate or fix anything). If nothing
matches, return an empty list. Only read: never send, draft, label, move or delete.`,
      {
        cwd: dir,
        autonomyLevel: AutonomyLevel.Off,
        permissionHandler: (params) => handler(params as unknown as Record<string, unknown>) as never,
        outputFormat: { type: OutputFormatType.JsonSchema, schema: EMAIL_SCHEMA },
      },
    )
    if (!result.success) {
      const detail = ('structuredOutputError' in result && result.structuredOutputError?.message) || result.error?.message || result.subtype
      throw new Error(`Gmail search failed: ${detail}`)
    }
    const output = result.structuredOutput as { messages?: EmailMessage[] } | undefined
    if (!output || !Array.isArray(output.messages)) throw new Error('Gmail search returned no message list')
    return output.messages.slice(0, max).map((m) => ({ ...m, date: utc(m.date) }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
