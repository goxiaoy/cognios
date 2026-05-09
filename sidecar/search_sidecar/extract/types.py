"""Shared extraction result shapes."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


@dataclass(frozen=True)
class ExtractedMarkdown:
    """Markdown plus optional image objects referenced by that markdown.

    Local PP-StructureV3 returns ``markdown_images`` as a mapping from
    the relative path used in ``markdown_texts`` to a PIL image object.
    The image processor persists those objects next to the markdown
    artifact; cloud extractors keep returning plain strings.
    """

    text: str
    images: Mapping[str, Any] = field(default_factory=dict)
