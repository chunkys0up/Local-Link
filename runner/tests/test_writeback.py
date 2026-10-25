import asyncio
import json
from pathlib import Path

import pytest

import layout
import writeback

# A toy app: its data is one JSON file of transactions with splits.
EXTRACT = '''
import json, sys
books = json.load(open(sys.argv[1]))
print(json.dumps([
    {"date": t["date"], "account": s["account"], "amount": s["amount"], "side": s["side"],
     "memo": t["description"], "source": f"{t['id']}/{i}"}
    for t in books["transactions"] for i, s in enumerate(t["splits"])
]))
'''

GOOD_WRITER = '''
import json, sys
path, txns = sys.argv[1], json.load(open(sys.argv[2]))
books = json.load(open(path))
for n, t in enumerate(txns):
    books["transactions"].append({"id": f"new{n}", "date": t["date"], "description": t["description"],
                                  "splits": [{k: s[k] for k in ("account", "amount", "side")} for s in t["splits"]]})
json.dump(books, open(path, "w"))
'''

# Adds the transactions but also "fixes" an existing amount.
SNEAKY_WRITER = GOOD_WRITER + '''
books["transactions"][0]["splits"][0]["amount"] = "1.00"
books["transactions"][0]["splits"][1]["amount"] = "1.00"
json.dump(books, open(path, "w"))
'''

TXNS = [{
    "date": "2026-10-01", "description": "Coffee", "num": "",
    "splits": [
        {"account": "Expenses:Dining", "amount": "4.50", "side": "debit", "memo": ""},
        {"account": "Assets:Checking", "amount": "4.50", "side": "credit", "memo": ""},
    ],
}]


@pytest.fixture
def toy(tmp_path, monkeypatch):
    monkeypatch.setattr(writeback, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(writeback, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(writeback, "AUDIT_LOG", tmp_path / "backups" / "writes.jsonl")
    data = tmp_path / "books.json"
    data.write_text(json.dumps({"transactions": [{
        "id": "t1", "date": "2026-09-01", "description": "Rent",
        "splits": [{"account": "Expenses:Rent", "amount": "900.00", "side": "debit"},
                   {"account": "Assets:Checking", "amount": "900.00", "side": "credit"}],
    }]}))
    cache = tmp_path / "cache" / "toyapp"
    cache.mkdir(parents=True)
    (cache / "extract.py").write_text(EXTRACT)
    (cache / "layout.json").write_text(json.dumps(layout.describe(data)))
    return data, cache


def cache_writer(cache: Path, data: Path, code: str, **method) -> None:
    (cache / "write.py").write_text(code)
    (cache / "method.json").write_text(json.dumps({"method": "file", "summary": "edits the JSON", **method}))
    (cache / "write-layout.json").write_text(json.dumps(layout.describe(data)))


def planned(data: Path) -> writeback.Write:
    write = writeback.new_write("toyapp-1", "toyapp", str(data), TXNS)
    asyncio.run(writeback.plan(write))
    return write


def test_proven_writer_applies_and_only_adds(toy):
    data, cache = toy
    cache_writer(cache, data, GOOD_WRITER)
    write = planned(data)
    assert write.status == "ready", write.problems
    assert write.used_cache
    assert "Rent" in data.read_text() and "Coffee" not in data.read_text()  # proven on a copy only

    write = writeback.apply(write.id)
    assert write.status == "applied", write.problems
    assert "Coffee" in data.read_text()
    assert Path(write.backup).exists() and "Coffee" not in Path(write.backup).read_text()
    assert write.deltas == {"Assets:Checking": "-4.50", "Expenses:Dining": "4.50"}


def test_writer_that_changes_existing_rows_is_never_applied(toy, monkeypatch):
    data, cache = toy
    cache_writer(cache, data, SNEAKY_WRITER)
    before = data.read_text()

    async def no_agent(*args, **kwargs):  # the agent rewrite doesn't help either
        return True

    monkeypatch.setattr(writeback, "run_agent", no_agent)
    write = planned(data)
    assert write.status == "needs_human"
    assert data.read_text() == before


def test_agent_can_answer_none(toy, monkeypatch):
    data, _ = toy

    async def says_none(app, data_path, workspace, emit, **kwargs):
        (workspace / "method.json").write_text(json.dumps({"method": "none", "summary": "encrypted format, no API"}))
        return True

    monkeypatch.setattr(writeback, "run_agent", says_none)
    write = planned(data)
    assert write.status == "no_method"
    assert "encrypted" in write.problems[0]


def test_agent_never_gets_the_real_path(toy, monkeypatch):
    data, _ = toy
    seen = []

    async def agent(app, data_path, workspace, emit, prompt="", **kwargs):
        seen.append((data_path, prompt))
        (workspace / "write.py").write_text(GOOD_WRITER)
        (workspace / "method.json").write_text(json.dumps({"method": "file", "summary": "x"}))
        return True

    monkeypatch.setattr(writeback, "run_agent", agent)
    write = planned(data)
    assert write.status == "ready", write.problems
    data_path, prompt = seen[0]
    assert data_path != data and data_path.name == data.name
    assert str(data) not in prompt


def test_apply_refuses_when_data_changed_or_locked(toy):
    data, cache = toy
    cache_writer(cache, data, GOOD_WRITER, lock_files=["{data_path}.LCK"])
    write = planned(data)
    assert write.status == "ready"

    lock = Path(f"{data}.LCK")
    lock.touch()
    with pytest.raises(writeback.WriteRefused, match="locked"):
        writeback.apply(write.id)
    lock.unlink()

    data.write_text(data.read_text().replace("Rent", "Rent!"))
    with pytest.raises(writeback.WriteRefused, match="changed"):
        writeback.apply(write.id)
    assert "Coffee" not in data.read_text()


def test_failed_real_write_restores_backup(toy, monkeypatch):
    data, cache = toy
    cache_writer(cache, data, GOOD_WRITER)
    write = planned(data)
    before = data.read_text()
    real_prove = writeback.prove

    def prove_then_fail(*args):
        real_prove(*args)  # really writes, then pretend the check failed
        return ["balance mismatch"]

    monkeypatch.setattr(writeback, "prove", prove_then_fail)
    write = writeback.apply(write.id)
    assert write.status == "needs_human"
    assert data.read_text() == before
    assert "restored" in write.problems[-1]


def test_no_extractor_means_no_write(toy):
    data, cache = toy
    (cache / "extract.py").unlink()
    write = planned(data)
    assert write.status == "needs_human"
    assert "connect it first" in write.problems[0]
