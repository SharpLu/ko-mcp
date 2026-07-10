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

    Stops when a page comes back short/empty, when ``meta.total_count`` is
    reached, or after ``max_pages`` (safety valve). The wrapped method must
    accept ``page`` and ``per_page`` keyword arguments.
    """
    seen = 0
    for page in range(1, max_pages + 1):
        result = method(*args, page=page, per_page=per_page, **kwargs)
        rows = result.rows
        if not rows:
            return
        yield from rows
        seen += len(rows)
        total = result.total_count
        if len(rows) < per_page or (total and seen >= total):
            return
