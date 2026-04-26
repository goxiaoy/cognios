"""CLI entry point — invoked by Tauri's supervisor.

Usage::

    python -m search_sidecar serve --storage-dir /Users/<name>/.cogios

Tauri's capability ACL (``src-tauri/capabilities/default.json``)
constrains the ``--storage-dir`` argument to absolute POSIX paths;
the sidecar additionally rejects paths that resolve outside the user's
home directory at startup.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from .lifecycle import serve

LOG = logging.getLogger("search_sidecar")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="search-sidecar")
    sub = parser.add_subparsers(dest="cmd", required=True)
    serve_cmd = sub.add_parser("serve", help="Start the FastAPI HTTP server")
    serve_cmd.add_argument(
        "--storage-dir",
        type=Path,
        required=True,
        help="Workspace root, e.g. /Users/<name>/.cogios",
    )
    return parser


def _validate_storage_dir(raw: Path) -> Path:
    """Resolve and assert the storage dir lives under the user's home.

    Mirrors the Tauri ACL validator regex; defends against a malicious
    arg that escapes the expected user-data tree (storage-dir is the
    sidecar's only source of paths it ever writes to).
    """
    resolved = raw.expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise SystemExit(f"--storage-dir does not exist: {resolved}")
    home = Path(os.path.expanduser("~")).resolve()
    try:
        resolved.relative_to(home)
    except ValueError as err:
        raise SystemExit(
            f"--storage-dir must live under {home}, got {resolved}"
        ) from err
    return resolved


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging()

    if args.cmd == "serve":
        storage_dir = _validate_storage_dir(args.storage_dir)
        return serve(storage_dir)
    parser.error(f"unknown command: {args.cmd}")
    return 2  # unreachable


if __name__ == "__main__":
    sys.exit(main())
