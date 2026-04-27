"""FastAPI app factory.

Phase 1 / Unit 3 added ``GET /healthz``. Phase 2 / Unit 4 mounted the
``/models/*`` router. Phase 2 / Unit 5 mounts ``/events/*`` and
``/index/*`` and threads the IndexingQueue + LanceDBStore onto
``app.state``. Unit 6 adds ``/search``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import FastAPI

from .auth import BearerAuthMiddleware
from .routes import events as events_routes
from .routes import index as index_routes
from .routes import models as models_routes
from .routes import search as search_routes

if TYPE_CHECKING:
    from .index.queue import IndexingQueue
    from .models.manager import ModelManager
    from .retrieval import SearchOrchestrator
    from .storage import LanceDBStore


def build_app(
    *,
    token: str,
    model_manager: "ModelManager | None" = None,
    indexing_queue: "IndexingQueue | None" = None,
    lancedb_store: "LanceDBStore | None" = None,
    search_orchestrator: "SearchOrchestrator | None" = None,
) -> FastAPI:
    """Construct a FastAPI app with bearer-auth + the Phase-2 routers.

    Each subsystem (model_manager, indexing_queue, lancedb_store) is
    optional so tests can mount only what they need. Routes whose
    dependencies are missing return a typed 500 — same surface Rust
    would see if app construction was misordered.
    """
    app = FastAPI(title="Cognios search-sidecar", version="0.0.1")
    app.add_middleware(BearerAuthMiddleware, token=token)

    @app.get("/healthz")
    def healthz() -> dict:
        models: dict[str, str] = {}
        manager = getattr(app.state, "model_manager", None)
        if manager is not None:
            models = {role: status.state for role, status in manager.status().items()}
        queue_depth = 0
        queue = getattr(app.state, "indexing_queue", None)
        if queue is not None:
            queue_depth = queue.queue_depth()
        return {
            "state": "initialising",
            "models": models,
            "queue_depth": queue_depth,
        }

    app.include_router(models_routes.router)
    app.include_router(events_routes.router)
    app.include_router(index_routes.router)
    app.include_router(search_routes.router)

    if model_manager is not None:
        app.state.model_manager = model_manager
    if indexing_queue is not None:
        app.state.indexing_queue = indexing_queue
    if lancedb_store is not None:
        app.state.lancedb_store = lancedb_store
    if search_orchestrator is not None:
        app.state.search_orchestrator = search_orchestrator

    return app
