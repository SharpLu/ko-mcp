from __future__ import annotations

from typing import Any

from ko_sec import paginate
from ko_sec.result import ApiResult


def make_method(pages: list[list[Any]], total: int):
    calls = []

    def method(*args: Any, page: int = 1, per_page: int = 100, **kwargs: Any) -> ApiResult:
        calls.append(page)
        data = pages[page - 1] if page <= len(pages) else []
        return ApiResult(data, {"total_count": total, "page": page, "per_page": per_page})

    return method, calls


def test_paginate_stops_on_short_page() -> None:
    method, calls = make_method([[1, 2, 3], [4]], total=4)
    rows = list(paginate(method, per_page=3))
    assert rows == [1, 2, 3, 4]
    assert calls == [1, 2]


def test_paginate_stops_at_total_count() -> None:
    method, calls = make_method([[1, 2], [3, 4]], total=4)
    rows = list(paginate(method, per_page=2))
    assert rows == [1, 2, 3, 4]
    assert calls == [1, 2]


def test_paginate_stops_on_empty_page() -> None:
    method, calls = make_method([[]], total=0)
    assert list(paginate(method, per_page=2)) == []
    assert calls == [1]


def test_paginate_detects_page_ignoring_endpoint() -> None:
    def endless(*args: Any, page: int = 1, per_page: int = 2, **kwargs: Any) -> ApiResult:
        return ApiResult([1, 2], {})

    # identical first row on consecutive pages → endpoint ignores `page`, stop
    rows = list(paginate(endless, per_page=2, max_pages=5))
    assert rows == [1, 2]


def test_paginate_max_pages_safety_valve() -> None:
    def varied(*args: Any, page: int = 1, per_page: int = 2, **kwargs: Any) -> ApiResult:
        return ApiResult([page * 10, page * 10 + 1], {"per_page": 2})

    rows = list(paginate(varied, per_page=2, max_pages=5))
    assert len(rows) == 10  # 5 pages, then the valve stops it
