"""Local layout-aware OCR via PaddleOCR PP-StructureV3.

Wraps the official ``paddleocr`` Python package to run a multi-stage
pipeline on each image:

1. Document orientation classification + (optional) unwarping
2. Layout / region detection
3. Per-block routing → text / table / formula
4. Detection + recognition for text blocks
5. Wired/wireless table classification → cell detection → structure
   reconstruction
6. Formula recognition (LaTeX)

The output is PaddleOCR's Markdown/HTML hybrid (plain prose,
layout ``<div>`` blocks, HTML tables, formulas) so the preview layer
can render the same structure Paddle produced. The search index
ingests the same text until we split display artifacts from embedding
text.

Heavyweight dependency. ``paddleocr`` + ``paddlepaddle`` together are
~600 MB on disk; we declare them in the optional ``advanced-ocr``
extra and fall back to ``None`` from the factory when missing — same
gating pattern the basic OCR path used to follow before its deps
moved into the main package. The local-paddleocr-advanced provider
also requires :mod:`search_sidecar.models.manifest` to have
downloaded all 13 stage repos; the factory checks the manager's role
states before constructing the pipeline.

The extractor is constructed once per sidecar boot and held by the
dispatcher. Cold-start cost is several seconds (paddle loads ~13
sub-models), so we lazy-construct on first call rather than at
process startup — most users don't have advanced-ocr enabled.
"""

from __future__ import annotations

import importlib.util
import logging
import re
from pathlib import Path
from typing import Any, Callable, cast

from .types import ExtractedMarkdown

LOG = logging.getLogger("search_sidecar.extract.local_advanced_ocr")
BLANK_LINE_RE = re.compile(r"\n{3,}")


def can_load_local_advanced_ocr() -> bool:
    """Cheap check (no module import) for whether ``paddleocr`` and
    ``paddlepaddle`` are importable.

    Both are part of the optional ``advanced-ocr`` extra. Users who
    haven't enabled advanced OCR don't pay the install cost; the
    factory uses this check to skip silently with a warning.
    """
    return (
        importlib.util.find_spec("paddleocr") is not None
        and importlib.util.find_spec("paddle") is not None
    )


