/** Where the engine keeps its state: ledgers, saved extractors, workflows and their runs. */

import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Electron's userData for "Retronaut", so the app and the standalone engine share data. */
export function dataDir(): string {
  return resolve(process.env.RETRONAUT_DATA ?? join(homedir(), 'Library', 'Application Support', 'Retronaut'))
}

export const DATA_DIR = dataDir()

/** Where Retronaut kept its data when it was called Local Link. */
const OLD_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Local Link')
const OURS = ['workflows', 'ledgers', 'cache', 'connectors.json', '.env']

/**
 * Retronaut used to be Local Link: the first time it starts, move the old data folder
 * over. If Electron has already made the new folder, move across what is ours.
 * Called once at startup, before anything reads the data folder.
 */
export function migrateDataDir(from = OLD_DATA_DIR, to = dataDir()): void {
  if ((from === OLD_DATA_DIR && process.env.RETRONAUT_DATA) || !existsSync(from)) return
  if (!existsSync(to)) {
    renameSync(from, to)
    return
  }
  for (const name of OURS) {
    if (existsSync(join(from, name)) && !existsSync(join(to, name))) renameSync(join(from, name), join(to, name))
  }
}

// Read on each call, so tests can point RETRONAUT_DATA at a temp folder.
export const dirs = {
  ledgers: () => join(dataDir(), 'ledgers'),
  cache: () => join(dataDir(), 'cache'),
  workflows: () => join(dataDir(), 'workflows'),
}

/** The bundled runtime that generated scripts import as ./retronaut.mjs (next to main.cjs). */
export const runtimeFile = () => process.env.RETRONAUT_RUNTIME ?? resolve(__dirname, 'retronaut.mjs')

export const PORT = Number(process.env.RETRONAUT_PORT ?? 8000)
export const API_BASE = `http://127.0.0.1:${PORT}`
