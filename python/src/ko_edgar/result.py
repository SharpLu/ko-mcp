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

        Deterministic rule covering every v1 envelope shape:

        1. ``data`` is a list → ``data``
        2. ``data["data"]`` is a list → that list (paginated objects)
        3. ``data`` is an object with exactly one list-valued field → that
           list (e.g. ``holders``, ``trend``, ``quarters``, ``insiders``)
        4. anything else → ``[data]`` (single-row view of an object)
        """
        if isinstance(self.data, list):
            return self.data
        if isinstance(self.data, dict):
            inner = self.data.get("data")
            if isinstance(inner, list):
                return inner
            list_fields = [v for v in self.data.values() if isinstance(v, list)]
            if len(list_fields) == 1:
                return list_fields[0]
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
        """Total rows available server-side (0 when the endpoint omits it).

        Checks ``meta.total_count`` / ``meta.total_available`` first, then
        the data-level ``total_count`` / ``totalCount`` that a few nested
        endpoints (stock-holders, crypto holders) use instead.
        """
        value = self.meta.get("total_count")
        if value is None:
            value = self.meta.get("total_available")
        if value is None and isinstance(self.data, dict):
            value = self.data.get("total_count")
            if value is None:
                value = self.data.get("totalCount")
        if value is None:
            return 0
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
