"""Model manifest, downloader, and license-gate (Phase 2 / Unit 4).

The roles — embedding, reranker, ASR, OCR stages — each map to a
HuggingFace repo with commit-pinned files and per-file SHA-256s. The
manager downloads, verifies, and activates the role's commit folder
under ``<storage>/models/<namespace>/<repo>/<commit>/`` with a ``current``
symlink for cold-start lookup.
"""

from .manager import ModelManager, ProgressEvent, RoleStatus
from .manifest import DEFAULTS, FileSpec, ModelSpec

__all__ = [
    "DEFAULTS",
    "FileSpec",
    "ModelSpec",
    "ModelManager",
    "ProgressEvent",
    "RoleStatus",
]
