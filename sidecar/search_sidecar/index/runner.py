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
from .queue import IndexingJob, IndexingQueue

LOG = logging.getLogger("search_sidecar.index.runner")

IDLE_POLL_INTERVAL_SECONDS = 0.5


class IndexingRunner:
    """Single-thread queue drainer.

    Construct, then call :meth:`start`; call :meth:`stop` on shutdown.
    Tests can drive a synchronous tick via :meth:`process_one` to
    exercise the dispatch + persistence chain without the polling loop.
    """

    def __init__(self, *, queue: IndexingQueue, dispatcher: Dispatcher) -> None:
        self._queue = queue
        self._dispatcher = dispatcher
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # When True, the runner stops claiming new jobs but keeps
        # the loop alive (so set_paused(False) resumes immediately).
        # Used to prevent mixed-provider corruption when settings
        # have changed and the user hasn't restarted yet — see
        # plan Key Decision "Mixed-provider data corruption guard".
        self._paused = threading.Event()

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def paused(self) -> bool:
        return self._paused.is_set()

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
            daemon=True,
        )
        self._thread.start()

    def stop(self, *, timeout: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=timeout)
        self._thread = None

    def process_one(self) -> bool:
        """Run a single dispatch tick. Returns ``True`` if a job was
        processed, ``False`` if the queue was empty *or* the runner
        is paused.

        Used by tests; the polling loop calls the same logic.
        """
        if self._paused.is_set():
            return False
        job = self._queue.claim_next()
        if job is None:
            return False
        self._handle(job)
        return True

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

    def _handle(self, job: IndexingJob) -> None:
        proc = self._dispatcher.find(job)
        if proc is None:
            self._queue.mark_error(
                job.node_id,
                f"no processor for kind={job.kind!r} path={job.absolute_content_path!r}",
            )
            return
        try:
            proc.process(job)
        except Exception as err:
            LOG.warning(
                "indexing failed for %s (%s): %s", job.node_id, job.kind, err
            )
            self._queue.mark_error(job.node_id, f"{type(err).__name__}: {err}")
            return
        self._queue.mark_indexed(job.node_id)
