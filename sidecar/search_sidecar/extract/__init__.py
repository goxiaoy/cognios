"""Image-extractor wiring.

Two extractor families plug into :class:`ImageProcessor`:

- ``ocr_extract: Callable[[Path], str]`` — pulls visible text from
  the image. Stored as ``role="body"`` chunks.
- ``caption_extract: Callable[[Path], str]`` — generates a short
  description of the image. Stored as ``role="summary"`` chunks.

Cloud (OpenAI / Qwen DashScope vision) and local (rapidocr) providers
both produce these callables; the factories here pick the right
implementation from settings, mirroring the embedder + reranker
factories in shape.
"""

from .cloud_vision import OpenAICompatVisionClient
from .factory import select_caption_extractor, select_ocr_extractor

__all__ = [
    "OpenAICompatVisionClient",
    "select_caption_extractor",
    "select_ocr_extractor",
]