class PpStructureV3Extractor:
    """Callable that runs PP-StructureV3 against an image/PDF and returns
    a single Markdown artifact.

    ``model_dir_by_stage`` maps each pipeline stage name to the
    directory holding its inference files (``inference.json`` /
    ``inference.pdmodel`` / ``inference.pdiparams``). The factory
    builds this map from :class:`ModelManager`'s file layout
    (``<storage>/search/models/<role>/<commit>/``) so the local
    pipeline never reaches HuggingFace at runtime.

    Construction is deferred to the first call: paddleocr's pipeline
    init loads ~13 sub-models, which takes several seconds and ~1 GB
    of RAM. The first job pays this cost; subsequent jobs are fast.
    """

    # Map our role-prefixed names to the per-stage PP-StructureV3 init
    # kwargs paddleocr expects. Centralised here so the factory is
    # decoupled from paddleocr's specific naming.
    #
    # Each stage gets *two* kwargs: ``_model_dir`` (where the files
    # live on disk) and ``_model_name`` (the model identifier
    # paddleocr cross-references against the local config). Without
    # the name, paddleocr defaults to its own pipeline-internal
    # default (e.g. ``PP-OCRv5_server_det`` for text detection in
    # 3.x) and rejects our v4-mobile dirs with a "model name
    # mismatch" error. The matching name string is the basename of
    # the HuggingFace repo we pinned in models/manifest.py.
    STAGE_TO_KWARGS: dict[str, tuple[str, str]] = {
        # role_id -> (dir_kwarg, name_kwarg)
        "advanced-ocr-detection": (
            "text_detection_model_dir",
            "text_detection_model_name",
        ),
        "advanced-ocr-recognition": (
            "text_recognition_model_dir",
            "text_recognition_model_name",
        ),
        "advanced-ocr-layout": (
            "layout_detection_model_dir",
            "layout_detection_model_name",
        ),
        "advanced-ocr-region": (
            "region_detection_model_dir",
            "region_detection_model_name",
        ),
        "advanced-ocr-doc-orientation": (
            "doc_orientation_classify_model_dir",
            "doc_orientation_classify_model_name",
        ),
        "advanced-ocr-textline-orientation": (
            "textline_orientation_model_dir",
            "textline_orientation_model_name",
        ),
        "advanced-ocr-doc-unwarping": (
            "doc_unwarping_model_dir",
            "doc_unwarping_model_name",
        ),
        "advanced-ocr-table-classification": (
            "table_classification_model_dir",
            "table_classification_model_name",
        ),
        "advanced-ocr-table-structure-wired": (
            "wired_table_structure_recognition_model_dir",
            "wired_table_structure_recognition_model_name",
        ),
        "advanced-ocr-table-structure-wireless": (
            "wireless_table_structure_recognition_model_dir",
            "wireless_table_structure_recognition_model_name",
        ),
        "advanced-ocr-table-cells-wired": (
            "wired_table_cells_detection_model_dir",
            "wired_table_cells_detection_model_name",
        ),
        "advanced-ocr-table-cells-wireless": (
            "wireless_table_cells_detection_model_dir",
            "wireless_table_cells_detection_model_name",
        ),
        "advanced-ocr-formula": (
            "formula_recognition_model_dir",
            "formula_recognition_model_name",
        ),
    }

    # Backwards-compatible alias for callers that previously iterated
    # ``STAGE_TO_KWARG`` (the dir-only mapping). Returns the dir
    # kwarg for each stage. Tests against the older key still work.
    STAGE_TO_KWARG: dict[str, str] = {
        stage: dir_kwarg for stage, (dir_kwarg, _) in STAGE_TO_KWARGS.items()
    }
    supports_pdf = True

    def __init__(
        self,
        model_dir_by_stage: dict[str, Path],
        model_name_by_stage: dict[str, str] | None = None,
    ) -> None:
        if not can_load_local_advanced_ocr():
            raise RuntimeError(
                "paddleocr / paddlepaddle are not importable. Install "
                "the optional dep group with `uv sync --extra advanced-ocr`."
            )
        missing_stages = [
            stage
            for stage in self.STAGE_TO_KWARGS
            if stage not in model_dir_by_stage
        ]
        if missing_stages:
            raise RuntimeError(
                "PP-StructureV3 missing model dirs for stages: "
                + ", ".join(missing_stages)
            )
        self._model_dir_by_stage = dict(model_dir_by_stage)
        self._model_name_by_stage = dict(model_name_by_stage or {})
        # Pipeline is constructed on first call; see class docstring.
        self._pipeline: Any | None = None

    def __call__(self, path: Path) -> ExtractedMarkdown:
        """Run PP-StructureV3 on ``path``; return Markdown + images."""
        if not path.is_file():
            raise RuntimeError(f"local-advanced-ocr: missing document {path}")
        pipeline = self._ensure_pipeline()
        try:
            results = pipeline.predict(str(path))
        except Exception as err:
            raise RuntimeError(
                f"local-advanced-ocr: PP-StructureV3 raised on {path.name}: {err}"
            ) from err
        return _results_to_markdown(results)

    def _ensure_pipeline(self) -> Any:
        if self._pipeline is not None:
            return self._pipeline
        # Lazy import — keeps the cheap can_load check importable when
        # paddleocr isn't installed, and defers the multi-second module
        # load out of process startup into the first OCR job.
        from paddleocr import PPStructureV3  # type: ignore[import-not-found]

        kwargs: dict[str, str] = {}
        for stage, (dir_kwarg, name_kwarg) in self.STAGE_TO_KWARGS.items():
            kwargs[dir_kwarg] = str(self._model_dir_by_stage[stage])
            name = self._model_name_by_stage.get(stage)
            if name:
                kwargs[name_kwarg] = name
        LOG.info(
            "PP-StructureV3 pipeline init with %d stage model dirs (+%d names)",
            sum(1 for k in kwargs if k.endswith("_model_dir")),
            sum(1 for k in kwargs if k.endswith("_model_name")),
        )
        self._pipeline = PPStructureV3(**kwargs)
        return self._pipeline


def _results_to_markdown(results: Any) -> ExtractedMarkdown:
    """Flatten paddleocr's PP-StructureV3 result object into a
    single Markdown artifact.

    paddleocr 3.x's result type (paddlex's ``LayoutParsingResultV2``)
    is iterable yielding per-page ``MarkdownMixin`` instances. Each
    instance's ``.markdown`` property returns a dict of the shape::

        {
          "markdown_texts": "# Title\\n\\n...",
          "markdown_images": {"path/to.png": <PIL.Image>},
          "page_index": int | None,
          "input_path": str,
        }

    ``markdown_images`` are preserved under the same relative paths
    referenced by ``markdown_texts``. If multiple pages reuse the
    same image path, later pages receive a deterministic suffix and
    that page's markdown is rewritten to match.

    Returns an empty string when the pipeline produces no output —
    matches the basic OCR contract (the runner doesn't retry empty
    results).
    """
    if results is None:
        return ExtractedMarkdown("")
    fragments: list[str] = []
    images: dict[str, Any] = {}
    iterable = results if _is_iterable(results) else [results]
    for entry in iterable:
        text = _extract_markdown_text(entry)
        entry_images = _extract_markdown_images(entry)
        if text:
            clean_text = _clean_markdown_text(text)
            for source, image in entry_images.items():
                target = _unique_image_key(source, images)
                if target != source:
                    clean_text = clean_text.replace(source, target)
                images[target] = image
            fragments.append(clean_text)
    return ExtractedMarkdown("\n\n".join(f for f in fragments if f), images)


