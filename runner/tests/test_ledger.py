from decimal import Decimal

import ledger
from rows import NormalizedRow


def row(source: str, amount: str, account: str = "Expenses:Rent", side: str = "debit") -> NormalizedRow:
    return NormalizedRow(
        date="2026-10-01", account=account, amount=Decimal(amount), side=side,
        source=source, run_id="run_x",
    )


def test_first_load_adds_everything(tmp_path):
    db = tmp_path / "ledger.db"
    changes = ledger.diff("app", [row("a", "1.00"), row("b", "2.00")], db)
    assert [c.change for c in changes] == ["added", "added"]


def test_second_load_reports_added_changed_deleted(tmp_path):
    db = tmp_path / "ledger.db"
    first = [row("a", "1.00"), row("b", "2.00"), row("c", "3.00")]
    ledger.apply("app", "run_1", ledger.diff("app", first, db), db)

    second = [row("a", "1.00"), row("b", "20.00"), row("d", "4.00")]
    changes = ledger.diff("app", second, db)
    assert [(c.change, c.source) for c in changes] == [
        ("changed", "b"),
        ("deleted", "c"),
        ("added", "d"),
    ]
    changed = changes[0]
    assert changed.before["amount"] == "2.00" and changed.after["amount"] == "20.00"

    ledger.apply("app", "run_2", changes, db)
    assert {(r["source"], r["amount"]) for r in ledger.all_rows(db_path=db)} == {
        ("a", "1.00"), ("b", "20.00"), ("d", "4.00"),
    }
    assert ledger.diff("app", second, db) == []


def test_apps_are_diffed_separately(tmp_path):
    db = tmp_path / "ledger.db"
    ledger.apply("one", "run_1", ledger.diff("one", [row("a", "1.00")], db), db)
    assert [c.change for c in ledger.diff("two", [row("a", "1.00")], db)] == ["added"]


def test_history_records_every_change(tmp_path):
    db = tmp_path / "ledger.db"
    ledger.apply("app", "run_1", ledger.diff("app", [row("a", "1.00")], db), db)
    ledger.apply("app", "run_2", ledger.diff("app", [row("a", "5.00")], db), db)
    with ledger.connect(db) as conn:
        history = [(r["run_id"], r["change"]) for r in conn.execute("select * from ledger_changes order by id")]
    assert history == [("run_1", "added"), ("run_2", "changed")]
