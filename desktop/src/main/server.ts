/**
 * The engine's HTTP API on 127.0.0.1, the same routes the Python runner had plus
 * workflows and jobs. Every route also answers under /api, so the renderer uses the
 * same paths in dev (through vite's proxy) and packaged (served from here).
 *
 * Only Retronaut's own pages may call it from a browser: requests with any other
 * Origin are refused, and POST bodies must be JSON (so a web page can't send a
 * "simple" cross-site form post at it).
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'

import * as apps from './apps'
import * as builder from './builder'
import { gmailSearch } from './connectors'
import * as gmail from './gmail'
import * as discover from './discover'
import * as jobs from './jobs'
import * as ledger from './ledger'
import { PORT } from './paths'
import * as pipeline from './pipeline'
import * as query from './query'
import { toCents } from './rows'
import { health } from './startup'
import * as workflows from './workflows'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type Params = Record<string, string>
interface Request {
  method: string
  path: string
  params: Params
  query: URLSearchParams
  body: Record<string, unknown>
}
type Handler = (req: Request) => unknown | Promise<unknown>

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = []

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = []
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`)
  routes.push({ method, pattern, keys, handler })
}

// ---------- query parameter helpers ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/

function str(q: URLSearchParams, key: string): string | undefined {
  const v = q.get(key)
  return v === null || v === '' ? undefined : v
}

function date(q: URLSearchParams, key: string): string | undefined {
  const v = str(q, key)
  if (v !== undefined && !DATE.test(v)) throw new HttpError(422, `${key} must be YYYY-MM-DD`)
  return v
}

function int(q: URLSearchParams, key: string, fallback: number | undefined, min = -Infinity, max = Infinity): number | undefined {
  const v = str(q, key)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, `${key} must be an integer between ${min} and ${max}`)
  return n
}

function oneOf<T extends string>(q: URLSearchParams, key: string, values: readonly T[]): T | undefined {
  const v = str(q, key)
  if (v !== undefined && !values.includes(v as T)) throw new HttpError(422, `${key} must be one of ${values.join(', ')}`)
  return v as T | undefined
}

function cents(q: URLSearchParams, key: string): number | undefined {
  const v = str(q, key)
  if (v === undefined) return undefined
  try {
    return toCents(v)
  } catch {
    throw new HttpError(422, `${key} must be an amount like 10 or 10.50`)
  }
}

function db(ledgerId: string): string {
  try {
    return query.existing(ledgerId)
  } catch (e) {
    if (e instanceof query.NotFound) throw new HttpError(404, e.message)
    throw new HttpError(400, (e as Error).message)
  }
}

function text(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(422, `${key} is required`)
  return v
}

function job(id: string): jobs.Job {
  const found = jobs.JOBS.get(id)
  if (!found) throw new HttpError(404, `no job ${id}`)
  return found
}

function workflow(id: string): workflows.Workflow {
  let found: workflows.Workflow | null
  try {
    found = workflows.get(id)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
  if (!found) throw new HttpError(404, `no workflow ${id}`)
  return found
}

class Jpeg {
  constructor(readonly bytes: Buffer) {}
}

// ---------- connect and read APIs (as the Python runner) ----------

route('GET', '/health', () => health())

route('POST', '/connect', (req) => {
  const run = pipeline.newRun(text(req.body, 'app'), text(req.body, 'data_path'), req.body.allow_ui === true)
  void pipeline.execute(run)
  return { run_id: run.id }
})

route('GET', '/events', (req) => {
  const id = str(req.query, 'run_id')
  const run = id ? pipeline.RUNS.get(id) : pipeline.latestRun()
  if (!run) throw new HttpError(404, id ? 'no such run' : 'no runs yet')
  return run.snapshot(int(req.query, 'after', 0, 0))
})

route('GET', '/runs/:id/shots/:n.jpg', (req) => {
  const shot = pipeline.RUNS.get(req.params.id)?.shot(Number(req.params.n))
  if (!shot) throw new HttpError(404, 'no such screenshot')
  return new Jpeg(shot)
})

route('GET', '/apps', async () => ({ apps: await apps.scan() }))

route('GET', '/apps/data', async (req) => ({ candidates: await discover.candidates(text(Object.fromEntries(req.query), 'path')) }))

route('GET', '/ledgers', () => ({ ledgers: ledger.listLedgers() }))

route('GET', '/ledger', (req) => {
  const q = req.query
  const ledgerId = text(Object.fromEntries(q), 'ledger_id')
  const file = db(ledgerId)
  const [rows, total] = ledger.queryRows(file, {
    account: str(q, 'account'),
    search: str(q, 'search'),
    date_from: date(q, 'from'),
    date_to: date(q, 'to'),
    min_amount: cents(q, 'min'),
    max_amount: cents(q, 'max'),
    side: oneOf(q, 'side', ['debit', 'credit'] as const),
    run_id: str(q, 'run_id'),
    limit: int(q, 'limit', 1000, 0, 5000),
    offset: int(q, 'offset', 0, 0),
  })
  return { ledger_id: ledgerId, total, rows, provenance: query.provenance(file, new Set(rows.map((r) => r.run_id))) }
})

route('GET', '/ledgers/:id/balances', (req) => {
  const as_of = date(req.query, 'as_of') ?? null
  return { ledger_id: req.params.id, as_of, accounts: ledger.balances(db(req.params.id), { account: str(req.query, 'account'), as_of: as_of ?? undefined }) }
})

route('GET', '/ledgers/:id/changes', (req) => {
  const file = db(req.params.id)
  let since = str(req.query, 'since') === undefined ? undefined : Number(str(req.query, 'since'))
  const sinceRun = str(req.query, 'since_run')
  if (sinceRun) {
    try {
      since = query.sinceRun(file, sinceRun)
    } catch (e) {
      if (e instanceof query.NotFound) throw new HttpError(404, e.message)
      throw e
    }
  }
  return {
    ledger_id: req.params.id,
    since: since ?? null,
    changes: ledger.changes(file, {
      run_id: str(req.query, 'run_id'),
      change: oneOf(req.query, 'change', ['added', 'changed', 'deleted'] as const),
      since,
      limit: int(req.query, 'limit', 1000, 1, 5000),
    }),
  }
})

route('GET', '/ledgers/:id/runs', (req) => ({ ledger_id: req.params.id, runs: ledger.runs(db(req.params.id), { limit: int(req.query, 'limit', 100, 1, 1000) }) }))

route('GET', '/ledgers/:id/flags', (req) => ({ ledger_id: req.params.id, ...query.flags(db(req.params.id)) }))

route('GET', '/ledgers/:id/monthly', (req) => {
  const by = oneOf(req.query, 'by', ['account', 'payee'] as const) ?? 'account'
  const months = query.monthly(db(req.params.id), {
    by,
    account: str(req.query, 'account'),
    depth: int(req.query, 'depth', undefined, 0),
    date_from: date(req.query, 'from'),
    date_to: date(req.query, 'to'),
  })
  return { ledger_id: req.params.id, by, months }
})

route('POST', '/ledgers/:id/sql', (req) => {
  const file = db(req.params.id)
  const limit = req.body.limit === undefined ? 500 : Number(req.body.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(422, 'limit must be 1-1000')
  try {
    return query.runSql(file, text(req.body, 'query'), limit)
  } catch (e) {
    if (e instanceof RangeError) throw new HttpError(400, e.message)
    throw e
  }
})

route('POST', '/reset', () => {
  if (pipeline.anyRunning() || jobs.anyRunning()) throw new HttpError(409, 'a run is in progress; wait for it to finish')
  pipeline.reset()
  return { cleared: true }
})

// ---------- workflows ----------

route('GET', '/workflows', () => ({ workflows: workflows.list() }))

route('POST', '/workflows', (req) => {
  const { workflow: wf, job: j } = builder.startBuild(text(req.body, 'prompt'))
  return { workflow_id: wf.id, job_id: j.id }
})

route('GET', '/workflows/:id', (req) => {
  const wf = workflow(req.params.id)
  return { ...wf, script: workflows.script(wf.id) }
})

route('DELETE', '/workflows/:id', (req) => {
  const wf = workflow(req.params.id)
  if ([...jobs.JOBS.values()].some((j) => j.workflowId === wf.id && (j.status === 'running' || j.status === 'waiting'))) {
    throw new HttpError(409, 'this workflow is running')
  }
  workflows.remove(wf.id)
  return { deleted: wf.id }
})

route('POST', '/workflows/:id/run', (req) => {
  const wf = workflow(req.params.id)
  if ([...jobs.JOBS.values()].some((j) => j.workflowId === wf.id && (j.status === 'running' || j.status === 'waiting'))) {
    throw new HttpError(409, 'this workflow is already running')
  }
  try {
    return { job_id: builder.startRun(wf.id).id }
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
})

route('GET', '/workflows/:id/runs/:job', (req) => {
  workflow(req.params.id)
  const live = jobs.JOBS.get(req.params.job)
  const saved = live ? live.snapshot() : workflows.savedRun(req.params.id, req.params.job)
  if (!saved) throw new HttpError(404, 'no such run')
  return saved
})

// ---------- jobs ----------

// The newest build or run still going, with its workflow's title: the picture-in-picture.
route('GET', '/live', () => {
  const j = jobs.liveJob()
  if (!j) return null
  const wf = workflows.get(j.workflowId)
  // A run's step count isn't known up front; the last good run's is the best guess.
  const lastGood = wf?.runs.find((r) => r.kind === 'run' && r.status === 'passed' && r.steps)
  return { ...j.snapshot(), title: wf?.title ?? '', expected_steps: lastGood?.steps ?? null }
})

route('GET', '/jobs/:id', (req) => job(req.params.id).snapshot(int(req.query, 'after', 0, 0)))

route('POST', '/jobs/:id/stop', async (req) => {
  const j = job(req.params.id)
  await j.stop()
  return j.snapshot()
})

route('POST', '/jobs/:id/pause', (req) => {
  const j = job(req.params.id)
  if (j.kind !== 'build') throw new HttpError(400, 'only builds can be paused')
  j.pause()
  return j.snapshot()
})

route('POST', '/jobs/:id/resume', (req) => {
  const j = job(req.params.id)
  j.resume()
  return j.snapshot()
})

route('GET', '/jobs/:id/shots/:n.jpg', (req) => {
  const shot = job(req.params.id).shot(Number(req.params.n))
  if (!shot) throw new HttpError(404, 'no such screenshot')
  return new Jpeg(shot)
})

route('POST', '/jobs/:id/requests/:request', (req) => {
  const j = job(req.params.id)
  try {
    return j.answer(req.params.request, req.body.approved === true, typeof req.body.feedback === 'string' ? req.body.feedback : '')
  } catch (e) {
    throw new HttpError(404, (e as Error).message)
  }
})

// ---------- connectors (called by workflow scripts) ----------

route('GET', '/connectors', () => ({ gmail: { connected: Boolean(gmail.connectedAccount()), email: gmail.connectedAccount() } }))

route('POST', '/connectors/gmail', async (req) => {
  try {
    await gmail.connect(text(req.body, 'email'), text(req.body, 'app_password'))
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
  return { connected: true, email: gmail.connectedAccount() }
})

route('DELETE', '/connectors/gmail', async () => {
  await gmail.disconnect()
  return { connected: false }
})

// Retronaut's own Gmail connection when there is one, else Factory's connector.
route('POST', '/connectors/gmail/search', async (req) => {
  const max = req.body.max === undefined ? 25 : Number(req.body.max)
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new HttpError(422, 'max must be 1-100')
  const query = text(req.body, 'query')
  try {
    return { messages: gmail.connectedAccount() ? await gmail.search(query, max) : await gmailSearch(query, max) }
  } catch (e) {
    throw new HttpError(502, (e as Error).message)
  }
})

// ---------- serving ----------

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true // curl, workflow scripts, Electron's own requests
  return [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'http://localhost:5317', 'http://127.0.0.1:5317'].includes(origin)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'send JSON (Content-Type: application/json)')
  try {
    const body = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body
  } catch {
    throw new HttpError(400, 'body must be a JSON object')
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (body instanceof Jpeg) {
    res.writeHead(status, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' })
    res.end(body.bytes)
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function serveStatic(root: string, path: string, res: ServerResponse): boolean {
  const file = normalize(join(root, path === '/' ? 'index.html' : path))
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return false
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
  return true
}

export async function handle(method: string, rawPath: string, query: URLSearchParams, body: Record<string, unknown>): Promise<[number, unknown]> {
  const path = rawPath.replace(/^\/api(?=\/)/, '')
  const matched = routes.filter((r) => r.pattern.test(path))
  if (!matched.length) return [404, { detail: 'Not Found' }]
  const r = matched.find((m) => m.method === method)
  if (!r) return [405, { detail: 'Method Not Allowed' }]
  const values = r.pattern.exec(path)!.slice(1)
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(values[i])]))
  try {
    return [method === 'POST' && path === '/connect' ? 202 : 200, await r.handler({ method, path, params, query, body })]
  } catch (e) {
    if (e instanceof HttpError) return [e.status, { detail: e.message }]
    if (e instanceof RangeError) return [400, { detail: e.message }]
    console.error(e)
    return [500, { detail: `${(e as Error).name}: ${(e as Error).message}` }]
  }
}

/** Start the API (and, when given, serve the built renderer from rendererDir). */
export function serve(rendererDir?: string): Promise<Server> {
  workflows.markInterrupted()
  const server = createServer(async (req, res) => {
    try {
      if (!allowedOrigin(req.headers.origin)) throw new HttpError(403, 'requests from other sites are not allowed')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'
      if (method === 'GET' && rendererDir && !url.pathname.startsWith('/api/') && serveStatic(rendererDir, url.pathname, res)) return
      const body = method === 'POST' ? await readBody(req) : {}
      const [status, payload] = await handle(method, url.pathname, url.searchParams, body)
      send(res, status, payload)
    } catch (e) {
      send(res, e instanceof HttpError ? e.status : 500, { detail: (e as Error).message })
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}
