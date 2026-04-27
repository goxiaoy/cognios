"""Per-content-type processors.

Phase 2 / Unit 5 ships ``text`` + ``url_cache``. ``pdf`` and ``image``
land in follow-up commits — each pulls a heavy dep that justifies
its own focused commit (PyMuPDF for PDF, paddleocr-onnx + the
llama-server HTTP client for image OCR + caption).
"""

from .text import TextProcessor
from .url_cache import URLCacheProcessor

__all__ = ["TextProcessor", "URLCacheProcessor"]
