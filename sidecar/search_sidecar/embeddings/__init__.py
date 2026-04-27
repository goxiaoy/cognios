"""Real ONNX embedder wrappers.

Splits across files because each model has a different argument shape:

- :mod:`.gte` — ``onnx-community/gte-multilingual-base`` (the v1
  default; CLS-pool, L2-normalize, 768-dim).
- :mod:`.factory` — selects between :class:`StubEmbedder` and
  :class:`GteEmbedder` based on dependency presence + model state.

Importing this package does not import ``optimum`` or
``transformers``; those are deferred to :class:`GteEmbedder`'s
constructor so the sidecar starts even when the ``embedding`` extra
is not installed.
"""

from __future__ import annotations

from .factory import (
    EmbedderFactoryError,
    can_load_real_embedder,
    select_embedder,
)
from .gte import GteEmbedder, GteEmbedderConfig
from .reembed import ReembedSummary, reembed_stale_chunks

__all__ = [
    "EmbedderFactoryError",
    "GteEmbedder",
    "GteEmbedderConfig",
    "ReembedSummary",
    "can_load_real_embedder",
    "reembed_stale_chunks",
    "select_embedder",
]
