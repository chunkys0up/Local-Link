"""SQLite ledgers of rows that passed the checker, plus a history of every change.

Each source (app + data path) gets its own ledger file in ledgers/. Each load is
diffed against what's already there, keyed on source: rows are added, changed or
deleted, and each change is recorded in ledger_changes.
"""

import hashlib
import json
import re
import shutil
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from rows import NormalizedRow

LEDGERS_DIR = Path(__file__).parent / "ledgers"
FIELDS = ("date", "account", "amount", "side", "memo")

SCHEMA = """
create table if not exists ledger (
    app text not null,
    source text not null,
    date text not null,
    account text not null,
    amount text not null,
    side text not null check (side in ('debit', 'credit')),
    memo text not null,
    run_id text not null,
    primary key (app, source)
);
create table if not exists ledger_changes (
    id integer primary key,
    app text not null,
    run_id text not null,
    change text not null check (change in ('added', 'changed', 'deleted')),
    source text not null,
    before text,
    after text,
    at real not null
);
create table if not exists ledger_source (
    id integer primary key check (id = 1),
    app text not null,
    data_path text not null
);
"""


def slug(app: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", app.lower()).strip("-") or "app"


def ledger_id(app: str, data_path: str) -> str:
    """Stable ID for one source: the app plus the resolved data path."""
    resolved = str(Path(data_path).expanduser().resolve())
    return f"{slug(app)}-{hashlib.sha1(resolved.encode()).hexdigest()[:8]}"


def path_for(ledger: str) -> Path:
    if not re.fullmatch(r"[a-z0-9_-]+", ledger):
        raise ValueError(f"bad ledger id: {ledger!r}")
    return LEDGERS_DIR / f"{ledger}.db"


def list_ledgers() -> list[dict]:
    """Every ledger with its app, data path and row count, most recently loaded first."""
    found = []
    for db in sorted(LEDGERS_DIR.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True):
        with connect(db) as conn:
            source = conn.execute("select app, data_path from ledger_source").fetchone()
            count = conn.execute("select count(*) from ledger").fetchone()[0]
        if source is None:  # created by a diff but never loaded
            continue
        found.append({"id": db.stem, "app": source["app"], "data_path": source["data_path"], "rows": count})
    return found


@dataclass
class Change:
    change: str  # added | changed | deleted
    source: str
    before: dict | None
    after: dict | None

    def as_dict(self) -> dict:
        return {"change": self.change, "source": self.source, "before": self.before, "after": self.after}


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def _fields(row: NormalizedRow) -> dict:
    return {
        "date": row.date.isoformat(),
        "account": row.account,
        "amount": f"{row.amount:.2f}",
        "side": row.side,
        "memo": row.memo,
    }


def diff(app: str, rows: list[NormalizedRow], db_path: Path) -> list[Change]:
    """What loading these rows would change for this app."""
    with connect(db_path) as conn:
        current = {
            r["source"]: {f: r[f] for f in FIELDS}
            for r in conn.execute("select * from ledger where app = ?", (app,))
        }
    incoming = {r.source: _fields(r) for r in rows}
    changes = [
        Change("added", source, None, after)
        for source, after in incoming.items()
        if source not in current
    ]
    changes += [
        Change("changed", source, current[source], after)
        for source, after in incoming.items()
        if source in current and current[source] != after
    ]
    changes += [
        Change("deleted", source, before, None)
        for source, before in current.items()
        if source not in incoming
    ]
    order = {"changed": 0, "deleted": 1, "added": 2}
    changes.sort(key=lambda c: (order[c.change], (c.after or c.before)["date"], c.source))
    return changes


def apply(
    app: str, run_id: str, changes: list[Change], db_path: Path, data_path: str = ""
) -> None:
    """Apply a diff atomically and record it in the change history."""
    now = time.time()
    with connect(db_path) as conn:
        conn.execute(
            "insert or replace into ledger_source (id, app, data_path) values (1, ?, ?)",
            (app, data_path),
        )
        for c in changes:
            if c.change == "deleted":
                conn.execute("delete from ledger where app = ? and source = ?", (app, c.source))
            else:
                conn.execute(
                    "insert or replace into ledger (app, source, date, account, amount, side, memo, run_id)"
                    " values (?, ?, ?, ?, ?, ?, ?, ?)",
                    (app, c.source, *(c.after[f] for f in FIELDS), run_id),
                )
        conn.executemany(
            "insert into ledger_changes (app, run_id, change, source, before, after, at)"
            " values (?, ?, ?, ?, ?, ?, ?)",
            [
                (app, run_id, c.change, c.source,
                 json.dumps(c.before) if c.before else None,
                 json.dumps(c.after) if c.after else None, now)
                for c in changes
            ],
        )


def all_rows(db_path: Path, limit: int = 1000) -> list[dict]:
    if not db_path.exists():
        return []
    with connect(db_path) as conn:
        cursor = conn.execute(
            "select app, date, account, amount, side, memo, source, run_id"
            " from ledger order by date, app, source limit ?",
            (limit,),
        )
        return [dict(r) for r in cursor]


def reset() -> None:
    shutil.rmtree(LEDGERS_DIR, ignore_errors=True)
