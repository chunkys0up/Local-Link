"""SQLite ledger of rows that passed the checker, plus a history of every change.

Each load is diffed against what's already there for that app, keyed on source:
rows are added, changed or deleted, and each change is recorded in ledger_changes.
"""

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from rows import NormalizedRow

DB_PATH = Path(__file__).parent / "ledger.db"
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
"""


@dataclass
class Change:
    change: str  # added | changed | deleted
    source: str
    before: dict | None
    after: dict | None

    def as_dict(self) -> dict:
        return {"change": self.change, "source": self.source, "before": self.before, "after": self.after}


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    columns = [r[1] for r in conn.execute("pragma table_info(ledger)")]
    if columns and "source" not in columns[:2]:
        conn.execute("drop table ledger")  # pre-diff schema; it only held test data
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


def diff(app: str, rows: list[NormalizedRow], db_path: Path = DB_PATH) -> list[Change]:
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


def apply(app: str, run_id: str, changes: list[Change], db_path: Path = DB_PATH) -> None:
    """Apply a diff atomically and record it in the change history."""
    now = time.time()
    with connect(db_path) as conn:
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


def all_rows(limit: int = 1000, db_path: Path = DB_PATH) -> list[dict]:
    with connect(db_path) as conn:
        cursor = conn.execute(
            "select app, date, account, amount, side, memo, source, run_id"
            " from ledger order by date, app, source limit ?",
            (limit,),
        )
        return [dict(r) for r in cursor]


def reset(db_path: Path = DB_PATH) -> None:
    db_path.unlink(missing_ok=True)
