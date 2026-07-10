from __future__ import annotations

from ko_sec import ApiResult


def test_rows_plain_list() -> None:
    result = ApiResult([{"a": 1}, {"a": 2}], {})
    assert result.rows == [{"a": 1}, {"a": 2}]
    assert len(result) == 2
    assert result[1] == {"a": 2}
    assert list(result) == result.rows
    assert bool(result)


def test_rows_double_nested_object() -> None:
    # /stock-holders/:ticker nests rows at data.data
    result = ApiResult({"data": [{"cik": "1"}], "page": 1}, {})
    assert result.rows == [{"cik": "1"}]


def test_rows_plain_object_wrapped_as_single_row() -> None:
    # /crypto/exposure-summary returns an object
    result = ApiResult({"complex": {}, "products": []}, {})
    assert result.rows == [{"complex": {}, "products": []}]
    assert len(result) == 1


def test_truncated_and_total_count() -> None:
    result = ApiResult([], {"truncated": True, "total_count": "42"})
    assert result.truncated
    assert result.total_count == 42


def test_total_count_falls_back_to_total_available() -> None:
    result = ApiResult([], {"total_available": 7})
    assert result.total_count == 7


def test_empty_result_is_falsy() -> None:
    assert not ApiResult([], {})


def test_repr_mentions_truncation() -> None:
    assert "truncated" in repr(ApiResult([1], {"truncated": True}))
