"""Fixed checker: compares extracted rows against the app's own reference total."""

import re
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal

from rows import NormalizedRow, Reference

# Cap per-account lines so a naming mismatch doesn't flood the report.
MAX_ACCOUNT_DIFFERENCES = 10

# Accounts that should net to zero in healthy books.
SUSPECT_ACCOUNT = re.compile(
    r"suspense|clearing|uncategori[sz]ed|unknown|imbalance|orphan|ask my accountant",
    re.IGNORECASE,
)


@dataclass
class CheckResult:
    passed: bool
    differences: list[str] = field(default_factory=list)


def money(value: Decimal) -> str:
    return f"{value:,.2f}"


def check(rows: list[NormalizedRow], reference: Reference) -> CheckResult:
    differences: list[str] = []

    if not rows:
        differences.append("no rows were extracted")

    debits = sum((r.amount for r in rows if r.side == "debit"), Decimal(0))
    credits = sum((r.amount for r in rows if r.side == "credit"), Decimal(0))

    if debits != credits:
        differences.append(
            f"debits {money(debits)} != credits {money(credits)} "
            f"(off by {money(abs(debits - credits))})"
        )
    if len(rows) != reference.row_count:
        differences.append(
            f"row count {len(rows)} != reference {reference.row_count}"
        )
    if debits != reference.total_debits:
        differences.append(
            f"total debits {money(debits)} != reference {money(reference.total_debits)} "
            f"(off by {money(abs(debits - reference.total_debits))})"
        )
    if credits != reference.total_credits:
        differences.append(
            f"total credits {money(credits)} != reference {money(reference.total_credits)} "
            f"(off by {money(abs(credits - reference.total_credits))})"
        )

    balances: dict[str, Decimal] = defaultdict(Decimal)
    for r in rows:
        balances[r.account] += r.amount if r.side == "debit" else -r.amount

    # Per-account comparison catches what totals can't: postings on the wrong
    # account, or debit and credit swapped within a transaction.
    account_differences = []
    for account in sorted(set(balances) | set(reference.accounts)):
        extracted = balances.get(account, Decimal(0))
        expected = reference.accounts.get(account, Decimal(0))
        if extracted != expected:
            account_differences.append(
                f"account {account}: extracted {money(extracted)} vs reference "
                f"{money(expected)} (off by {money(abs(extracted - expected))})"
            )
    differences += account_differences[:MAX_ACCOUNT_DIFFERENCES]
    if len(account_differences) > MAX_ACCOUNT_DIFFERENCES:
        differences.append(
            f"...and {len(account_differences) - MAX_ACCOUNT_DIFFERENCES} more account balances differ"
        )

    for account, balance in sorted(balances.items()):
        if balance != 0 and SUSPECT_ACCOUNT.search(account):
            differences.append(
                f"unexpected nonzero account {account}: {money(balance)}"
            )

    return CheckResult(passed=not differences, differences=differences)
