"""Direct sidecar indexing runner.

Rust owns durable task state in ``cognios.db``. The sidecar runner is a
small processor facade: it receives one claimed task over HTTP, invokes
the matching processor, writes LanceDB rows, and returns the result.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

from .dispatch import Dispatcher
from .job import IndexingJob, JobState
from ..observability import ObservabilityStore

LOG = logging.getLogger("search_sidecar.index.runner")


class IndexingRunner:
    """Direct processor facade used by Rust-owned background tasks."""

    def __init__(
        self,
        *,
        queue: object | None = None,
        dispatcher: Dispatcher,
        enable_enhancement: bool = True,
        observability_store: ObservabilityStore | None = None,
    ) -> None:
        _ = queue
        self._dispatcher = dispatcher
        self._enable_enhancement = enable_enhancement
        self._observability_store = observability_store
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._enhancement_lock = threading.Lock()
        self._enhancement_in_flight: str | None = None

    @property
    def running(self) -> bool:
        return False

    @property
    def paused(self) -> bool:
        return self._paused.is_set()

    @property
    def enhancement_in_flight_node_ids(self) -> list[str]:
        with self._enhancement_lock:
            return (
                [self._enhancement_in_flight]
                if self._enhancement_in_flight is not None
                else []
            )

    def set_paused(self, paused: bool) -> None:
        """Pause / resume direct processing calls."""
        if paused:
            self._paused.set()
        else:
            self._paused.clear()

    def stop(self, *, timeout: float | None = None) -> bool:
        """Compatibility hook for lifecycle shutdown."""
        self._stop.set()
        return True

    def process_direct(
        self,
        *,
        node_id: str,
        kind: str,
        name: str,
        absolute_content_path: str | None = None,
        mount_id: str | None = None,
        created_at: datetime | None = None,
        modified_at: datetime | None = None,
    ) -> dict:
        """Process one Rust-owned task without using ``queue.db``."""
        if self._paused.is_set():
            return {"status": "paused", "error": "indexing runner is paused"}
        now = datetime.now(timezone.utc)
        job = IndexingJob(
            node_id=node_id,
            kind=kind,
            name=name,
            absolute_content_path=absolute_content_path,
            mount_id=mount_id,
            state=JobState.INDEXING,
            enqueued_at=now,
            indexed_at=None,
            last_error=None,
            attempts=1,
            created_at=created_at or now,
            modified_at=modified_at or now,
            content_version=None,
        )
        return self._handle_direct(job)

    def process_direct_enhancement(
        self,
        *,
        node_id: str,
        kind: str,
        name: str,
        absolute_content_path: str | None = None,
        mount_id: str | None = None,
        created_at: datetime | None = None,
        modified_at: datetime | None = None,
    ) -> dict:
        if not self._enable_enhancement:
            return {"status": "unavailable", "error": "advanced OCR enhancement is disabled"}
        if not self._dispatcher.has_advanced_ocr():
            return {"status": "unavailable", "error": "advanced OCR runtime is unavailable"}
        now = datetime.now(timezone.utc)
        job = IndexingJob(
            node_id=node_id,
            kind=kind,
            name=name,
            absolute_content_path=absolute_content_path,
            mount_id=mount_id,
            state=JobState.INDEXED,
            enqueued_at=now,
            indexed_at=now,
            last_error=None,
            attempts=1,
            created_at=created_at or now,
            modified_at=modified_at or now,
            content_version=None,
        )
        processor = self._dispatcher.find_enhancement(job)
        if processor is None:
            return {"status": "failed", "error": f"no enhancement processor for {job.kind}"}

        with self._enhancement_lock:
            self._enhancement_in_flight = job.node_id
        started_at = time.monotonic()
        LOG.info(
            "advanced-OCR enhancement started node_id=%s kind=%s name=%r path=%s",
            job.node_id,
            job.kind,
            job.name,
            job.absolute_content_path or "",
        )
        try:
            processor.process_enhancement(job, 0)
            elapsed_ms = _elapsed_ms(started_at)
            LOG.info(
                "advanced-OCR enhancement finished node_id=%s kind=%s elapsed_ms=%d",
                job.node_id,
                job.kind,
                elapsed_ms,
            )
            self._record_duration("enhancement", elapsed_ms)
            return {"status": "completed", "error": None}
        except Exception as err:
            elapsed_ms = _elapsed_ms(started_at)
            LOG.warning(
                "advanced-OCR enhancement failed node_id=%s kind=%s elapsed_ms=%d: %s",
                job.node_id,
                job.kind,
                elapsed_ms,
                err,
            )
            self._record_duration("enhancement", elapsed_ms, ok=False)
            return {"status": "failed", "error": str(err)}
        finally:
            with self._enhancement_lock:
                self._enhancement_in_flight = None

    def _handle_direct(self, job: IndexingJob) -> dict:
        started_at = time.monotonic()
        proc = self._dispatcher.find(job)
        if proc is None:
            if job.kind in {"note", "file", "url", "folder", "mount"}:
                try:
                    written = self._dispatcher.replace_metadata(job)
                except Exception as err:
                    elapsed_ms = _elapsed_ms(started_at)
                    LOG.warning(
                        "metadata indexing failed node_id=%s kind=%s elapsed_ms=%d: %s",
                        job.node_id,
                        job.kind,
                        elapsed_ms,
                        err,
                    )
                    self._record_duration("indexing", elapsed_ms, ok=False)
                    return {
                        "status": JobState.ERROR.value,
                        "error": f"{type(err).__name__}: {err}",
                    }
                elapsed_ms = _elapsed_ms(started_at)
                LOG.info(
                    "metadata indexing finished node_id=%s kind=%s chunks=%d elapsed_ms=%d",
                    job.node_id,
                    job.kind,
                    written,
                    elapsed_ms,
                )
                self._record_duration("indexing", elapsed_ms)
                return {
                    "status": JobState.INDEXED.value,
                    "error": None,
                    "indexed_at": datetime.now(timezone.utc).isoformat(),
                }
            return {
                "status": JobState.ERROR.value,
                "error": f"no processor for kind={job.kind!r} path={job.absolute_content_path!r}",
            }
        LOG.info(
            "indexing started node_id=%s kind=%s name=%r content_version=%s path=%s",
            job.node_id,
            job.kind,
            job.name,
            job.content_version,
            job.absolute_content_path or "",
        )
        try:
            written = proc.process(job)
            metadata_written = self._dispatcher.replace_metadata(job)
        except Exception as err:
            elapsed_ms = _elapsed_ms(started_at)
            LOG.warning(
                "indexing failed node_id=%s kind=%s elapsed_ms=%d: %s",
                job.node_id,
                job.kind,
                elapsed_ms,
                err,
            )
            self._record_duration("indexing", elapsed_ms, ok=False)
            return {
                "status": JobState.ERROR.value,
                "error": f"{type(err).__name__}: {err}",
            }
        elapsed_ms = _elapsed_ms(started_at)
        LOG.info(
            "indexing finished node_id=%s kind=%s chunks=%d elapsed_ms=%d",
            job.node_id,
            job.kind,
            written + metadata_written,
            elapsed_ms,
        )
        self._record_duration("indexing", elapsed_ms)
        return {
            "status": JobState.INDEXED.value,
            "error": None,
            "indexed_at": datetime.now(timezone.utc).isoformat(),
        }

    def _record_duration(self, kind: str, elapsed_ms: int, *, ok: bool = True) -> None:
        if self._observability_store is not None:
            self._observability_store.record_duration(kind, elapsed_ms, ok=ok)


def _elapsed_ms(started_at: float) -> int:
    return int((time.monotonic() - started_at) * 1000)
