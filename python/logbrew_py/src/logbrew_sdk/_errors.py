"""Stable public SDK error types shared by delivery components."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class SdkError(Exception):
    """Stable public SDK error with parseable code and message fields."""

    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"
