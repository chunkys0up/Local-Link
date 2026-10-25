"""Read-side helpers for the HTTP API, on top of ledger.py's query_rows, balances and changes:
provenance, flagged runs, monthly rollups and read-only SQL.
"""

import re
import sqlite3
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

import ledger
from checker import SUSPECT_ACCOUNT

MAX_SQL_ROWS = 1000
FLAGGED = ("needs_human", "error")


class NotFound(LookupError):
    pass


def existing(ledger_id: str) -> Path:
    """The ledger's file, or NotFound. A malformed id raises ValueError."""
    db = ledger.path_for(ledger_id)
    if not db.exists():
        raise NotFound(f"no ledger {ledger_id!r}")
    return db


def provenance(db: Path, run_ids: set[str]) -> dict:
    """Where rows came from: the source file, the runs that loaded them, the latest run.

    Every row in a ledger passed the checker when it was loaded; runs that failed it
    loaded nothing and show up under flags instead.
    """
    with ledger.connect(db) as conn:
        source = conn.execute("select app, data_path from ledger_source").fetchone()
    recorded = {r["run_id"]: r for r in ledger.runs(db, limit=1000)}
    latest = next(iter(recorded.values()), None)
    return {
        "app": source["app"] if source else "",
        "data_path": source["data_path"] if source else "",
        "checker_passed": True,
        "latest_run": latest,
        "runs": {run_id: recorded.get(run_id) for run_id in sorted(run_ids)},
    }


def flags(db: Path) -> dict:
    """What needs a human: runs that stopped at needs_human or error (with the checker's
    reasons), and suspense-type accounts that don't net to zero."""
    suspect = [
        b for b in ledger.balances(db)
        if SUSPECT_ACCOUNT.search(b["account"]) and Decimal(b["balance"]) != 0
    ]
    return {"runs": ledger.runs(db, status=FLAGGED), "suspect_accounts": suspect}


def monthly(
    db: Path,
    by: str = "account",
    account: str | None = None,
    depth: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[dict]:
    """Debits, credits and net per month per account (or per payee, i.e. memo).

    depth cuts account paths to that many levels below the top (0 = "Expenses").
    """
    rows, _ = ledger.query_rows(db, account=account, date_from=date_from, date_to=date_to, limit=-1)
    groups: dict[tuple[str, str], dict] = defaultdict(lambda: {"debits": Decimal(0), "credits": Decimal(0), "rows": 0})
    for r in rows:
        if by == "payee":
            key = r["memo"].strip() or "(no memo)"
        else:
            key = r["account"] if depth is None else ":".join(r["account"].split(":")[: depth + 1])
        g = groups[(r["date"][:7], key)]
        g["debits" if r["side"] == "debit" else "credits"] += Decimal(r["amount"])
        g["rows"] += 1
    return [
        {
            "month": month,
            by: key,
            "debits": f"{g['debits']:.2f}",
            "credits": f"{g['credits']:.2f}",
            "net": f"{g['debits'] - g['credits']:.2f}",
            "rows": g["rows"],
        }
        for (month, key), g in sorted(groups.items())
    ]


def since_run(db: Path, run_id: str) -> float:
    """When a run finished, to list the changes made after it."""
    recorded = {r["run_id"]: r for r in ledger.runs(db, limit=1000)}
    if run_id in recorded:
        return recorded[run_id]["finished"]
    with ledger.connect(db) as conn:  # runs loaded before run history was kept
        at = conn.execute("select max(at) from ledger_changes where run_id = ?", (run_id,)).fetchone()[0]
    if at is None:
        raise NotFound(f"no run {run_id!r} in this ledger")
    return at


_READ_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}


def _only_reads(action: int, *_: object) -> int:
    return sqlite3.SQLITE_OK if action in _READ_ACTIONS else sqlite3.SQLITE_DENY


def run_sql(db: Path, query: str, limit: int = 500) -> dict:
    """One SELECT (or WITH ... SELECT) against a ledger, opened read-only. Anything else
    is refused: by the statement check, the read-only connection, and an authorizer."""
    text = query.strip().rstrip(";").strip()
    if not re.match(r"(?is)^(select|with)\b", text):
        raise ValueError("only SELECT queries are allowed")
    if ";" in text:
        raise ValueError("only one statement is allowed")
    limit = max(0, min(limit, MAX_SQL_ROWS))
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        conn.execute("pragma query_only = on")
        conn.set_authorizer(_only_reads)
        try:
            cursor = conn.execute(text)
        except sqlite3.DatabaseError as e:
            raise ValueError(f"query failed: {e}") from e
        columns = [d[0] for d in cursor.description or ()]
        fetched = cursor.fetchmany(limit + 1)
    finally:
        conn.close()
    return {"columns": columns, "rows": [list(r) for r in fetched[:limit]], "truncated": len(fetched) > limit}
