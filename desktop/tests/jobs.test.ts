import { expect, test } from 'vitest'

import { Job, newJob, onJobsChange } from '../src/main/jobs'

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

test('a paused build holds its next action until resumed, and stopping lets it go', async () => {
  const job = new Job('build', 'wf_pause')
  await job.whenRunning() // not paused: no wait

  job.pause()
  expect(job.snapshot().paused).toBe(true)
  let through = 0
  const held = job.whenRunning().then(() => through++)
  await new Promise((r) => setTimeout(r, 10))
  expect(through).toBe(0)
  job.resume()
  await held
  expect(through).toBe(1)
  expect(job.events.map((e) => e.label)).toEqual(['Paused', 'Resumed'])

  job.pause()
  const released = job.whenRunning()
  await job.stop()
  await released
  expect(job.paused).toBe(false)

  // Runs can't be paused.
  const run = new Job('run', 'wf_pause')
  run.pause()
  expect(run.paused).toBe(false)
})

test('jobs say when one starts, is paused or resumed, and finishes', async () => {
  const heard: string[] = []
  const off = onJobsChange(() => heard.push('changed'))
  const job = newJob('build', 'wf_listen')
  job.pause()
  job.resume()
  job.finish('passed')
  job.finish('failed') // already finished: nothing new
  off()
  newJob('build', 'wf_listen').stop()
  expect(heard).toEqual(['changed', 'changed', 'changed', 'changed'])
})

test('a job records when it was paused and resumed', () => {
  const job = new Job('build', 'wf_pauses')
  job.pause()
  expect(job.snapshot().pauses).toHaveLength(1)
  expect(job.snapshot().pauses[0][1]).toBeNull() // still paused
  job.resume()
  const [start, end] = job.snapshot().pauses[0]
  expect(end).not.toBeNull()
  expect(end!).toBeGreaterThanOrEqual(start)
})
