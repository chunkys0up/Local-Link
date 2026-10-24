"""One connect run: cached scripts or agent, then checker, one repair, then ledger."""

import asyncio
import json
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import ValidationError

import ledger
from agent import run_agent
from checker import CheckResult, check, money
from rows import NormalizedRow, Reference

ROOT = Path(__file__).parent
SCRATCH_DIR = ROOT / "scratch"
CACHE_DIR = ROOT / "cache"
SCRIPTS = ("extract.py", "reference.py")
SCRIPT_TIMEOUT_SECONDS = 120


@dataclass
class Run:
    id: str
    app: str
    data_path: str
    status: str = "running"  # running | passed | needs_human | error
    events: list[dict] = field(default_factory=list)
    gap: list[str] = field(default_factory=list)
    rows_loaded: int | None = None
    used_cache: bool = False

    def emit(self, kind: str, label: str, detail: str = "") -> None:
        self.events.append(
            {"i": len(self.events), "ts": time.time(), "kind": kind, "label": label, "detail": detail}
        )

    def snapshot(self, after: int = 0) -> dict:
        return {
            "run_id": self.id,
            "app": self.app,
            "data_path": self.data_path,
            "status": self.status,
            "gap": self.gap,
            "rows_loaded": self.rows_loaded,
            "used_cache": self.used_cache,
            "events": self.events[after:],
        }


RUNS: dict[str, Run] = {}


def new_run(app: str, data_path: str) -> Run:
    run = Run(id=f"run_{uuid.uuid4().hex[:8]}", app=app, data_path=data_path)
    RUNS[run.id] = run
    return run


def latest_run() -> Run | None:
    return next(reversed(RUNS.values()), None)


def slug(app: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", app.lower()).strip("-") or "app"


def _run_script(script: Path, data_path: Path) -> object:
    proc = subprocess.run(
        [sys.executable, script.name, str(data_path)],
        cwd=script.parent,
        capture_output=True,
        text=True,
        timeout=SCRIPT_TIMEOUT_SECONDS,
    )
    if proc.returncode != 0:
        tail = proc.stderr.strip().splitlines()[-5:]
        raise RuntimeError(f"{script.name} exited {proc.returncode}: {' | '.join(tail)}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{script.name} did not print valid JSON: {e}") from e


def evaluate(run: Run, scratch: Path, data_path: Path) -> tuple[CheckResult, list[NormalizedRow]]:
    """Run the scratch scripts and check their output."""
    missing = [s for s in SCRIPTS if not (scratch / s).exists()]
    if missing:
        return CheckResult(False, [f"missing script: {s}" for s in missing]), []

    try:
        raw_rows = _run_script(scratch / "extract.py", data_path)
        if not isinstance(raw_rows, list):
            raise RuntimeError("extract.py must print a JSON array")
        rows = [NormalizedRow.model_validate({**r, "run_id": run.id}) for r in raw_rows]
        run.emit("info", "Extractor produced rows", f"{len(rows)} rows")

        reference = Reference.model_validate(_run_script(scratch / "reference.py", data_path))
        run.emit(
            "info",
            "Reference total from the app",
            f"{reference.row_count} rows · debits {money(reference.total_debits)}"
            f" · credits {money(reference.total_credits)}",
        )
    except (RuntimeError, subprocess.TimeoutExpired, ValidationError, TypeError) as e:
        message = " ".join(str(e).split())[:500]
        run.emit("fail", "Scripts failed", message)
        return CheckResult(False, [message]), []

    result = check(rows, reference)
    if result.passed:
        run.emit("ok", "Checker passed", f"debits = credits · {len(rows)} rows · totals match")
    else:
        run.emit("fail", "Checker failed", "; ".join(result.differences))
    return result, rows


def _finish_pass(run: Run, scratch: Path, rows: list[NormalizedRow]) -> None:
    cache = CACHE_DIR / slug(run.app)
    cache.mkdir(parents=True, exist_ok=True)
    for name in SCRIPTS:
        shutil.copy2(scratch / name, cache / name)
    run.rows_loaded = ledger.load(run.app, rows)
    run.status = "passed"
    run.emit("ok", "Loaded into ledger", f"{run.rows_loaded} rows → ledger.db")


async def execute(run: Run) -> None:
    try:
        data_path = Path(run.data_path).expanduser().resolve()
        if not data_path.exists():
            raise FileNotFoundError(f"data path does not exist: {data_path}")
        scratch = SCRATCH_DIR / run.id
        scratch.mkdir(parents=True)
        run.emit("info", "Connect requested", f"app={run.app} · data={data_path} · run={run.id}")

        error: list[str] | None = None
        cache = CACHE_DIR / slug(run.app)
        if all((cache / s).exists() for s in SCRIPTS):
            for name in SCRIPTS:
                shutil.copy2(cache / name, scratch / name)
            run.emit("info", "Using cached scripts", f"from cache/{slug(run.app)}, skipping the agent")
            result, rows = await asyncio.to_thread(evaluate, run, scratch, data_path)
            if result.passed:
                run.used_cache = True
                _finish_pass(run, scratch, rows)
                return
            run.emit("info", "Cached scripts broke", "falling back to the agent")
            error = result.differences

        for attempt in (1, 2):
            label = "Agent session started" if attempt == 1 else "Repair: rerunning agent with the error"
            run.emit("info", label, f"read-only: {data_path} · write: {scratch}")
            try:
                await run_agent(run.app, data_path, scratch, run.emit, error)
            except Exception as e:  # still check whatever scripts it left behind
                run.emit("error", "Agent session crashed", f"{type(e).__name__}: {e}")
            result, rows = await asyncio.to_thread(evaluate, run, scratch, data_path)
            if result.passed:
                _finish_pass(run, scratch, rows)
                return
            error = result.differences

        run.status = "needs_human"
        run.gap = error or []
        run.emit("fail", "Needs human", "still failing after one repair; nothing loaded")
    except Exception as e:  # surface anything unexpected to the dashboard
        run.status = "error"
        run.gap = [f"{type(e).__name__}: {e}"]
        run.emit("error", "Run crashed", run.gap[0])
