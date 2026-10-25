/**
 * Process setup shared by the Electron app and the standalone engine: PATH (apps
 * launched from the Finder get a bare one, without droid or node), FACTORY_API_KEY
 * from a .env file, and the readiness report the UI shows before the first build.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { connectedAccount } from './gmail'
import { DATA_DIR, migrateDataDir } from './paths'

const EXTRA_PATH = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']

/** .env files tried in order: the repo root (dev), then Retronaut's data folder. */
export const ENV_FILES = [resolve(__dirname, '..', '..', '.env'), join(DATA_DIR, '.env')]

export function prepareEnvironment(): void {
  migrateDataDir()
  const parts = (process.env.PATH ?? '/usr/bin:/bin').split(':')
  process.env.PATH = [...EXTRA_PATH.filter((p) => !parts.includes(p)), ...parts].join(':')
  for (const file of ENV_FILES) {
    if (!process.env.FACTORY_API_KEY && existsSync(file)) {
      try {
        process.loadEnvFile(file)
      } catch {
        // a malformed .env shouldn't stop the app; health() reports the missing key
      }
    }
  }
}

export interface Health {
  droid: string | null // version, or null if the CLI isn't installed
  api_key: boolean
  accessibility: boolean | null // null when unknown (not running inside Electron)
  screen_recording: string | null
  gmail: string | null // the connected address
  env_files: string[]
}

/** Permission checks only Electron can make; set by the Electron entry point. */
export const permissions: { probe: () => { accessibility: boolean | null; screen_recording: string | null } } = {
  probe: () => ({ accessibility: null, screen_recording: null }),
}

export function health(): Health {
  let droid: string | null = null
  try {
    droid = execFileSync('droid', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    droid = null
  }
  return { droid, api_key: Boolean(process.env.FACTORY_API_KEY), ...permissions.probe(), gmail: connectedAccount(), env_files: ENV_FILES }
}
