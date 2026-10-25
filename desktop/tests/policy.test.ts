import { expect, test } from 'vitest'

import { readOnlyConnectorTools } from '../src/main/connectors'
import { denyReason, makePermissionHandler, type PolicyScope } from '../src/main/policy'

const SCRATCH = '/tmp/local-link-scratch'
const DATA = '/Users/someone/books/book.gnucash'
const OPTIONS = [{ value: 'proceed_once' }, { value: 'proceed_always' }, { value: 'cancel' }]
const scope: PolicyScope = { scratch: SCRATCH, servers: ['locallink'], toolFilter: readOnlyConnectorTools }

const execute = (command: string, impact = 'medium') => ({ type: 'exec', fullCommand: command, impactLevel: impact })
const patch = (path: string) => ({ type: 'apply_patch', filePath: path, patchContent: `*** Begin Patch\n*** Add File: ${path}\n+hi\n*** End Patch` })

test('allows writes in scratch', () => {
  expect(denyReason(patch(`${SCRATCH}/workflow.mjs`), scope)).toBeNull()
  expect(denyReason({ type: 'create', filePath: 'check.mjs' }, scope)).toBeNull()
})

test('blocks writes to the data path, and path escapes', () => {
  expect(denyReason(patch(DATA), scope)).toMatch(/only allowed inside/)
  expect(denyReason({ type: 'edit', filePath: DATA }, scope)).not.toBeNull()
  expect(denyReason(patch(`${SCRATCH}/../x.mjs`), scope)).not.toBeNull()
  expect(denyReason({ type: 'create', filePath: `${SCRATCH}-evil/x.mjs` }, scope)).not.toBeNull()
})

test('blocks a patch that sneaks a second file out', () => {
  const action = patch(`${SCRATCH}/workflow.mjs`)
  action.patchContent += `\n*** Update File: ${DATA}\n`
  expect(denyReason(action, scope)).not.toBeNull()
})

test('allows read-only commands and scratch scripts run with node', () => {
  expect(denyReason(execute(`sqlite3 ${DATA} .tables`, 'low'), scope)).toBeNull()
  expect(denyReason(execute(`node extract.mjs ${DATA}`), scope)).toBeNull()
  expect(denyReason(execute(`cd ${SCRATCH} && node workflow.mjs`), scope)).toBeNull()
  expect(denyReason(execute(`node ${SCRATCH}/probe.js "${DATA}"`), scope)).toBeNull()
})

test('blocks other commands', () => {
  expect(denyReason(execute(`rm ${DATA}`), scope)).not.toBeNull()
  expect(denyReason(execute('node /etc/evil.mjs'), scope)).not.toBeNull()
  expect(denyReason(execute("node -e 'console.log(1)'"), scope)).not.toBeNull()
  expect(denyReason(execute('python3 extract.py'), scope)).not.toBeNull()
  expect(denyReason(execute('cd /Users/someone/books && node evil.mjs'), scope)).not.toBeNull()
})

test('blocks pipes, redirects and subshells', () => {
  for (const command of [
    `node extract.mjs ${DATA} > ${DATA}.json`,
    `node extract.mjs ${DATA} | tee /tmp/x`,
    'node extract.mjs $(rm -rf /)',
    'node extract.mjs "$(rm -rf /)"',
    'node extract.mjs `rm -rf /`',
    'node extract.mjs; rm -rf /',
    'node extract.mjs & rm -rf /',
  ]) expect(denyReason(execute(command), scope), command).not.toBeNull()
})

test('shell UI commands are refused, even when droid rates them low', () => {
  for (const command of [
    `osascript -e 'tell application "GnuCash" to activate'`,
    `screencapture -x ${SCRATCH}/a.png`,
    'cliclick c:10,10',
    `cd ${SCRATCH} && /usr/bin/osascript -e 'beep'`,
  ]) {
    expect(denyReason(execute(command, 'low'), scope), command).toMatch(/computer tools/)
  }
})

