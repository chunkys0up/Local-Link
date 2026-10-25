import { expect, test } from 'vitest'

import * as workflows from '../src/main/workflows'

test('builds cut off by a restart are marked interrupted, others are left alone', () => {
  const stuck = workflows.create('a build that was running when the app quit')
  const done = workflows.create('a finished one')
  workflows.update(done.id, (w) => void (w.status = 'ready'))
  expect(workflows.markInterrupted()).toBe(1)
  expect(workflows.get(stuck.id)).toMatchObject({ status: 'failed', note: expect.stringMatching(/^Interrupted/) })
  expect(workflows.get(done.id)?.status).toBe('ready')
})

test("Local Link's data folder moves to Retronaut's: whole, or what's ours if Electron made the new one first", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { migrateDataDir } = await import('../src/main/paths')

  const a = mkdtempSync(join(tmpdir(), 'll-migrate-'))
  mkdirSync(join(a, 'Local Link', 'workflows', 'wf_1'), { recursive: true })
  migrateDataDir(join(a, 'Local Link'), join(a, 'Retronaut'))
  expect(existsSync(join(a, 'Retronaut', 'workflows', 'wf_1'))).toBe(true)
  expect(existsSync(join(a, 'Local Link'))).toBe(false)

  const b = mkdtempSync(join(tmpdir(), 'll-migrate-'))
  mkdirSync(join(b, 'Local Link', 'workflows'), { recursive: true })
  writeFileSync(join(b, 'Local Link', 'connectors.json'), '{"gmail":{"email":"a@b.c"}}')
  writeFileSync(join(b, 'Local Link', 'Cookies'), 'electron cache')
  mkdirSync(join(b, 'Retronaut', 'ledgers'), { recursive: true }) // made by a newer run already
  writeFileSync(join(b, 'Local Link', 'ledgers.keep'), '')
  migrateDataDir(join(b, 'Local Link'), join(b, 'Retronaut'))
  expect(existsSync(join(b, 'Retronaut', 'workflows'))).toBe(true)
  expect(readFileSync(join(b, 'Retronaut', 'connectors.json'), 'utf8')).toContain('a@b.c')
  expect(existsSync(join(b, 'Retronaut', 'Cookies'))).toBe(false) // Electron's own files stay behind
})
