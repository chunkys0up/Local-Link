"""SQLite ledger holding rows that passed the checker."""

import sqlite3
from pathlib import Path

from rows import NormalizedRow

DB_PATH = Path(__file__).parent / "ledger.db"

SCHEMA = """
create table if not exists ledger (
    id integer primary key,
    app text not null,
    date text not null,
    account text not null,
    amount text not null,
    side text not null check (side in ('debit', 'credit')),
    memo text not null,
    source text not null,
    run_id text not null
)
"""


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute(SCHEMA)
    return conn


def load(app: str, rows: list[NormalizedRow], db_path: Path = DB_PATH) -> int:
    """Replace the app's rows with this run's rows, atomically."""
    with connect(db_path) as conn:
        conn.execute("delete from ledger where app = ?", (app,))
        conn.executemany(
            "insert into ledger (app, date, account, amount, side, memo, source, run_id)"
            " values (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (app, r.date.isoformat(), r.account, f"{r.amount:.2f}", r.side, r.memo, r.source, r.run_id)
                for r in rows
            ],
        )
    return len(rows)


def all_rows(limit: int = 1000, db_path: Path = DB_PATH) -> list[dict]:
    with connect(db_path) as conn:
        cursor = conn.execute(
            "select app, date, account, amount, side, memo, source, run_id"
            " from ledger order by date, id limit ?",
            (limit,),
        )
        return [dict(r) for r in cursor]