test('our own MCP tools are allowed; connector tools only when they read', () => {
  expect(denyReason({ type: 'mcp_tool', toolName: 'click', serverName: 'locallink' }, scope)).toBeNull()
  expect(denyReason({ type: 'mcp_tool', toolName: 'gmail_search_messages', serverName: 'gmail' }, scope)).toBeNull()
  expect(denyReason({ type: 'mcp_tool', toolName: 'read_thread', serverName: 'gmail' }, scope)).toBeNull()
  expect(denyReason({ type: 'mcp_tool', toolName: 'gmail_send_message', serverName: 'gmail' }, scope)).toMatch(/only reading/)
  expect(denyReason({ type: 'mcp_tool', toolName: 'trash_thread', serverName: 'gmail' }, scope)).not.toBeNull()
  expect(denyReason({ type: 'mcp_tool', toolName: 'get_or_create_label', serverName: 'gmail' }, scope)).not.toBeNull()
  expect(denyReason({ type: 'mcp_tool', toolName: 'click' }, { scratch: SCRATCH })).not.toBeNull()
})

test('blocks unknown actions', () => {
  expect(denyReason({ type: 'sandbox_violation' }, scope)).not.toBeNull()
})

const scriptRequest = (...confirmations: object[]) => ({
  toolUses: [{ confirmationType: 'script', details: { type: 'script', calls: [...confirmations.map((c) => ({ toolName: 'X', confirmation: c })), { toolName: 'TodoWrite' }] } }],
  options: OPTIONS,
})

test('a script request is approved only when every call is allowed', () => {
  const events: string[][] = []
  const policy = makePermissionHandler(scope, (...e) => void events.push(e as string[]))
  expect(policy(scriptRequest(patch(`${SCRATCH}/w.mjs`), execute('node w.mjs')))).toEqual({ selectedOption: 'proceed_once' })
  expect(events).toEqual([])
  const response = policy(scriptRequest(patch(`${SCRATCH}/w.mjs`), patch(DATA)))
  expect(response.selectedOption).toBe('cancel')
  expect(response.comment).toContain(DATA)
  expect(events[0][0]).toBe('denied')
})

test('a plain request uses the same policy', () => {
  const policy = makePermissionHandler(scope, () => {})
  expect(policy({ toolUses: [{ confirmationType: 'exec', details: execute(`rm ${DATA}`) }], options: OPTIONS }).selectedOption).toBe('cancel')
})

test("droid's AskUser goes to the user only when there is someone to ask", () => {
  expect(denyReason({ type: 'ask_user' }, { ...scope, askUser: true })).toBeNull()
  expect(denyReason({ type: 'ask_user' }, scope)).toMatch(/no one to ask/)
})

test("Factory's Gmail connector: reading tools allowed, everything that changes mail refused", () => {
  const allowed = ['gmail__get_message', 'gmail__get_message_text', 'gmail__get_thread', 'gmail__list_messages', 'gmail__list_threads', 'gmail__get_attachment']
  const refused = [
    'gmail__send_message', 'gmail__send_draft', 'gmail__forward_message', 'gmail__create_draft', 'gmail__create_forward_draft',
    'gmail__delete_message', 'gmail__delete_thread', 'gmail__batch_delete_messages', 'gmail__batch_modify_messages',
    'gmail__modify_message_labels', 'gmail__modify_thread_labels', 'gmail__untrash_message', 'gmail__untrash_thread',
    'gmail__create_label', 'gmail__update_label', 'gmail__delete_label', 'gmail__update_draft', 'gmail__delete_draft',
  ]
  for (const name of allowed) expect(readOnlyConnectorTools(name, 'gmail'), name).toBeNull()
  for (const name of refused) expect(readOnlyConnectorTools(name, 'gmail'), name).not.toBeNull()
})

test('Gmail dates come back in one form, however the agent wrote them', async () => {
  const { utc } = await import('../src/main/connectors')
  expect(utc('2026-10-24T23:45:59-07:00')).toBe('2026-10-25T06:45:59.000Z')
  expect(utc('2026-10-25T06:45:59.000Z')).toBe('2026-10-25T06:45:59.000Z')
  expect(utc('Sat, 25 Oct 2026 06:45:59 +0000')).toBe('2026-10-25T06:45:59.000Z')
  expect(utc('not a date')).toBe('not a date')
})
