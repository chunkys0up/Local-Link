# Retronaut (desktop)

One Electron app: describe a workflow in a chat box, and an agent explores your local apps and
online accounts, proposes a plan, writes `workflow.mjs`, test-runs it, and saves it. Saved
workflows run with no agent; when a step fails, a healing agent fixes the script and the run
continues.

```bash
npm install
npm run dev        # vite + esbuild watch + Electron
npm test           # vitest: checker, ledger, layout, policy, API, apps, discover, executor, jobs
npm run typecheck
npm run build && npm start   # the built app (the engine serves the UI itself)
npm run engine     # the engine alone on 127.0.0.1:8000, for curl
npm run demo:book  # (re)write the demo GnuCash book: ~/Documents/Local Link Demo/northwind.gnucash
npm run demo:reset # between run-throughs: a fresh book, and saved workflows forget earlier runs
```

Needs the `droid` CLI on PATH (or in `~/.local/bin`) and `FACTORY_API_KEY` in the repo's
`.env`. macOS asks for **Accessibility** (clicks, keys, menus) and **Screen Recording**
(screenshots) for the app that launched Retronaut: in dev that is "Electron". The home
screen shows what's missing, with buttons to the right System Settings panes.

## How a workflow is built (`src/main/builder.ts`)

1. The builder agent (droid, via `@factory/droid-sdk`) gets Retronaut's tools (`tools.ts`):
   `list_apps`, `request_access`, `screenshot` (returns the image), `list_windows`, `ui_tree`,
   `list_menu`, `choose_menu`, `click`, `click_element`, `type_text`, `press_keys`, `propose_plan`.
   Every UI tool checks that the app was allowed by the user and is frontmost.
2. Questions (allow an app, connect an account, approve the plan) never block a tool call:
   droid gives up on a tool after about a minute. The tool queues the question and tells the
   agent to end its turn; the build loop resumes the same session with the user's answer.
3. It writes `workflow.mjs` against `./retronaut.mjs` (`src/runtime/retronaut.ts`): steps, state
   for idempotency, app control, Gmail, file/XML/SQLite helpers.
4. The engine test-runs the script (`executor.ts`); a failure goes back to the builder with the
   failing step and a screenshot, up to twice. A passing script is installed.

Runs: `POST /workflows/:id/run`. A failed step starts a healing agent on a copy of the script,
with the failure, its screenshot, the plan and `state.json`; its fix is installed (the old one
kept in `history/`) and the run picks up again.

Gmail is Retronaut's own connection (`gmail.ts`): IMAP with a Google app password, checked
against Gmail when connected and kept in the macOS keychain (connect it on the home screen,
or when the builder asks). Searches use Gmail's query syntax and return exact message bodies,
with no agent involved. The builder explores with the `gmail_search` tool; scripts call
`ll.gmail.search`, which goes through the engine (`POST /connectors/gmail/search`).
Without that connection the engine falls back to Factory's managed connector (one read-only
droid turn with structured output), which only works if the connector is connected for the
user and organization behind `FACTORY_API_KEY`.

When the builder hits something ambiguous it asks with droid's AskUser; the questions show
up as a card. Healing sessions have no one to ask, so AskUser is refused there.

## Policy (`src/main/policy.ts`)

Writes only inside the session's own temp folder. Commands only if droid rates them read-only,
or `node <script>.mjs` for a script in that folder. Shell UI commands (osascript, screencapture,
cliclick) are refused in favour of Retronaut's tools. Connector tools may only read. Like the
Python runner's policy, this narrows what droid runs; it isn't a sandbox, since a script it
writes can call anything.

## API

The routes of the Python runner (`/connect`, `/events`, `/apps`, `/ledgers`, `/ledger`,
`/ledgers/:id/...`, `/reset`; see `../runner/README.md`), plus `/health`, `/workflows`,
`/workflows/:id`, `/workflows/:id/run`, `/jobs/:id`, `/jobs/:id/requests/:request`,
`/jobs/:id/stop`. Everything also answers under `/api`. Requests from other sites' pages
(any other `Origin`) are refused, and POST bodies must be JSON.

State lives in `~/Library/Application Support/Retronaut` (`RETRONAUT_DATA` overrides).
Retronaut was called Local Link: on first start it moves `…/Local Link` there, and a Gmail
app password saved under the old name moves to the new keychain entry when first used.
Scripts written before the rename (`./locallink.mjs`, `LOCAL_LINK_*`) keep working.

## Demo

Before each run-through: quit GnuCash, `npm run demo:reset`, then reopen the book in GnuCash
(File › Open Recent). The reset refuses while GnuCash has the book open or Retronaut is
building or running. It keeps saved workflows and their run history; it only clears what
they remember having handled (`state.json`), so the next run creates the invoices again.

`demo/work-orders.json` has five work-order emails (two share WO-1042), and one to send live.
Expected invoices: WO-1042 Acme $419.20, WO-1043 Brightside $344.50, WO-1044 Harbor View
$423.49, WO-1045 Acme $691.20; live WO-1046 Brightside $264.00.
