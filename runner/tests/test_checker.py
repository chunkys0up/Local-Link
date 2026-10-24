from decimal import Decimal

from checker import check
from rows import NormalizedRow


def row(account: str, amount: str, side: str, source: str) -> NormalizedRow:
    return NormalizedRow(
        date="2026-10-01",
        account=account,
        amount=Decimal(amount),
        side=side,
        source=source,
        run_id="run_test",
    )


BALANCED = [
    row("Assets:Checking", "2500.00", "debit", "t1/s1"),
    row("Income:Sales", "2500.00", "credit", "t1/s2"),
    row("Expenses:Rent", "1800.00", "debit", "t2/s1"),
    row("Assets:Checking", "1800.00", "credit", "t2/s2"),
]


def test_passes_clean_books():
    assert check(BALANCED).differences == []


def test_flags_50_dollars_parked_in_suspense():
    rows = BALANCED + [
        row("Expenses:Supplies", "50.00", "debit", "t3/s1"),
        row("Suspense", "50.00", "credit", "t3/s2"),
    ]
    assert check(rows).differences == ["unexpected nonzero account Suspense: -50.00"]


def test_flags_unbalanced_rows():
    rows = BALANCED + [row("Expenses:Supplies", "50.00", "debit", "t3/s1")]
    assert check(rows).differences == ["debits 4,350.00 != credits 4,300.00 (off by 50.00)"]


def test_flags_duplicate_source_ids():
    rows = BALANCED[:2] + [
        row("Expenses:Rent", "1800.00", "debit", "t1/s1"),
        row("Assets:Checking", "1800.00", "credit", "t1/s2"),
    ]
    assert check(rows).differences == [
        "2 source IDs are used by more than one row: t1/s1, t1/s2"
    ]


def test_fails_on_no_rows():
    assert check([]).differences == ["no rows were extracted"]
