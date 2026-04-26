"""Writes the rendezvous file Rust reads to discover the sidecar's
``(port, token)``.

Lives at ``<storage_dir>/search/sidecar.runtime``. Format::

    {
      "port": 53127,
      "token": "0123...64-hex-chars..."
    }

Mode 0600 — same user only. Rust additionally rejects symlinks via
``fs::symlink_metadata`` when reading (see Rust's ``runtime_file.rs``).

Single-instance enforcement is via a sibling ``sidecar.lock`` file with
``fcntl.flock(LOCK_EX | LOCK_NB)``. Acquiring the lock fails fast with a
:class:`RuntimeError` if another sidecar process is already running. The
lock handle must stay open for the sidecar's lifetime; releasing it
(closing the handle, or process exit) drops the lock automatically.
"""

from __future__ import annotations

import fcntl
import json
import os
from io import BufferedWriter
from pathlib import Path


def write_runtime_file(path: Path, *, port: int, token: str) -> None:
    """Atomic write of ``{port, token}`` JSON with mode 0600.

    Uses the ``tmp + os.replace`` pattern so a crash mid-write cannot
    leave a half-written runtime file that Rust would parse and reject.
    """
    if not (1 <= port <= 65535):
        raise ValueError(f"invalid port {port}")
    if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        raise ValueError("token must be 64 lowercase hex chars")

    payload = json.dumps({"port": port, "token": token}, indent=2)
    tmp = path.with_suffix(path.suffix + ".tmp")

    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    os.replace(tmp, path)


def acquire_lock(lock_path: Path) -> BufferedWriter:
    """Acquire an exclusive non-blocking flock on ``lock_path``.

    The returned file handle owns the lock — keep it alive for the
    process's lifetime. If another sidecar already holds the lock,
    :class:`RuntimeError` is raised immediately.
    """
    # Touch the file with mode 0600 if it does not exist yet.
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o600)
    handle = os.fdopen(fd, "wb")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as err:
        handle.close()
        raise RuntimeError(
            f"another sidecar instance holds the lock at {lock_path}"
        ) from err
    return handle


def remove_runtime_file(path: Path) -> None:
    """Best-effort cleanup on shutdown."""
    try:
        path.unlink()
    except FileNotFoundError:
        pass
