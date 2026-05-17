"""``onnx-community/gte-multilingual-reranker-base`` cross-encoder.

Wraps ``optimum.onnxruntime.ORTModelForSequenceClassification`` + a
HF ``AutoTokenizer`` to score (query, document) pairs. Higher logit
= more relevant — the orchestrator uses the raw logit as the score
directly (no sigmoid; we only need a monotonic ranking).

Imports of ``optimum`` and ``transformers`` are deferred to the
constructor so this module remains importable without the
``embedding`` extra installed (the same extra ships the embedder's
deps; both share one switch).

A typical model directory layout (matches the per-role tree
:class:`ModelManager` writes under
``<storage>/models/onnx-community/gte-multilingual-reranker-base/<commit>/``)::

    <model_dir>/
      onnx/
        model_int8.onnx
      config.json
      tokenizer.json
      tokenizer_config.json
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

LOG = logging.getLogger("search_sidecar.rerank.gte")

DEFAULT_ONNX_FILE_NAME = "onnx/model_int8.onnx"
DEFAULT_MAX_LENGTH = 512
DEFAULT_BATCH_SIZE = 8


@dataclass(frozen=True)
class GteRerankerConfig:
    """Tunables for :class:`GteReranker`. Most callers stick with defaults."""

    model_dir: Path
    onnx_file_name: str = DEFAULT_ONNX_FILE_NAME
    max_length: int = DEFAULT_MAX_LENGTH
    batch_size: int = DEFAULT_BATCH_SIZE


class GteReranker:
    """Real cross-encoder reranker backed by ONNX runtime.

    Construction loads the ONNX model + tokenizer eagerly. Failure
    to load (file missing, tokenizer mismatched) raises
    :class:`RuntimeError` so the supervisor can fall back to "no
    reranker" rather than silently producing noisy rankings.
    """

    def __init__(self, config: GteRerankerConfig) -> None:
        self._config = config
        self._tokenizer, self._model = _load_model_and_tokenizer(config)
        # Bind numpy lazily so the module imports cleanly without it.
        import numpy as np

        self._np = np

    def rerank(self, query: str, documents: list[str]) -> list[float]:
        """Score each ``(query, doc)`` pair and return the scores in
        the same order as ``documents``. An empty document list short-
        circuits to an empty score list (no tokenizer call).
        """
        if not documents:
            return []
        np = self._np
        scores: list[float] = []
        batch_size = self._config.batch_size
        for start in range(0, len(documents), batch_size):
            batch_docs = documents[start : start + batch_size]
            pairs = [[query, doc] for doc in batch_docs]
            encoded = self._tokenizer(
                pairs,
                padding=True,
                truncation=True,
                max_length=self._config.max_length,
                return_tensors="np",
            )
            model_out = self._model(**encoded)
            logits = _coerce_logits(np, model_out)
            scores.extend(_to_score_vector(logits))
        return scores


# ----- internals ------------------------------------------------------------


def _load_model_and_tokenizer(config: GteRerankerConfig):
    """Lazy-load optimum + transformers, surface ``ImportError`` to the
    factory layer when the ``embedding`` extra isn't installed."""
    try:
        from optimum.onnxruntime import ORTModelForSequenceClassification
        from transformers import AutoTokenizer
    except ImportError as cause:
        raise ImportError(
            "GteReranker requires the 'embedding' extra "
            "(`uv sync --extra embedding`)"
        ) from cause

    model_dir = config.model_dir
    if not model_dir.is_dir():
        raise RuntimeError(
            f"GteReranker model_dir does not exist: {model_dir}"
        )
    onnx_path = model_dir / config.onnx_file_name
    if not onnx_path.is_file():
        raise RuntimeError(
            f"GteReranker ONNX file missing: {onnx_path}"
        )

    LOG.info(
        "loading GTE multilingual reranker ONNX model from %s", model_dir
    )
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir))
    model = ORTModelForSequenceClassification.from_pretrained(
        str(model_dir),
        file_name=config.onnx_file_name,
    )
    return tokenizer, model


def _coerce_logits(np, model_out):
    """``ORTModelForSequenceClassification`` returns either a HF
    ``SequenceClassifierOutput`` or a tuple. Normalise to numpy."""
    logits = getattr(model_out, "logits", None)
    if logits is None:
        logits = model_out[0]
    return np.asarray(logits)


def _to_score_vector(logits) -> list[float]:
    """Convert a logits matrix into a flat list of relevance scores.

    GTE reranker's head outputs shape ``(batch, 1)`` — a single
    relevance logit per pair. For two-class heads (``(batch, 2)``)
    the relevance score is the positive-class logit; we use index 1
    by convention. Anything else surfaces as a clear error rather
    than a silently-wrong ranking.
    """
    arr = logits.reshape(logits.shape[0], -1)
    if arr.shape[1] == 1:
        return arr[:, 0].astype("float32").tolist()
    if arr.shape[1] == 2:
        return arr[:, 1].astype("float32").tolist()
    raise RuntimeError(
        f"unexpected reranker logits shape {logits.shape}; "
        "expected (batch,) or (batch, 1) or (batch, 2)"
    )
