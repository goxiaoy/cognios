"""``onnx-community/gte-multilingual-base`` embedder.

Wraps ``onnxruntime.InferenceSession`` + a Hugging Face
``tokenizers.Tokenizer`` to
produce 768-dim sentence embeddings. The pooling strategy and
normalization match the upstream model card:
**CLS pooling + L2 normalization** (sentence-transformers default).

Imports are deferred until the constructor runs so this module remains
importable without the ``embedding`` extra installed — the
:func:`search_sidecar.embeddings.select_embedder` factory falls back to
:class:`StubEmbedder` when ``onnxruntime``/``tokenizers`` are missing.

A typical model directory layout (matches the per-role tree
:class:`ModelManager` writes under
``<storage>/models/onnx-community/gte-multilingual-base/<commit>/``)::

    <model_dir>/
      onnx/
        model_int8.onnx
      config.json
      tokenizer.json
      tokenizer_config.json
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from ..storage import EMBEDDING_DIMENSION

LOG = logging.getLogger("search_sidecar.embeddings.gte")

DEFAULT_ONNX_FILE_NAME = "onnx/model_int8.onnx"
# v1 caps the per-call token budget conservatively. The model itself
# tolerates up to 8192 (rotary position), but our chunker emits ~500-
# token chunks so 1024 is more than enough headroom.
DEFAULT_MAX_LENGTH = 1024


@dataclass(frozen=True)
class GteEmbedderConfig:
    """Tunables for :class:`GteEmbedder`. Most callers stick with defaults."""

    model_dir: Path
    onnx_file_name: str = DEFAULT_ONNX_FILE_NAME
    max_length: int = DEFAULT_MAX_LENGTH
    batch_size: int = 16


class GteEmbedder:
    """Real semantic embedder backed by ONNX runtime.

    Construction loads the ONNX model + tokenizer eagerly so the first
    :meth:`embed` call doesn't pay a multi-second startup cost. Failure
    to load (file missing, tokenizer mismatched) raises
    :class:`RuntimeError` so the supervisor can fall back to
    :class:`StubEmbedder` rather than silently returning bad vectors.
    """

    def __init__(self, config: GteEmbedderConfig) -> None:
        self._config = config
        self._tokenizer, self._model = _load_model_and_tokenizer(config)
        # Bind numpy lazily so the module imports cleanly without it.
        import numpy as np

        self._np = np

    @property
    def dimension(self) -> int:
        return EMBEDDING_DIMENSION

    @property
    def is_semantic(self) -> bool:
        return True

    def embed(self, texts: Iterable[str]) -> list[list[float]]:
        """Tokenize, run the ONNX model, CLS-pool, L2-normalize.

        Returns an empty list when ``texts`` is empty (no allocation,
        no tokenizer call). Long inputs are truncated to
        :attr:`GteEmbedderConfig.max_length` tokens; sentence-
        transformers handles the same way upstream.
        """
        np = self._np
        materialised = [t for t in texts]
        if not materialised:
            return []
        out: list[list[float]] = []
        batch_size = self._config.batch_size
        for start in range(0, len(materialised), batch_size):
            batch = materialised[start : start + batch_size]
            encoded = _encode_batch(np, self._tokenizer, batch)
            feed = _build_onnx_inputs(np, encoded, self._model)
            model_out = self._model.run(None, feed)
            # ONNX output includes token embeddings with shape
            # ``(batch, seq, hidden)``. CLS pooling = index 0.
            last_hidden = _coerce_to_numpy(np, model_out)
            cls = last_hidden[:, 0, :]
            normed = _l2_normalize(np, cls)
            for row in normed:
                vec = row.astype("float32").tolist()
                if len(vec) != EMBEDDING_DIMENSION:
                    raise RuntimeError(
                        f"GteEmbedder produced {len(vec)}-dim vector; "
                        f"expected {EMBEDDING_DIMENSION}. Model file "
                        "likely mismatches the embedding role."
                    )
                out.append(vec)
        return out


# ----- internals ------------------------------------------------------------


def _load_model_and_tokenizer(config: GteEmbedderConfig):
    """Lazy-load onnxruntime + tokenizers, surface ``ImportError`` to the
    factory layer when the ``embedding`` extra isn't installed."""
    try:
        import onnxruntime as ort
        from tokenizers import Tokenizer
    except ImportError as cause:
        raise ImportError(
            "GteEmbedder requires the 'embedding' extra "
            "(`uv sync --extra embedding`)"
        ) from cause

    model_dir = config.model_dir
    if not model_dir.is_dir():
        raise RuntimeError(
            f"GteEmbedder model_dir does not exist: {model_dir}"
        )
    onnx_path = model_dir / config.onnx_file_name
    if not onnx_path.is_file():
        raise RuntimeError(
            f"GteEmbedder ONNX file missing: {onnx_path}"
        )

    tokenizer_path = model_dir / "tokenizer.json"
    if not tokenizer_path.is_file():
        raise RuntimeError(f"GteEmbedder tokenizer missing: {tokenizer_path}")

    LOG.info("loading GTE multilingual ONNX model from %s", model_dir)
    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    tokenizer.enable_truncation(max_length=config.max_length)
    pad_id = tokenizer.token_to_id("<pad>")
    if pad_id is None:
        raise RuntimeError("GteEmbedder tokenizer has no <pad> token")
    tokenizer.enable_padding(pad_id=pad_id, pad_token="<pad>")
    model = ort.InferenceSession(
        str(onnx_path),
        providers=["CPUExecutionProvider"],
    )
    return tokenizer, model


