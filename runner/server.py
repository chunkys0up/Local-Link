"""HTTP API: POST /connect starts a run in the background, GET /events reports it."""

import asyncio
import logging
import shutil
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import ledger
import pipeline

log = logging.getLogger("uvicorn.error")


def reset_state() -> None:
    """Start every runner session clean: empty ledger, no cached scripts."""
    ledger.DB_PATH.unlink(missing_ok=True)
    shutil.rmtree(pipeline.CACHE_DIR, ignore_errors=True)
    log.info("Cleared %s and %s/", ledger.DB_PATH.name, pipeline.CACHE_DIR.name)


@asynccontextmanager
async def lifespan(_: FastAPI):
    reset_state()
    yield


app = FastAPI(title="Local Link runner", lifespan=lifespan)
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
