"""HTTP API: POST /connect starts a run in the background, GET /events reports it."""

import asyncio
from decimal import Decimal
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

import apps
import discover
import ledger
import pipeline
import query

app = FastAPI(title="Local Link runner")
_tasks: set[asyncio.Task] = set()


class ConnectBody(BaseModel):
    app: str = Field(min_length=1)
    data_path: str = Field(min_length=1)
    allow_ui: bool = False  # let the agent drive the app's UI from the first attempt


@app.post("/connect", status_code=202)
async def connect(body: ConnectBody) -> dict:
    run = pipeline.new_run(body.app, body.data_path, body.allow_ui)
    task = asyncio.create_task(pipeline.execute(run))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"run_id": run.id}


@app.get("/events")
def events(run_id: str | None = None, after: int = 0) -> dict:
    run = pipeline.RUNS.get(run_id) if run_id else pipeline.latest_run()
    if run is None:
        raise HTTPException(404, "no such run" if run_id else "no runs yet")
    return run.snapshot(after)


@app.get("/apps")
def get_apps() -> dict:
    """Apps installed on this machine, for the dashboard's app picker."""
    return {"apps": apps.scan()}


@app.get("/apps/data")
def get_app_data(path: str) -> dict:
    """Likely data files for one installed app; the user confirms one before a run."""
    return {"candidates": discover.candidates(path)}


@app.get("/ledgers")
def get_ledgers() -> dict:
    """One ledger per source (app + data path), most recently loaded first."""
    return {"ledgers": ledger.list_ledgers()}


DATE = r"^\d{4}-\d{2}-\d{2}$"


def _db(ledger_id: str):
    try:
        return query.existing(ledger_id)
    except query.NotFound as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/ledger")
def get_ledger(
    ledger_id: str,
    account: str | None = None,
    search: str | None = None,
    date_from: str | None = Query(None, alias="from", pattern=DATE),
    date_to: str | None = Query(None, alias="to", pattern=DATE),
    min_amount: Decimal | None = Query(None, alias="min"),
    max_amount: Decimal | None = Query(None, alias="max"),
    side: Literal["debit", "credit"] | None = None,
    run_id: str | None = None,
    limit: int = Query(1000, ge=0, le=5000),
    offset: int = Query(0, ge=0),
) -> dict:
    """A ledger's rows, filtered: account (and its subaccounts), search (memo, account or
    source contains), from/to (inclusive dates), min/max (amount), side, run_id.
    `total` counts all matches; `provenance` says which file and runs they came from."""
    db = _db(ledger_id)
    rows, total = ledger.query_rows(
        db, account=account, search=search, date_from=date_from, date_to=date_to,
        min_amount=min_amount, max_amount=max_amount, side=side, run_id=run_id,
        limit=limit, offset=offset,
    )
    return {
        "ledger_id": ledger_id,
        "total": total,
        "rows": rows,
        "provenance": query.provenance(db, {r["run_id"] for r in rows}),
    }


@app.get("/ledgers/{ledger_id}/balances")
def get_balances(
    ledger_id: str, account: str | None = None, as_of: str | None = Query(None, pattern=DATE)
) -> dict:
    """Debits, credits and balance per account, as of a date (inclusive)."""
    return {"ledger_id": ledger_id, "as_of": as_of, "accounts": ledger.balances(_db(ledger_id), account=account, as_of=as_of)}


@app.get("/ledgers/{ledger_id}/changes")
def get_changes(
    ledger_id: str,
    since_run: str | None = None,
    since: float | None = None,
    run_id: str | None = None,
    change: Literal["added", "changed", "deleted"] | None = None,
    limit: int = Query(1000, ge=1, le=5000),
) -> dict:
    """What loads added, changed or deleted, newest first: after a run (since_run), after
    a Unix time (since), or by one run (run_id)."""
    db = _db(ledger_id)
    if since_run:
        try:
            since = query.since_run(db, since_run)
        except query.NotFound as e:
            raise HTTPException(404, str(e)) from e
    return {
        "ledger_id": ledger_id,
        "since": since,
        "changes": ledger.changes(db, run_id=run_id, change=change, since=since, limit=limit),
    }


@app.get("/ledgers/{ledger_id}/runs")
def get_runs(ledger_id: str, limit: int = Query(100, ge=1, le=1000)) -> dict:
    """Every run on this source and how it ended (passed, needs_human, error)."""
    return {"ledger_id": ledger_id, "runs": ledger.runs(_db(ledger_id), limit=limit)}


@app.get("/ledgers/{ledger_id}/flags")
def get_flags(ledger_id: str) -> dict:
    """What needs a human: failed runs with the checker's reasons, and suspense-type
    accounts that don't net to zero."""
    return {"ledger_id": ledger_id, **query.flags(_db(ledger_id))}


@app.get("/ledgers/{ledger_id}/monthly")
def get_monthly(
    ledger_id: str,
    by: Literal["account", "payee"] = "account",
    account: str | None = None,
    depth: int | None = Query(None, ge=0),
    date_from: str | None = Query(None, alias="from", pattern=DATE),
    date_to: str | None = Query(None, alias="to", pattern=DATE),
) -> dict:
    """Debits, credits and net per month, by account (cut to `depth` levels) or by payee (memo)."""
    rollup = query.monthly(_db(ledger_id), by, account, depth, date_from, date_to)
    return {"ledger_id": ledger_id, "by": by, "months": rollup}


class SqlBody(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(500, ge=1, le=1000)


@app.post("/ledgers/{ledger_id}/sql")
def post_sql(ledger_id: str, body: SqlBody) -> dict:
    """One read-only SELECT against the ledger's tables: ledger, ledger_changes,
    ledger_source, runs. Anything else is refused with 400."""
    try:
        return query.run_sql(_db(ledger_id), body.query, body.limit)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/reset")
def reset() -> dict:
    """Testing aid: clear the ledger, its change history, saved extractors and runs."""
    if pipeline.any_running():
        raise HTTPException(409, "a run is in progress; wait for it to finish")
    pipeline.reset()
    return {"cleared": True}
