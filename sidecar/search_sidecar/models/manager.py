"""ModelManager: per-role download + SHA-256 verify + activation.

Storage layout::

    <storage>/models/
      <repo namespace>/
        <repo name>/
          current -> <commit>        # symlink, set after activation
          license.accepted           # presence-only sentinel
          <commit>/
            <file1>
            <file2>
          <commit>/                  # an older commit, still on disk
            ...
          tmp/                       # in-progress downloads
            <file>.partial

Download is HTTP GET with ``Range: bytes=N-`` resume when a ``.partial``
exists. Each file is verified end-to-end against the manifest's SHA-256
before being moved out of ``tmp/`` into ``<commit>/``. After every file
in the role's manifest is in place, ``current`` is atomically updated
to point at ``<commit>``.

This module is intentionally async — downloads stream over httpx and
emit progress events that the FastAPI route layer (``routes/models.py``)
can re-emit as SSE. The manager itself does not depend on FastAPI.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import urlsplit

import httpx

from .manifest import FileSpec, ModelSpec

LOG = logging.getLogger("search_sidecar.models")

CHUNK_SIZE = 64 * 1024  # 64 KiB — balances syscall overhead and memory.

HF_DEFAULT_ENDPOINT = "https://huggingface.co"
HF_CHINA_MIRROR_ENDPOINT = "https://hf-mirror.com"
DOWNLOAD_ENDPOINT_ENV = "COGNIOS_MODEL_DOWNLOAD_ENDPOINT"
HF_ENDPOINT_ENV = "HF_ENDPOINT"
DOWNLOAD_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=10.0)

# Retry policy for transient ``DownloadFailed`` errors. Mirrors the
# pin script's retry shape so dev + ops behave the same way against
# HuggingFace's CDN (which drops a noticeable fraction of long
# downloads under load). 4 attempts × backoff [1, 3, 7, 15]s gives
# the network ~26 s of headroom before surfacing as a hard error.
MAX_DOWNLOAD_ATTEMPTS = 4
DOWNLOAD_BACKOFF_SECONDS: tuple[float, ...] = (1.0, 3.0, 7.0, 15.0)


class IntegrityError(RuntimeError):
    """Raised when a downloaded file's SHA-256 does not match the
    manifest. The ``.partial`` file is removed before this is raised."""


class DownloadFailed(RuntimeError):
    """Raised on non-200/206 HTTP responses or transport errors."""


@dataclass(frozen=True)
class ProgressEvent:
    """Streamed during a download for the route layer to re-emit as SSE.

    ``"queued"`` fires when more callers asked to download than the
    concurrency cap allows; the request is parked on the semaphore.
    The next live event is either ``"downloading"`` (slot opened)
    or ``"error"`` (the caller closed the SSE stream early).
    """

    role: str
    state: str  # "queued" | "downloading" | "verifying" | "ready" | "error"
    file: str | None = None  # which file is being processed
    bytes_downloaded: int = 0
    bytes_total: int | None = None
    error: str | None = None


@dataclass
class RoleStatus:
    """What ``GET /models/status`` returns per role.

    ``repo`` is the upstream model identifier (today: a HuggingFace
    ``owner/repo`` slug from the manifest). The frontend surfaces it
    in Settings → Models so users can cross-reference docs / file
    bugs / open the upstream page without reading the manifest.
    """

    role: str
    state: str  # "missing" | "downloading" | "ready" | "error"
    repo: str = ""
    commit: str | None = None
    error: str | None = None


class ModelManager:
    """Orchestrates the model lifecycle for the manifest roles.

    The manager is constructed once at sidecar startup with the active
    manifest (defaults at ``models.manifest.DEFAULTS``). Tests inject a
    custom manifest with localhost URLs and computed SHA-256s.

    Concurrency: each role can be downloaded independently. A single
    role cannot be downloaded twice concurrently — the second caller
    receives a 409-style ``RuntimeError``. This mirrors the route layer's
    expected behaviour.

    A separate ``asyncio.Semaphore`` caps total concurrent active
    downloads at ``MAX_CONCURRENT_DOWNLOADS``. When the user enables
    a multi-stage feature (PP-StructureV3 fans out 13 download
    requests), the first 2 stream while the rest queue inside their
    own ``download()`` coroutine. The route layer's SSE response
    stays open; the queued caller's first frame fires when a slot
    opens up. The cap protects HuggingFace's CDN (which throttles
    aggressively under burst) and the user's bandwidth.
    """

    MAX_CONCURRENT_DOWNLOADS = 2

    def __init__(
        self,
        *,
        storage_dir: Path,
        manifest: dict[str, ModelSpec],
        url_override: dict[str, str] | None = None,
    ) -> None:
        self._storage_dir = storage_dir
        self._manifest = dict(manifest)
        # Tests pass {repo+commit+filename -> URL} to point at a fixture
        # HTTP server. Production passes None (manager builds HF URLs).
        self._url_override = dict(url_override or {})
        self._models_root = storage_dir / "models"
        self._legacy_models_root = storage_dir / "search" / "models"
        self._models_root.mkdir(parents=True, exist_ok=True)
        self._migrate_legacy_model_dirs()
        self._inflight: set[str] = set()
        self._lock = asyncio.Lock()
        # Lazy semaphore creation: ``asyncio.Semaphore`` binds to
        # the running loop on construction, which the FastAPI test
        # client doesn't have at import time. Create on first use.
        self._download_slot: asyncio.Semaphore | None = None

    # ----- public surface ------------------------------------------------

    @property
    def manifest(self) -> dict[str, ModelSpec]:
        return self._manifest

    def role_dir(self, role: str) -> Path:
        return self._repo_dir(self._spec(role))

    def commit_dir(self, role: str, commit: str) -> Path:
        return self.role_dir(role) / commit

    def status(self) -> dict[str, RoleStatus]:
        """Synchronous read of every role's current state. Cheap;
        called by ``GET /models/status``."""
        out: dict[str, RoleStatus] = {}
        for role, spec in self._manifest.items():
            current = self._read_current(role)
            if role in self._inflight:
                state = "downloading"
            elif current is not None:
                state = "ready"
            else:
                state = "missing"
            out[role] = RoleStatus(
                role=role,
                state=state,
                repo=spec.repo,
                commit=current,
            )
        return out

    def is_ready(self, role: str) -> bool:
        return self._read_current(role) is not None

    async def download(self, role: str) -> AsyncIterator[ProgressEvent]:
        """Download every file for ``role`` and activate the commit.

        Yields ``ProgressEvent``s the route layer can pipe to SSE:
        - ``state="downloading"`` repeatedly with byte counts
        - ``state="verifying"`` once per file at SHA-256 check time
        - ``state="ready"`` once after activation, OR
        - ``state="error"`` once with an ``error`` message; iteration ends.

        Concurrency: the per-role check (``self._inflight``) prevents
        a duplicate request; the global semaphore
        (``self._download_slot``) caps total active downloads at
        ``MAX_CONCURRENT_DOWNLOADS``. Stages past the cap suspend
        before any IO and resume when a slot opens.
        """
        spec = self._spec(role)

        async with self._lock:
            if role in self._inflight:
                raise RuntimeError(f"role {role!r} already downloading")
            self._inflight.add(role)

        try:
            slot = self._get_download_slot()
            # Emit a ``queued`` frame when we'd actually have to wait
            # for a slot. Without this the SSE stream stays silent
            # while parked on the semaphore and the DownloadDock
            # can't tell "request landed but is queued" from "no
            # request was ever made". Polled non-blocking-ly so the
            # already-free path skips the noise.
            if slot.locked():
                yield ProgressEvent(role=spec.role, state="queued")
            async with slot:
                async for event in self._download_role(spec):
                    yield event
        finally:
            self._inflight.discard(role)

    def _get_download_slot(self) -> asyncio.Semaphore:
        """Lazily create the global download semaphore the first time
        a download() runs. Bound to the active loop at that point so
        the manager can be constructed outside an event loop (matters
        for synchronous tests that use the manager's ``status()``)."""
        if self._download_slot is None:
            self._download_slot = asyncio.Semaphore(self.MAX_CONCURRENT_DOWNLOADS)
        return self._download_slot

    # ----- internals -----------------------------------------------------

    def _spec(self, role: str) -> ModelSpec:
        try:
            return self._manifest[role]
        except KeyError as err:
            raise KeyError(f"unknown role: {role!r}") from err

    def _repo_dir(self, spec: ModelSpec) -> Path:
        return self._models_root / _repo_relative_path(spec.repo)

    def _migrate_legacy_model_dirs(self) -> None:
        """Move old ``search/models/<role>`` folders to repo paths.

        Older builds used role names as the persistent directory name,
        which collapsed upstream identifiers like ``Qwen/Qwen3-ASR-0.6B``
        into app-specific names such as ``audio-transcript``. Keep the
        public role API but store files under the original HF namespace
        path so users can inspect and reuse downloaded models directly.
        """
        legacy_root = self._legacy_models_root
        if not legacy_root.exists():
            return
        for role, spec in self._manifest.items():
            legacy_dir = legacy_root / role
            if not legacy_dir.exists() and not legacy_dir.is_symlink():
                continue
            target_dir = self._repo_dir(spec)
            try:
                self._move_or_merge_legacy_dir(legacy_dir, target_dir)
            except OSError as err:
                LOG.warning(
                    "failed to migrate model directory for %s from %s to %s: %s",
                    role,
                    legacy_dir,
                    target_dir,
                    err,
                )
        self._prune_empty_legacy_model_dirs()

    def _move_or_merge_legacy_dir(self, source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() and not target.is_symlink():
            source.rename(target)
            LOG.info("migrated model directory %s -> %s", source, target)
            return
        if source.is_dir() and target.is_dir():
            self._merge_directory_contents(source, target)
            return
        LOG.warning(
            "leaving legacy model path in place because target already exists: %s -> %s",
            source,
            target,
        )

    def _merge_directory_contents(self, source: Path, target: Path) -> None:
        for child in source.iterdir():
            destination = target / child.name
            if not destination.exists() and not destination.is_symlink():
                child.rename(destination)
                continue
            if child.is_dir() and destination.is_dir() and not child.is_symlink():
                self._merge_directory_contents(child, destination)
                continue
            if _same_legacy_content(child, destination):
                _remove_duplicate_legacy_path(child)
                continue
            LOG.warning(
                "leaving legacy model path in place because target already exists: %s",
                child,
            )
        try:
            source.rmdir()
        except OSError:
            pass

    def _prune_empty_legacy_model_dirs(self) -> None:
        ds_store = self._legacy_models_root / ".DS_Store"
        if ds_store.is_file():
            try:
                ds_store.unlink()
            except OSError:
                pass
        for path in (self._legacy_models_root, self._legacy_models_root.parent):
            try:
                path.rmdir()
            except OSError:
                pass

    def _read_current(self, role: str) -> str | None:
        link = self.role_dir(role) / "current"
        if not link.exists() and not link.is_symlink():
            return None
        try:
            target = os.readlink(link)
        except OSError:
            return None
        # Symlink target is a relative directory name (the commit hash).
        return target

    def _activate(self, role: str, commit: str) -> None:
        """Atomically point the role's ``current`` link at ``<commit>``.

        Implementation: write the new symlink to ``current.tmp`` and
        ``os.replace`` it onto ``current``. ``os.replace`` of a symlink
        is atomic on POSIX.
        """
        link = self.role_dir(role) / "current"
        tmp = self.role_dir(role) / "current.tmp"
        if tmp.exists() or tmp.is_symlink():
            tmp.unlink()
        os.symlink(commit, tmp)
        os.replace(tmp, link)

    def _build_urls(self, spec: ModelSpec, file_name: str) -> tuple[str, ...]:
        # Tests inject explicit URLs via url_override; production builds
        # candidate HF-compatible URLs from the spec. Candidate order is
        # policy-driven: auto mode prefers the China mirror when local
        # environment hints point at mainland China, otherwise the
        # official endpoint gets first try. Every candidate uses the same
        # partial file, so a failed source can be resumed from the next.
        key = f"{spec.repo}@{spec.commit}/{file_name}"
        if key in self._url_override:
            return (self._url_override[key],)
        return tuple(
            f"{base}/{spec.repo}/resolve/{spec.commit}/{file_name}"
            for base in _download_base_urls()
        )

    def _resolve_target_paths(
        self, spec: ModelSpec, file_name: str
    ) -> tuple[Path, Path]:
        """Return ``(partial_path, final_path)`` for a file. Ensures the
        ``tmp/`` directory and the commit folder both exist."""
        commit_dir = self.commit_dir(spec.role, spec.commit)
        tmp_dir = self.role_dir(spec.role) / "tmp"
        commit_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)
        # File names may contain "/" (e.g. "onnx/model_int8.onnx").
        # Mirror that under both tmp/ and commit_dir/.
        partial = tmp_dir / (file_name.replace("/", "__") + ".partial")
        final = commit_dir / file_name
        final.parent.mkdir(parents=True, exist_ok=True)
        return partial, final

    async def _download_role(
        self, spec: ModelSpec
    ) -> AsyncIterator[ProgressEvent]:
        """Download every file in the role, retrying transient
        ``DownloadFailed`` errors with exponential backoff.

        Retry policy:
          * ``DownloadFailed`` (transport / HTTP / connection drops) →
            retry up to ``MAX_DOWNLOAD_ATTEMPTS`` times with backoff
            ``DOWNLOAD_BACKOFF_SECONDS``. The per-file Range-resume
            already preserves partial progress, so each retry picks
            up where the previous attempt left off — no wasted bytes.
          * ``IntegrityError`` (SHA mismatch on a finished file) →
            fail fast. The partial has already been deleted by the
            time we get here, but integrity failures are usually a
            manifest mismatch rather than transient corruption, and
            blindly redownloading just spends time arriving at the
            same conclusion. The user sees the error in Settings
            and can re-pin / re-bind.
        """
        last_err: Exception | None = None
        for attempt in range(MAX_DOWNLOAD_ATTEMPTS):
            try:
                role_total = _manifest_role_total(spec)
                completed_bytes = 0
                for file in spec.files:
                    async for ev in self._download_file(
                        spec,
                        file,
                        role_completed_bytes=completed_bytes,
                        role_total_bytes=role_total,
                    ):
                        yield ev
                    completed_bytes += self._completed_file_bytes(spec, file)
                self._activate(spec.role, spec.commit)
                yield ProgressEvent(role=spec.role, state="ready")
                return
            except DownloadFailed as err:
                last_err = err
                if attempt + 1 >= MAX_DOWNLOAD_ATTEMPTS:
                    break
                sleep_for = DOWNLOAD_BACKOFF_SECONDS[
                    min(attempt, len(DOWNLOAD_BACKOFF_SECONDS) - 1)
                ]
                LOG.info(
                    "download for %s transient failure (attempt %d/%d): %s; "
                    "retrying in %.0fs",
                    spec.role,
                    attempt + 1,
                    MAX_DOWNLOAD_ATTEMPTS,
                    err,
                    sleep_for,
                )
                await asyncio.sleep(sleep_for)
            except IntegrityError as err:
                LOG.warning(
                    "download for %s integrity check failed (no retry): %s",
                    spec.role,
                    err,
                )
                yield ProgressEvent(
                    role=spec.role, state="error", error=str(err)
                )
                return
        LOG.warning(
            "download for %s exhausted %d retries: %s",
            spec.role,
            MAX_DOWNLOAD_ATTEMPTS,
            last_err,
        )
        yield ProgressEvent(
            role=spec.role,
            state="error",
            error=str(last_err) if last_err else "download failed",
        )

    async def _download_file(
        self,
        spec: ModelSpec,
        file: FileSpec,
        *,
        role_completed_bytes: int,
        role_total_bytes: int | None,
    ) -> AsyncIterator[ProgressEvent]:
        partial, final = self._resolve_target_paths(spec, file.name)

        # If final is already present + verifies, skip.
        if final.exists() and _file_sha256(final) == file.sha256:
            downloaded = role_completed_bytes + final.stat().st_size
            yield ProgressEvent(
                role=spec.role,
                state="verifying",
                file=file.name,
                bytes_downloaded=downloaded,
                bytes_total=role_total_bytes or downloaded,
            )
            return

        urls = self._build_urls(spec, file.name)
        last_err: DownloadFailed | None = None
        for index, url in enumerate(urls):
            try:
                async for event in self._download_file_from_url(
                    spec,
                    file,
                    url=url,
                    partial=partial,
                    final=final,
                    role_completed_bytes=role_completed_bytes,
                    role_total_bytes=role_total_bytes,
                ):
                    yield event
                return
            except DownloadFailed as err:
                last_err = err
                if index + 1 >= len(urls):
                    break
                LOG.info(
                    "download source failed for %s/%s (%s); trying fallback source %s",
                    spec.role,
                    file.name,
                    err,
                    _safe_download_host(urls[index + 1]),
                )
        if last_err is not None:
            raise last_err
        raise DownloadFailed(f"no download source configured for {file.name}")

    async def _download_file_from_url(
        self,
        spec: ModelSpec,
        file: FileSpec,
        *,
        url: str,
        partial: Path,
        final: Path,
        role_completed_bytes: int,
        role_total_bytes: int | None,
    ) -> AsyncIterator[ProgressEvent]:
        headers: dict[str, str] = {}

        # Range-resume if we have a non-empty partial
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > 0:
            headers["Range"] = f"bytes={offset}-"

        try:
            async with httpx.AsyncClient(
                follow_redirects=True, timeout=DOWNLOAD_TIMEOUT
            ) as client:
                async with client.stream("GET", url, headers=headers) as resp:
                    if resp.status_code == 416:
                        # Range not satisfiable — server says we already
                        # have everything. Fall through to verification.
                        pass
                    elif resp.status_code in (200, 206):
                        total = _expected_total(resp, offset)
                        # 200 means server ignored Range — restart from 0.
                        write_mode = "ab" if resp.status_code == 206 else "wb"
                        if write_mode == "wb":
                            offset = 0
                        bytes_downloaded = offset
                        with open(partial, write_mode) as fh:
                            async for chunk in resp.aiter_bytes(CHUNK_SIZE):
                                fh.write(chunk)
                                bytes_downloaded += len(chunk)
                                yield ProgressEvent(
                                    role=spec.role,
                                    state="downloading",
                                    file=file.name,
                                    bytes_downloaded=role_completed_bytes
                                    + bytes_downloaded,
                                    bytes_total=role_total_bytes
                                    or (
                                        role_completed_bytes + total
                                        if total is not None
                                        else None
                                    ),
                                )
                    else:
                        body_preview = (await resp.aread())[:200].decode(
                            "utf-8", errors="replace"
                        )
                        raise DownloadFailed(
                            f"HTTP {resp.status_code} for {file.name} "
                            f"from {_safe_download_host(url)}: {body_preview}"
                        )
        except httpx.HTTPError as err:
            raise DownloadFailed(
                f"transport error from {_safe_download_host(url)}: {err}"
            ) from err

        # Verify
        downloaded = role_completed_bytes + partial.stat().st_size
        yield ProgressEvent(
            role=spec.role,
            state="verifying",
            file=file.name,
            bytes_downloaded=downloaded,
            bytes_total=role_total_bytes or downloaded,
        )
        actual = _file_sha256(partial)
        if actual != file.sha256:
            try:
                partial.unlink()
            except FileNotFoundError:
                pass
            raise IntegrityError(
                f"sha256 mismatch for {file.name}: "
                f"manifest={file.sha256[:12]}…, actual={actual[:12]}…"
            )

        # Atomic rename into commit folder
        os.replace(partial, final)

    def _completed_file_bytes(self, spec: ModelSpec, file: FileSpec) -> int:
        _, final = self._resolve_target_paths(spec, file.name)
        if final.exists():
            return final.stat().st_size
        if file.size_bytes is not None:
            return file.size_bytes
        return 0


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(CHUNK_SIZE), b""):
            h.update(chunk)
    return h.hexdigest()


