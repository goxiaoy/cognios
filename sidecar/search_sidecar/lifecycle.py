"""Sidecar startup ordering.

Sequence:

  1. Acquire ``fcntl.flock`` on ``<storage>/search/sidecar.lock`` —
     fail-fast if another sidecar is already running.
  2. Generate a 256-bit bearer token.
  3. Hand uvicorn ``host=127.0.0.1, port=0`` and start serving.
  4. Once uvicorn reports ``server.started``, read back the OS-assigned
     port and atomic-write ``sidecar.runtime`` (port + token, mode 0600).
  5. Block on the server thread until shutdown.

The brief gap between "uvicorn is accepting" and "runtime file is on
disk" is benign: Rust only connects after reading the runtime file, so
the worst Rust sees is "file not found, retry" for one poll tick. Any
other process trying to abuse the briefly-open port lacks the token and
is rejected by the bearer middleware.
"""

from __future__ import annotations

import logging
import signal
import threading
import time
from pathlib import Path

import uvicorn

from .app import build_app
from .auth import generate_token
from .embeddings import reembed_stale_chunks, select_embedder
from .index import IndexingRunner
from .index.dispatch import Dispatcher
from .index.queue import open_queue
from .models import DEFAULTS, ModelManager
from .rerank import select_reranker
from .retrieval import SearchOrchestrator
from .runtime_file import (
    acquire_lock,
    remove_runtime_file,
    write_runtime_file,
)
from .settings import boot_signature, load_settings, save_settings
from .storage import open_store

LOG = logging.getLogger("search_sidecar.lifecycle")

STARTUP_DEADLINE_SECONDS = 30.0
STARTUP_POLL_INTERVAL_SECONDS = 0.05


def prepare_search_dir(storage_dir: Path) -> Path:
    """Ensure ``<storage_dir>/search/`` exists with mode 0700."""
    search_dir = storage_dir / "search"
    search_dir.mkdir(parents=True, exist_ok=True)
    search_dir.chmod(0o700)
    return search_dir


def serve(storage_dir: Path) -> int:
    """Start the sidecar, write the runtime file, block until shutdown.

    Returns the process exit code (0 on clean shutdown, 1 on lock
    contention or startup timeout).
    """
    search_dir = prepare_search_dir(storage_dir)
    lock_path = search_dir / "sidecar.lock"
    runtime_path = search_dir / "sidecar.runtime"

    try:
        lock_handle = acquire_lock(lock_path)
    except RuntimeError as err:
        LOG.error(str(err))
        return 1

    token = generate_token()
    settings_path = search_dir / "settings.json"
    # Materialize defaults on first launch so the file mode is fixed
    # at 0600 from the start; subsequent runs no-op via the load path.
    if not settings_path.exists():
        save_settings(settings_path, load_settings(settings_path))
    settings = load_settings(settings_path)
    model_manager = ModelManager(storage_dir=storage_dir, manifest=DEFAULTS)
    lancedb_store = open_store(search_dir / "index.lance")
    indexing_queue = open_queue(search_dir / "queue.db")
    embedder = select_embedder(
        model_manager=model_manager,
        settings=settings,
    )
    LOG.info(
        "embedder selected: %s (is_semantic=%s)",
        type(embedder).__name__,
        embedder.is_semantic,
    )
    # Re-embed sweep: when a real embedder is wired and the lancedb
    # table contains chunks left over from a prior stub-embedded
    # session, transparently upgrade them in the background. Daemon
    # thread so a slow sweep can never block sidecar shutdown.
    if embedder.is_semantic:
        threading.Thread(
            target=_run_reembed_sweep,
            args=(lancedb_store, embedder),
            name="search-sidecar-reembed",
            daemon=True,
        ).start()
    dispatcher = Dispatcher(store=lancedb_store, embedder=embedder)
    indexing_runner = IndexingRunner(queue=indexing_queue, dispatcher=dispatcher)
    indexing_runner.start()
    reranker = select_reranker(model_manager=model_manager, settings=settings)
    if reranker is not None:
        LOG.info("cross-encoder reranker loaded: %s", type(reranker).__name__)
    search_orchestrator = SearchOrchestrator(
        store=lancedb_store, embedder=embedder, reranker=reranker
    )

    app = build_app(
        token=token,
        model_manager=model_manager,
        indexing_queue=indexing_queue,
        indexing_runner=indexing_runner,
        lancedb_store=lancedb_store,
        search_orchestrator=search_orchestrator,
        settings_path=settings_path,
        boot_settings_signature=boot_signature(settings),
    )
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=0,
        log_level="info",
        access_log=False,  # access log goes through our redacting logger if added later
    )
    server = uvicorn.Server(config)

    server_thread = threading.Thread(
        target=server.run,
        name="search-sidecar-uvicorn",
        daemon=True,
    )
    server_thread.start()

    # Uvicorn installs its own SIGTERM/SIGINT handlers via
    # ``loop.add_signal_handler``, but those only attach when uvicorn
    # runs on the main thread. We run it in a worker thread (so the
    # main thread can write the runtime file once uvicorn has bound),
    # so we must install our own main-thread handlers that flip
    # ``server.should_exit`` and let uvicorn drain cleanly. Without
    # this, SIGTERM kills the process before the ``finally`` block
    # below can remove ``sidecar.runtime`` and release the lock.
    def _request_shutdown(_signum, _frame):
        server.should_exit = True

    signal.signal(signal.SIGTERM, _request_shutdown)
    signal.signal(signal.SIGINT, _request_shutdown)

    deadline = time.monotonic() + STARTUP_DEADLINE_SECONDS
    while not server.started:
        if time.monotonic() > deadline:
            LOG.error("uvicorn failed to bind within %.1fs", STARTUP_DEADLINE_SECONDS)
            server.should_exit = True
            server_thread.join(timeout=5.0)
            lock_handle.close()
            return 1
        time.sleep(STARTUP_POLL_INTERVAL_SECONDS)

    bound_port = _read_bound_port(server)
    if bound_port is None:
        LOG.error("could not determine bound port from uvicorn server")
        server.should_exit = True
        server_thread.join(timeout=5.0)
        lock_handle.close()
        return 1

    write_runtime_file(runtime_path, port=bound_port, token=token)
    LOG.info(
        "search-sidecar serving on http://127.0.0.1:%d (runtime=%s)",
        bound_port,
        runtime_path,
    )

    try:
        server_thread.join()
    finally:
        indexing_runner.stop()
        indexing_queue.close()
        remove_runtime_file(runtime_path)
        lock_handle.close()

    return 0


def _run_reembed_sweep(store, embedder) -> None:  # type: ignore[no-untyped-def]
    """Background entrypoint for the re-embed sweep.

    Wraps :func:`reembed_stale_chunks` with a top-level ``except`` so
    a sweep failure does not propagate into a thread death exception
    no one catches.
    """
    try:
        reembed_stale_chunks(store, embedder)
    except Exception as err:
        LOG.warning("re-embed sweep crashed: %s", err)


def _read_bound_port(server: uvicorn.Server) -> int | None:
    """Read the OS-assigned port back from uvicorn after ``server.started``.

    uvicorn keeps the bound asyncio servers in ``server.servers`` and
    each holds its sockets in ``.sockets``. Returns ``None`` if the
    structure is empty (should not happen once ``server.started`` is
    True, but guard for edge cases).
    """
    servers = getattr(server, "servers", None)
    if not servers:
        return None
    for asyncio_server in servers:
        for sock in getattr(asyncio_server, "sockets", []) or []:
            try:
                return sock.getsockname()[1]
            except (OSError, IndexError):
                continue
    return None
