"""Reranker selection logic.

Mirrors :func:`search_sidecar.embeddings.select_embedder`. Returns a
real :class:`GteReranker` when the ``embedding`` extra is installed
AND the reranker role is downloaded + activated; otherwise ``None``.

The orchestrator interprets ``None`` as "skip reranking" — search
still works, just without the cross-encoder reorder of the top-K
window.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ..embeddings.factory import (
    can_load_real_embedder,
    _resolve_active_model_dir,
)
from .gte_reranker import GteReranker, GteRerankerConfig

if TYPE_CHECKING:
    from ..models.manager import ModelManager

LOG = logging.getLogger("search_sidecar.rerank.factory")


def select_reranker(
    *,
    model_manager: "ModelManager | None",
    role: str = "reranker",
) -> GteReranker | None:
    """Return a real :class:`GteReranker` or ``None`` for the no-rerank
    path. Failures during construction are logged and converted to
    ``None`` so a broken reranker can never kill search."""
    if model_manager is None:
        return None
    if not can_load_real_embedder():
        LOG.debug(
            "embedding extra not installed; skipping reranker "
            "(install with `uv sync --extra embedding`)"
        )
        return None
    if not model_manager.is_ready(role):
        LOG.info("reranker role not ready; rerank disabled")
        return None
    model_dir = _resolve_active_model_dir(model_manager, role)
    if model_dir is None:
        return None
    try:
        return GteReranker(GteRerankerConfig(model_dir=model_dir))
    except Exception as err:
        LOG.warning(
            "failed to load GteReranker from %s: %s. Rerank disabled.",
            model_dir,
            err,
        )
        return None