def _expected_total(resp: httpx.Response, offset: int) -> int | None:
    # Content-Length in a 206 response is the bytes remaining; we
    # report total as offset + remaining. In 200, it's the full size.
    cl = resp.headers.get("content-length")
    if cl is None:
        return None
    try:
        n = int(cl)
    except ValueError:
        return None
    if resp.status_code == 206:
        return offset + n
    return n


def _manifest_role_total(spec: ModelSpec) -> int | None:
    total = 0
    for file in spec.files:
        if file.size_bytes is None:
            return None
        total += file.size_bytes
    return total


def _download_base_urls() -> tuple[str, ...]:
    """Return HuggingFace-compatible endpoint bases in failover order.

    ``COGNIOS_MODEL_DOWNLOAD_ENDPOINT`` is the app-level override:
    - ``auto`` (default): choose order from locale/timezone hints, then fail over
    - ``china`` / ``mirror`` / ``hf-mirror``: hf-mirror first, official second
    - ``huggingface`` / ``direct``: official first, mirror second
    - URL value: use that endpoint only, for private proxies

    ``HF_ENDPOINT`` is honoured as a lower-level override because many HF
    users already set it in China. A custom endpoint is treated as explicit
    and does not fall back to the official host to avoid accidental egress.
    """
    configured = os.getenv(DOWNLOAD_ENDPOINT_ENV)
    if configured is not None and configured.strip():
        return _configured_download_base_urls(configured)

    hf_endpoint = os.getenv(HF_ENDPOINT_ENV)
    if hf_endpoint is not None and hf_endpoint.strip():
        return (_normalise_endpoint_base(hf_endpoint),)

    if _looks_like_china_environment():
        return (HF_CHINA_MIRROR_ENDPOINT, HF_DEFAULT_ENDPOINT)
    return (HF_DEFAULT_ENDPOINT, HF_CHINA_MIRROR_ENDPOINT)


