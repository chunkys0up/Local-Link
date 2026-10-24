# runner

Connects a local accounting app: a Droid agent writes `extract.py` + `reference.py`,
the checker verifies them, and passing rows load into `ledger.db`.

```bash
uv sync
uv run pytest                                              # checker + permission policy tests
uv run --env-file ../.env uvicorn server:app --port 8000   # API (needs FACTORY_API_KEY in ../.env)
```

```bash
curl -X POST localhost:8000/connect -H 'Content-Type: application/json' \
  -d '{"app": "gnucash", "data_path": "/path/to/books.gnucash"}'   # -> {"run_id": ...}
curl "localhost:8000/events?run_id=<id>"   # steps so far + status; omit run_id for the latest run
curl localhost:8000/ledger                 # loaded rows
```

- `rows.py`: the normalized row every extractor must output, and the reference-total shape.
- `checker.py`: debits = credits, row count, totals vs reference, nonzero suspense-like accounts.
- `agent.py`: Droid session. Each run works in its own temp folder outside the project
  (deleted when the run ends); writes are allowed only there, and commands only if
  read-only or running a `.py` from that folder. Everything else is refused.
- `pipeline.py`: cached scripts → agent → checker → one repair → `needs_human` or load.
- `ledger.py`: SQLite ledger; a passing run replaces that app's rows.
- Working scripts are cached in `cache/<app>/`; delete that folder to force the agent.
