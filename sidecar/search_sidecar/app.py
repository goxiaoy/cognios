"""FastAPI app factory.

Phase 1 / Unit 3 ships ``GET /healthz`` only. Phase 2 (Units 4–6) adds
``/index/*``, ``/events/*``, ``/search``, ``/models/*`` routes and
mounts the ModelManager + queue + retrieval orchestrator.
"""

from __future__ import annotations

from fastapi import FastAPI

from .auth import BearerAuthMiddleware


def build_app(*, token: str) -> FastAPI:
    """Construct a FastAPI app with bearer-auth installed.

    Tests use this directly via :class:`fastapi.testclient.TestClient`;
    the real entry point in :mod:`search_sidecar.__main__` builds the
    same app and serves it via uvicorn.
    """
    app = FastAPI(title="Cognios search-sidecar", version="0.0.1")
    app.add_middleware(BearerAuthMiddleware, token=token)

    @app.get("/healthz")
    def healthz() -> dict:
        # Phase 1 / Unit 3 stub. Indexing-queue depth, per-role model
        # state, and degraded flag arrive in Units 4–6.
        return {
            "state": "initialising",
            "models": {},
            "queue_depth": 0,
        }

    return app
