"""ModelManager: download + verify + activate against a fixture HTTP server.

Mirrors the test pattern in ``src-tauri/tests/url_indexing.rs`` — spawn
a tiny HTTP server bound to 127.0.0.1:0, point a custom manifest at it,
exercise the manager end-to-end. No network, no flakiness.
"""

from __future__ import annotations

import hashlib
import http.server
import os
import socket
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest

from search_sidecar.models.manager import (
    DownloadFailed,
    IntegrityError,
    ModelManager,
    ProgressEvent,
)
from search_sidecar.models.manifest import FileSpec, ModelSpec


# ----- fixture HTTP server -----------------------------------------------


class _Handler(http.server.BaseHTTPRequestHandler):
    """Serves a configured set of (path -> bytes) entries.

    Supports HTTP/1.1 ``Range: bytes=N-`` requests so the manager's
    resume path can be exercised.
    """

    files: dict[str, bytes] = {}
    not_found_paths: set[str] = set()
    deny_range_paths: set[str] = set()

    def do_GET(self):  # noqa: N802 (http.server convention)
        path = self.path
        if path in self.not_found_paths:
            self.send_response(404)
            self.send_header("Content-Length", "9")
            self.end_headers()
            self.wfile.write(b"not found")
            return
        body = self.files.get(path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        rng = self.headers.get("Range")
        if rng and path not in self.deny_range_paths:
            # Parse "bytes=N-"
            try:
                start = int(rng.split("=")[1].split("-")[0])
            except (IndexError, ValueError):
                self.send_response(416)
                self.end_headers()
                return
            if start >= len(body):
                self.send_response(416)
                self.end_headers()
                return
            chunk = body[start:]
            self.send_response(206)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(chunk)))
            self.send_header(
                "Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}"
            )
            self.end_headers()
            self.wfile.write(chunk)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args, **_kwargs):  # silence test output
        pass


@contextmanager
def fixture_server(
    files: dict[str, bytes],
    *,
    not_found: set[str] | None = None,
    deny_range: set[str] | None = None,
):
    """Spawn an HTTP server in a thread; yield its base URL."""
    cls = type(
        "Handler",
        (_Handler,),
        {
            "files": files,
            "not_found_paths": not_found or set(),
            "deny_range_paths": deny_range or set(),
        },
    )
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)


# ----- helpers -----------------------------------------------------------


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _make_spec(role: str, files: dict[str, bytes]) -> ModelSpec:
    return ModelSpec(
        role=role,
        repo="fixture/repo",
        commit="abc123",
        files=tuple(
            FileSpec(name=name, sha256=_sha256(body), size_bytes=len(body))
            for name, body in files.items()
        ),
    )


def _repo_dir(storage_dir: Path, spec: ModelSpec) -> Path:
    return storage_dir / "models" / Path(*spec.repo.split("/"))


def _make_manager(
    storage_dir: Path,
    spec: ModelSpec,
    *,
    base_url: str,
    license_role: ModelSpec | None = None,
) -> ModelManager:
    manifest = {spec.role: spec}
    if license_role is not None:
        manifest[license_role.role] = license_role
    overrides = {}
    for f in spec.files:
        overrides[f"{spec.repo}@{spec.commit}/{f.name}"] = f"{base_url}/{f.name}"
    if license_role is not None:
        for f in license_role.files:
            overrides[f"{license_role.repo}@{license_role.commit}/{f.name}"] = (
                f"{base_url}/{f.name}"
            )
    return ModelManager(
        storage_dir=storage_dir, manifest=manifest, url_override=overrides
    )


async def _drain(it):
    return [event async for event in it]


# ----- tests -------------------------------------------------------------


