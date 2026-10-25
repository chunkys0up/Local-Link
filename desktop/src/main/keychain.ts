/** Secrets in the macOS login keychain, through the `security` tool, under service "Retronaut". */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SERVICE = 'Retronaut'
const OLD_SERVICE = 'Local Link' // Retronaut's name before; secrets saved then move over when first read

export async function setSecret(account: string, secret: string): Promise<void> {
  // -U replaces an existing item. The secret is an argument, so it never touches a file.
  await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret])
}

async function find(service: string, account: string): Promise<string | null> {
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
    return stdout.replace(/\n$/, '')
  } catch {
    return null
  }
}

export async function getSecret(account: string): Promise<string | null> {
  const secret = await find(SERVICE, account)
  if (secret !== null) return secret
  const old = await find(OLD_SERVICE, account)
  if (old === null) return null
  await setSecret(account, old)
  await run('security', ['delete-generic-password', '-s', OLD_SERVICE, '-a', account]).catch(() => {})
  return old
}

export async function deleteSecret(account: string): Promise<void> {
  await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]).catch(() => {})
}
