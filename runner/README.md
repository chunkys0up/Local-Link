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
curl localhost:8000/ledgers                # one ledger per source (app + data path)
curl "localhost:8000/ledger?ledger_id=<id>" # that ledger's rows
curl -X POST localhost:8000/reset          # testing: clear ledger, change history, saved extractors
```

- `rows.py`: the normalized row every extractor must output. `source` is a stable ID from
  the app, used to match rows between loads.
- `checker.py`: rows exist, debits = credits, source IDs unique, no money left in
  suspense-type accounts.
- `layout.py`: fingerprint of the data's structure (SQLite tables/columns, XML element
  paths, CSV headers, JSON keys). A saved extractor is only reused while it's unchanged.
- `agent.py`: Droid session in its own temp folder outside the project (deleted after the
  run). Writes only there; commands only if read-only or running a `.py` from that folder.
- `pipeline.py`: saved extractor (if the layout matches) or agent → checker → one repair →
  `needs_human`, or diff into the ledger.
- `ledger.py`: one SQLite file per source in `ledgers/<app>-<path hash>.db`, keyed on
  (app, source), plus `ledger_changes` history. Saved extractors stay per app in `cache/`.
- Data persists across restarts; use `/reset` (or the dashboard's Clear data) to start over.
