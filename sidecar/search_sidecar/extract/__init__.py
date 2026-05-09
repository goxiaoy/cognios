"""Document/image extractor wiring.

Three extractor families plug into :class:`ImageProcessor`:

- ``ocr_extract: Callable[[Path], str]`` — pulls visible text from
  the image. Stored as ``role="body"`` chunks.
- ``caption_extract: Callable[[Path], str]`` — generates a short
  description of the image. Stored as ``role="summary"`` chunks.
- ``advanced_ocr_extract: Callable[[Path], str | ExtractedMarkdown]`` —
  layout-aware OCR that emits Markdown (tables / formulas /
  structured text) plus optional extracted image assets.
  When wired and successful, takes priority over the basic
  ``ocr_extract`` for the body chunks.

Cloud (OpenAI / Qwen DashScope vision) and local (rapidocr,
PP-StructureV3) providers both produce these callables; the
factories here pick the right implementation from settings,
mirroring the embedder + reranker factories in shape.
"""

from .cloud_vision import OpenAICompatVisionClient
from .factory import (
    select_advanced_ocr_extractor,
    select_caption_extractor,
    select_ocr_extractor,
)

__all__ = [
    "OpenAICompatVisionClient",
    "select_advanced_ocr_extractor",
    "select_caption_extractor",
    "select_ocr_extractor",
]
