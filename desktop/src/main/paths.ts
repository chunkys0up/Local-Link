/** Where the engine keeps its state: ledgers, saved extractors, workflows and their runs. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Electron's userData for "Local Link", so the app and the standalone engine share data. */
export function dataDir(): string {
  return resolve(process.env.LOCAL_LINK_DATA ?? join(homedir(), 'Library', 'Application Support', 'Local Link'))
}

export const DATA_DIR = dataDir()

// Read on each call, so tests can point LOCAL_LINK_DATA at a temp folder.
export const dirs = {
  ledgers: () => join(dataDir(), 'ledgers'),
  cache: () => join(dataDir(), 'cache'),
  workflows: () => join(dataDir(), 'workflows'),
}

/** The bundled runtime that generated scripts import as ./locallink.mjs (next to main.cjs). */
export const runtimeFile = () => process.env.LOCAL_LINK_RUNTIME ?? resolve(__dirname, 'locallink.mjs')

export const PORT = Number(process.env.LOCAL_LINK_PORT ?? 8000)
export const API_BASE = `http://127.0.0.1:${PORT}`
