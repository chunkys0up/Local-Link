import gzip
import sqlite3

import layout


def test_sqlite_lists_tables_and_columns(tmp_path):
    db = tmp_path / "books.db"
    conn = sqlite3.connect(db)
    conn.execute("create table splits (id, txn_id, value)")
    conn.commit()
    conn.close()
    assert layout.describe(db) == ["table splits(id, txn_id, value)"]


def test_sqlite_column_change_is_detected(tmp_path):
    db = tmp_path / "books.db"
    conn = sqlite3.connect(db)
    conn.execute("create table splits (id, value)")
    conn.commit()
    before = layout.describe(db)
    conn.execute("alter table splits add column memo")
    conn.commit()
    conn.close()
    added, removed = layout.diff(before, layout.describe(db))
    assert added == ["table splits(id, value, memo)"]
    assert removed == ["table splits(id, value)"]


def test_gzipped_xml_lists_element_paths_not_values(tmp_path):
    book = tmp_path / "book.gnucash"
    book.write_bytes(gzip.compress(b"<book><txn><value>1</value></txn><txn><value>2</value></txn></book>"))
    assert layout.describe(book) == ["xml book", "xml book/txn", "xml book/txn/value"]


def test_csv_header(tmp_path):
    f = tmp_path / "export.csv"
    f.write_text("date,account,amount\n2026-01-01,Rent,10\n")
    assert layout.describe(f) == ["csv columns(date, account, amount)"]
