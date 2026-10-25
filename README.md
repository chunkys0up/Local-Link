# Retronaut

Retronaut automates finance workflows in local and legacy apps that have no API.
You describe a workflow in plain English. An agent then explores the apps involved
(their data files, menus, keyboard shortcuts, accessibility tree, and screenshots
with clicks) and proposes a plan for you to approve. Once approved, it writes a
reusable script, tests it and saves it. If a later run breaks, a healing agent
repairs the script.

The first target is **GnuCash on macOS**. The demo workflow turns work orders
emailed to a Gmail inbox into posted invoices in a GnuCash book.

> The repo is still named `Local-Link`, the project's original name.

## Repository layout

| Path         | What it is |
|--------------|------------|
| `desktop/`   | **The app.** An Electron + React app (TypeScript) that also runs the local engine. Builds use the [Factory Droid SDK](https://factory.ai). |
| `runner/`    | Python prototype of the engine (FastAPI): extraction, checker, ledger diffs. See [`runner/README.md`](runner/README.md). |
| `dashboard/` | React UI for the Python runner. See [`dashboard/README.md`](dashboard/README.md). |
| `test-data/` | Sample CSV data. |

Most people only need `desktop/`.

## Requirements

- macOS
- Node.js 22 or newer (the app reads `.env` with `process.loadEnvFile`)
- The [Factory `droid` CLI](https://docs.factory.ai) on your `PATH`
  (`droid --version` should work)
- A Factory API key
- [GnuCash](https://www.gnucash.org) installed in `/Applications`, for the demo
- Optional: a Gmail account with IMAP turned on and an
  [app password](https://myaccount.google.com/apppasswords)

## Setup

```bash
git clone https://github.com/chunkys0up/Local-Link.git
cd Local-Link
cp .env.example .env          # then put your key in it: FACTORY_API_KEY="fk-..."
cd desktop
npm install
```

Retronaut reads `FACTORY_API_KEY` from the repo-root `.env` first. If it isn't
there, it falls back to `~/Library/Application Support/Retronaut/.env`.

### macOS permissions

UI automation needs **Accessibility** and **Screen Recording** permission for the
app that runs Retronaut: Electron in development, or Terminal if you run the
engine on its own. Grant both in **System Settings → Privacy & Security**. The
first time Retronaut drives GnuCash, macOS also asks to let it control the app and
System Events. Before your first build, the app's start screen shows which of
these checks pass (droid CLI, API key, permissions, Gmail).

## Running the app

From `desktop/`:

```bash
npm run dev        # Vite + esbuild watch + Electron, with hot reload
```

Or make a production build and run it:

```bash
npm run build
npm start
```

To run only the local engine, with no window (it serves on `127.0.0.1:8000`):

```bash
npm run engine
```

## Using Retronaut

1. **Connect your sources.** Pick a local app (Retronaut lists the apps in
   `/Applications`) and confirm which data file it should use, such as a
   `.gnucash` book. To read email, connect Gmail with your address and an app
   password. The password is kept in the macOS Keychain.
2. **Describe a workflow** in the chat box, for example:
   *"When a work order email arrives, create and post an invoice for that
   customer in GnuCash."*
3. **Review the plan.** The agent explores the apps and shows a plan card. Approve
   it or ask for changes.
4. **Let it build.** The agent writes, tests and saves the script. A full build
   can take around 25 minutes.
5. **Run it.** Saved workflows show up on the home screen. Run one whenever you
   want. If a run fails because the app or the data changed, the healing agent
   fixes the script.

App data (workflows, their scripts, run history, ledgers, connectors) lives in
`~/Library/Application Support/Retronaut/`. Set `RETRONAUT_DATA` to use a
different folder.

## The demo

The demo uses a GnuCash book for a small repair contractor, "Northwind": three
customers, an accounts-receivable account, a few months of history, and no
invoices yet.

```bash
cd desktop
npm run demo:book    # writes ~/Documents/Local Link Demo/northwind.gnucash
npm run demo:reset   # fresh book, and saved workflows forget earlier runs
```

`demo:reset` keeps your workflows, their scripts and run history. It refuses to
run while GnuCash has the book open (quit GnuCash with ⌘Q first) or while
Retronaut is building or running something. Sample work orders are in
`desktop/demo/work-orders.json`.

The demo folder is deliberately still named `Local Link Demo`, because the saved
demo workflow refers to that path.

## Development

From `desktop/`:

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit
```

Useful environment variables:

| Variable          | Default                                     | Purpose |
|-------------------|---------------------------------------------|---------|
| `FACTORY_API_KEY` | (none)                                      | Needed for builds and healing |
| `RETRONAUT_DATA`  | `~/Library/Application Support/Retronaut`   | Where workflows, ledgers and runs are stored |
| `RETRONAUT_PORT`  | `8000`                                      | Port for the local engine API |

For the Python runner, run these from `runner/`:

```bash
uv sync
uv run pytest
uv run --env-file ../.env uvicorn server:app --port 8000
```
