"""Inline-filter parser."""

from __future__ import annotations

from datetime import datetime, timezone

from search_sidecar.retrieval.filters import parse_query

VALID_UUID = "11111111-1111-1111-1111-111111111111"
ANOTHER_UUID = "22222222-2222-2222-2222-222222222222"
NOW = datetime(2026, 4, 27, 12, 0, 0, tzinfo=timezone.utc)


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


# ---- Date filters (Unit 9) -----------------------------------------------


def test_modified_relative_n_days_sets_lower_bound():
    out = parse_query("modified:7d oauth", now=NOW)
    assert out.text == "oauth"
    assert out.modified_after is not None
    # Within 1ms of NOW - 7d
    delta = (NOW - out.modified_after).total_seconds()
    assert 7 * 86400 - 1 <= delta <= 7 * 86400 + 1


def test_created_strict_greater_uses_inclusive_lower_bound():
    """``created:>YYYY-MM-DD`` and ``created:>=YYYY-MM-DD`` both
    render as ``created_at >= …`` for v1 (inclusive)."""
    out = parse_query("created:>2026-01-01 oauth", now=NOW)
    assert out.text == "oauth"
    assert out.created_after == datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert out.created_before is None


def test_modified_strict_less_uses_eod_upper_bound():
    out = parse_query("modified:<2026-04-27 oauth", now=NOW)
    assert out.text == "oauth"
    assert out.modified_after is None
    assert out.modified_before is not None
    # Just before midnight 2026-04-27 → strictly before that day
    assert out.modified_before < datetime(
        2026, 4, 27, tzinfo=timezone.utc
    )


def test_modified_range_inclusive_both_ends():
    out = parse_query("modified:2026-01-01..2026-04-01 oauth", now=NOW)
    assert out.text == "oauth"
    assert out.modified_after == datetime(2026, 1, 1, tzinfo=timezone.utc)
    # End-of-day on the upper bound
    assert out.modified_before is not None
    assert out.modified_before.date().isoformat() == "2026-04-01"
    assert out.modified_before.hour == 23


def test_invalid_date_falls_through_to_text():
    out = parse_query("created:notadate oauth", now=NOW)
    assert out.text == "created:notadate oauth"
    assert out.created_after is None
    assert out.created_before is None


def test_relative_zero_days_falls_through():
    out = parse_query("modified:0d oauth", now=NOW)
    assert out.text == "modified:0d oauth"
    assert out.modified_after is None


def test_relative_excessive_days_falls_through():
    """Cap relative-day windows so a malicious caller can't synthesise
    a multi-thousand-year lower bound."""
    out = parse_query("modified:99999d oauth", now=NOW)
    assert out.text == "modified:99999d oauth"
    assert out.modified_after is None


def test_filter_sql_includes_date_clauses():
    out = parse_query(
        "kind:note modified:>=2026-01-01 created:<2026-12-31 oauth", now=NOW
    )
    sql = out.filter_sql()
    assert sql is not None
    assert "kind IN" in sql
    assert "modified_at >= '2026-01-01T00:00:00.000Z'" in sql
    assert "created_at <= '" in sql


def test_intersecting_relative_and_absolute_modified_takes_tighter_bound():
    """If both ``modified:7d`` and ``modified:>=2026-04-25`` are
    present and 2026-04-25 is *more recent* than NOW-7d, the absolute
    bound wins (parser keeps the larger lower bound)."""
    out = parse_query("modified:7d modified:>=2026-04-25 oauth", now=NOW)
    # NOW is 2026-04-27; NOW-7d is 2026-04-20. 2026-04-25 is tighter.
    assert out.modified_after == datetime(2026, 4, 25, tzinfo=timezone.utc)
