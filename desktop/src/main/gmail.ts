/**
 * Retronaut's own Gmail connection: IMAP with a Google app password, kept in the
 * keychain. Unlike Factory's connector, it needs no agent: scripts get exact message
 * bodies straight from Gmail, searched with Gmail's own query syntax (X-GM-RAW).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

import { deleteSecret, getSecret, setSecret } from './keychain'
import { dataDir } from './paths'

export interface EmailMessage {
  id: string
  thread_id: string
  from: string
  to: string
  subject: string
  date: string
  body: string
}

const settingsFile = () => join(dataDir(), 'connectors.json')

function readSettings(): { gmail?: { email: string } } {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(settings: { gmail?: { email: string } }): void {
  mkdirSync(dirname(settingsFile()), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
}

/** The connected address, or null. */
export function connectedAccount(): string | null {
  return existsSync(settingsFile()) ? (readSettings().gmail?.email ?? null) : null
}

function client(email: string, password: string): ImapFlow {
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass: password }, logger: false })
}

/** Check the address and app password against Gmail, then remember them. */
export async function connect(email: string, appPassword: string): Promise<void> {
  const password = appPassword.replace(/\s+/g, '') // Google shows app passwords in groups of four
  const imap = client(email.trim(), password)
  try {
    await imap.connect()
  } catch (e) {
    const text = String((e as { responseText?: string }).responseText ?? (e as Error).message)
    throw new Error(
      /AUTHENTICATIONFAILED|Invalid credentials|Application-specific password/i.test(text)
        ? 'Gmail refused that address and app password. Use an app password (not your normal password), and make sure IMAP is on in Gmail settings.'
        : `Couldn't reach Gmail: ${text}`,
    )
  } finally {
    await imap.logout().catch(() => {})
  }
  await setSecret(`gmail:${email.trim()}`, password)
  writeSettings({ ...readSettings(), gmail: { email: email.trim() } })
}

export async function disconnect(): Promise<void> {
  const email = connectedAccount()
  if (email) await deleteSecret(`gmail:${email}`)
  const settings = readSettings()
  delete settings.gmail
  writeSettings(settings)
}

const address = (value: unknown): string => {
  const v = value as { text?: string } | { text?: string }[] | undefined
  return Array.isArray(v) ? v.map((a) => a.text ?? '').join(', ') : (v?.text ?? '')
}

/** Messages matching a Gmail search query, newest first, with full plain-text bodies. */
export async function search(query: string, max = 25): Promise<EmailMessage[]> {
  const email = connectedAccount()
  const password = email ? await getSecret(`gmail:${email}`) : null
  if (!email || !password) throw new Error('Gmail is not connected to Retronaut')
  const imap = client(email, password)
  await imap.connect()
  try {
    // "All Mail" is localized ("[Google Mail]/All Mail" in some countries); find it by its flag.
    const allMail = (await imap.list()).find((box) => box.specialUse === '\\All')?.path ?? 'INBOX'
    const lock = await imap.getMailboxLock(allMail, { readOnly: true })
    try {
      const uids = (await imap.search({ gmraw: query }, { uid: true })) || []
      const newest = uids.sort((a, b) => b - a).slice(0, max)
      if (!newest.length) return []
      const messages: EmailMessage[] = []
      for await (const msg of imap.fetch(newest, { source: true, emailId: true, threadId: true }, { uid: true })) {
        const parsed = await simpleParser(msg.source!)
        messages.push({
          id: msg.emailId ?? String(msg.uid),
          thread_id: msg.threadId ?? '',
          from: address(parsed.from),
          to: address(parsed.to),
          subject: parsed.subject ?? '',
          date: (parsed.date ?? new Date(0)).toISOString(),
          body: (parsed.text ?? '').trim(),
        })
      }
      return messages.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    } finally {
      lock.release()
    }
  } finally {
    await imap.logout().catch(() => {})
  }
}
