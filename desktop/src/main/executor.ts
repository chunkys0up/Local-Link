/**
 * Runs a workflow script as its own process, with Electron's Node (or node in dev),
 * and turns the runtime's "@@ll" report lines into job events.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Job } from './jobs'
import * as ui from './uiActivity'
import { API_BASE, runtimeFile } from './paths'

export const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000
const TAIL_LINES = 12

export interface ScriptOutcome {
  ok: boolean
  /** Stopped on purpose (ll.needsReview): a person decides; nothing is healed. */
  review: boolean
  summary: unknown
  error: string | null
  step: { index: number; name: string; app?: string } | null
  failure: Record<string, unknown> | null
  failureShot: Buffer | null
  output: string // the last lines of stdout/stderr that weren't reports
}

/** The node that runs scripts: Electron itself as Node when packaged, else this node. */
export function nodeCommand(): { command: string; env: Record<string, string> } {
  return process.versions.electron
    ? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: process.execPath, env: {} }
}

/** Put the current runtime next to a script, so it imports ./locallink.mjs. */
export function provideRuntime(dir: string): void {
  copyFileSync(runtimeFile(), join(dir, 'locallink.mjs'))
}

export async function runScript(
  job: Job,
  opts: { dir: string; script: string; out: string; state: string; test?: boolean },
): Promise<ScriptOutcome> {
  provideRuntime(opts.dir)
  const node = nodeCommand()
  const child = spawn(node.command, [opts.script], {
    cwd: opts.dir,
    env: {
      ...process.env,
      ...node.env,
      LOCAL_LINK_API: API_BASE,
      LOCAL_LINK_OUT: opts.out,
      LOCAL_LINK_STATE: opts.state,
      LOCAL_LINK_TEST: opts.test ? '1' : '0',
      LOCAL_LINK_JOB: job.id,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let onScreen = 0 // UI actions begun and not yet ended, closed if the script dies mid-action
  let result: { ok: boolean; review?: boolean; summary?: unknown; error?: string; step?: ScriptOutcome['step'] } | null = null
  const tail: string[] = []
  const keep = (line: string) => {
    if (!line.trim()) return
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
  }

  const onLine = (line: string) => {
    if (!line.startsWith('@@ll ')) return keep(line)
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line.slice(5))
    } catch {
      return keep(line)
    }
    if (event.type === 'step') {
      const name = String(event.name)
      if (event.status === 'running') job.emit('step', `Step ${event.index}: ${name}`, 'running')
      else if (event.status === 'failed' && event.review) job.emit('review', `Step ${event.index}: ${name}`, String(event.error ?? 'needs review'))
      else if (event.status === 'ok') job.emit('ok', `Step ${event.index}: ${name}`, `done in ${((event.ms as number) / 1000).toFixed(1)}s`)
      else job.emit('fail', `Step ${event.index}: ${name}`, String(event.error ?? 'failed'))
    } else if (event.type === 'ui') {
      if (event.state === 'begin') {
        onScreen++
        ui.begin(String(event.app ?? ''), job.id, String(event.label ?? ''))
      } else if (event.state === 'end' && onScreen > 0) {
        onScreen--
        ui.end()
      } else if (event.state === 'paused' || event.state === 'resumed') {
        ui.paused(event.state === 'paused')
        if (event.state === 'paused') job.emit('ui', 'Waiting for you', 'paused until you let go of the mouse and keyboard')
      }
    } else if (event.type === 'log') {
      job.emit('info', String(event.message), String(event.detail ?? ''))
    } else if (event.type === 'result') {
      result = event as typeof result
    }
  }

  const reader = (stream: NodeJS.ReadableStream) => {
    let buffered = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      lines.forEach(onLine)
    })
    stream.on('end', () => buffered && onLine(buffered))
  }
  reader(child.stdout!)
  reader(child.stderr!)

  job.onStop(() => child.kill('SIGKILL'))
  const timer = setTimeout(() => child.kill('SIGKILL'), SCRIPT_TIMEOUT_MS)
  const code: number | null = await new Promise((resolve) => {
    child.on('close', resolve)
    child.on('error', () => resolve(-1))
  })
  clearTimeout(timer)
  for (; onScreen > 0; onScreen--) ui.end()
  ui.paused(false)

  const failurePath = join(opts.out, 'failure.json')
  const shotPath = join(opts.out, 'failure.jpg')
  const failure = existsSync(failurePath) ? JSON.parse(readFileSync(failurePath, 'utf8')) : null
  const failureShot = existsSync(shotPath) ? readFileSync(shotPath) : null
  const r = result as { ok: boolean; review?: boolean; summary?: unknown; error?: string; step?: ScriptOutcome['step'] } | null
  const output = tail.join('\n')

  if (r?.ok && code === 0) return { ok: true, review: false, summary: r.summary ?? null, error: null, step: null, failure: null, failureShot: null, output }
  const error =
    r?.error ??
    (code === null ? `the script was stopped after ${SCRIPT_TIMEOUT_MS / 60000} minutes` : `the script exited ${code} without a result${output ? `: ${output.split('\n').slice(-3).join(' | ')}` : ''}`)
  return { ok: false, review: r?.review === true, summary: null, error, step: r?.step ?? null, failure, failureShot, output }
}
