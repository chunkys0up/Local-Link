/**
 * Building and healing workflows.
 *
 * Build: the builder agent asks for the apps and accounts it needs, explores them,
 * proposes a plan (the user approves it), and writes workflow.mjs. The engine then
 * test-runs the script; a failure goes back to the same session with the failing
 * step and a screenshot, up to MAX_FIXES times. A passing script is installed.
 *
 * Run: the saved script runs with no agent. If a step fails, a healing agent gets
 * the failure, works out what changed (an app update that moved a button, a renamed
 * window, ...), fixes the script, and the engine runs it again.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Agent, type AskUserQuestion } from './agent'
import { FACTORY_CONNECTORS_URL, readOnlyConnectorTools } from './connectors'
import { provideRuntime, runScript, type ScriptOutcome } from './executor'
import { needAttention, newJob, type Job } from './jobs'
import { SERVER, computerServer, type AllowedApp, type Plan, type Question } from './tools'
import * as gmail from './gmail'
import * as workflows from './workflows'

const MAX_FIXES = 2

export const RUNTIME_API = `
## ./retronaut.mjs (import * as ll from './retronaut.mjs')
await ll.workflow(async ({ step, state, log, isTest }) => { ...; return { invoices_created: n } })
step(name, fn, { app })   one action, reported live; pass the app so a failure screenshots it
ll.needsReview(reason)    stop on purpose for a person to decide (data that's ambiguous, changed after
                          it was handled, or unknown). Never healed. Throw ordinary errors for breakages.
log(message, detail)      a line in the run log
state.get(key, fallback) / state.set(key, value)   JSON kept between runs
state.done(set, id) / state.markDone(set, id)      e.g. state.done('work_orders', 'WO-1042')
ll.gmail.search(query, { max })  -> [{ id, thread_id, from, to, subject, date, body }] (Gmail query syntax)
const app = ll.app('GnuCash')
  app.activate()  app.menu(['File', 'Import', '...'])  app.keys('cmd+shift+g', 'tab', 'return')
  app.type('text')  app.clickAt(x, y, { window: 'Title' })  (points from the window's top-left)
  app.clickElement('window 1/button 2')  app.waitForWindow('Title' | /re/, ms)  app.waitForWindowGone(...)
  app.window('Title')  app.windows()  app.screenshot(path)
ll.readText(path) (gunzips if needed)  ll.xml.parse(text)  ll.sqlite(path, { readOnly })  ll.csv.stringify(rows)
ll.sleep(ms)   Node's standard library is available too (node:fs, node:path, ...).
`

const BUILD = `You are building a reusable automation on the user's Mac. They asked:

"{goal}"

Retronaut turns this into a script that runs again and again without you, so work out
exactly how to do it, then write that down as code.

## How to work
1. Find out what's needed. list_apps shows installed apps. For each local app whose
   interface the workflow drives, call request_access with kind "app" (reading a data
   file the user named needs no request). For an online account (Gmail, Outlook, ...)
   call request_access with kind "connector", then explore it (Gmail: the gmail_search
   tool; other accounts: their connector tools; read only). Ask for everything you need
   at once, then end your turn: Retronaut resumes you with the user's answers.
   When something is ambiguous (which of several books or files, which customer an
   email means, a missing rate), ask the user with AskUser rather than guessing or
   stopping. An app may have the user's own data open: confirm it's the right file
   before relying on it.
2. Explore with real data and the real UI before choosing how. Prefer, in order:
   - direct file access: read the app's data file (find it from the app's recent files,
     preferences or Application Support). Write to it only if the app is closed and you
     have verified the format, and keep a backup copy.
   - the app's own import/export features, driven through its menus (list_menu, choose_menu).
   - keyboard (press_keys, type_text): Tab between fields, Return to confirm.
   - accessibility (ui_tree, click_element), if the app exposes its widgets.
   - screenshot + click at coordinates, as the last resort.
   Take a screenshot after each UI action to check where you are. While exploring,
   don't make the real change: cancel dialogs you open (escape).
3. Call propose_plan with the steps and how each is done, then end your turn. You are
   resumed with the user's approval or feedback; on feedback, revise and propose again.
4. Write workflow.mjs in the working folder with ./retronaut.mjs (API below):
   - one ll.step per meaningful action, with { app } when it drives an app;
   - idempotent: record each item you handle with state.markDone and skip items
     state.done says were handled, so reruns never create duplicates;
   - verify: after changing an app, read the result back (its data file, or the window
     that confirms it) in a step, and throw if it isn't there;
   - when the data itself needs a person (an item changed after it was handled, an
     unknown customer, a format you don't recognise), call ll.needsReview(reason) for
     that case, and keep handling the other items if that is safe;
   - wait for windows (waitForWindow) instead of fixed sleeps where you can;
   - keep money exact (integer cents), and never invent amounts, customers or accounts:
     if the data doesn't say, throw with a clear message.
   Run it yourself with node if that helps, then finish your turn with a short summary.
   Retronaut then runs it as the test run and tells you the result.

## Rules
- Working folder: {workspace}. Write files only there. Commands: read-only ones, or
  \`node <script>.mjs\` for scripts in the working folder.
- Only drive apps the user allowed, never Retronaut, a terminal, or other apps.
- Never send, delete or change anything in an online account unless the user asked.
${RUNTIME_API}`

const TEST_FAILED = `Retronaut's test run of workflow.mjs failed.

{failure}

Find the cause (screenshot the app if it helps; the screenshot attached is from the
moment it failed). Fix workflow.mjs, then finish your turn. Items the run already
handled are recorded in state.json; the script must skip them, not redo them.`

const HEAL = `You maintain a saved automation on the user's Mac. It worked before, and failed in
today's run. What it does: "{goal}"

The approved plan:
{plan}

The failure:
{failure}

workflow.mjs (and the state.json of what's already been handled) are in your working
folder, with ./retronaut.mjs. Work out what changed, for example an app update that
moved a menu item or button, a renamed window, a different email format, by looking at
the app now (screenshot, list_menu, ui_tree) and at the data. Then make the smallest fix
to workflow.mjs that keeps the same behaviour, and finish your turn with what changed
and why. Don't redo items state.json lists as done. If the failure is one of the
script's own safety checks working as intended (the data needs a person), change
nothing and say so: never weaken a check to get a run through.

## Rules
- Working folder: {workspace}. Write files only there. Commands: read-only ones, or
  \`node <script>.mjs\` for scripts in the working folder.
- Only drive the apps this workflow uses: {apps}.
${RUNTIME_API}`

function describeFailure(outcome: ScriptOutcome): string {
  const lines = [
    outcome.step ? `Failed at step ${outcome.step.index}: "${outcome.step.name}"` : 'Failed before or between steps.',
    `Error: ${outcome.error}`,
  ]
  if (outcome.failure?.windows) lines.push(`Open windows then: ${JSON.stringify(outcome.failure.windows)}`)
  if (outcome.failure?.stack) lines.push(`Stack:\n${outcome.failure.stack}`)
  if (outcome.output) lines.push(`Last output:\n${outcome.output}`)
  return lines.join('\n')
}

function describePlan(plan: Plan | null): string {
  if (!plan) return '(none recorded)'
  return [plan.summary, ...plan.steps.map((s, i) => `${i + 1}. ${s.title} [${s.how}]: ${s.detail}`)].join('\n')
}

function attachments(outcome: ScriptOutcome) {
  return outcome.failureShot ? [{ type: 'base64' as const, mediaType: 'image/jpeg' as const, data: outcome.failureShot.toString('base64') }] : []
}

const MAX_EXCHANGES = 12

/**
 * The questions a builder asked (tools.ts queues them, never waiting), answered by the
 * user in the UI. Answers are applied here (an allowed app, a connected account, the
 * plan) and handed back to the agent as text when it is resumed.
 */
