"""Adding transactions to a local app's data, with a writer the agent builds.

The agent gets a copy of the data, the transactions and the rules in agent.WRITE, and
picks the safest method that works (the app's API, its importer, the open file format,
UI automation if allowed) or answers "none". It never sees the real file.

The runner then proves the writer on a fresh copy, using the app's saved extractor:
extract, write, extract again, and the only difference must be one new row per split.
Only after that, and only when asked to apply, does it touch the real data: refuse if the
data changed since, the app is running or the data is locked; back up; write; prove it
the same way; restore the backup on any mismatch. Then the ledger is reloaded.
"""

import asyncio
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import layout
import ledger
from agent import SCRIPT, UiScope, build_write_prompt, run_agent
from checker import check
from rows import NormalizedRow

ROOT = Path(__file__).parent
CACHE_DIR = ROOT / "cache"
BACKUP_DIR = ROOT / "backups"
AUDIT_LOG = BACKUP_DIR / "writes.jsonl"
WRITER = "write.py"
METHOD = "method.json"
WRITE_LAYOUT = "write-layout.json"
TRANSACTIONS = "transactions.json"
METHODS = ("api", "importer", "file", "ui", "none")
WRITE_TIMEOUT_SECONDS = 300
EXTRACT_TIMEOUT_SECONDS = 120


class WriteRefused(Exception):
    """The write can't go ahead as asked; nothing was changed."""


@dataclass
class Write:
    id: str
    ledger_id: str
    app: str
    data_path: str
    transactions: list[dict]
    allow_ui: bool = False
    # planning -> ready | no_method | needs_human; ready -> applying -> applied | needs_human
    status: str = "planning"
    method: dict | None = None
    expected_rows: int = 0
    deltas: dict[str, str] = field(default_factory=dict)
    blockers: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    data_sha256: str = ""
    backup: str | None = None
    used_cache: bool = False
    run_id: str | None = None  # the ledger reload after applying
    events: list[dict] = field(default_factory=list)
    writer: Path | None = None  # the proven write.py, kept until applied

    def emit(self, kind: str, label: str, detail: str = "") -> None:
        self.events.append({"i": len(self.events), "ts": time.time(), "kind": kind, "label": label, "detail": detail})

    def as_dict(self) -> dict:
        out = asdict(self)
        out.pop("writer")
        return out


WRITES: dict[str, Write] = {}


def fingerprint(path: Path) -> str:
    """Hash of a data file, or of every file in a data folder."""
    if path.is_file():
        return hashlib.sha256(path.read_bytes()).hexdigest()
    h = hashlib.sha256()
    for f in sorted(p for p in path.rglob("*") if p.is_file()):
        h.update(str(f.relative_to(path)).encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def _copy(src: Path, dst: Path) -> None:
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)


def deltas(transactions: list[dict]) -> dict[str, str]:
    """How much each account moves (debits minus credits)."""
    out: dict[str, Decimal] = {}
    for t in transactions:
        for s in t["splits"]:
            signed = Decimal(s["amount"]) * (1 if s["side"] == "debit" else -1)
            out[s["account"]] = out.get(s["account"], Decimal(0)) + signed
    return {a: f"{v:.2f}" for a, v in sorted(out.items())}


def _expected(transactions: list[dict]) -> Counter:
    return Counter(
        (t["date"], s["account"], f"{Decimal(s['amount']):.2f}", s["side"])
        for t in transactions for s in t["splits"]
    )


# Proving a writer -----------------------------------------------------------------------

def extract(script: Path, data: Path) -> list[NormalizedRow]:
    proc = subprocess.run(
        [sys.executable, script.name, str(data)],
        cwd=script.parent, capture_output=True, text=True, timeout=EXTRACT_TIMEOUT_SECONDS,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{SCRIPT} exited {proc.returncode}: {proc.stderr.strip()[-300:]}")
    return [NormalizedRow.model_validate({**r, "run_id": "write"}) for r in json.loads(proc.stdout)]


def run_writer(script: Path, data: Path, transactions: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, script.name, str(data), str(transactions)],
        cwd=script.parent, capture_output=True, text=True, timeout=WRITE_TIMEOUT_SECONDS,
    )


