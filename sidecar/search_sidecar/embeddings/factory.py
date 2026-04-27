"""Embedder selection logic.

Two checks decide whether the orchestrator gets a real
:class:`GteEmbedder` or the fallback :class:`StubEmbedder`:

1. The ``embedding`` extra is installed (``optimum`` + ``transformers``
   importable). Dev installs default to no extra; the StubEmbedder
   path keeps test runs snappy.
2. :class:`ModelManager` reports the embedding role as ``ready`` and
   the on-disk files actually exist.

Either failing → :class:`StubEmbedder`. The orchestrator inspects
:attr:`Embedder.is_semantic` to choose between hybrid retrieval and
the FTS-only fallback, so a missing model is not a fatal condition.
"""

from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from ..index.embedder import Embedder, StubEmbedder
from .gte import GteEmbedder, GteEmbedderConfig

if TYPE_CHECKING:
    from ..models.manager import ModelManager

LOG = logging.getLogger("search_sidecar.embeddings.factory")


class EmbedderFactoryError(RuntimeError):
    """Raised when the factory is asked for a real embedder but cannot
    construct one. Callers handle by falling back to ``StubEmbedder``;
    the error stays surfaceable for tests + diagnostics."""


def can_load_real_embedder() -> bool:
    """Cheap check (no module import) for whether the optional
    ``embedding`` extra is installed."""
    return (
        importlib.util.find_spec("optimum") is not None
        and importlib.util.find_spec("transformers") is not None
    )


def select_embedder(
    *,
    model_manager: "ModelManager | None",
    role: str = "embedding",
) -> Embedder:
    """Return the most-capable embedder available right now.

    Order:
    1. Real :class:`GteEmbedder` when (a) the extra is installed,
       (b) ``model_manager.is_ready(role)`` is True, and (c) the
       per-role current commit dir contains the expected files.
    2. :class:`StubEmbedder` for everything else.

    Failures during real-embedder construction (missing files, model
    init crash) are logged at WARN and fall through to the stub. The
    orchestrator prefers degraded-FTS results to no results at all.
    """
    if model_manager is None:
        LOG.debug("no model_manager wired; using StubEmbedder")
        return StubEmbedder()
    if not can_load_real_embedder():
        LOG.debug(
            "embedding extra not installed; using StubEmbedder "
            "(install with `uv sync --extra embedding`)"
        )
        return StubEmbedder()
    if not model_manager.is_ready(role):
        LOG.info(
            "embedding role not ready (state=%s); using StubEmbedder",
            model_manager.status().get(role, None),
        )
        return StubEmbedder()
    model_dir = _resolve_active_model_dir(model_manager, role)
    if model_dir is None:
        return StubEmbedder()
    try:
        return GteEmbedder(GteEmbedderConfig(model_dir=model_dir))
    except Exception as err:  # broad: any load-time fault → fallback
        LOG.warning(
            "failed to load GteEmbedder from %s: %s. Falling back "
            "to StubEmbedder.",
            model_dir,
            err,
        )
        return StubEmbedder()


def _resolve_active_model_dir(
    manager: "ModelManager", role: str
) -> Path | None:
    """Return the on-disk directory holding the active commit's files,
    or ``None`` when the layout is malformed."""
    role_dir = manager.role_dir(role)
    current = role_dir / "current"
    if not current.exists() and not current.is_symlink():
        LOG.warning("missing 'current' symlink under %s", role_dir)
        return None
    # Resolve the symlink target relative to the role dir; ModelManager
    # writes a relative target (the commit name).
    try:
        commit_dir = current.resolve(strict=True)
    except FileNotFoundError:
        LOG.warning("'current' symlink in %s points at a missing dir", role_dir)
        return None
    if not commit_dir.is_dir():
        return None
    return commit_dir