def _clean_markdown_text(text: str) -> str:
    """Preserve PaddleOCR's Markdown/HTML and only trim noisy whitespace."""
    return BLANK_LINE_RE.sub("\n\n", text).strip()


def _extract_markdown_text(entry: Any) -> str | None:
    """Pull markdown text out of one paddleocr result entry.

    Prefers the canonical ``MarkdownMixin.markdown`` property
    (returns a dict shaped like
    ``Dict[str, Union[str, Dict[str, Any]]]``) and reads its
    ``markdown_texts`` key. Falls back to other shapes for
    forward-compatibility.
    """
    md = _read_attr(entry, "markdown")
    text = _dict_str(md, "markdown_texts")
    if text is not None:
        return text
    if isinstance(md, str):
        return md
    # Older / serialised shapes: a plain dict with markdown already
    # extracted, or a dict whose ``markdown`` key holds the dict.
    text = _dict_str(entry, "markdown_texts")
    if text is not None:
        return text
    nested = _read_dict_key(entry, "markdown")
    text = _dict_str(nested, "markdown_texts")
    if text is not None:
        return text
    if isinstance(nested, str):
        return nested
    return None


def _extract_markdown_images(entry: Any) -> dict[str, Any]:
    """Pull PaddleOCR ``markdown_images`` out of one result entry."""
    md = _read_attr(entry, "markdown")
    images = _dict_mapping(md, "markdown_images")
    if images is not None:
        return images
    images = _dict_mapping(entry, "markdown_images")
    if images is not None:
        return images
    nested = _read_dict_key(entry, "markdown")
    images = _dict_mapping(nested, "markdown_images")
    return images or {}


def _unique_image_key(source: str, existing: dict[str, Any]) -> str:
    if source not in existing:
        return source
    path = source.replace("\\", "/")
    parent, sep, name = path.rpartition("/")
    stem, dot, suffix = name.rpartition(".")
    if not dot:
        stem, suffix = name, ""
    for idx in range(2, len(existing) + 3):
        next_name = f"{stem}-{idx}.{suffix}" if suffix else f"{stem}-{idx}"
        candidate = f"{parent}{sep}{next_name}" if parent else next_name
        if candidate not in existing:
            return candidate
    return f"{path}-{len(existing) + 1}"


def _dict_str(obj: Any, key: str) -> str | None:
    """If ``obj`` is a dict and ``obj[key]`` is a string, return it.
    Otherwise ``None``. Takes ``Any`` and does both isinstance
    checks internally so callers can pass freshly-narrowed values
    without losing track of the type."""
    if not isinstance(obj, dict):
        return None
    typed: dict[Any, Any] = cast("dict[Any, Any]", obj)
    val: Any = typed.get(key)
    return val if isinstance(val, str) else None


def _dict_mapping(obj: Any, key: str) -> dict[str, Any] | None:
    if not isinstance(obj, dict):
        return None
    typed: dict[Any, Any] = cast("dict[Any, Any]", obj)
    val: Any = typed.get(key)
    if not isinstance(val, dict):
        return None
    return {str(k): v for k, v in cast("dict[Any, Any]", val).items()}


def _read_dict_key(obj: Any, key: str) -> Any:
    """If ``obj`` is a dict, return ``obj[key]``; else ``None``."""
    if not isinstance(obj, dict):
        return None
    typed: dict[Any, Any] = cast("dict[Any, Any]", obj)
    return typed.get(key)


def _read_attr(obj: Any, name: str) -> Any:
    """Read ``obj.name`` (or ``obj.name()`` if callable). Returns
    whatever value was produced (no type filtering here — the
    caller decides how to interpret it). Swallows exceptions so a
    malformed property doesn't crash the dispatcher."""
    if not hasattr(obj, name):
        return None
    try:
        val = getattr(obj, name)
        if callable(val):
            val = val()
    except Exception:
        return None
    return val


def _is_iterable(obj: Any) -> bool:
    if isinstance(obj, (str, bytes, dict)):
        return False
    try:
        iter(obj)
        return True
    except TypeError:
        return False


# Public type alias for the callable shape ImageProcessor expects.
AdvancedOcrExtractor = Callable[[Path], str | ExtractedMarkdown]
