"""Reranker selection logic.

Parallels :func:`search_sidecar.embeddings.select_embedder`. Returns
a real :class:`GteReranker` when:

- the ``result-reranking`` feature is enabled and bound to a known
  reranking-capable provider in ``settings`` (or ``settings`` is
  ``None``, the legacy "decide from model availability alone" path);
- the ``embedding`` extra is installed; and
- the reranker role is downloaded + activated.

Otherwise ``None``. The orchestrator interprets ``None`` as "skip
reranking" — search still works, just without the cross-encoder
reorder of the top-K window. Reranker construction failures degrade
to ``None`` rather than killing the sidecar so a broken model file
can never block search.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ..embeddings.factory import (
    can_load_real_embedder,
    _resolve_active_model_dir,
)
from ..providers import PRESETS
from .gte_reranker import GteReranker, GteRerankerConfig

if TYPE_CHECKING:
    from ..models.manager import ModelManager
    from ..settings import SearchSettings

LOG = logging.getLogger("search_sidecar.rerank.factory")


def select_reranker(
    *,
    model_manager: "ModelManager | None",
    settings: "SearchSettings | None" = None,
    role: str = "reranker",
) -> GteReranker | None:
    """Return a real :class:`GteReranker` or ``None`` for the no-rerank
    path."""
    if settings is not None:
        feature = settings.features.get("result-reranking")
        if feature is None or not feature.enabled or feature.provider_id is None:
            LOG.debug("result-reranking unbound or disabled; skipping reranker")
            return None
        preset = PRESETS.get(feature.provider_id)
        if preset is None:
            LOG.warning(
                "result-reranking bound to unknown provider %r; "
                "skipping reranker",
                feature.provider_id,
            )
            return None
        if "reranking" not in preset.capabilities:
            LOG.warning(
                "provider %r does not declare reranking capability; "
                "skipping reranker",
                preset.provider_id,
            )
            return None
        if preset.provider_type != "local":
            # v1 only ships a local cross-encoder; cloud reranking is
            # not yet wired (would need an HTTP reranker client).
            LOG.warning(
                "cloud reranking provider %r selected but not "
                "implemented in v1; skipping reranker",
                preset.provider_id,
            )
            return None
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
