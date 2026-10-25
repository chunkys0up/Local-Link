// Resets the demo for another run-through: a fresh northwind book (three customers, no
// invoices) and saved workflows that remember nothing about earlier runs. Workflows,
// their scripts and run history are kept; only what a run remembers is cleared.
//
//   npm run demo:reset
//
// Refuses while GnuCash has the book open (it would save its old copy over the new one)
// or while Retronaut is building or running something.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEMO_DIR = process.env.RETRONAUT_DEMO_DIR ?? join(homedir(), 'Documents', 'Local Link Demo')
const BOOK = join(DEMO_DIR, 'northwind.gnucash')
const DATA_DIR = process.env.RETRONAUT_DATA ?? join(homedir(), 'Library', 'Application Support', 'Retronaut')
const ENGINE = `http://127.0.0.1:${process.env.RETRONAUT_PORT ?? 8000}`

function stop(message) {
  console.error(`Not reset: ${message}`)
  process.exit(1)
}

function gnucashRunning() {
  try {
    execFileSync('pgrep', ['-f', 'Gnucash.app/Contents/MacOS/Gnucash'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// 1. GnuCash must not have the book open.
if (existsSync(`${BOOK}.LCK`)) {
  if (gnucashRunning()) stop('GnuCash has northwind.gnucash open. Quit GnuCash (⌘Q), then run this again.')
  rmSync(`${BOOK}.LCK`) // left behind by a GnuCash that quit uncleanly
}

// 2. Nothing may be building or running.
try {
  const live = await (await fetch(`${ENGINE}/api/live`, { signal: AbortSignal.timeout(2000) })).json()
  if (live) stop(`Retronaut is ${live.kind === 'build' ? 'building' : 'running'} "${live.title}". Let it finish or press Stop, then run this again.`)
} catch {
  // Retronaut isn't running; nothing can be in progress
}

// 3. A fresh book, and none of GnuCash's backups and logs of the old one.
execFileSync(process.execPath, [join(import.meta.dirname, 'make-book.mjs'), BOOK], { stdio: 'inherit' })
const leftovers = existsSync(DEMO_DIR) ? readdirSync(DEMO_DIR).filter((f) => /^northwind\.gnucash\.\d{14}\.(gnucash|log)$/.test(f)) : []
for (const f of leftovers) rmSync(join(DEMO_DIR, f))
console.log(`Removed ${leftovers.length} GnuCash backup and log files of the old book`)

// 4. Workflows on the demo book forget what earlier runs handled.
const workflowsDir = join(DATA_DIR, 'workflows')
const cleared = []
for (const id of existsSync(workflowsDir) ? readdirSync(workflowsDir) : []) {
  const dir = join(workflowsDir, id)
  const script = join(dir, 'workflow.mjs')
  if (!existsSync(script) || !readFileSync(script, 'utf8').includes('northwind.gnucash')) continue
  for (const f of ['state.json', '.workflow.lock']) rmSync(join(dir, f), { force: true })
  let title = id
  try {
    title = JSON.parse(readFileSync(join(dir, 'workflow.json'), 'utf8')).title
  } catch {
    // keep the id
  }
  cleared.push(title)
}
console.log(cleared.length ? `Cleared what these workflows remember: ${cleared.join(', ')}` : 'No saved workflows use the demo book')

console.log('\nReady. Open GnuCash and choose File › Open Recent › northwind.gnucash.')
