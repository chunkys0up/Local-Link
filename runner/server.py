"""HTTP API: POST /connect starts a run in the background, GET /events reports it."""

import asyncio

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import ledger
import pipeline

app = FastAPI(title="Local Link runner")
_tasks: set[asyncio.Task] = set()


class ConnectBody(BaseModel):
    app: str = Field(min_length=1)
    data_path: str = Field(min_length=1)


@app.post("/connect", status_code=202)
async def connect(body: ConnectBody) -> dict:
    run = pipeline.new_run(body.app, body.data_path)
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


@app.get("/ledger")
def get_ledger(limit: int = 1000) -> dict:
    return {"rows": ledger.all_rows(limit)}


@app.post("/reset")
def reset() -> dict:
    """Testing aid: clear the ledger, its change history, saved extractors and runs."""
    if pipeline.any_running():
        raise HTTPException(409, "a run is in progress; wait for it to finish")
    pipeline.reset()
    return {"cleared": True}