def compare(before: list[NormalizedRow], after: list[NormalizedRow], transactions: list[dict]) -> list[str]:
    """The only difference may be one new row per split, matching date, account, amount, side."""
    problems = []
    old = {r.source: r.model_dump(exclude={"run_id"}) for r in before}
    new = {r.source: r for r in after}
    changed = [s for s in old if s in new and new[s].model_dump(exclude={"run_id"}) != old[s]]
    deleted = [s for s in old if s not in new]
    if changed:
        problems.append(f"{len(changed)} existing row(s) changed, e.g. {changed[0]}")
    if deleted:
        problems.append(f"{len(deleted)} existing row(s) disappeared, e.g. {deleted[0]}")
    added = Counter((r.date.isoformat(), r.account, f"{r.amount:.2f}", r.side) for s, r in new.items() if s not in old)
    want = _expected(transactions)
    missing, extra = want - added, added - want
    if missing:
        problems.append(f"{sum(missing.values())} split(s) not found after writing, e.g. {next(iter(missing))}")
    if extra:
        problems.append(f"{sum(extra.values())} unexpected new row(s), e.g. {next(iter(extra))}")
    if check(before).passed and not check(after).passed:
        problems.append("the books passed the checker before writing and fail it after: " + "; ".join(check(after).differences))
    return problems


def prove(writer: Path, extractor: Path, data: Path, transactions: Path, txns: list[dict]) -> list[str]:
    """Extract, write, extract again, compare. Writes to `data`."""
    before = extract(extractor, data)
    proc = run_writer(writer, data, transactions)
    if proc.returncode != 0:
        return [f"{WRITER} exited {proc.returncode}: {(proc.stderr.strip() or proc.stdout.strip())[-400:]}"]
    return compare(before, extract(extractor, data), txns)


def blockers(method: dict, data: Path) -> list[str]:
    """Reasons it isn't safe to write the real data right now, from what the agent found."""
    found = []
    if method.get("app_must_be_closed", True):
        names = {n.casefold() for n in method.get("process_names") or ()}
        try:
            out = subprocess.run(["ps", "-Ao", "comm="], capture_output=True, text=True, timeout=5).stdout
            running = {Path(line.strip()).name.casefold() for line in out.splitlines()}
        except (OSError, subprocess.SubprocessError):
            running = names  # can't tell, so assume it is
        if names & running:
            found.append("The app is running. Quit it first; it could overwrite the change or hold a lock.")
    for pattern in method.get("lock_files") or ():
        lock = Path(str(pattern).replace("{data_path}", str(data)))
        if lock.exists():
            found.append(f"The data is locked ({lock.name} exists). If the app is closed, the lock is stale: delete it.")
    return found


def _audit(write: Write) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    with AUDIT_LOG.open("a") as f:
        f.write(json.dumps({"at": time.time(), **write.as_dict()}) + "\n")


# Planning: get a writer and prove it on a copy ------------------------------------------

def new_write(ledger_id: str, app: str, data_path: str, transactions: list[dict], allow_ui: bool = False) -> Write:
    write = Write(
        id=f"write_{uuid.uuid4().hex[:8]}", ledger_id=ledger_id, app=app, data_path=data_path,
        transactions=transactions, allow_ui=allow_ui,
        expected_rows=sum(len(t["splits"]) for t in transactions), deltas=deltas(transactions),
    )
    WRITES[write.id] = write
    return write


