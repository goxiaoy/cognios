"""Inline-filter parser for the search query language.

Phase 2 / Unit 6 part 1 supports:

- ``kind:note`` (single value)
- ``kind:note,url`` (comma-separated; OR semantics within the operator)
- ``mount:<id>`` (single value; the UI surface treats this as the mount
  display name and resolves to the node id Rust-side, so by the time
  the sidecar sees the value it is a UUID)

Phase 4 / Unit 9 extends this with date filters:

- ``created:>YYYY-MM-DD`` / ``created:<YYYY-MM-DD`` — strict bound
- ``created:>=YYYY-MM-DD`` / ``created:<=YYYY-MM-DD`` — inclusive bound
- ``created:YYYY-MM-DD..YYYY-MM-DD`` — inclusive range
- ``created:Nd`` — within the last N days (relative; max N=3650)
- ``modified:`` accepts the same forms.

Tokens that fail validation fall through to plain query text per
requirement R6 (silent fallthrough — no parse-error UI).

SEC-FINDING-005: every value that survives parsing is restricted to
an allowlist (for ``kind``), a UUID-shape regex (for ``mount``), or
parsed via :func:`datetime.strptime` (for date filters). Invalid
values are dropped silently; the operator is treated as if it weren't
present, and the original token rejoins the plain-text query.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

KIND_ALLOWLIST = frozenset(
    {"note", "file", "url", "folder", "mount"}
)

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Operators we recognise. Order matters only for the docstring; the
# parser scans every whitespace-separated token.
SUPPORTED_OPERATORS = ("kind:", "mount:", "created:", "modified:")

# Hard cap on the lookback window for ``created:Nd`` / ``modified:Nd``
# so a user can't synthesise an absurd timestamp via the UI / inline
# syntax.
MAX_RELATIVE_DAYS = 3650


@dataclass(frozen=True)
class ParsedQuery:
    """Output of :func:`parse_query`."""

    text: str
    kinds: tuple[str, ...] = field(default_factory=tuple)
    mounts: tuple[str, ...] = field(default_factory=tuple)
    # Date bounds are stored as datetimes with UTC tz so the SQL
    # rendering can emit ISO 8601 strings that lancedb / DataFusion
    # auto-coerces against ``timestamp[ms, tz=UTC]`` columns.
    created_after: datetime | None = None
    created_before: datetime | None = None
    modified_after: datetime | None = None
    modified_before: datetime | None = None

    def filter_sql(self) -> str | None:
        """Render the filter as a lancedb WHERE clause, or None when
        no constraints survived parsing."""
        clauses: list[str] = []
        if self.kinds:
            quoted = ", ".join(f"'{_escape(k)}'" for k in self.kinds)
            clauses.append(f"kind IN ({quoted})")
        if self.mounts:
            quoted = ", ".join(f"'{_escape(m)}'" for m in self.mounts)
            clauses.append(f"mount_id IN ({quoted})")
        if self.created_after is not None:
            clauses.append(f"created_at >= '{_iso(self.created_after)}'")
        if self.created_before is not None:
            clauses.append(f"created_at <= '{_iso(self.created_before)}'")
        if self.modified_after is not None:
            clauses.append(f"modified_at >= '{_iso(self.modified_after)}'")
        if self.modified_before is not None:
            clauses.append(f"modified_at <= '{_iso(self.modified_before)}'")
        if not clauses:
            return None
        return " AND ".join(clauses)


def parse_query(raw: str, *, now: datetime | None = None) -> ParsedQuery:
    """Split ``raw`` into operator-bearing tokens and free text.

    ``now`` is injectable for deterministic relative-date tests; defaults
    to ``datetime.now(timezone.utc)``.
    """
    if not raw:
        return ParsedQuery(text="")
    now = now or datetime.now(timezone.utc)
    tokens = raw.split()
    text_tokens: list[str] = []
    kinds: list[str] = []
    mounts: list[str] = []
    created_after: datetime | None = None
    created_before: datetime | None = None
    modified_after: datetime | None = None
    modified_before: datetime | None = None

    for token in tokens:
        if token.startswith("kind:"):
            values = _parse_kind(token[len("kind:") :])
            if values:
                kinds.extend(values)
            else:
                text_tokens.append(token)
        elif token.startswith("mount:"):
            value = _parse_mount(token[len("mount:") :])
            if value:
                mounts.append(value)
            else:
                text_tokens.append(token)
        elif token.startswith("created:"):
            bounds = _parse_date(token[len("created:") :], now=now)
            if bounds is None:
                text_tokens.append(token)
            else:
                lo, hi = bounds
                created_after = _max_dt(created_after, lo)
                created_before = _min_dt(created_before, hi)
        elif token.startswith("modified:"):
            bounds = _parse_date(token[len("modified:") :], now=now)
            if bounds is None:
                text_tokens.append(token)
            else:
                lo, hi = bounds
                modified_after = _max_dt(modified_after, lo)
                modified_before = _min_dt(modified_before, hi)
        else:
            text_tokens.append(token)

    return ParsedQuery(
        text=" ".join(text_tokens).strip(),
        kinds=_dedup_lower(kinds),
        mounts=_dedup_lower(mounts),
        created_after=created_after,
        created_before=created_before,
        modified_after=modified_after,
        modified_before=modified_before,
    )


def _parse_kind(value: str) -> list[str]:
    if not value:
        return []
    parts = [p.strip().lower() for p in value.split(",")]
    return [p for p in parts if p in KIND_ALLOWLIST]


def _parse_mount(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    if not UUID_RE.match(value):
        return None
    return value.lower()


_RELATIVE_DAYS_RE = re.compile(r"^(\d{1,4})d$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_date(
    value: str, *, now: datetime
) -> tuple[datetime | None, datetime | None] | None:
    """Parse a date filter token's value. Returns ``(after, before)``
    bounds or ``None`` if invalid.

    Either bound may be ``None`` to indicate an open end. Both bounds
    are inclusive (the SQL rendering uses ``>=`` / ``<=``).
    """
    if not value:
        return None
    # Relative: ``Nd`` (within the last N days)
    rel_match = _RELATIVE_DAYS_RE.match(value)
    if rel_match:
        days = int(rel_match.group(1))
        if days <= 0 or days > MAX_RELATIVE_DAYS:
            return None
        return (now - timedelta(days=days), None)
    # Range: ``YYYY-MM-DD..YYYY-MM-DD`` (inclusive both ends)
    if ".." in value:
        lo_str, _, hi_str = value.partition("..")
        lo = _parse_iso_date(lo_str)
        hi = _parse_iso_date(hi_str)
        if lo is None or hi is None:
            return None
        if lo > hi:
            return None
        # Push hi to end-of-day so ``2026-01-01..2026-01-01`` covers the
        # full day rather than a single instant.
        hi_eod = hi.replace(hour=23, minute=59, second=59, microsecond=999000)
        return (lo, hi_eod)
    # Bounded: ``>YYYY-MM-DD`` / ``<YYYY-MM-DD`` / ``>=YYYY-MM-DD`` / ``<=YYYY-MM-DD``
    op, rest = _split_op(value)
    iso = _parse_iso_date(rest)
    if iso is None:
        return None
    if op in (">", ">="):
        return (iso, None)
    if op == "<":
        return (None, iso - timedelta(microseconds=1000))
    if op == "<=":
        return (None, iso.replace(hour=23, minute=59, second=59, microsecond=999000))
    if op == "=":
        # Bare ``YYYY-MM-DD`` covers the full day.
        return (iso, iso.replace(hour=23, minute=59, second=59, microsecond=999000))
    return None


def _split_op(value: str) -> tuple[str, str]:
    """Strip a leading ``>``, ``>=``, ``<``, ``<=`` and return ``(op, rest)``.

    Bare values come back as ``("=", value)`` so the caller can treat
    ``created:2026-01-01`` as same-day equality."""
    if value.startswith(">="):
        return (">=", value[2:])
    if value.startswith("<="):
        return ("<=", value[2:])
    if value.startswith(">"):
        return (">", value[1:])
    if value.startswith("<"):
        return ("<", value[1:])
    return ("=", value)


def _parse_iso_date(value: str) -> datetime | None:
    if not _DATE_RE.match(value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _max_dt(a: datetime | None, b: datetime | None) -> datetime | None:
    """Return the *most-restrictive* lower bound (the larger of the two)."""
    if a is None:
        return b
    if b is None:
        return a
    return a if a > b else b


def _min_dt(a: datetime | None, b: datetime | None) -> datetime | None:
    """Return the *most-restrictive* upper bound (the smaller of the two)."""
    if a is None:
        return b
    if b is None:
        return a
    return a if a < b else b


def _dedup_lower(values: list[str]) -> tuple[str, ...]:
    """Preserve insertion order while deduplicating case-insensitively."""
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        key = v.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return tuple(out)


def _escape(value: str) -> str:
    """Single-quote escape for inclusion in a lancedb WHERE clause.

    The ``kind`` and ``mount`` validators above already restrict input
    to safe characters, but the escape is belt-and-braces for the
    SEC-FINDING-005 mitigation in lieu of parameterised predicates.
    """
    return value.replace("'", "''")


def _iso(dt: datetime) -> str:
    """Render a ``datetime`` for inclusion in a lancedb WHERE clause.

    Uses a fixed ISO 8601 form that DataFusion auto-coerces against
    ``timestamp[ms, tz=UTC]`` columns. Always includes a ``Z`` suffix
    so the comparison is unambiguously UTC.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