class Questions {
  private waiting: Promise<string>[] = []
  private apps = new Set<string>()

  constructor(
    private readonly job: Job,
    private readonly wfId: string,
    private readonly allowed: Map<string, AllowedApp>,
  ) {}

  ask = (q: Question): void => {
    if (q.kind === 'app') {
      const key = q.app.name.toLowerCase()
      this.apps.add(key)
      this.waiting.push(
        this.job.ask('app', `Let Retronaut use ${q.app.name}?`, q.reason, { app: q.app.name, path: q.app.path, kind: q.app.kind }).then((r) => {
          this.apps.delete(key)
          if (r.status !== 'approved') return `The user declined access to ${q.app.name}.`
          this.allowed.set(key, { app: q.app.name, bundleId: q.app.bundle_id || undefined, path: q.app.path })
          return `The user allowed ${q.app.name}. You can now screenshot and drive it.`
        }),
      )
    } else if (q.kind === 'connector') {
      const title = `Connect ${q.name[0].toUpperCase()}${q.name.slice(1)}`
      this.waiting.push(
        this.job.ask('connector', title, q.reason, { connector: q.name, url: FACTORY_CONNECTORS_URL }).then((r) => {
          if (r.status !== 'approved') return `The user did not connect ${q.name}.`
          workflows.update(this.wfId, (wf) => void (wf.connectors = [...new Set([...wf.connectors, q.name])]))
          if (/gmail|google/i.test(q.name) && gmail.connectedAccount()) {
            return `The user connected Gmail (${gmail.connectedAccount()}). Explore it with the gmail_search tool; in workflow.mjs use ll.gmail.search.`
          }
          if (/gmail|google/i.test(q.name)) {
            return `Gmail is connected through Factory. Explore it with the gmail__ connector tools (ToolSearch "select:gmail__list_messages,gmail__get_message_text"; read only); in workflow.mjs use ll.gmail.search, which reaches the same mailbox.`
          }
          return `The user connected ${q.name}. Its connector tools are available to you (search for them by name if they are deferred).`
        }),
      )
    } else {
      workflows.update(this.wfId, (wf) => {
        wf.plan = q.plan
        if (q.plan.name?.trim()) wf.title = q.plan.name.trim()
      })
      this.waiting.push(
        this.job.ask('plan', 'Review the plan', q.plan.summary, { plan: q.plan }).then((r) =>
          r.status === 'approved'
            ? `The user approved the plan.${r.feedback ? ` Their note: ${r.feedback}` : ''} Now write workflow.mjs.`
            : `The user wants changes to the plan: ${r.feedback || '(no reason given)'}. Revise it and call propose_plan again.`,
        ),
      )
    }
  }

