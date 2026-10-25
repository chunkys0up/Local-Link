import { afterEach, expect, test, vi } from 'vitest'

import { QUIET_MS, userBusy } from '../src/shared/macos'
import * as ui from '../src/main/uiActivity'

const NOW = 1_000_000

test('a person who just moved the mouse makes Retronaut wait', () => {
  expect(userBusy(0.3, NOW, 0)).toBe(true)
  expect(userBusy((QUIET_MS - 1) / 1000, NOW, 0)).toBe(true)
})

test('once they have been still for the quiet period, Retronaut acts', () => {
  expect(userBusy(QUIET_MS / 1000, NOW, 0)).toBe(false)
  expect(userBusy(30, NOW, 0)).toBe(false)
})

test("Retronaut's own clicks and keys don't count as the person", () => {
  // The latest input was 0.1s ago, inside the window we marked as ours.
  expect(userBusy(0.1, NOW, NOW + 300)).toBe(false)
  // Input after our last action is the person's.
  expect(userBusy(0.1, NOW, NOW - 500)).toBe(true)
})

afterEach(() => {
  ui.reset()
  vi.useRealTimers()
})

test('the frame stays up through a burst of actions and hides after the last one', async () => {
  vi.useFakeTimers()
  const states: boolean[] = []
  const off = ui.onChange((s) => states.push(s.active))
  await ui.during('GnuCash', 'job_1', async () => {})
  vi.advanceTimersByTime(ui.HIDE_AFTER_MS / 2)
  await ui.during('GnuCash', 'job_1', async () => {}) // the next action arrives in time
  expect(ui.current()).toMatchObject({ active: true, app: 'GnuCash', jobId: 'job_1' })
  vi.advanceTimersByTime(ui.HIDE_AFTER_MS + 1)
  expect(ui.current().active).toBe(false)
  expect(states).toEqual([true, false])
  off()
})

test('nested actions keep the frame up until the outer one ends, even if it throws', async () => {
  vi.useFakeTimers()
  await expect(
    ui.during('GnuCash', null, async () => {
      await ui.during('GnuCash', null, async () => {})
      vi.advanceTimersByTime(ui.HIDE_AFTER_MS * 2)
      expect(ui.current().active).toBe(true)
      throw new Error('the dialog never opened')
    }),
  ).rejects.toThrow('the dialog never opened')
  vi.advanceTimersByTime(ui.HIDE_AFTER_MS + 1)
  expect(ui.current().active).toBe(false)
})

test('the pill shows keys and typing the way a person would read them', () => {
  expect(['tab', 'tab', 'down', 'cmd+shift+g', 'return', 'a'].map(ui.keyLabel).join(' ')).toBe('Tab Tab ↓ ⌘⇧G ↵ A')
  expect(ui.typedLabel('/Users/someone/Documents/Local Link Demo/run/WO-1042.csv')).toBe('Typing “/Users/someone/Documents/Local Link Demo/run/WO…”')
})

test('the frame keeps the current action until it hides', async () => {
  vi.useFakeTimers()
  await ui.during('GnuCash', 'job_1', async () => {}, 'Choosing File › Import')
  expect(ui.current().action).toBe('Choosing File › Import')
  vi.advanceTimersByTime(ui.HIDE_AFTER_MS + 1)
  expect(ui.current()).toMatchObject({ active: false, action: '' })
})
