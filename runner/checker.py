"""Fixed checker: verifies extracted rows before anything is loaded."""

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal

from rows import NormalizedRow

MAX_LISTED = 5

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


def check(rows: list[NormalizedRow]) -> CheckResult:
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

    # Loads are diffed row by row on source, so it must identify exactly one row.
    duplicates = [s for s, n in Counter(r.source for r in rows).items() if n > 1]
    if duplicates:
        listed = ", ".join(duplicates[:MAX_LISTED])
        more = f" and {len(duplicates) - MAX_LISTED} more" if len(duplicates) > MAX_LISTED else ""
        differences.append(f"{len(duplicates)} source IDs are used by more than one row: {listed}{more}")

    balances: dict[str, Decimal] = defaultdict(Decimal)
    for r in rows:
        balances[r.account] += r.amount if r.side == "debit" else -r.amount
    for account, balance in sorted(balances.items()):
        if balance != 0 and SUSPECT_ACCOUNT.search(account):
            differences.append(f"unexpected nonzero account {account}: {money(balance)}")

    return CheckResult(passed=not differences, differences=differences)
