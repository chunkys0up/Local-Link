import { expect, test } from 'vitest'

import type { JobEvent, JobSnapshot, UserRequest } from '../src/renderer/api'
import { activeSeconds, buildPhase, phaseDurations, phaseStarts } from '../src/renderer/phases'

const event = (ts: number, kind: string, label: string, i = 0): JobEvent => ({ i, ts, kind, label, detail: '' })
const plan = (answered?: number | null): UserRequest => ({
  id: 'req_plan', kind: 'plan', title: 'Review the plan', reason: '', data: {}, status: 'approved', feedback: '',
  ...(answered === undefined ? {} : { asked: 200, answered }),
})
const build = (events: JobEvent[], requests: UserRequest[], status: JobSnapshot['status'] = 'running', finished: number | null = null): JobSnapshot => ({
  job_id: 'job_test', kind: 'build', workflow_id: 'wf_test', status, started: 0, finished, result: null, requests, events,
})

const events = [
  event(5, 'request', 'Asking to connect gmail'),
  event(30, 'ui', 'Screenshot of Gnucash'),
  event(200, 'plan', 'Plan ready for review'),
  event(203, 'agent', 'Builder: says'), // right after proposing, before approval
  event(260, 'agent', 'Builder: Script'), // resumed once approved
  event(900, 'info', 'Test run'),
]

test('each phase starts at the event that moves the build into it; writing at the approval', () => {
  const job = build(events, [plan(255)], 'passed', 960)
  expect(phaseStarts(job)).toEqual([0, 5, 30, 200, 255, 900])
  expect(phaseDurations(job, 960)).toEqual([5, 25, 170, 55, 645, 60])
})

test('logs from before approvals were timed: writing starts after the builder went quiet', () => {
  const job = build(events, [plan()], 'passed', 960)
  expect(phaseStarts(job)[4]).toBe(260)
})

test('the current phase counts up; phases ahead have no time, skipped ones none either', () => {
  const job = build([event(10, 'ui', 'Screenshot of Gnucash')], [])
  expect(buildPhase(job)).toBe(2)
  // Straight from understanding to exploring: connecting had no time of its own.
  expect(phaseDurations(job, 70)).toEqual([10, null, 60, null, null, null])
})

test('time spent paused is left out of the build and phase timers', () => {
  const job = { ...build(events, [plan(255)], 'running'), pauses: [[40, 100], [300, null]] as [number, number | null][] }
  // Exploring ran 30-200 with 40-100 paused: 110s, not 170s.
  expect(activeSeconds(job, 30, 200)).toBe(110)
  // Writing began at 255 and was paused at 300, still paused at 400: 45s so far, not 145s.
  expect(phaseDurations(job, 400)[4]).toBe(45)
  expect(phaseDurations(job, 500)[4]).toBe(45) // it doesn't count up while paused
  // The build's own clock: 400s since it began, 60s + 100s of it paused.
  expect(activeSeconds(job, 0, 400)).toBe(240)
})
