import { expect, test } from 'vitest'

import { Job } from '../src/main/jobs'

test('a question waits for the answer and the job waits with it', async () => {
  const job = new Job('build', 'wf_test')
  const answer = job.ask('app', 'Let Retronaut use GnuCash?', 'to create invoices', { app: 'GnuCash' })
  expect(job.status).toBe('waiting')
  expect(job.snapshot().requests.map((r) => r.status)).toEqual(['pending'])

  const id = job.requests[0].id
  job.answer(id, true, 'go ahead')
  expect((await answer).status).toBe('approved')
  expect(job.status).toBe('running')
  // Answering twice changes nothing.
  expect(job.answer(id, false).status).toBe('approved')
  expect(() => job.answer('req_nope', true)).toThrow(RangeError)
})

test('stopping declines open questions, ends what the job started, and sticks', async () => {
  const job = new Job('run', 'wf_test')
  const answer = job.ask('plan', 'Review the plan', 'summary')
  const ended: string[] = []
  job.onStop(() => ended.push('agent'))
  job.onStop(() => {
    throw new Error('already gone')
  })
  job.onStop(() => ended.push('script'))

  await job.stop()
  expect(job.stopped).toBe(true)
  expect((await answer).status).toBe('declined')
  expect(ended).toEqual(['agent', 'script'])
  expect(job.status).toBe('failed')
  expect(job.result).toEqual({ error: 'Stopped by you' })

  // The interrupted work finishing afterwards doesn't overwrite the outcome.
  job.finish('passed', { summary: 'late' })
  expect(job.status).toBe('failed')
})

test('screenshots are served by number and only the recent ones are kept', () => {
  const job = new Job('build', 'wf_test')
  const first = job.saveShot(Buffer.from('a'))
  expect(first).toBe(`/jobs/${job.id}/shots/0.jpg`)
  for (let i = 0; i < 60; i++) job.saveShot(Buffer.from(String(i)))
  expect(job.shot(0)).toBeUndefined()
  expect(job.shot(60)?.toString()).toBe('59')
})

test('the live job is the newest one still going, and attention reaches listeners', async () => {
  const { JOBS, liveJob, needAttention, newJob, onAttention } = await import('../src/main/jobs')
  JOBS.clear()
  expect(liveJob()).toBeNull()
  const older = newJob('build', 'wf_a')
  const newer = newJob('run', 'wf_b')
  expect(liveJob()?.id).toBe(newer.id)
  newer.finish('passed')
  expect(liveJob()?.id).toBe(older.id)

  const heard: string[] = []
  const off = onAttention((job, why) => heard.push(`${job.workflowId}:${why}`))
  needAttention(older, 'questions')
  off()
  needAttention(older, 'ignored after unsubscribing')
  expect(heard).toEqual(['wf_a:questions'])
  older.finish('failed')
  expect(liveJob()).toBeNull()
})
