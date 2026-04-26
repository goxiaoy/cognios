"""FastAPI app factory.

Phase 1 / Unit 3 added ``GET /healthz``. Phase 2 / Unit 4 mounts the
``/models/*`` router and threads a ``ModelManager`` instance onto
``app.state``. Units 5–6 add ``/index/*``, ``/events/*``, ``/search``.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI

from .auth import BearerAuthMiddleware
from .routes import models as models_routes

if TYPE_CHECKING:
    from .models.manager import ModelManager


def build_app(*, token: str, model_manager: "ModelManager | None" = None) -> FastAPI:
    """Construct a FastAPI app with bearer-auth installed.

    ``model_manager`` is optional for test ergonomics — auth and healthz
    work without it. If ``None``, ``/models/*`` routes return 500 with a
    ``model_manager not configured`` error, which is the same surface
    Rust would see if app construction was misordered.
    """
    app = FastAPI(title="Cognios search-sidecar", version="0.0.1")
    app.add_middleware(BearerAuthMiddleware, token=token)

    @app.get("/healthz")
    def healthz() -> dict:
        # Phase 1 / Unit 3 stub. Models become real in Unit 4 — once a
        # ModelManager is attached we surface its status here too.
        models: dict[str, str] = {}
        manager = getattr(app.state, "model_manager", None)
        if manager is not None:
            models = {role: status.state for role, status in manager.status().items()}
        return {
            "state": "initialising",
            "models": models,
            "queue_depth": 0,
        }

    app.include_router(models_routes.router)
    if model_manager is not None:
        app.state.model_manager = model_manager

    return app
