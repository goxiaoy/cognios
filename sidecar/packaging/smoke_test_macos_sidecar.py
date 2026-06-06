#!/usr/bin/env python3
"""Smoke-test the frozen macOS search sidecar.

This intentionally runs the PyInstaller output, not ``uv run`` or the source
package. It catches missing package data / native modules that only fail after
installation.
"""

from __future__ import annotations

import argparse
import json
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


NODE_ID = "11111111-2222-3333-4444-555555555555"
QUERY = "custom rerankers"


def main() -> int:
    args = _parse_args()
    binary = args.binary.resolve()
    if not binary.is_file():
        raise SystemExit(f"sidecar binary does not exist: {binary}")

    _assert_packaged_trafilatura_data(binary)

    storage_dir = Path(
        tempfile.mkdtemp(prefix=".cognios-sidecar-smoke-", dir=Path.home())
    )
    stdout_path = storage_dir / "sidecar.stdout.log"
    stderr_path = storage_dir / "sidecar.stderr.log"
    proc: subprocess.Popen[bytes] | None = None
    try:
        url_cache_dir = storage_dir / "url-cache"
        url_cache_dir.mkdir(parents=True)
        cache_path = url_cache_dir / f"{NODE_ID}.html"
        cache_path.write_text(_html_fixture(), encoding="utf-8")

        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            proc = subprocess.Popen(
                [str(binary), "serve", "--storage-dir", str(storage_dir)],
                stdout=stdout,
                stderr=stderr,
            )
            runtime = _wait_for_runtime(storage_dir / "search" / "sidecar.runtime")
            _post_node_event(runtime, cache_path)
            _wait_for_indexed(storage_dir / "search" / "queue.db")
            _assert_url_search(runtime)
    except Exception:
        _dump_process_logs(stdout_path, stderr_path)
        raise
    finally:
        if proc is not None:
            _terminate(proc)
        shutil.rmtree(storage_dir, ignore_errors=True)
    print("packaged sidecar smoke test passed")
    return 0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "binary",
        type=Path,
        help="Path to the frozen search-sidecar executable inside the .app bundle",
    )
    return parser.parse_args()


def _assert_packaged_trafilatura_data(binary: Path) -> None:
    candidates = [
        binary.parent / "_internal" / "trafilatura" / "settings.cfg",
        binary.parent / "trafilatura" / "settings.cfg",
    ]
    if not any(path.is_file() for path in candidates):
        searched = ", ".join(str(path) for path in candidates)
        raise RuntimeError(f"packaged trafilatura settings.cfg missing; searched {searched}")


def _wait_for_runtime(runtime_path: Path) -> dict:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if runtime_path.is_file():
            return json.loads(runtime_path.read_text(encoding="utf-8"))
        time.sleep(0.25)
    raise TimeoutError(f"sidecar runtime file not produced: {runtime_path}")


def _post_node_event(runtime: dict, cache_path: Path) -> None:
    body = {
        "event": "node_changed",
        "node_id": NODE_ID,
        "kind": "url",
        "name": "A Practical Guide to Training Custom Rerankers",
        "absolute_content_path": str(cache_path),
        "mount_id": None,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "force": True,
    }
    _request(runtime, "/events/node", body)


def _wait_for_indexed(queue_path: Path) -> None:
    deadline = time.monotonic() + 60
    last_state = None
    last_error = None
    while time.monotonic() < deadline:
        if queue_path.is_file():
            with sqlite3.connect(queue_path) as conn:
                row = conn.execute(
                    "select state, last_error from jobs where node_id = ?",
                    (NODE_ID,),
                ).fetchone()
            if row is not None:
                last_state, last_error = row
                if last_state == "indexed":
                    return
                if last_state == "error":
                    raise RuntimeError(f"url node indexing failed: {last_error}")
        time.sleep(0.5)
    raise TimeoutError(
        f"url node was not indexed; state={last_state!r} error={last_error!r}"
    )


def _assert_url_search(runtime: dict) -> None:
    payload = _request(runtime, "/search", {"query": QUERY, "limit": 3})
    results = payload.get("results") or []
    if not any(result.get("node_id") == NODE_ID for result in results):
        raise RuntimeError(f"indexed URL node missing from search results: {payload}")


def _request(runtime: dict, path: str, body: dict) -> dict:
    port = runtime["port"]
    token = runtime["token"]
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _html_fixture() -> str:
    return """
<!doctype html>
<html>
  <body>
    <article>
      <h1>A Practical Guide to Training Custom Rerankers</h1>
      <p>
        Custom rerankers improve search quality by scoring candidate documents
        after retrieval. This paragraph is intentionally long enough for
        Trafilatura's extraction thresholds inside the packaged runtime.
      </p>
      <p>
        The indexed URL cache should preserve meaningful content while dropping
        scripts, navigation, and other page chrome.
      </p>
    </article>
    <script>tracker()</script>
  </body>
</html>
"""


def _terminate(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def _dump_process_logs(stdout_path: Path, stderr_path: Path) -> None:
    for label, path in (("stdout", stdout_path), ("stderr", stderr_path)):
        if not path.is_file():
            continue
        print(f"--- sidecar {label} ---", file=sys.stderr)
        print(path.read_text(encoding="utf-8", errors="replace")[-4000:], file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
