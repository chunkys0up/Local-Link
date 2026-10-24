"""One connect run: cached scripts or agents, then checker, one repair, then ledger."""

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

import ledger
from agent import ROLES, run_agent
from checker import CheckResult, check, money
from rows import NormalizedRow, Reference

ROOT = Path(__file__).parent
CACHE_DIR = ROOT / "cache"
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


def evaluate(
    run: Run, workspaces: dict[str, Path], data_path: Path
) -> tuple[CheckResult, list[NormalizedRow]]:
    """Run each role's script from its own workspace and check their output."""
    scripts = {key: workspaces[key] / ROLES[key].script for key in ROLES}
    missing = [p.name for p in scripts.values() if not p.exists()]
    if missing:
        return CheckResult(False, [f"missing script: {s}" for s in missing]), []

    try:
        raw_rows = _run_script(scripts["extract"], data_path)
        if not isinstance(raw_rows, list):
            raise RuntimeError("extract.py must print a JSON array")
        rows = [NormalizedRow.model_validate({**r, "run_id": run.id}) for r in raw_rows]
        run.emit("info", "Extractor produced rows", f"{len(rows)} rows")

        reference = Reference.model_validate(_run_script(scripts["reference"], data_path))
        run.emit(
            "info",
            "Reference total from the app",
            f"{reference.row_count} rows · debits {money(reference.total_debits)}"
            f" · credits {money(reference.total_credits)} · {len(reference.accounts)} accounts",
        )
    except (RuntimeError, subprocess.TimeoutExpired, ValidationError, TypeError) as e:
        message = " ".join(str(e).split())[:500]
        run.emit("fail", "Scripts failed", message)
        return CheckResult(False, [message]), []

    result = check(rows, reference)
    if result.passed:
        run.emit(
            "ok",
            "Checker passed",
            f"debits = credits · {len(rows)} rows · totals and {len(reference.accounts)} account balances match",
        )
    else:
        run.emit("fail", "Checker failed", "; ".join(result.differences))
    return result, rows


def _finish_pass(run: Run, workspaces: dict[str, Path], rows: list[NormalizedRow]) -> None:
    cache = CACHE_DIR / slug(run.app)
    cache.mkdir(parents=True, exist_ok=True)
    for key, role in ROLES.items():
        shutil.copy2(workspaces[key] / role.script, cache / role.script)
    run.rows_loaded = ledger.load(run.app, rows)
    run.status = "passed"
    run.emit("ok", "Loaded into ledger", f"{run.rows_loaded} rows → ledger.db")


async def _run_agents(
    run: Run, data_path: Path, workspaces: dict[str, Path], error: list[str] | None
) -> None:
    """Both roles at once, each in its own folder, never seeing the other's work."""

    async def one(key: str) -> None:
        try:
            await run_agent(key, run.app, data_path, workspaces[key], run.emit, error)
        except Exception as e:  # still check whatever script it left behind
            run.emit("error", f"{ROLES[key].name} session crashed", f"{type(e).__name__}: {e}")

    await asyncio.gather(*(one(key) for key in ROLES))


async def execute(run: Run) -> None:
    workspaces: dict[str, Path] = {}
    try:
        data_path = Path(run.data_path).expanduser().resolve()
        if not data_path.exists():
            raise FileNotFoundError(f"data path does not exist: {data_path}")
        # Each role gets a fresh temp folder outside the project, deleted when the run
        # ends, so agents never see the repo, each other, or earlier runs' work.
        # Resolve because macOS temp paths sit behind the /var -> /private/var symlink.
        for key in ROLES:
            workspaces[key] = Path(tempfile.mkdtemp(prefix=f"local-link-{run.id}-{key}-")).resolve()
        run.emit("info", "Connect requested", f"app={run.app} · data={data_path} · run={run.id}")

        error: list[str] | None = None
        cache = CACHE_DIR / slug(run.app)
        if all((cache / role.script).exists() for role in ROLES.values()):
            for key, role in ROLES.items():
                shutil.copy2(cache / role.script, workspaces[key] / role.script)
            run.emit("info", "Using cached scripts", f"from cache/{slug(run.app)}, skipping the agents")
            result, rows = await asyncio.to_thread(evaluate, run, workspaces, data_path)
            if result.passed:
                run.used_cache = True
                _finish_pass(run, workspaces, rows)
                return
            run.emit("info", "Cached scripts broke", "falling back to the agents")
            error = result.differences

        for attempt in (1, 2):
            label = "Agents started" if attempt == 1 else "Repair: rerunning both agents with the error"
            run.emit(
                "info",
                label,
                f"extractor and reference agents work separately · read-only: {data_path}",
            )
            await _run_agents(run, data_path, workspaces, error)
            result, rows = await asyncio.to_thread(evaluate, run, workspaces, data_path)
            if result.passed:
                _finish_pass(run, workspaces, rows)
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
        for workspace in workspaces.values():
            shutil.rmtree(workspace, ignore_errors=True)
