from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

import ledger
import query
import server
from rows import NormalizedRow

LEDGER = "gnucash-test"


def row(source, date, account, amount, side, memo="", run_id="run_1"):
    return NormalizedRow(
        date=date, account=account, amount=Decimal(amount), side=side, memo=memo,
        source=source, run_id=run_id,
    )


def load(db, run_id, rows, at):
    ledger.apply("gnucash", run_id, ledger.diff("gnucash", rows, db), db, "/books.gnucash")
    ledger.record_run(db, "gnucash", "/books.gnucash", {
        "run_id": run_id, "status": "passed", "started": at - 1, "finished": at,
        "used_cache": False, "rows_loaded": len(rows), "gap": [],
    })


FIRST = [
    row("t1/a", "2026-04-01", "Assets:Checking", "40000.00", "debit", "Opening balance"),
    row("t1/b", "2026-04-01", "Equity:Opening Balances", "40000.00", "credit", "Opening balance"),
    row("t2/a", "2026-05-03", "Expenses:Office:Supplies", "47.18", "debit", "STAPLES #0412"),
    row("t2/b", "2026-05-03", "Assets:Checking", "47.18", "credit", "STAPLES #0412"),
    row("t3/a", "2026-05-20", "Expenses:Office:Rent", "900.00", "debit", "Rent"),
    row("t3/b", "2026-05-20", "Assets:Checking", "900.00", "credit", "Rent"),
    row("t4/a", "2026-06-10", "Assets:Checking", "1200.00", "debit", "Invoice 17"),
    row("t4/b", "2026-06-10", "Income:Sales", "1200.00", "credit", "Invoice 17"),
]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGERS_DIR", tmp_path)
    db = ledger.path_for(LEDGER)
    clock = [1000.0]
    monkeypatch.setattr(ledger.time, "time", lambda: clock[0])
    load(db, "run_1", FIRST, at=1000.0)
    clock[0] = 2000.0
    second = [r.model_copy(update={"run_id": "run_2"}) for r in FIRST if r.source != "t3/a" and r.source != "t3/b"]
    second[2] = second[2].model_copy(update={"amount": Decimal("47.81")})  # t2/a edited
    load(db, "run_2", second, at=2000.0)
    return TestClient(server.app)


def test_rows_with_filters_and_provenance(client):
    body = client.get(f"/ledger?ledger_id={LEDGER}&account=Expenses&search=staples").json()
    assert body["total"] == 1 and body["rows"][0]["amount"] == "47.81"
    prov = body["provenance"]
    assert prov["data_path"] == "/books.gnucash" and prov["checker_passed"] is True
    assert prov["latest_run"]["run_id"] == "run_2"
    assert set(prov["runs"]) == {"run_2"} and prov["runs"]["run_2"]["status"] == "passed"
    assert client.get("/ledger?ledger_id=nope-1").status_code == 404
    assert client.get("/ledger?ledger_id=../x").status_code == 400


def test_changes_since_run(client):
    changes = client.get(f"/ledgers/{LEDGER}/changes?since_run=run_1").json()["changes"]
    assert sorted((c["change"], c["source"]) for c in changes) == [
        ("changed", "t2/a"), ("deleted", "t3/a"), ("deleted", "t3/b"),
    ]
    assert len(client.get(f"/ledgers/{LEDGER}/changes?since=0").json()["changes"]) == 11
    assert client.get(f"/ledgers/{LEDGER}/changes?since_run=run_9").status_code == 404


def test_flags_list_failed_runs_and_suspect_accounts(client):
    db = ledger.path_for(LEDGER)
    ledger.record_run(db, "gnucash", "/books.gnucash", {
        "run_id": "run_3", "status": "needs_human", "started": 2999.0, "finished": 3000.0,
        "used_cache": True, "rows_loaded": None,
        "gap": ["unexpected nonzero account Expenses:Unknown: 50.00"],
    })
    flags = client.get(f"/ledgers/{LEDGER}/flags").json()
    assert [r["run_id"] for r in flags["runs"]] == ["run_3"]
    assert flags["runs"][0]["gap"] == ["unexpected nonzero account Expenses:Unknown: 50.00"]
    assert flags["suspect_accounts"] == []
    assert [r["status"] for r in client.get(f"/ledgers/{LEDGER}/runs").json()["runs"]] == ["needs_human", "passed", "passed"]


def test_first_run_needing_a_human_still_lists_the_source(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGERS_DIR", tmp_path)
    ledger.record_run(ledger.path_for("app-1"), "app", "/x.db", {
        "run_id": "r", "status": "needs_human", "started": 1.0, "finished": 2.0,
        "used_cache": False, "rows_loaded": None, "gap": ["debits != credits"],
    })
    assert ledger.list_ledgers() == [{"id": "app-1", "app": "app", "data_path": "/x.db", "rows": 0}]


def test_monthly_by_account_and_payee(client):
    months = client.get(f"/ledgers/{LEDGER}/monthly?account=Expenses&depth=0").json()["months"]
    assert months == [{"month": "2026-05", "account": "Expenses", "debits": "47.81", "credits": "0.00", "net": "47.81", "rows": 1}]
    payees = client.get(f"/ledgers/{LEDGER}/monthly?by=payee&from=2026-06-01").json()["months"]
    assert payees == [{"month": "2026-06", "payee": "Invoice 17", "debits": "1200.00", "credits": "1200.00", "net": "0.00", "rows": 2}]


def test_balances_as_of(client):
    accounts = {a["account"]: a for a in client.get(f"/ledgers/{LEDGER}/balances?as_of=2026-05-31").json()["accounts"]}
    assert accounts["Assets:Checking"]["balance"] == "39952.82"
    assert "Income:Sales" not in accounts


def test_sql_reads_only(client):
    ok = client.post(f"/ledgers/{LEDGER}/sql", json={"query": "select status, count(*) n from runs group by status"})
    assert ok.status_code == 200 and ok.json()["rows"] == [["passed", 2]]
    for sql in [
        "delete from ledger",
        "update ledger set amount = '0'",
        "select 1; delete from ledger",
        "with t as (select 1) delete from ledger",
        "attach database '/tmp/x.db' as x",
        "pragma writable_schema = on",
    ]:
        assert client.post(f"/ledgers/{LEDGER}/sql", json={"query": sql}).status_code == 400, sql
    assert client.get(f"/ledger?ledger_id={LEDGER}").json()["total"] == 6


def test_run_sql_truncates(client):
    result = query.run_sql(ledger.path_for(LEDGER), "select * from ledger", limit=2)
    assert len(result["rows"]) == 2 and result["truncated"] is True
