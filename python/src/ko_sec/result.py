"""Response envelope wrapper.

Every ko.io v1 response is ``{"data": ..., "meta": {...}}``. ``data`` is
usually a list of rows, but a few endpoints return objects (documented on
the corresponding SDK methods). :class:`ApiResult` keeps the envelope
intact while making the common case — iterating rows — ergonomic.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any


class ApiResult:
    """A parsed ``{data, meta}`` API response.

    - ``result.data`` — the raw payload (list or dict, endpoint-dependent)
    - ``result.meta`` — pagination and plan metadata
    - ``result.rows`` — best-effort list view of the payload
    - iteration / ``len()`` / indexing operate on ``rows``
    """

    __slots__ = ("data", "meta")

    def __init__(self, data: Any, meta: dict[str, Any]) -> None:
        self.data = data
        self.meta = meta

    @property
    def rows(self) -> list[Any]:
        """Normalized row list.

        Handles the three envelope shapes found on v1: a plain list, a
        paginated object with rows nested at ``data["data"]``, and plain
        objects (returned as a single-element list).
        """
        if isinstance(self.data, list):
            return self.data
        if isinstance(self.data, dict):
            inner = self.data.get("data")
            if isinstance(inner, list):
                return inner
            return [self.data]
        return [self.data] if self.data is not None else []

    @property
    def truncated(self) -> bool:
        """True when the plan's row cap truncated this response.

        Upgrade hints, if any, are in ``meta["upgrade_hint"]``.
        """
        return bool(self.meta.get("truncated"))

    @property
    def total_count(self) -> int:
        """Total rows available server-side (0 when the endpoint omits it)."""
        value = self.meta.get("total_count", self.meta.get("total_available", 0))
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def __iter__(self) -> Iterator[Any]:
        return iter(self.rows)

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> Any:
        return self.rows[index]

    def __bool__(self) -> bool:
        return len(self.rows) > 0

    def __repr__(self) -> str:
        if isinstance(self.data, list):
            shape = f"{len(self.rows)} rows"
        else:
            shape = type(self.data).__name__
        extra = " truncated" if self.truncated else ""
        return f"<ApiResult {shape}{extra}>"
