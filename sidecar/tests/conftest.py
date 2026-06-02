"""Shared pytest fixtures.

Test-suite-wide hooks live here so individual test files don't have
to import + wire them up themselves.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_provider_secret_cache():
    """Drop the in-process provider-secret cache between tests.

    The ``providers.keychain`` module memoises secrets for the
    sidecar process lifetime, but it leaks state between tests within
    a single pytest session. A test that populated the cache with one
    set of secrets would shadow the intent of a later test that points
    the env-file reader at different fixtures.

    Cheap to call; the cache is a small dict.
    """
    from search_sidecar.providers import keychain

    keychain.invalidate_provider_secret_cache()
    yield
    keychain.invalidate_provider_secret_cache()
