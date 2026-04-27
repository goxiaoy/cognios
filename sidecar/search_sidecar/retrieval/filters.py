"""Inline-filter parser for the search query language.

Phase 2 / Unit 6 part 1 supports:

- ``kind:note`` (single value)
- ``kind:note,url`` (comma-separated; OR semantics within the operator)
- ``mount:<id>`` (single value; the UI surface treats this as the mount
  display name and resolves to the node id Rust-side, so by the time
  the sidecar sees the value it is a UUID)

Date filters (``created:7d``, ``modified:>2026-01-01``) are P1 — they
land alongside the dedicated search view's filter bar (Unit 9). Until
then, date tokens fall through as plain query text per requirement R6.

SEC-FINDING-005: every value that survives parsing is restricted to
an allowlist (for ``kind``) or a UUID-shape regex (for ``mount``).
Invalid values are dropped silently; the operator is treated as if it
weren't present, and the original token rejoins the plain-text query
so the user gets some result rather than a parse error.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

KIND_ALLOWLIST = frozenset(
    {"note", "file", "url", "folder", "mount", "directory"}
)

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Operators we recognise. Order matters only for the docstring; the
# parser scans every whitespace-separated token.
SUPPORTED_OPERATORS = ("kind:", "mount:")


@dataclass(frozen=True)
class ParsedQuery:
    """Output of :func:`parse_query`."""

    text: str
    kinds: tuple[str, ...] = field(default_factory=tuple)
    mounts: tuple[str, ...] = field(default_factory=tuple)

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
        if not clauses:
            return None
        return " AND ".join(clauses)


def parse_query(raw: str) -> ParsedQuery:
    """Split ``raw`` into operator-bearing tokens and free text."""
    if not raw:
        return ParsedQuery(text="")
    tokens = raw.split()
    text_tokens: list[str] = []
    kinds: list[str] = []
    mounts: list[str] = []

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
        else:
            text_tokens.append(token)

    return ParsedQuery(
        text=" ".join(text_tokens).strip(),
        kinds=_dedup_lower(kinds),
        mounts=_dedup_lower(mounts),
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
