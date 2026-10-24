"""The one row shape every extractor must produce."""

import datetime as dt
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class NormalizedRow(BaseModel):
    """One posting line (debit or credit) from the source app."""

    model_config = ConfigDict(extra="forbid")

    date: dt.date
    account: str = Field(min_length=1)
    amount: Decimal = Field(ge=0, decimal_places=2)
    side: Literal["debit", "credit"]
    memo: str = ""
    source: str = Field(min_length=1)
    run_id: str = Field(min_length=1)

