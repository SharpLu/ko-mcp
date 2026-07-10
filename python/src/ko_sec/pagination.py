"""Pagination helper.

>>> from ko_sec import KoClient, paginate
>>> ko = KoClient()
>>> for trade in paginate(ko.congress.trades, ticker="NVDA", per_page=100):
...     ...  # iterates across pages until exhausted
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Callable

from .result import ApiResult


def paginate(
    method: Callable[..., ApiResult],
    *args: Any,
    per_page: int = 100,
    max_pages: int = 100,
    **kwargs: Any,
) -> Iterator[Any]:
    """Iterate rows across pages of any list method.

    Stops when the server is exhausted: page shorter than the *effective*
    page size (the server may cap ``per_page`` below what you asked for —
    detected via ``meta.per_page`` or the first page's length), when
    ``total_count`` is reached, when an endpoint ignores ``page`` and
    repeats itself, or after ``max_pages`` (safety valve). The wrapped
    method must accept ``page`` and ``per_page`` keyword arguments.
    """
    seen = 0
    page_size: int | None = None
    prev_first: Any = _SENTINEL
    for page in range(1, max_pages + 1):
        result = method(*args, page=page, per_page=per_page, **kwargs)
        rows = result.rows
        if not rows:
            return
        # An endpoint that ignores `page` would replay the same rows forever.
        if rows[0] == prev_first:
            return
        prev_first = rows[0]
        if page_size is None:
            page_size = _effective_page_size(result, len(rows))
        yield from rows
        seen += len(rows)
        total = result.total_count
        if total and seen >= total:
            return
        if len(rows) < page_size:
            return


_SENTINEL = object()


def _effective_page_size(result: ApiResult, first_page_len: int) -> int:
    """The page size the server actually used (it may cap the request)."""
    echoed = result.meta.get("per_page")
    if echoed is None and isinstance(result.data, dict):
        echoed = result.data.get("per_page")
    try:
        return int(echoed) if echoed else first_page_len
    except (TypeError, ValueError):
        return first_page_len
