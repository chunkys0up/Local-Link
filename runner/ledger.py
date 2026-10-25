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
from decimal import Decimal
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
create table if not exists runs (
    run_id text primary key,
    status text not null,
    started real not null,
    finished real not null,
    used_cache integer not null,
    rows_loaded integer,
    gap text not null
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


def _under(account: str) -> tuple[str, list]:
    """SQL matching an account and every account below it ("Expenses" -> "Expenses:Rent")."""
    return "(account = ? or substr(account, 1, length(?) + 1) = ? || ':')", [account, account, account]


def query_rows(
    db_path: Path,
    *,
    account: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    search: str | None = None,
    side: str | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    run_id: str | None = None,
    limit: int = 1000,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Rows matching every filter given, oldest first, plus how many match in total."""
    if not db_path.exists():
        return [], 0
    where, params = [], []
    if account:
        clause, args = _under(account)
        where.append(clause)
        params += args
    if date_from:
        where.append("date >= ?")
        params.append(date_from)
    if date_to:
        where.append("date <= ?")
        params.append(date_to)
    if search:
        # instr instead of LIKE so % and _ in the search text are taken literally
        where.append("(instr(lower(memo), lower(?)) or instr(lower(account), lower(?)) or instr(lower(source), lower(?)))")
        params += [search] * 3
    if side:
        where.append("side = ?")
        params.append(side)
    if min_amount is not None:
        where.append("cast(amount as real) >= ?")
        params.append(float(min_amount))
    if max_amount is not None:
        where.append("cast(amount as real) <= ?")
        params.append(float(max_amount))
    if run_id:
        where.append("run_id = ?")
        params.append(run_id)
    clause = f" where {' and '.join(where)}" if where else ""
    with connect(db_path) as conn:
        total = conn.execute(f"select count(*) from ledger{clause}", params).fetchone()[0]
        cursor = conn.execute(
            "select app, date, account, amount, side, memo, source, run_id"
            f" from ledger{clause} order by date, app, source limit ? offset ?",
            [*params, limit, offset],
        )
        return [dict(r) for r in cursor], total


def balances(db_path: Path, *, account: str | None = None, as_of: str | None = None) -> list[dict]:
    """Debit and credit totals per account, and the balance (debits minus credits)."""
    if not db_path.exists():
        return []
    where, params = [], []
    if account:
        clause, args = _under(account)
        where.append(clause)
        params += args
    if as_of:
        where.append("date <= ?")
        params.append(as_of)
    clause = f" where {' and '.join(where)}" if where else ""
    totals: dict[str, dict] = {}
    with connect(db_path) as conn:
        for r in conn.execute(f"select account, amount, side from ledger{clause}", params):
            t = totals.setdefault(r["account"], {"debits": Decimal(0), "credits": Decimal(0), "rows": 0})
            t["debits" if r["side"] == "debit" else "credits"] += Decimal(r["amount"])
            t["rows"] += 1
    # Summed in Decimal and returned as strings so cents stay exact
    return [
        {
            "account": name,
            "debits": f"{t['debits']:.2f}",
            "credits": f"{t['credits']:.2f}",
            "balance": f"{t['debits'] - t['credits']:.2f}",
            "rows": t["rows"],
        }
        for name, t in sorted(totals.items())
    ]


def changes(
    db_path: Path,
    *,
    run_id: str | None = None,
    change: str | None = None,
    since: float | None = None,
    limit: int = 1000,
) -> list[dict]:
    """The change history, newest first. since: only changes recorded after this Unix time."""
    if not db_path.exists():
        return []
    where, params = [], []
    if since is not None:
        where.append("at > ?")
        params.append(since)
    if run_id:
        where.append("run_id = ?")
        params.append(run_id)
    if change:
        where.append("change = ?")
        params.append(change)
    clause = f" where {' and '.join(where)}" if where else ""
    with connect(db_path) as conn:
        cursor = conn.execute(
            f"select run_id, change, source, before, after, at from ledger_changes{clause}"
            " order by at desc, id desc limit ?",
            [*params, limit],
        )
        return [
            {**dict(r), "before": json.loads(r["before"]) if r["before"] else None,
             "after": json.loads(r["after"]) if r["after"] else None}
            for r in cursor
        ]


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


def record_run(db_path: Path, app: str, data_path: str, run: dict) -> None:
    """Keep the outcome of every run on this source, including ones that loaded nothing."""
    with connect(db_path) as conn:
        # A source whose first run needs a human still gets listed, with 0 rows.
        conn.execute(
            "insert or ignore into ledger_source (id, app, data_path) values (1, ?, ?)", (app, data_path)
        )
        conn.execute(
            "insert or replace into runs (run_id, status, started, finished, used_cache, rows_loaded, gap)"
            " values (?, ?, ?, ?, ?, ?, ?)",
            (run["run_id"], run["status"], run["started"], run["finished"], int(run["used_cache"]),
             run["rows_loaded"], json.dumps(run["gap"])),
        )


def runs(db_path: Path, *, status: tuple[str, ...] = (), limit: int = 100) -> list[dict]:
    """Recorded runs, newest first, optionally only those with one of the given statuses."""
    if not db_path.exists():
        return []
    clause = f" where status in ({', '.join('?' * len(status))})" if status else ""
    with connect(db_path) as conn:
        cursor = conn.execute(f"select * from runs{clause} order by finished desc limit ?", [*status, limit])
        return [{**dict(r), "used_cache": bool(r["used_cache"]), "gap": json.loads(r["gap"])} for r in cursor]


def reset() -> None:
    shutil.rmtree(LEDGERS_DIR, ignore_errors=True)