def _configured_download_base_urls(value: str) -> tuple[str, ...]:
    normalized = value.strip()
    choice = normalized.lower()
    if choice == "auto":
        if _looks_like_china_environment():
            return (HF_CHINA_MIRROR_ENDPOINT, HF_DEFAULT_ENDPOINT)
        return (HF_DEFAULT_ENDPOINT, HF_CHINA_MIRROR_ENDPOINT)
    if choice in {"china", "cn", "mirror", "hf-mirror"}:
        return (HF_CHINA_MIRROR_ENDPOINT, HF_DEFAULT_ENDPOINT)
    if choice in {"huggingface", "hf", "direct"}:
        return (HF_DEFAULT_ENDPOINT, HF_CHINA_MIRROR_ENDPOINT)
    return (_normalise_endpoint_base(normalized),)


def _normalise_endpoint_base(value: str) -> str:
    base = value.strip().rstrip("/")
    if not base:
        raise ValueError("download endpoint must not be empty")
    if "://" not in base:
        base = f"https://{base}"
    return base


def _looks_like_china_environment() -> bool:
    probes = (
        os.getenv("TZ", ""),
        os.getenv("LANG", ""),
        os.getenv("LC_ALL", ""),
        os.getenv("LC_MESSAGES", ""),
        os.getenv("LC_CTYPE", ""),
    )
    haystack = " ".join(probes).lower().replace("-", "_")
    china_hints = (
        "asia/shanghai",
        "asia/beijing",
        "asia/chongqing",
        "asia/urumqi",
        "asia/harbin",
        "asia/kashgar",
        "zh_cn",
        "zh_hans_cn",
    )
    return any(hint in haystack for hint in china_hints)


def _safe_download_host(url: str) -> str:
    parsed = urlsplit(url)
    return parsed.netloc or url


def _repo_relative_path(repo: str) -> Path:
    parts = tuple(repo.split("/"))
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"invalid model repo path: {repo!r}")
    return Path(*parts)


def _same_legacy_content(source: Path, destination: Path) -> bool:
    if source.is_symlink() or destination.is_symlink():
        if not source.is_symlink() or not destination.is_symlink():
            return False
        return os.readlink(source) == os.readlink(destination)
    if source.is_file() and destination.is_file():
        if source.stat().st_size != destination.stat().st_size:
            return False
        return _file_sha256(source) == _file_sha256(destination)
    return False


def _remove_duplicate_legacy_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