def _encode_batch(np, tokenizer, batch: list[str]) -> dict:
    encodings = tokenizer.encode_batch(batch)
    return {
        "input_ids": np.asarray(
            [encoding.ids for encoding in encodings], dtype="int64"
        ),
        "attention_mask": np.asarray(
            [encoding.attention_mask for encoding in encodings], dtype="int64"
        ),
    }


def _build_onnx_inputs(np, encoded, model) -> dict:
    input_names = {model_input.name for model_input in model.get_inputs()}
    feed = {
        name: np.asarray(value)
        for name, value in encoded.items()
        if name in input_names
    }
    missing = input_names - feed.keys()
    if missing:
        raise RuntimeError(
            "tokenizer output missing ONNX input(s): "
            + ", ".join(sorted(missing))
        )
    return feed


def _coerce_to_numpy(np, model_out):
    """Return the token-embedding output as a numpy array."""
    last_hidden = getattr(model_out, "last_hidden_state", None)
    if last_hidden is None:
        candidates = (
            model_out.values()
            if isinstance(model_out, dict)
            else model_out
            if isinstance(model_out, (list, tuple))
            else [model_out]
        )
        for candidate in candidates:
            arr = np.asarray(candidate)
            if arr.ndim == 3:
                return arr
        last_hidden = model_out
    arr = np.asarray(last_hidden)
    if arr.ndim != 3:
        raise RuntimeError(
            f"unexpected last_hidden_state rank {arr.ndim}; "
            "model is not a BERT-style feature extractor"
        )
    return arr


def _l2_normalize(np, matrix):
    norms = np.linalg.norm(matrix, axis=-1, keepdims=True)
    # Avoid divide-by-zero on degenerate inputs (shouldn't happen with
    # valid CLS embeddings; guard for completeness).
    norms = np.where(norms < 1e-12, 1.0, norms)
    return matrix / norms


# Convenience for tests + sanity checks: the unit-circle distance
# between two L2-normalised vectors is monotone with cosine similarity.
def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        raise ValueError("vector dimensions differ")
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for x, y in zip(a, b):
        dot += x * y
        norm_a += x * x
        norm_b += y * y
    denom = math.sqrt(norm_a) * math.sqrt(norm_b)
    if denom < 1e-12:
        return 0.0
    return dot / denom
