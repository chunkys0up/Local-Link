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
4. Tests change real data, so while exploring the builder also works out how this app's data
   is backed up and restored, writes `backup.mjs` and `restore.mjs`, and tests the round trip.
   The method depends on the app: copying its data files with `ll.backup.save` / `restore`
   (quitting and reopening the app around a restore when it holds the file open), the app's
   own backup feature through its menus, or a lossless export and re-import. The plan says
   which; "none" means tests run with no undo, and the user approves that knowingly. The
   policy refuses `node workflow.mjs` until both scripts exist.
5. The engine backs up, test-runs the script (`executor.ts`), and on a failure restores the
   backup (and `state.json`) before the failure goes back to the builder with the failing step
   and a screenshot, up to twice. Nothing is repaired by hand. A passing script is installed
   with its backup scripts, which healing sessions use to undo their own attempts.

Runs: `POST /workflows/:id/run`. A failed step starts a healing agent on a copy of the script,
with the failure, its screenshot, the plan and `state.json`; its fix is installed (the old one
kept in `history/`) and the run picks up again.

Gmail goes through Factory's managed connector: connect it in the Factory app (Settings ›
Connectors) with the account behind `FACTORY_API_KEY`. The engine reaches it with one
read-only droid turn per search (structured output).

Optionally, Retronaut can also read Gmail directly (`gmail.ts`): IMAP with a Google app
password, checked against Gmail and kept in the macOS keychain. There is no UI for it; while
the app is running:

```bash
curl -X POST localhost:8000/connectors/gmail -H 'Content-Type: application/json' \
  -d '{"email": "you@gmail.com", "app_password": "abcd efgh ijkl mnop"}'
curl localhost:8000/connectors                       # which address is connected
curl -X DELETE localhost:8000/connectors/gmail       # forget it
```

With it, searches return exact message bodies in a second or two, with no agent involved,
and the builder explores with the `gmail_search` tool. Scripts call `ll.gmail.search` either
way; the engine (`POST /connectors/gmail/search`) uses the direct connection when there is one.

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