async def test_download_happy_path(tmp_path: Path):
    file_a = b"first file body" * 100
    file_b = b"second body!" * 50
    served = {"/onnx/model_int8.onnx": file_a, "/tokenizer.json": file_b}
    spec = _make_spec(
        "embedding",
        {"onnx/model_int8.onnx": file_a, "tokenizer.json": file_b},
    )

    with fixture_server(served) as base_url:
        manager = _make_manager(tmp_path, spec, base_url=base_url)
        events = await _drain(manager.download("embedding"))

    states = [e.state for e in events]
    assert "ready" in states
    assert states[-1] == "ready"

    # Files in commit folder
    commit_dir = manager.commit_dir("embedding", "abc123")
    assert (commit_dir / "onnx" / "model_int8.onnx").read_bytes() == file_a
    assert (commit_dir / "tokenizer.json").read_bytes() == file_b
    # current symlink points at commit
    current = manager.role_dir("embedding") / "current"
    assert current.is_symlink()
    assert current.resolve().name == "abc123"
    # tmp/ is now empty
    assert not list((manager.role_dir("embedding") / "tmp").iterdir())


async def test_role_dir_uses_manifest_repo_path(tmp_path: Path):
    spec = _make_spec("audio-transcript", {"a.bin": b"x"})
    manager = ModelManager(
        storage_dir=tmp_path,
        manifest={"audio-transcript": spec},
    )

    assert manager.role_dir("audio-transcript") == (
        tmp_path / "models" / "fixture" / "repo"
    )


async def test_constructor_migrates_legacy_role_dir_to_repo_path(
    tmp_path: Path,
):
    spec = _make_spec("embedding", {"a.bin": b"x"})
    legacy_dir = tmp_path / "search" / "models" / "embedding"
    commit_dir = legacy_dir / "abc123"
    commit_dir.mkdir(parents=True, exist_ok=True)
    (commit_dir / "a.bin").write_bytes(b"x")
    os.symlink("abc123", legacy_dir / "current")

    manager = ModelManager(storage_dir=tmp_path, manifest={"embedding": spec})

    migrated_dir = tmp_path / "models" / "fixture" / "repo"
    assert manager.role_dir("embedding") == migrated_dir
    assert not legacy_dir.exists()
    assert (migrated_dir / "abc123" / "a.bin").read_bytes() == b"x"
    current = migrated_dir / "current"
    assert current.is_symlink()
    assert os.readlink(current) == "abc123"


async def test_download_progress_reports_role_total_across_files(tmp_path: Path):
    file_a = b"a" * 1024
    file_b = b"b" * 2048
    served = {"/a.bin": file_a, "/b.bin": file_b}
    spec = _make_spec("embedding", {"a.bin": file_a, "b.bin": file_b})

    with fixture_server(served) as base_url:
        manager = _make_manager(tmp_path, spec, base_url=base_url)
        events = await _drain(manager.download("embedding"))

    progress_events = [event for event in events if event.state == "downloading"]
    assert progress_events, events
    assert {event.bytes_total for event in progress_events} == {
        len(file_a) + len(file_b)
    }
    assert progress_events[-1].bytes_downloaded == len(file_a) + len(file_b)
    assert progress_events[-1].bytes_total == len(file_a) + len(file_b)


async def test_download_404_emits_error_event(tmp_path: Path):
    spec = _make_spec("embedding", {"a.bin": b"x"})
    with fixture_server({}, not_found={"/a.bin"}) as base_url:
        manager = _make_manager(tmp_path, spec, base_url=base_url)
        events = await _drain(manager.download("embedding"))

    last = events[-1]
    assert last.state == "error"
    assert "404" in (last.error or "")
    # current symlink not created on failure
    assert not (manager.role_dir("embedding") / "current").exists()


async def test_download_sha256_mismatch_emits_error_and_cleans_partial(tmp_path: Path):
    served = {"/a.bin": b"actual content"}
    # Manifest says different SHA-256
    bad_spec = ModelSpec(
        role="embedding",
        repo="fixture/repo",
        commit="abc123",
        files=(FileSpec(name="a.bin", sha256="0" * 64),),
    )
    with fixture_server(served) as base_url:
        manager = _make_manager(tmp_path, bad_spec, base_url=base_url)
        events = await _drain(manager.download("embedding"))

    last = events[-1]
    assert last.state == "error"
    assert "sha256 mismatch" in (last.error or "")
    # partial cleaned
    tmp_dir = manager.role_dir("embedding") / "tmp"
    assert tmp_dir.exists()
    assert not list(tmp_dir.iterdir())