def read_method(workspace: Path) -> dict:
    try:
        method = json.loads((workspace / METHOD).read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(f"{METHOD} missing or not JSON: {e}") from e
    if not isinstance(method, dict) or method.get("method") not in METHODS:
        raise RuntimeError(f"{METHOD} needs a method: one of {', '.join(METHODS)}")
    return method


async def plan(write: Write) -> None:
    """Find or build a writer, prove it on a fresh copy, and stop at ready for a human."""
    workspace: Path | None = None
    try:
        data = Path(write.data_path).expanduser().resolve()
        cache = CACHE_DIR / ledger.slug(write.app)
        if not (cache / SCRIPT).exists():
            raise WriteRefused("no saved extractor for this app; connect it first so writes can be checked")
        structure = await asyncio.to_thread(layout.describe, data)
        if layout.diff(json.loads((cache / "layout.json").read_text()), structure) != ([], []):
            raise WriteRefused("the data's layout changed since the last load; reconnect first")

        write.data_sha256 = await asyncio.to_thread(fingerprint, data)
        workspace = Path(tempfile.mkdtemp(prefix=f"local-link-{write.id}-")).resolve()
        (workspace / TRANSACTIONS).write_text(json.dumps(write.transactions, indent=1))
        shutil.copy2(cache / SCRIPT, workspace / SCRIPT)
        write.emit("info", "Write requested", f"{len(write.transactions)} transaction(s), {write.expected_rows} splits → {data}")

        error: list[str] | None = None
        saved = cache / WRITE_LAYOUT
        if (cache / WRITER).exists() and saved.exists() and json.loads(saved.read_text()) == structure:
            shutil.copy2(cache / WRITER, workspace / WRITER)
            shutil.copy2(cache / METHOD, workspace / METHOD)
            write.method = read_method(workspace)
            write.emit("info", "Reusing the saved writer", f"method: {write.method['method']}")
            error = await _try(write, workspace, data)
            if error is None:
                write.used_cache = True
                _ready(write, workspace, cache, structure)
                return
            write.emit("info", "Saved writer failed on a copy", "asking the agent for a new one")

        ui = UiScope(Path(write.app).stem, why="The user allowed UI automation for this write.") if write.allow_ui else None
        for attempt in (1, 2):
            copy_dir = workspace / "data"
            shutil.rmtree(copy_dir, ignore_errors=True)
            copy_dir.mkdir()
            data_copy = copy_dir / data.name
            await asyncio.to_thread(_copy, data, data_copy)
            (workspace / METHOD).unlink(missing_ok=True)
            label = "Writer agent started" if attempt == 1 else "Repair: rerunning the writer agent with the error"
            write.emit("info", label, f"works on a copy: {data_copy}")
            prompt = build_write_prompt(write.app, data_copy, workspace, TRANSACTIONS, error, ui)
            try:
                await run_agent(write.app, data_copy, workspace, write.emit, ui=ui, prompt=prompt, done=(METHOD,), name="Writer agent")
            except Exception as e:  # still check whatever it left behind
                write.emit("error", "Writer agent session crashed", f"{type(e).__name__}: {e}")
            try:
                write.method = read_method(workspace)
            except RuntimeError as e:
                error = [str(e)]
                write.emit("fail", "No method recorded", error[0])
                continue
            if write.method["method"] == "none":
                write.status = "no_method"
                write.problems = [write.method.get("summary") or "the agent found no safe way to write to this app"]
                write.emit("fail", "No safe way to write to this app", write.problems[0])
                return
            write.emit("info", f"Method: {write.method['method']}", write.method.get("summary", ""))
            error = await _try(write, workspace, data)
            if error is None:
                _ready(write, workspace, cache, structure)
                return

        write.status = "needs_human"
        write.problems = error or []
        write.emit("fail", "Needs human", "the writer still fails on a copy; your data was not touched")
    except WriteRefused as e:
        write.status = "needs_human"
        write.problems = [str(e)]
        write.emit("fail", "Write refused", str(e))
    except Exception as e:
        write.status = "needs_human"
        write.problems = [f"{type(e).__name__}: {e}"]
        write.emit("error", "Write planning crashed", write.problems[0])
    finally:
        if workspace is not None:
            shutil.rmtree(workspace, ignore_errors=True)
        _audit(write)


async def _try(write: Write, workspace: Path, data: Path) -> list[str] | None:
    """Prove write.py on a fresh copy of the real data. None when it passes."""
    if not (workspace / WRITER).exists():
        problems = [f"missing {WRITER}"]
    else:
        trial = Path(tempfile.mkdtemp(prefix=f"local-link-{write.id}-trial-")).resolve()
        try:
            copy = trial / data.name
            await asyncio.to_thread(_copy, data, copy)
            problems = await asyncio.to_thread(
                prove, workspace / WRITER, workspace / SCRIPT, copy, workspace / TRANSACTIONS, write.transactions
            )
        except Exception as e:
            problems = [f"{type(e).__name__}: {e}"]
        finally:
            shutil.rmtree(trial, ignore_errors=True)
    if problems:
        write.emit("fail", "Writer failed on a fresh copy", "; ".join(problems))
        return problems
    write.emit("ok", "Writer proven on a fresh copy", f"+{write.expected_rows} rows, nothing else changed")
    return None


def _ready(write: Write, workspace: Path, cache: Path, structure: list[str]) -> None:
    for name in (WRITER, METHOD):
        shutil.copy2(workspace / name, cache / name)
    (cache / WRITE_LAYOUT).write_text(json.dumps(structure, indent=1))
    keep = Path(tempfile.mkdtemp(prefix=f"local-link-{write.id}-ready-")).resolve()
    for name in (WRITER, SCRIPT, TRANSACTIONS):
        shutil.copy2(workspace / name, keep / name)
    write.writer = keep / WRITER
    write.blockers = blockers(write.method or {}, Path(write.data_path).expanduser().resolve())
    write.status = "ready"
    detail = "nothing written to your data yet"
    write.emit("ok", "Ready to apply", detail + (f" · {' '.join(write.blockers)}" if write.blockers else ""))


# Applying to the real data --------------------------------------------------------------

def apply(write_id: str) -> Write:
    """Back up, write, prove it on the real data; restore the backup on any mismatch."""
    write = WRITES.get(write_id)
    if write is None:
        raise LookupError(f"no write {write_id!r}")
    if write.status != "ready" or write.writer is None:
        raise WriteRefused(f"write is {write.status}, not ready")
    data = Path(write.data_path).expanduser().resolve()
    if fingerprint(data) != write.data_sha256:
        raise WriteRefused("the data changed since the writer was proven; request the write again")
    found = blockers(write.method or {}, data)
    if found:
        write.blockers = found
        raise WriteRefused(" ".join(found))

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = BACKUP_DIR / f"{datetime.now():%Y%m%d-%H%M%S}-{write.id}-{data.name}"
    _copy(data, backup)
    if fingerprint(backup) != write.data_sha256:
        raise WriteRefused("the backup doesn't match the data; nothing written")
    write.backup = str(backup)
    write.status = "applying"
    write.emit("info", "Backed up your data", str(backup))

    folder = write.writer.parent
    try:
        problems = prove(write.writer, folder / SCRIPT, data, folder / TRANSACTIONS, write.transactions)
    except Exception as e:
        problems = [f"{type(e).__name__}: {e}"]
    if problems:
        try:
            if data.is_dir():
                shutil.rmtree(data)
            _copy(backup, data)
            restored = fingerprint(data) == write.data_sha256
        except Exception:
            restored = False
        problems.append("restored your data from the backup" if restored else f"RESTORE FAILED: copy {backup} back to {data} by hand")
        write.status = "needs_human"
        write.problems = problems
        write.emit("fail", "Write didn't check out", "; ".join(problems))
    else:
        write.status = "applied"
        write.emit("ok", "Written", f"+{write.expected_rows} rows in your data, nothing else changed")
        # The saved extractor just read the written data correctly, so new fields the write
        # added (a memo the book never had, say) are not a layout change worth a rewrite.
        cache = CACHE_DIR / ledger.slug(write.app)
        structure = json.dumps(layout.describe(data), indent=1)
        (cache / "layout.json").write_text(structure)
        (cache / WRITE_LAYOUT).write_text(structure)
        shutil.rmtree(folder, ignore_errors=True)
        write.writer = None
    _audit(write)
    return write
