"""LanceDB schema migrations for the authoritative chunk store."""

from __future__ import annotations

import logging

import lancedb
import pyarrow as pa

LOG = logging.getLogger("search_sidecar.storage.migrations")

ADDITIVE_FIELDS: tuple[pa.Field, ...] = (
    pa.field("role", pa.string()),
    pa.field("content_version", pa.string()),
)


def run_migrations(table: lancedb.Table) -> None:
    """Apply additive LanceDB table migrations in place."""
    existing = set(table.schema.names)
    for new_field in ADDITIVE_FIELDS:
        if new_field.name in existing:
            continue
        try:
            table.add_columns(new_field)
        except Exception as err:
            # Idempotent: another process may have added it between
            # the schema read and the call. Legacy reads stay safe
            # because every consumer uses ``role_or_default``. Log
            # so a real failure (disk full, permissions) surfaces in
            # operator logs rather than disappearing silently.
            LOG.warning(
                "lancedb migration add_columns(%s) failed: %s",
                new_field.name,
                err,
            )