async def test_download_resumes_from_existing_partial(tmp_path: Path):
    full = b"abcdefghij" * 1000  # 10 KB
    served = {"/a.bin": full}
    spec = _make_spec("embedding", {"a.bin": full})

    # Pre-seed a partial with the first half
    half = full[: len(full) // 2]
    manager_dir = _repo_dir(tmp_path, spec) / "tmp"
    manager_dir.mkdir(parents=True, exist_ok=True)
    (manager_dir / "a.bin.partial").write_bytes(half)

    with fixture_server(served) as base_url:
        manager = _make_manager(tmp_path, spec, base_url=base_url)
        events = await _drain(manager.download("embedding"))

    states = [e.state for e in events]
    assert "ready" in states
    final = manager.commit_dir("embedding", "abc123") / "a.bin"
    assert final.read_bytes() == full


async def test_download_falls_back_to_next_source_and_keeps_partial(
    tmp_path: Path, monkeypatch
):
    full = b"abcdefghij" * 1000
    spec = _make_spec("embedding", {"a.bin": full})

    half = full[: len(full) // 2]
    manager_dir = _repo_dir(tmp_path, spec) / "tmp"
    manager_dir.mkdir(parents=True, exist_ok=True)
    (manager_dir / "a.bin.partial").write_bytes(half)

    with fixture_server(
        {"/mirror/a.bin": full},
        not_found={"/direct/a.bin"},
    ) as base_url:
        manager = ModelManager(storage_dir=tmp_path, manifest={"embedding": spec})
        monkeypatch.setattr(
            manager,
            "_build_urls",
            lambda _spec, _file_name: (
                f"{base_url}/direct/a.bin",
                f"{base_url}/mirror/a.bin",
            ),
        )
        events = await _drain(manager.download("embedding"))

    assert events[-1].state == "ready", events
    final = manager.commit_dir("embedding", "abc123") / "a.bin"
    assert final.read_bytes() == full


async def test_download_handles_server_ignoring_range(tmp_path: Path):
    """If the server returns 200 instead of 206, manager should restart
    from byte 0 (overwrite the partial)."""
    full = b"contents" * 100
    served = {"/a.bin": full}
    spec = _make_spec("embedding", {"a.bin": full})

    # Partial with garbage that does not match the actual file
    manager_dir = _repo_dir(tmp_path, spec) / "tmp"
    manager_dir.mkdir(parents=True, exist_ok=True)
    (manager_dir / "a.bin.partial").write_bytes(b"garbage" * 30)

    with fixture_server(served, deny_range={"/a.bin"}) as base_url:
        manager = _make_manager(tmp_path, spec, base_url=base_url)
        events = await _drain(manager.download("embedding"))

    states = [e.state for e in events]
    assert "ready" in states
    final = manager.commit_dir("embedding", "abc123") / "a.bin"
    assert final.read_bytes() == full


async def test_skips_download_when_final_already_verified(tmp_path: Path):
    body = b"already here"
    spec = _make_spec("embedding", {"a.bin": body})
    # Pre-place the final file at the commit dir
    final = _repo_dir(tmp_path, spec) / "abc123" / "a.bin"
    final.parent.mkdir(parents=True, exist_ok=True)
    final.write_bytes(body)

    # Server has different content — should never be hit
    with fixture_server({"/a.bin": b"different"}) as base_url:
        manager = _make_manager(tmp_path, spec, base_url=base_url)
        events = await _drain(manager.download("embedding"))

    states = [e.state for e in events]
    # We expect verifying + ready; no downloading event
    assert "downloading" not in states
    assert states[-1] == "ready"


async def test_status_reflects_state_transitions(tmp_path: Path):
    body = b"x" * 1024
    spec = _make_spec("embedding", {"a.bin": body})
    with fixture_server({"/a.bin": body}) as base_url:
        manager = _make_manager(tmp_path, spec, base_url=base_url)
        before = manager.status()
        assert before["embedding"].state == "missing"
        await _drain(manager.download("embedding"))
        after = manager.status()
        assert after["embedding"].state == "ready"
        assert after["embedding"].commit == "abc123"


async def test_concurrent_download_for_same_role_is_rejected(tmp_path: Path):
    body = b"x" * 4096
    spec = _make_spec("embedding", {"a.bin": body})
    with fixture_server({"/a.bin": body}) as base_url:
        manager = _make_manager(tmp_path, spec, base_url=base_url)

        # Manually flip in-flight to simulate an active download.
        manager._inflight.add("embedding")
        try:
            with pytest.raises(RuntimeError, match="already downloading"):
                await _drain(manager.download("embedding"))
        finally:
            manager._inflight.discard("embedding")


async def test_unknown_role_raises(tmp_path: Path):
    spec = _make_spec("embedding", {"a.bin": b"x"})
    manager = ModelManager(storage_dir=tmp_path, manifest={"embedding": spec})
    with pytest.raises(KeyError):
        await _drain(manager.download("nonexistent"))


async def test_transient_download_failure_is_retried(
    tmp_path: Path, monkeypatch
):
    """Transport-level ``DownloadFailed`` (HuggingFace's CDN dropping
    a connection mid-stream) should be retried automatically with
    backoff. The role still completes successfully on a later
    attempt without the user seeing an error event."""
    import asyncio as _asyncio

    from search_sidecar.models import manager as manager_mod

    body = b"x" * 4096
    spec = _make_spec("embedding", {"a.bin": body})

    # Replace the asyncio sleep with a no-op so the retry backoff
    # doesn't drag the test out across multiple seconds.
    async def fast_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(manager_mod.asyncio, "sleep", fast_sleep)

    with fixture_server({"/a.bin": body}) as base_url:
        m = _make_manager(tmp_path, spec, base_url=base_url)
        # Patch ``_download_file`` to fail twice then delegate to
        # the real implementation. Mirrors a CDN that drops two
        # connections before recovering.
        real = m._download_file
        attempts = {"n": 0}

        async def flaky_download_file(spec_, file_, **kwargs):
            attempts["n"] += 1
            if attempts["n"] <= 2:
                raise manager_mod.DownloadFailed(
                    f"simulated transport failure (attempt {attempts['n']})"
                )
            async for ev in real(spec_, file_, **kwargs):
                yield ev

        monkeypatch.setattr(m, "_download_file", flaky_download_file)
        events = await _drain(m.download("embedding"))

    assert events[-1].state == "ready", events
    assert attempts["n"] == 3, f"expected 3 attempts (2 fail + 1 success), got {attempts['n']}"
    # No error event surfaced to the caller — the retries were silent.
    assert not any(ev.state == "error" for ev in events)


async def test_integrity_failure_is_not_retried(tmp_path: Path):
    """``IntegrityError`` (manifest mismatch) is a config issue, not
    transient. The download fails fast with a single error event
    rather than burning through 4 retry attempts."""
    body = b"x" * 1024
    # Pin a wrong SHA so the integrity check fails.
    bad_spec = ModelSpec(
        role="embedding",
        repo="fixture/repo",
        commit="abc123",
        files=(FileSpec(name="a.bin", sha256="0" * 64),),
    )
    with fixture_server({"/a.bin": body}) as base_url:
        m = ModelManager(
            storage_dir=tmp_path,
            manifest={"embedding": bad_spec},
            url_override={
                "fixture/repo@abc123/a.bin": f"{base_url}/a.bin",
            },
        )
        events = await _drain(m.download("embedding"))

    error_events = [e for e in events if e.state == "error"]
    assert len(error_events) == 1, error_events
    assert "sha256 mismatch" in error_events[0].error


async def test_concurrent_downloads_capped_at_max(tmp_path: Path):
    """When more than ``MAX_CONCURRENT_DOWNLOADS`` callers issue
    download() at once (e.g. PP-StructureV3's 13 stages firing
    together), the cap suspends the excess before any IO. We use 3
    roles + a max of 2 to verify the third suspends until one of the
    first two completes."""
    import asyncio as _asyncio

    bodies = {f"role-{i}": b"x" * 256 for i in range(3)}
    specs: dict[str, ModelSpec] = {}
    for role, body in bodies.items():
        specs[role] = ModelSpec(
            role=role,
            repo=f"fixture/{role}",
            commit="abc123",
            files=(FileSpec(name="a.bin", sha256=_sha256(body)),),
        )

    served = {f"/{role}": body for role, body in bodies.items()}
    with fixture_server(served) as base_url:
        manager = ModelManager(
            storage_dir=tmp_path,
            manifest=specs,
            url_override={
                f"fixture/{role}@abc123/a.bin": f"{base_url}/{role}"
                for role in bodies
            },
        )
        # Force the cap low so the test is deterministic against
        # tiny payloads that complete near-instantly.
        manager._download_slot = _asyncio.Semaphore(2)

        # Track how many downloads are simultaneously inside the
        # semaphore. The downloader's first frame fires immediately
        # after acquire, so observing >2 active means the cap leaked.
        active_count = 0
        peak = 0
        observation_lock = _asyncio.Lock()

        async def run_one(role: str) -> list[ProgressEvent]:
            nonlocal active_count, peak
            events: list[ProgressEvent] = []
            async for ev in manager.download(role):
                if ev.state == "downloading" and ev.bytes_downloaded == 0:
                    async with observation_lock:
                        active_count += 1
                        peak = max(peak, active_count)
                events.append(ev)
                if ev.state in ("ready", "error"):
                    async with observation_lock:
                        active_count -= 1
            return events

        # Drive 3 concurrent downloads.
        results = await _asyncio.gather(
            *[run_one(role) for role in bodies]
        )
        for role_events in results:
            assert role_events[-1].state == "ready", role_events
        assert peak <= 2, f"peak concurrent downloads exceeded cap: {peak}"

        # At least one role must have observed a ``queued`` event —
        # with 3 callers and a cap of 2, at least one had to wait
        # for a slot. Without the pre-acquire ``queued`` frame, the
        # DownloadDock can't tell "request landed but is queued"
        # from "no request was ever made", which surfaced as
        # "missing pending models" in the v1 dock UX.
        queued_seen = any(
            any(ev.state == "queued" for ev in role_events)
            for role_events in results
        )
        assert queued_seen, "expected at least one ``queued`` frame from the third caller"


def test_download_base_urls_auto_prefers_china_mirror_for_china_locale(
    monkeypatch,
):
    from search_sidecar.models import manager as manager_mod

    monkeypatch.delenv(manager_mod.DOWNLOAD_ENDPOINT_ENV, raising=False)
    monkeypatch.delenv(manager_mod.HF_ENDPOINT_ENV, raising=False)
    monkeypatch.setenv("TZ", "Asia/Shanghai")
    monkeypatch.setenv("LANG", "zh_CN.UTF-8")

    assert manager_mod._download_base_urls() == (
        manager_mod.HF_CHINA_MIRROR_ENDPOINT,
        manager_mod.HF_DEFAULT_ENDPOINT,
    )


def test_download_base_urls_honours_explicit_hf_endpoint(monkeypatch):
    from search_sidecar.models import manager as manager_mod

    monkeypatch.delenv(manager_mod.DOWNLOAD_ENDPOINT_ENV, raising=False)
    monkeypatch.setenv(manager_mod.HF_ENDPOINT_ENV, "https://hf-mirror.com/")

    assert manager_mod._download_base_urls() == ("https://hf-mirror.com",)


def test_download_base_urls_honours_app_endpoint_modes(monkeypatch):
    from search_sidecar.models import manager as manager_mod

    monkeypatch.delenv(manager_mod.HF_ENDPOINT_ENV, raising=False)
    monkeypatch.setenv(manager_mod.DOWNLOAD_ENDPOINT_ENV, "china")
    assert manager_mod._download_base_urls() == (
        manager_mod.HF_CHINA_MIRROR_ENDPOINT,
        manager_mod.HF_DEFAULT_ENDPOINT,
    )

    monkeypatch.setenv(manager_mod.DOWNLOAD_ENDPOINT_ENV, "https://models.example.test/hf/")
    assert manager_mod._download_base_urls() == ("https://models.example.test/hf",)
