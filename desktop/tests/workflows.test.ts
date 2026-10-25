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
