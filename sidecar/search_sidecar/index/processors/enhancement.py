"""Shared advanced-OCR enhancement helpers."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from ...extract.types import ExtractedMarkdown
from ..chunking import chunk_text

AdvancedOcrExtract = Callable[[Path], str | ExtractedMarkdown]
ExtractAssets = dict[str, Any]
MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*]\([^)]*\)")
HTML_IMAGE_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


def meaningful_chunks(text: str) -> list[str]:
    """Chunk advanced output and drop punctuation-only garbage."""
    return [chunk for chunk in chunk_text(text) if any(ch.isalnum() for ch in chunk)]


def extract_text_and_assets(
    output: str | ExtractedMarkdown | None,
) -> tuple[str, ExtractAssets]:
    if output is None:
        return "", {}
    if isinstance(output, ExtractedMarkdown):
        return output.text, dict(output.images)
    return str(output), {}


def strip_image_references(text: str) -> str:
    """Remove image-only references before embedding advanced OCR text."""
    without_markdown = MARKDOWN_IMAGE_RE.sub("", text)
    return HTML_IMAGE_RE.sub("", without_markdown)
