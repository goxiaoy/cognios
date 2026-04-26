"""Per-content-type processors.

Phase 2 / Unit 5 ships ``text``. ``pdf``, ``image``, ``url_cache``
land in follow-up commits — each pulls a heavy dep that justifies
its own focused commit.
"""

from .text import TextProcessor

__all__ = ["TextProcessor"]
