"""Inline-filter parser."""

from __future__ import annotations

from search_sidecar.retrieval.filters import parse_query

VALID_UUID = "11111111-1111-1111-1111-111111111111"
ANOTHER_UUID = "22222222-2222-2222-2222-222222222222"


def test_plain_query_has_no_filters():
    out = parse_query("oauth refresh tokens")
    assert out.text == "oauth refresh tokens"
    assert out.kinds == ()
    assert out.mounts == ()
    assert out.filter_sql() is None


def test_kind_single_value():
    out = parse_query("kind:note oauth")
    assert out.text == "oauth"
    assert out.kinds == ("note",)
    assert "kind IN ('note')" in out.filter_sql()


def test_kind_comma_separated():
    out = parse_query("kind:note,url oauth")
    assert out.text == "oauth"
    assert out.kinds == ("note", "url")
    sql = out.filter_sql()
    assert sql is not None
    assert "kind IN" in sql
    assert "'note'" in sql and "'url'" in sql


def test_kind_unknown_value_falls_through_to_text():
    out = parse_query("kind:dragon oauth")
    assert out.text == "kind:dragon oauth"
    assert out.kinds == ()


def test_kind_partially_valid_filters_to_known_subset():
    """``kind:note,dragon`` keeps the valid one and drops the rest;
    the token is consumed (not falling back to text) because at least
    one value matched the allowlist."""
    out = parse_query("kind:note,dragon oauth")
    assert out.kinds == ("note",)
    assert out.text == "oauth"


def test_mount_uuid_only():
    out = parse_query(f"mount:{VALID_UUID} oauth")
    assert out.text == "oauth"
    assert out.mounts == (VALID_UUID,)


def test_mount_non_uuid_falls_through():
    out = parse_query("mount:my-stuff oauth")
    assert out.text == "mount:my-stuff oauth"
    assert out.mounts == ()


def test_kind_and_mount_combine_with_and():
    out = parse_query(f"kind:note mount:{VALID_UUID} oauth")
    assert out.kinds == ("note",)
    assert out.mounts == (VALID_UUID,)
    sql = out.filter_sql()
    assert sql is not None
    assert " AND " in sql
    assert "kind IN" in sql and "mount_id IN" in sql


def test_dedupes_repeated_values_case_insensitively():
    out = parse_query("kind:note,Note,NOTE,url stuff")
    assert out.kinds == ("note", "url")


def test_empty_kind_value_falls_through():
    out = parse_query("kind: oauth")
    assert out.text == "kind: oauth"
    assert out.kinds == ()


def test_empty_query_returns_empty_parse():
    out = parse_query("")
    assert out.text == ""
    assert out.kinds == ()
    assert out.mounts == ()


def test_dropped_token_does_not_swallow_neighbouring_text():
    """The original query "kind:dragon oauth" must round-trip to
    a text query of "kind:dragon oauth" — invalid operator behaves
    as plain text per requirement R6."""
    out = parse_query("oauth kind:dragon refresh")
    assert out.text == "oauth kind:dragon refresh"


def test_filter_sql_escapes_single_quotes_defensively():
    """Operator values are validated against allowlists, but the
    escape function still must handle the malicious case as
    defence-in-depth (SEC-FINDING-005)."""
    from search_sidecar.retrieval.filters import _escape

    assert _escape("o'brien") == "o''brien"