  waitingFor = (): Set<string> => this.apps

  /** The agent has ended its turn and waits on the user: bring the app forward. */
  needsYou(): void {
    needAttention(this.job, 'questions')
  }

  /** droid's AskUser: shown as a card; the agent's call waits for the answer. */
  askUser = async (asked: AskUserQuestion[]): Promise<string[] | null> => {
    const title = asked.length === 1 ? asked[0].topic || 'A question' : `${asked.length} questions`
    const answer = this.job.ask('question', title, asked[0]?.question ?? '', { questions: asked })
    needAttention(this.job, 'question')
    const r = await answer
    if (r.status !== 'approved') return null
    try {
      const answers = JSON.parse(r.feedback) as string[]
      return asked.map((_, i) => String(answers[i] ?? ''))
    } catch {
      return asked.map(() => r.feedback)
    }
  }

  get pending(): boolean {
    return this.waiting.length > 0
  }

  /** Wait until the user has answered everything asked so far. */
  async answers(): Promise<string> {
    return (await Promise.all(this.waiting.splice(0))).join('\n')
  }
}

/** Send a prompt, then keep resuming the agent with the user's answers until it asks nothing more. */
async function converse(agent: Agent, questions: Questions | null, prompt: string, images?: ReturnType<typeof attachments>): Promise<void> {
  await agent.send(prompt, { images })
  for (let i = 0; questions?.pending && i < MAX_EXCHANGES; i++) {
    questions.needsYou()
    const answers = await questions.answers()
    await agent.send(`${answers}\n\nContinue where you left off.`)
  }
}

function toolContext(job: Job, allowed: Map<string, AllowedApp>, questions: Questions | null) {
  return {
    emit: job.emit,
    allowed,
    saveShot: job.saveShot,
    jobId: job.id,
    ...(questions ? { ask: questions.ask, waitingFor: questions.waitingFor } : {}),
  }
}

function makeAgent(name: string, job: Job, workspace: string, ctx: ReturnType<typeof toolContext>, questions: Questions | null) {
  const agent = new Agent({
    name,
    emit: job.emit,
    scope: { scratch: workspace, servers: [SERVER], toolFilter: readOnlyConnectorTools, askUser: Boolean(questions) },
    askUser: questions?.askUser,
    mcpServers: [computerServer(ctx)],
    onAuthRequired: ({ serverName, authUrl, message }) => {
      void job.ask('connector', `Sign in to ${serverName}`, message, { connector: serverName, url: authUrl })
    },
    done: () => existsSync(join(workspace, workflows.SCRIPT)),
    gate: job.whenRunning,
    paused: () => job.paused,
  })
  job.onStop(() => agent.close())
  return agent
}

