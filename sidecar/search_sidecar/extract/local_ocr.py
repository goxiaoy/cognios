"""Local OCR extractor — thin wrapper around ``rapidocr-onnxruntime``.

`rapidocr-onnxruntime <https://github.com/RapidAI/RapidOCR>`__ is the
ONNX-converted distribution of PaddleOCR's PP-OCRv4 detection +
recognition pipeline. It ships its model files inside the package
(no separate HuggingFace download), so this extractor does NOT
participate in :class:`ModelManager`'s download lifecycle — being a
declared dependency of the main package is enough to make local OCR
work out of the box.

The class is constructed once per sidecar boot, but the RapidOCR engine
is loaded on first use so sidecar startup can publish its runtime file
without waiting on onnxruntime model initialisation. Subsequent
``__call__`` invocations are plain inference. Thread safety:
rapidocr's ``RapidOCR`` instance is re-entrant for sync calls because
the underlying onnxruntime sessions serialize at the C level.

Failures (file not found, decode error, model crash) propagate as
``RuntimeError`` so the caller's ``_safe_extract`` wrapper logs and
downgrades to an empty string — never poisons the indexing queue.
"""

from __future__ import annotations

import importlib.util
import logging
import threading
from pathlib import Path
from typing import Any

LOG = logging.getLogger("search_sidecar.extract.local_ocr")


def can_load_local_ocr() -> bool:
    """Cheap check (no module import) for whether ``rapidocr_onnxruntime``
    is importable.

    The dep is part of the main package, so this returns ``True`` in
    every healthy install. Kept as a defensive net for venvs whose
    install partially failed or platforms where the wheel isn't
    available — the factory uses it to skip the OCR extractor and
    log instead of crashing the dispatcher path.
    """
    return importlib.util.find_spec("rapidocr_onnxruntime") is not None


class RapidOcrExtractor:
    """Callable that turns an image path into the concatenated OCR text.

    Two-line OCR results are joined with ``\\n`` so the chunker sees
    natural line breaks; recognised text below ``min_confidence`` is
    dropped on the floor (rapidocr's per-line confidence). The cutoff
    is intentionally low — recall over precision for a search index;
    a noisy false-positive word is fine, a missed real one is not.
    """

    def __init__(self, *, min_confidence: float = 0.3) -> None:
        if not can_load_local_ocr():
            raise RuntimeError(
                "rapidocr-onnxruntime is not importable in this environment "
                "(it is a declared dep of the main package; check the venv)."
            )
        self._engine: Any | None = None
        self._engine_lock = threading.Lock()
        self._min_confidence = min_confidence

    def __call__(self, path: Path) -> str:
        """Run OCR on ``path``; return joined text (may be empty)."""
        if not path.is_file():
            raise RuntimeError(f"local-ocr: missing image {path}")
        engine = self._get_engine()
        # rapidocr accepts a path (str) and returns
        # ``(results, elapsed)`` where ``results`` is a list of
        # ``[box, text, confidence]`` triples or ``None`` for an
        # image with no detected text.
        try:
            result, _ = engine(str(path))
        except Exception as err:
            raise RuntimeError(
                f"local-ocr: rapidocr raised on {path.name}: {err}"
            ) from err
        if not result:
            return ""
        lines: list[str] = []
        for entry in result:
            if not isinstance(entry, (list, tuple)) or len(entry) < 3:
                continue
            text = entry[1]
            confidence = entry[2]
            try:
                conf_f = float(confidence)
            except (TypeError, ValueError):
                conf_f = 0.0
            if conf_f < self._min_confidence:
                continue
            if isinstance(text, str) and text.strip():
                lines.append(text.strip())
        return "\n".join(lines)

    def _get_engine(self) -> Any:
        engine = self._engine
        if engine is not None:
            return engine
        with self._engine_lock:
            if self._engine is None:
                try:
                    from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]

                    self._engine = RapidOCR()
                except Exception as err:
                    raise RuntimeError(
                        f"local-ocr: rapidocr initialisation failed: {err}"
                    ) from err
            return self._engine
