"""One connect run: saved extractor (if the data layout is unchanged) or the agent,
then the checker, one repair, then a row-by-row diff into the ledger."""

import asyncio
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import ValidationError

import layout
import ledger
from agent import SCRIPT, run_agent
from checker import CheckResult, check
from rows import NormalizedRow

ROOT = Path(__file__).parent
CACHE_DIR = ROOT / "cache"
LAYOUT_FILE = "layout.json"
SCRIPT_TIMEOUT_SECONDS = 120
MAX_CHANGES_SHOWN = 500
MAX_LAYOUT_LINES = 6


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
    changes: dict | None = None

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
            "changes": self.changes,
            "events": self.events[after:],
        }


RUNS: dict[str, Run] = {}


def new_run(app: str, data_path: str) -> Run:
    run = Run(id=f"run_{uuid.uuid4().hex[:8]}", app=app, data_path=data_path)
    RUNS[run.id] = run
    return run


def latest_run() -> Run | None:
    return next(reversed(RUNS.values()), None)


def any_running() -> bool:
    return any(run.status == "running" for run in RUNS.values())


def reset() -> None:
    """Testing aid: forget runs, saved extractors, the ledger and its history."""
    RUNS.clear()
    shutil.rmtree(CACHE_DIR, ignore_errors=True)
    ledger.reset()


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


def evaluate(run: Run, workspace: Path, data_path: Path) -> tuple[CheckResult, list[NormalizedRow]]:
    """Run the extractor and check its output."""
    script = workspace / SCRIPT
    if not script.exists():
        return CheckResult(False, [f"missing script: {SCRIPT}"]), []
    try:
        raw_rows = _run_script(script, data_path)
        if not isinstance(raw_rows, list):
            raise RuntimeError(f"{SCRIPT} must print a JSON array")
        rows = [NormalizedRow.model_validate({**r, "run_id": run.id}) for r in raw_rows]
        run.emit("info", "Extractor produced rows", f"{len(rows)} rows in the normalized format")
    except (RuntimeError, subprocess.TimeoutExpired, ValidationError, TypeError) as e:
        message = " ".join(str(e).split())[:500]
        run.emit("fail", "Extractor failed", message)
        return CheckResult(False, [message]), []

    result = check(rows)
    if result.passed:
        run.emit("ok", "Checker passed", f"debits = credits · {len(rows)} rows · source IDs unique")
    else:
        run.emit("fail", "Checker failed", "; ".join(result.differences))
    return result, rows


def _summarize_layout_change(added: list[str], removed: list[str]) -> str:
    lines = [f"+ {a}" for a in added] + [f"− {r}" for r in removed]
    more = len(lines) - MAX_LAYOUT_LINES
    return " · ".join(lines[:MAX_LAYOUT_LINES]) + (f" · …and {more} more" if more > 0 else "")


def _finish_pass(run: Run, workspace: Path, structure: list[str], rows: list[NormalizedRow]) -> None:
    cache = CACHE_DIR / slug(run.app)
    cache.mkdir(parents=True, exist_ok=True)
    shutil.copy2(workspace / SCRIPT, cache / SCRIPT)
    (cache / LAYOUT_FILE).write_text(json.dumps(structure, indent=1))

    changes = ledger.diff(run.app, rows)
    ledger.apply(run.app, run.id, changes)
    counts = {kind: sum(c.change == kind for c in changes) for kind in ("added", "changed", "deleted")}
    run.changes = {**counts, "items": [c.as_dict() for c in changes[:MAX_CHANGES_SHOWN]]}
    run.rows_loaded = len(rows)
    run.status = "passed"
    if changes:
        detail = f"+{counts['added']} added · ~{counts['changed']} changed · −{counts['deleted']} deleted"
    else:
        detail = "no changes since the last load"
    run.emit("ok", "Ledger updated", f"{detail} ({len(rows)} rows now)")


async def execute(run: Run) -> None:
    workspace: Path | None = None
    try:
        data_path = Path(run.data_path).expanduser().resolve()
        if not data_path.exists():
            raise FileNotFoundError(f"data path does not exist: {data_path}")
        # A fresh temp folder outside the project, deleted when the run ends, so the
        # agent never sees the repo or earlier runs' work. Resolve because macOS temp
        # paths sit behind the /var -> /private/var symlink.
        workspace = Path(tempfile.mkdtemp(prefix=f"local-link-{run.id}-")).resolve()
        run.emit("info", "Connect requested", f"app={run.app} · data={data_path} · run={run.id}")

        structure = await asyncio.to_thread(layout.describe, data_path)
        run.emit("info", "Read data layout", f"{len(structure)} structure entries (tables, columns, fields)")

        error: list[str] | None = None
        cache = CACHE_DIR / slug(run.app)
        if (cache / SCRIPT).exists() and (cache / LAYOUT_FILE).exists():
            added, removed = layout.diff(json.loads((cache / LAYOUT_FILE).read_text()), structure)
            if added or removed:
                run.emit("fail", "Data layout changed", _summarize_layout_change(added, removed))
                run.emit("info", "Not trusting the saved extractor", "rewriting it with the agent")
            else:
                shutil.copy2(cache / SCRIPT, workspace / SCRIPT)
                run.emit("info", "Data layout unchanged", f"reusing the saved extractor from cache/{slug(run.app)}")
                result, rows = await asyncio.to_thread(evaluate, run, workspace, data_path)
                if result.passed:
                    run.used_cache = True
                    _finish_pass(run, workspace, structure, rows)
                    return
                run.emit("info", "Saved extractor broke", "falling back to the agent")
                error = result.differences

        for attempt in (1, 2):
            label = "Extractor agent started" if attempt == 1 else "Repair: rerunning the agent with the error"
            run.emit("info", label, f"read-only: {data_path}")
            try:
                await run_agent(run.app, data_path, workspace, run.emit, error)
            except Exception as e:  # still check whatever script it left behind
                run.emit("error", "Extractor agent session crashed", f"{type(e).__name__}: {e}")
            result, rows = await asyncio.to_thread(evaluate, run, workspace, data_path)
            if result.passed:
                _finish_pass(run, workspace, structure, rows)
                return
            error = result.differences

        run.status = "needs_human"
        run.gap = error or []
        run.emit("fail", "Needs human", "still failing after one repair; nothing loaded")
    except Exception as e:  # surface anything unexpected to the dashboard
        run.status = "error"
        run.gap = [f"{type(e).__name__}: {e}"]
        run.emit("error", "Run crashed", run.gap[0])
    finally:
        if workspace is not None:
            shutil.rmtree(workspace, ignore_errors=True)
