"""Runtime-file write + lock behaviour.

Round-trips the same JSON shape Rust's
``src-tauri/src/services/search/runtime_file.rs`` parses; if either
side drifts, both suites should fail.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from search_sidecar.runtime_file import (
    acquire_lock,
    remove_runtime_file,
    write_runtime_file,
)

VALID_TOKEN = "0123456789abcdef" * 4  # 64 hex chars


def test_write_runtime_file_round_trips_port_and_token(tmp_path: Path):
    target = tmp_path / "sidecar.runtime"
    write_runtime_file(target, port=53127, token=VALID_TOKEN)
    body = json.loads(target.read_text())
    assert body == {"port": 53127, "token": VALID_TOKEN}


def test_write_runtime_file_sets_mode_0600(tmp_path: Path):
    target = tmp_path / "sidecar.runtime"
    write_runtime_file(target, port=1, token=VALID_TOKEN)
    mode = stat.S_IMODE(target.stat().st_mode)
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"


def test_write_runtime_file_overwrites_existing_atomically(tmp_path: Path):
    target = tmp_path / "sidecar.runtime"
    target.write_text("stale content")
    write_runtime_file(target, port=4242, token=VALID_TOKEN)
    body = json.loads(target.read_text())
    assert body["port"] == 4242
    # No stray .tmp left behind.
    assert not (tmp_path / "sidecar.runtime.tmp").exists()


def test_write_runtime_file_rejects_invalid_port(tmp_path: Path):
    target = tmp_path / "sidecar.runtime"
    for bad_port in (0, -1, 65536, 100_000):
        with pytest.raises(ValueError):
            write_runtime_file(target, port=bad_port, token=VALID_TOKEN)


def test_write_runtime_file_rejects_invalid_token(tmp_path: Path):
    target = tmp_path / "sidecar.runtime"
    cases = [
        "",
        "abc",  # too short
        "A" * 64,  # uppercase hex
        "g" * 64,  # non-hex char
        VALID_TOKEN + "0",  # too long
    ]
    for bad in cases:
        with pytest.raises(ValueError):
            write_runtime_file(target, port=1, token=bad)


def test_acquire_lock_succeeds_when_unheld(tmp_path: Path):
    lock = tmp_path / "sidecar.lock"
    handle = acquire_lock(lock)
    assert lock.exists()
    handle.close()


def test_acquire_lock_blocks_second_acquirer(tmp_path: Path):
    lock = tmp_path / "sidecar.lock"
    held = acquire_lock(lock)
    try:
        with pytest.raises(RuntimeError, match="another sidecar instance"):
            acquire_lock(lock)
    finally:
        held.close()


def test_acquire_lock_writes_pid_into_file(tmp_path: Path):
    """Holder writes its PID so a supervising process can read it
    and SIGTERM the holder on next start."""
    import os

    lock = tmp_path / "sidecar.lock"
    held = acquire_lock(lock)
    try:
        body = lock.read_text("ascii").strip()
        assert body == str(os.getpid())
    finally:
        held.close()


def test_blocked_acquirer_error_message_includes_holder_pid(tmp_path: Path):
    import os

    lock = tmp_path / "sidecar.lock"
    held = acquire_lock(lock)
    try:
        with pytest.raises(RuntimeError, match=f"holder pid={os.getpid()}"):
            acquire_lock(lock)
    finally:
        held.close()


def test_acquire_lock_releases_on_close(tmp_path: Path):
    lock = tmp_path / "sidecar.lock"
    first = acquire_lock(lock)
    first.close()
    second = acquire_lock(lock)
    second.close()


def test_remove_runtime_file_is_idempotent(tmp_path: Path):
    target = tmp_path / "sidecar.runtime"
    remove_runtime_file(target)  # no-op on missing
    write_runtime_file(target, port=1, token=VALID_TOKEN)
    remove_runtime_file(target)
    assert not target.exists()
    remove_runtime_file(target)  # still no error
