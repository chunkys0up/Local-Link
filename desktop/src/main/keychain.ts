/** Secrets in the macOS login keychain, through the `security` tool, under service "Local Link". */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SERVICE = 'Local Link'

export async function setSecret(account: string, secret: string): Promise<void> {
  // -U replaces an existing item. The secret is an argument, so it never touches a file.
  await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret])
}

export async function getSecret(account: string): Promise<string | null> {
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
    return stdout.replace(/\n$/, '')
  } catch {
    return null
  }
}

export async function deleteSecret(account: string): Promise<void> {
  await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]).catch(() => {})
}