/** Start building a workflow from the user's goal. Returns the build job at once. */
export function startBuild(goal: string): { workflow: workflows.Workflow; job: Job } {
  const wf = workflows.create(goal)
  const job = newJob('build', wf.id)
  workflows.update(wf.id, (w) => void (w.build_job = job.id))
  void build(wf.id, job)
  return { workflow: workflows.get(wf.id)!, job }
}

async function build(wfId: string, job: Job): Promise<void> {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), `retronaut-${wfId}-`)))
  const allowed = new Map<string, AllowedApp>()
  const questions = new Questions(job, wfId, allowed)
  const agent = makeAgent('Builder', job, workspace, toolContext(job, allowed, questions), questions)
  let outcome: ScriptOutcome | null = null
  try {
    provideRuntime(workspace)
    const wf = workflows.get(wfId)!
    job.emit('info', 'Building your workflow', wf.goal)
    await converse(agent, questions, BUILD.replace('{goal}', wf.goal).replaceAll('{workspace}', workspace))

    if (job.stopped) throw new Error('stopped')
    if (!existsSync(join(workspace, workflows.SCRIPT))) {
      job.emit('info', 'No workflow.mjs yet', 'asking the builder to write it')
      await converse(agent, questions, 'workflow.mjs is not in the working folder yet. Finish the plan and write it.')
    }
    for (let attempt = 0; attempt <= MAX_FIXES; attempt++) {
      await job.whenRunning() // a test run drives the apps; not while paused
      if (job.stopped) throw new Error('stopped')
      if (!existsSync(join(workspace, workflows.SCRIPT))) break
      job.emit('info', attempt === 0 ? 'Test run' : `Test run ${attempt + 1}`, 'running workflow.mjs for real')
      outcome = await runScript(job, {
        dir: workspace,
        script: workflows.SCRIPT,
        out: join(workspace, `test-${attempt + 1}`),
        state: join(workspace, workflows.STATE),
        test: true,
      })
      if (outcome.ok) break
      if (outcome.failureShot) job.emit('fail', 'Test run failed', outcome.error ?? '', job.saveShot(outcome.failureShot))
      else job.emit('fail', 'Test run failed', outcome.error ?? '')
      if (attempt === MAX_FIXES) break
      job.emit('info', 'Fixing the script', 'sending the failure to the builder')
      await converse(agent, questions, TEST_FAILED.replace('{failure}', describeFailure(outcome)), attachments(outcome))
    }

    if (outcome?.ok) {
      workflows.install(wfId, workspace, 'build')
      workflows.update(wfId, (w) => {
        w.status = 'ready'
        w.apps = [...allowed.values()]
        if (w.plan?.summary) w.note = w.plan.summary
      })
      job.emit('ok', 'Workflow saved', 'it can now run on its own, and heals itself if something changes')
      job.finish('passed', { summary: outcome.summary })
      needAttention(job, 'built')
      workflows.recordRun(job, { summary: outcome.summary })
    } else {
      const error = outcome?.error ?? 'the builder did not write workflow.mjs'
      workflows.update(wfId, (w) => {
        w.status = 'failed'
        w.note = error
      })
      job.emit('fail', 'Needs a human', error)
      job.finish('failed', { error })
      needAttention(job, 'build failed')
      workflows.recordRun(job, { error })
    }
  } catch (e) {
    const error = job.stopped ? 'Stopped by you' : `${(e as Error).name}: ${(e as Error).message}`
    if (!job.stopped) job.emit('error', 'Build crashed', error)
    workflows.update(wfId, (w) => {
      w.status = 'failed'
      w.note = error
    })
    job.finish('error', { error })
    workflows.recordRun(job, { error })
  } finally {
    await agent.close()
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** Run a saved workflow; heal and retry once if a step fails. Returns the job at once. */
export function startRun(wfId: string): Job {
  const wf = workflows.get(wfId)
  if (!wf) throw new RangeError(`no workflow ${wfId}`)
  if (!workflows.script(wfId)) throw new RangeError(`${wf.title} has no script yet`)
  const job = newJob('run', wfId)
  void runAndHeal(wfId, job)
  return job
}

async function runAndHeal(wfId: string, job: Job): Promise<void> {
  const dir = workflows.folder(wfId)
  const state = join(dir, workflows.STATE)
  try {
    job.emit('info', 'Running', workflows.get(wfId)!.title)
    let outcome = await runScript(job, { dir, script: workflows.SCRIPT, out: workflows.runDir(wfId, job.id), state })
    let healed = false
    if (!outcome.ok && outcome.review) {
      job.emit('review', 'Needs your review', outcome.error ?? '')
    } else if (!outcome.ok) {
      job.emit('fail', 'Run failed', outcome.error ?? '', outcome.failureShot ? job.saveShot(outcome.failureShot) : undefined)
      workflows.update(wfId, (w) => void (w.status = 'needs_attention'))
      const fixed = !job.stopped && (await heal(wfId, job, outcome))
      if (fixed) {
        job.emit('info', 'Running the healed script', 'picking up where the failed run stopped')
        outcome = await runScript(job, { dir, script: workflows.SCRIPT, out: join(workflows.runDir(wfId, job.id), 'after-heal'), state })
        healed = outcome.ok
      }
    }
    if (job.stopped) {
      workflows.update(wfId, (w) => void (w.status = 'ready'))
      workflows.recordRun(job, { error: 'Stopped by you' })
    } else if (outcome.ok) {
      workflows.update(wfId, (w) => {
        w.status = 'ready'
        if (healed) w.heals += 1
      })
      job.emit('ok', healed ? 'Done, after healing' : 'Done', outcome.summary ? JSON.stringify(outcome.summary) : '')
      job.finish('passed', { summary: outcome.summary, healed })
      workflows.recordRun(job, { summary: outcome.summary, healed })
    } else {
      workflows.update(wfId, (w) => {
        w.status = 'needs_attention'
        w.note = outcome.error ?? ''
      })
      if (!outcome.review) job.emit('fail', 'Needs a human', outcome.error ?? '')
      job.finish('failed', { error: outcome.error, review: outcome.review })
      needAttention(job, outcome.review ? 'needs review' : 'run failed')
      workflows.recordRun(job, { error: outcome.error })
    }
  } catch (e) {
    const error = job.stopped ? 'Stopped by you' : `${(e as Error).name}: ${(e as Error).message}`
    if (!job.stopped) job.emit('error', 'Run crashed', error)
    job.finish('error', { error })
    workflows.recordRun(job, { error })
  }
}

/** A healing session on a copy of the workflow; installs the fix if the agent made one. */
async function heal(wfId: string, job: Job, outcome: ScriptOutcome): Promise<boolean> {
  const wf = workflows.get(wfId)!
  const dir = workflows.folder(wfId)
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), `retronaut-heal-${wfId}-`)))
  const allowed = new Map(wf.apps.map((a) => [a.app.toLowerCase(), a]))
  const agent = makeAgent('Healer', job, workspace, toolContext(job, allowed, null), null)
  try {
    copyFileSync(join(dir, workflows.SCRIPT), join(workspace, workflows.SCRIPT))
    if (existsSync(join(dir, workflows.STATE))) copyFileSync(join(dir, workflows.STATE), join(workspace, workflows.STATE))
    provideRuntime(workspace)
    const before = readFileSync(join(workspace, workflows.SCRIPT), 'utf8')
    job.emit('info', 'Healing', 'an agent is looking at what changed')
    const prompt = HEAL.replace('{goal}', wf.goal)
      .replace('{plan}', describePlan(wf.plan))
      .replace('{failure}', describeFailure(outcome))
      .replaceAll('{workspace}', workspace)
      .replace('{apps}', wf.apps.map((a) => a.app).join(', ') || 'none')
    await agent.send(prompt, { images: attachments(outcome) })
    const after = readFileSync(join(workspace, workflows.SCRIPT), 'utf8')
    if (after === before) {
      job.emit('fail', 'Healer made no change', 'the failure may need a human')
      return false
    }
    // state.json comes along: if the healer ran the script, what it handled really happened.
    workflows.install(wfId, workspace, 'heal')
    job.emit('ok', 'Script healed', 'the fix is saved; the earlier version is kept in history/')
    return true
  } finally {
    await agent.close()
    rmSync(workspace, { recursive: true, force: true })
  }
}
