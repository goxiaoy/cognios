"""Background indexing runner.

Drains :class:`IndexingQueue` jobs serially on a worker thread; the
text processor is light enough that one worker is fine for v1. PDF /
image / caption processors land later and may want their own worker
pools (per the plan's "1 worker for OCR/caption, N for text" note);
this runner is the coordinator the future pools plug into.

Each job runs inside a try/except fence — one bad file cannot poison
the queue. On unhandled exception, the runner records the truncated
``str(err)`` via :meth:`IndexingQueue.mark_error` and moves on.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from .dispatch import Dispatcher
from .processors.enhancement import EnhancementTransientError
from .queue import IndexingJob, IndexingQueue

LOG = logging.getLogger("search_sidecar.index.runner")

IDLE_POLL_INTERVAL_SECONDS = 0.5


class IndexingRunner:
    """Single-thread queue drainer.

    Construct, then call :meth:`start`; call :meth:`stop` on shutdown.
    Tests can drive a synchronous tick via :meth:`process_one` to
    exercise the dispatch + persistence chain without the polling loop.
    """

    def __init__(
        self,
        *,
        queue: IndexingQueue,
        dispatcher: Dispatcher,
        enable_enhancement: bool = True,
    ) -> None:
        self._queue = queue
        self._dispatcher = dispatcher
        self._enable_enhancement = enable_enhancement
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # When True, the runner stops claiming new jobs but keeps
        # the loop alive (so set_paused(False) resumes immediately).
        # Used to prevent mixed-provider corruption when settings
        # have changed and the user hasn't restarted yet — see
        # plan Key Decision "Mixed-provider data corruption guard".
        self._paused = threading.Event()
        self._enhancement_lock = threading.Lock()
        self._enhancement_in_flight: str | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

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
        """Pause / resume new job claims without stopping the loop."""
        if paused:
            self._paused.set()
        else:
            self._paused.clear()

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop,
            name="search-sidecar-index-runner",
            daemon=False,
        )
        self._thread.start()

    def stop(self, *, timeout: Optional[float] = None) -> bool:
        """Request shutdown and wait for the current job to finish.

        The runner never interrupts an in-flight processor call. This
        matters for native OCR libraries: exiting Python while Paddle
        is initializing in a daemon thread can surface as a macOS
        "Python quit unexpectedly" crash report. Returning ``False``
        means the caller's timeout elapsed and the runner is still
        draining the active job.
        """
        self._stop.set()
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout=timeout)
        stopped = not thread.is_alive()
        if stopped:
            self._thread = None
        return stopped

    def process_one(self) -> bool:
        """Run a single dispatch tick. Returns ``True`` if a job was
        processed, ``False`` if the queue was empty *or* the runner
        is paused.

        Used by tests; the polling loop calls the same logic.
        """
        if self._paused.is_set():
            return False
        job = self._queue.claim_next()
        if job is not None:
            self._handle(job)
            return True
        if self._try_process_enhancement():
            return True
        return False

    # ----- internals ----------------------------------------------------

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                processed = self.process_one()
            except Exception:  # pragma: no cover - belt-and-braces
                LOG.exception("indexing runner loop crashed mid-job")
                processed = False
            if not processed:
                # Idle wait — Event.wait so stop() is responsive.
                self._stop.wait(IDLE_POLL_INTERVAL_SECONDS)

    def _try_process_enhancement(self) -> bool:
        if not self._enable_enhancement:
            return False
        if not self._dispatcher.has_advanced_ocr():
            return False
        result = self._queue.claim_next_enhancement()
        if result is None:
            return False
        job, claim_seq = result
        processor = self._dispatcher.find_enhancement(job)
        if processor is None:
            LOG.warning(
                "advanced-OCR enhancement has no processor for %s (%s)",
                job.node_id,
                job.name,
            )
            self._queue.mark_enhancement_failed(job.node_id)
            return True
        with self._enhancement_lock:
            self._enhancement_in_flight = job.node_id
        started_at = time.monotonic()
        LOG.info(
            "advanced-OCR enhancement started node_id=%s kind=%s name=%r "
            "content_version=%s claim_seq=%s path=%s",
            job.node_id,
            job.kind,
            job.name,
            job.content_version,
            claim_seq,
            job.absolute_content_path or "",
        )
        try:
            processor.process_enhancement(job, claim_seq)
            LOG.info(
                "advanced-OCR enhancement finished node_id=%s kind=%s elapsed_ms=%d",
                job.node_id,
                job.kind,
                _elapsed_ms(started_at),
            )
        except EnhancementTransientError:
            LOG.info(
                "advanced-OCR enhancement transient failure node_id=%s kind=%s "
                "elapsed_ms=%d",
                job.node_id,
                job.kind,
                _elapsed_ms(started_at),
            )
        except Exception as err:
            LOG.warning(
                "advanced-OCR enhancement failed node_id=%s kind=%s "
                "elapsed_ms=%d: %s",
                job.node_id,
                job.kind,
                _elapsed_ms(started_at),
                err,
            )
            self._queue.mark_enhancement_failed(job.node_id)
        finally:
            with self._enhancement_lock:
                self._enhancement_in_flight = None
        return True

    def _handle(self, job: IndexingJob) -> None:
        proc = self._dispatcher.find(job)
        if proc is None:
            if job.kind in {"note", "file", "url", "folder", "mount"}:
                try:
                    written = self._dispatcher.replace_metadata(job)
                except Exception as err:
                    LOG.warning(
                        "metadata indexing failed node_id=%s kind=%s: %s",
                        job.node_id,
                        job.kind,
                        err,
                    )
                    self._queue.mark_error(
                        job.node_id, f"{type(err).__name__}: {err}"
                    )
                    return
                self._queue.mark_indexed(job.node_id)
                LOG.info(
                    "metadata indexing finished node_id=%s kind=%s chunks=%d",
                    job.node_id,
                    job.kind,
                    written,
                )
                return
            self._queue.mark_error(
                job.node_id,
                f"no processor for kind={job.kind!r} path={job.absolute_content_path!r}",
            )
            return
        started_at = time.monotonic()
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
            LOG.warning(
                "indexing failed node_id=%s kind=%s elapsed_ms=%d: %s",
                job.node_id,
                job.kind,
                _elapsed_ms(started_at),
                err,
            )
            self._queue.mark_error(job.node_id, f"{type(err).__name__}: {err}")
            return
        self._queue.mark_indexed(job.node_id)
        LOG.info(
            "indexing finished node_id=%s kind=%s chunks=%d elapsed_ms=%d",
            job.node_id,
            job.kind,
            written + metadata_written,
            _elapsed_ms(started_at),
        )


def _elapsed_ms(started_at: float) -> int:
    return int((time.monotonic() - started_at) * 1000)
