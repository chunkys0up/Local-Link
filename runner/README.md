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
