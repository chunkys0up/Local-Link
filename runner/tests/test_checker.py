from decimal import Decimal

from checker import check
from rows import NormalizedRow, Reference


def row(account: str, amount: str, side: str) -> NormalizedRow:
    return NormalizedRow(
        date="2026-10-01",
        account=account,
        amount=Decimal(amount),
        side=side,
        source="test",
        run_id="run_test",
    )


BALANCED = [
    row("Assets:Checking", "2500.00", "debit"),
    row("Income:Sales", "2500.00", "credit"),
    row("Expenses:Rent", "1800.00", "debit"),
    row("Assets:Checking", "1800.00", "credit"),
]


def ref(count: int, debits: str, credits: str) -> Reference:
    return Reference(
        row_count=count, total_debits=Decimal(debits), total_credits=Decimal(credits)
    )


def test_passes_clean_books():
    result = check(BALANCED, ref(4, "4300.00", "4300.00"))
    assert result.passed
    assert result.differences == []


def test_flags_50_dollars_parked_in_suspense():
    # Like book-v3: balanced and matching the reference, but $50 sits in Suspense.
    rows = BALANCED + [
        row("Expenses:Supplies", "50.00", "debit"),
        row("Suspense", "50.00", "credit"),
    ]
    result = check(rows, ref(6, "4350.00", "4350.00"))
    assert not result.passed
    assert result.differences == ["unexpected nonzero account Suspense: -50.00"]


def test_flags_unbalanced_rows():
    rows = BALANCED + [row("Expenses:Supplies", "50.00", "debit")]
    result = check(rows, ref(5, "4350.00", "4300.00"))
    assert not result.passed
    assert "debits 4,350.00 != credits 4,300.00 (off by 50.00)" in result.differences


def test_flags_row_count_and_total_mismatch():
    result = check(BALANCED, ref(5, "4350.00", "4350.00"))
    assert result.differences == [
        "row count 4 != reference 5",
        "total debits 4,300.00 != reference 4,350.00 (off by 50.00)",
        "total credits 4,300.00 != reference 4,350.00 (off by 50.00)",
    ]


def test_fails_on_no_rows():
    result = check([], ref(0, "0", "0"))
    assert result.differences == ["no rows were extracted"]
