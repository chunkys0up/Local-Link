import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { beforeAll, expect, test } from 'vitest'

import { runScript } from '../src/main/executor'
import { Job } from '../src/main/jobs'
import * as ui from '../src/main/uiActivity'

beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'll-runtime-')), 'locallink.mjs')
  await build({ entryPoints: [join(__dirname, '..', 'src', 'runtime', 'locallink.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  process.env.LOCAL_LINK_RUNTIME = out
})

const SCRIPT = `
import * as ll from './locallink.mjs'
await ll.workflow(async ({ step, state }) => {
  const orders = ['WO-1', 'WO-2']
  let made = 0
  for (const id of orders) {
    if (state.done('orders', id)) continue
    await step('Invoice ' + id, async () => {
      if (process.env.FAIL_ON === id) throw new Error('the Save button moved')
      if (process.env.REVIEW_ON === id) ll.needsReview(id + ' has a later visit after it was posted')
      made++
    })
    state.markDone('orders', id)
  }
  return { invoices_created: made }
})
`

async function run(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'll-wf-'))
  writeFileSync(join(dir, 'workflow.mjs'), SCRIPT)
  const job = new Job('run', 'wf_test')
  Object.assign(process.env, env)
  try {
    const outcome = await runScript(job, { dir, script: 'workflow.mjs', out: join(dir, 'out'), state: join(dir, 'state.json') })
    return { dir, job, outcome }
  } finally {
    for (const k of Object.keys(env)) delete process.env[k]
  }
}

test('steps are reported, the result comes back, state persists', async () => {
  const { dir, job, outcome } = await run()
  expect(outcome.ok).toBe(true)
  expect(outcome.summary).toEqual({ invoices_created: 2 })
  expect(job.events.map((e) => `${e.kind} ${e.label}`)).toEqual([
    'step Step 1: Invoice WO-1', 'ok Step 1: Invoice WO-1', 'step Step 2: Invoice WO-2', 'ok Step 2: Invoice WO-2',
  ])
  expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual({ orders: ['WO-1', 'WO-2'] })
})

test('a failing step leaves a failure report naming the step', async () => {
  const { dir, outcome } = await run({ FAIL_ON: 'WO-2' })
  expect(outcome.ok).toBe(false)
  expect(outcome.error).toBe('the Save button moved')
  expect(outcome.step).toMatchObject({ index: 2, name: 'Invoice WO-2' })
  expect(outcome.failure).toMatchObject({ error: 'the Save button moved', step: { name: 'Invoice WO-2' } })
  // WO-1 was handled before the failure and stays recorded, so a rerun skips it.
  expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual({ orders: ['WO-1'] })
})

test('needsReview stops the run on purpose, marked as a review, not a breakage', async () => {
  const { job, outcome } = await run({ REVIEW_ON: 'WO-2' })
  expect(outcome.ok).toBe(false)
  expect(outcome.review).toBe(true)
  expect(outcome.error).toBe('WO-2 has a later visit after it was posted')
  expect(outcome.failure).toMatchObject({ review: true })
  expect(job.events.at(-1)).toMatchObject({ kind: 'review', label: 'Step 2: Invoice WO-2' })
})

test('an ordinary error is not a review', async () => {
  const { outcome } = await run({ FAIL_ON: 'WO-1' })
  expect(outcome.review).toBe(false)
})

test("a script's UI reports drive the frame, and a script that dies mid-action can't leave it up", async () => {
  ui.reset()
  const seen: string[] = []
  const off = ui.onChange((s) => seen.push(`${s.active ? 'on' : 'off'}:${s.app}:${s.paused ? 'paused' : ''}`))
  const dir = mkdtempSync(join(tmpdir(), 'll-wf-'))
  writeFileSync(
    join(dir, 'workflow.mjs'),
    `const r = (e) => process.stdout.write('@@ll ' + JSON.stringify(e) + '\\n')
r({ type: 'ui', state: 'begin', app: 'GnuCash' }); r({ type: 'ui', state: 'paused' }); r({ type: 'ui', state: 'resumed' })
process.exit(3)`,
  )
  const job = new Job('run', 'wf_test')
  const outcome = await runScript(job, { dir, script: 'workflow.mjs', out: join(dir, 'out'), state: join(dir, 'state.json') })
  expect(outcome.ok).toBe(false)
  expect(seen.slice(0, 3)).toEqual(['on:GnuCash:', 'on:GnuCash:paused', 'on:GnuCash:'])
  expect(job.events.map((e) => e.label)).toContain('Waiting for you')
  await new Promise((r) => setTimeout(r, ui.HIDE_AFTER_MS + 100))
  expect(ui.current().active).toBe(false)
  off()
})
