# runner

Connects a local accounting app: a Droid agent writes `extract.py`, the checker
verifies its rows, and each load is diffed into that source's ledger as added / changed / deleted.

```bash
uv sync
uv run pytest                                              # checker, ledger diff, layout, policy tests
uv run --env-file ../.env uvicorn server:app --port 8000   # API (needs FACTORY_API_KEY in ../.env)
```

```bash
curl -X POST localhost:8000/connect -H 'Content-Type: application/json' \
  -d '{"app": "gnucash", "data_path": "/path/to/books.gnucash"}'   # -> {"run_id": ...}
curl "localhost:8000/events?run_id=<id>"   # steps so far, status, and the load's changes
curl localhost:8000/apps                   # installed Mac apps: name, bundle ID, version, kind
curl "localhost:8000/apps/data?path=/Applications/Gnucash.app"  # likely data files for one app
curl localhost:8000/ledgers                # one ledger per source (app + data path)
curl "localhost:8000/ledger?ledger_id=<id>" # that ledger's rows (filters below)
curl -X POST localhost:8000/reset          # testing: clear ledger, change history, saved extractors
```

- `rows.py`: the normalized row every extractor must output. `source` is a stable ID from
  the app, used to match rows between loads.
- `checker.py`: rows exist, debits = credits, source IDs unique, no money left in
  suspense-type accounts.
- `apps.py`: scans /Applications (and subfolders like Utilities); reads each Info.plist and tags the app as electron, qt, gtk, java or native.
- `discover.py`: likely data files for a picked app (paths in its preferences plist,
  Spotlight hits for file types it opens, Application Support and its container). The
  user confirms one; only that path goes to the agent.
- `layout.py`: fingerprint of the data's structure (SQLite tables/columns, XML element
  paths, CSV headers, JSON keys). A saved extractor is only reused while it's unchanged.
- `agent.py`: Droid session in its own temp folder outside the project (deleted after the
  run). Writes only there; commands only if read-only or running a `.py` from that folder.
- `pipeline.py`: saved extractor (if the layout matches) or agent → checker → one repair →
  `needs_human`, or diff into the ledger.
- `ledger.py`: one SQLite file per source in `ledgers/<app>-<path hash>.db`, keyed on
  (app, source), plus `ledger_changes` history. Saved extractors stay per app in `cache/`.
- Data persists across restarts; use `POST /reset` to start over.

## UI automation

The last rung, for data the agent can't read directly. On the repair attempt (or from the
start with `"allow_ui": true` on `/connect`, the dashboard's "Allow UI automation" box)
the agent may also run, one at a time:

- `osascript -e ...` that only targets the picked app, or `System Events` process of that
  app. No `do shell script`, script files, other apps, or file/delete commands.
- `screencapture` into the run's temp folder.
- `cliclick` if installed (not `-f`).

Each allowed UI command shows in the run's events as a "UI action". macOS needs the
terminal running uvicorn to have Accessibility and Screen Recording (System Settings >
Privacy & Security), and asks once to let it control the app and System Events.
GTK apps like GnuCash expose only their menu bar to AppleScript, so the agent is told to
use the app's own Export menu and keystrokes. This narrows what droid can run; it isn't a
sandbox, since a `.py` it writes in its folder can still call anything.

## Writing back

`POST /ledgers/<id>/writes` with `{"transactions": [{"date", "description", "splits":
[{"account", "amount", "side", "memo"}]}]}` adds transactions to that ledger's source data.
Nothing touches your file until you call `POST /writes/<write_id>/apply`.

1. A writer agent gets a copy of the data and the rules in `agent.WRITE`. It goes down a
   fixed list and takes the first method that works: the app's own API or CLI, then the
   app's importer run without its UI, then writing the open file format itself (mirroring
   an existing transaction, add only, atomic, lock respected), then UI automation (only
   with `"allow_ui": true`). If none is safe it says so (`no_method`) instead of guessing.
   It writes `write.py` and `method.json` (method, why it skipped the ones above it, the
   app's process names and lock files).
2. The runner proves `write.py` on a fresh copy with the app's saved extractor: extract,
   write, extract again. The only difference allowed is one new row per split; existing
   rows unchanged; the checker still passes if it passed before. Then `ready`.
3. Apply refuses if the data changed since, the app is running or a lock file exists.
   It backs the data up to `backups/`, writes, and runs the same proof on the real file;
   any mismatch restores the backup (`needs_human`). Then the ledger reloads.

Every write is logged in `backups/writes.jsonl`. The writer is cached per app like the
extractor, but always re-proven on a copy first. Needs a saved extractor, so connect the
app before writing.

## Querying

Every query is read-only. Filters combine and are all optional; `account` includes its
subaccounts, dates are inclusive `YYYY-MM-DD`.

```bash
L=<ledger id from /ledgers>
curl "localhost:8000/ledger?ledger_id=$L&account=Expenses&search=staples&from=2026-06-01&to=2026-06-30&min=10&max=500&side=debit"
                                                       # rows + total + provenance (file, runs, checker)
curl "localhost:8000/ledgers/$L/balances?as_of=2026-09-30"           # per account, as of a date
curl "localhost:8000/ledgers/$L/changes?since_run=<run id>"          # added / changed / deleted after a run
curl "localhost:8000/ledgers/$L/runs"                                # every run on this source and its outcome
curl "localhost:8000/ledgers/$L/flags"                               # needs-human runs with reasons, suspense balances
curl "localhost:8000/ledgers/$L/monthly?account=Expenses&depth=1"    # per month per account
curl "localhost:8000/ledgers/$L/monthly?by=payee&from=2026-06-01"    # per month per payee (memo)
curl -X POST "localhost:8000/ledgers/$L/sql" -H 'Content-Type: application/json' \
  -d '{"query": "select account, count(*) from ledger group by account"}'  # one SELECT, read-only
```

Run outcomes are kept in each ledger's `runs` table, so provenance and flags survive restarts.
Runs from before this change only show up through their changes.
