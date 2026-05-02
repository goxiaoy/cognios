"""ModelManager: per-role download + SHA-256 verify + activation.

Storage layout::

    <storage>/search/models/
      <role>/
        current -> <commit>          # symlink, set after activation
        license.accepted             # presence-only sentinel
        <commit>/
          <file1>
          <file2>
        <commit>/                    # an older commit, still on disk
          ...
        tmp/                         # in-progress downloads
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

import httpx

from .manifest import ModelSpec

LOG = logging.getLogger("search_sidecar.models")

CHUNK_SIZE = 64 * 1024  # 64 KiB — balances syscall overhead and memory.


class LicenseRequired(RuntimeError):
    """Raised when a download is attempted on a role whose license
    has not yet been accepted (currently only the ``captioner`` role)."""


class IntegrityError(RuntimeError):
    """Raised when a downloaded file's SHA-256 does not match the
    manifest. The ``.partial`` file is removed before this is raised."""


class DownloadFailed(RuntimeError):
    """Raised on non-200/206 HTTP responses or transport errors."""


@dataclass(frozen=True)
class ProgressEvent:
    """Streamed during a download for the route layer to re-emit as SSE."""

    role: str
    state: str  # one of: "downloading", "verifying", "ready", "error"
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
    license_accepted: bool = False
    requires_acceptance: bool = False
    error: str | None = None


class ModelManager:
    """Orchestrates the model lifecycle for the four roles.

    The manager is constructed once at sidecar startup with the active
    manifest (defaults at ``models.manifest.DEFAULTS``). Tests inject a
    custom manifest with localhost URLs and computed SHA-256s.

    Concurrency: each role can be downloaded independently. A single
    role cannot be downloaded twice concurrently — the second caller
    receives a 409-style ``RuntimeError``. This mirrors the route layer's
    expected behaviour.
    """

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
        self._models_root = storage_dir / "search" / "models"
        self._models_root.mkdir(parents=True, exist_ok=True)
        self._inflight: set[str] = set()
        self._lock = asyncio.Lock()

    # ----- public surface ------------------------------------------------

    @property
    def manifest(self) -> dict[str, ModelSpec]:
        return self._manifest

    def role_dir(self, role: str) -> Path:
        return self._models_root / role

    def commit_dir(self, role: str, commit: str) -> Path:
        return self.role_dir(role) / commit

    def license_sentinel(self, role: str) -> Path:
        return self.role_dir(role) / "license.accepted"

    def is_license_accepted(self, role: str) -> bool:
        return self.license_sentinel(role).exists()

    def accept_license(self, role: str) -> None:
        spec = self._spec(role)
        if not spec.requires_acceptance:
            # Idempotent no-op: roles without a license gate are always
            # "accepted" by definition.
            return
        path = self.license_sentinel(role)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()

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
                license_accepted=self.is_license_accepted(role),
                requires_acceptance=spec.requires_acceptance,
            )
        return out

    def is_ready(self, role: str) -> bool:
        return self._read_current(role) is not None

    async def download(
        self,
        role: str,
        *,
        hf_token: str | None = None,
    ) -> AsyncIterator[ProgressEvent]:
        """Download every file for ``role`` and activate the commit.

        Yields ``ProgressEvent``s the route layer can pipe to SSE:
        - ``state="downloading"`` repeatedly with byte counts
        - ``state="verifying"`` once per file at SHA-256 check time
        - ``state="ready"`` once after activation, OR
        - ``state="error"`` once with an ``error`` message; iteration ends.
        """
        spec = self._spec(role)

        if spec.requires_acceptance and not self.is_license_accepted(role):
            raise LicenseRequired(
                f"role {role!r} requires license acceptance before download"
            )

        async with self._lock:
            if role in self._inflight:
                raise RuntimeError(f"role {role!r} already downloading")
            self._inflight.add(role)

        try:
            async for event in self._download_role(spec, hf_token=hf_token):
                yield event
        finally:
            self._inflight.discard(role)

    # ----- internals -----------------------------------------------------

    def _spec(self, role: str) -> ModelSpec:
        try:
            return self._manifest[role]
        except KeyError as err:
            raise KeyError(f"unknown role: {role!r}") from err

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
        """Atomically point ``<role>/current`` at ``<commit>``.

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

    def _build_url(self, spec: ModelSpec, file_name: str) -> str:
        # Tests inject explicit URLs via url_override; production builds
        # the canonical HF URL from the spec.
        key = f"{spec.repo}@{spec.commit}/{file_name}"
        if key in self._url_override:
            return self._url_override[key]
        return f"https://huggingface.co/{spec.repo}/resolve/{spec.commit}/{file_name}"

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
        self, spec: ModelSpec, *, hf_token: str | None
    ) -> AsyncIterator[ProgressEvent]:
        try:
            for file in spec.files:
                async for ev in self._download_file(spec, file, hf_token=hf_token):
                    yield ev
            self._activate(spec.role, spec.commit)
            yield ProgressEvent(role=spec.role, state="ready")
        except (IntegrityError, DownloadFailed) as err:
            LOG.warning("download for %s failed: %s", spec.role, err)
            yield ProgressEvent(role=spec.role, state="error", error=str(err))

    async def _download_file(
        self, spec: ModelSpec, file, *, hf_token: str | None
    ) -> AsyncIterator[ProgressEvent]:
        partial, final = self._resolve_target_paths(spec, file.name)

        # If final is already present + verifies, skip.
        if final.exists() and _file_sha256(final) == file.sha256:
            yield ProgressEvent(
                role=spec.role,
                state="verifying",
                file=file.name,
                bytes_downloaded=final.stat().st_size,
                bytes_total=final.stat().st_size,
            )
            return

        url = self._build_url(spec, file.name)
        headers: dict[str, str] = {}
        if hf_token:
            headers["Authorization"] = f"Bearer {hf_token}"

        # Range-resume if we have a non-empty partial
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > 0:
            headers["Range"] = f"bytes={offset}-"

        try:
            async with httpx.AsyncClient(
                follow_redirects=True, timeout=httpx.Timeout(30.0)
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
                                    bytes_downloaded=bytes_downloaded,
                                    bytes_total=total,
                                )
                    else:
                        body_preview = (await resp.aread())[:200].decode(
                            "utf-8", errors="replace"
                        )
                        raise DownloadFailed(
                            f"HTTP {resp.status_code} for {file.name}: {body_preview}"
                        )
        except httpx.HTTPError as err:
            raise DownloadFailed(f"transport error: {err}") from err

        # Verify
        yield ProgressEvent(
            role=spec.role,
            state="verifying",
            file=file.name,
            bytes_downloaded=partial.stat().st_size,
            bytes_total=partial.stat().st_size,
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
