"""Shared advanced-OCR enhancement helpers."""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any, Callable, Literal

import httpx

from ...extract.types import ExtractedMarkdown
from ..chunking import chunk_text
from ..queue import IndexingQueue, MAX_ENHANCEMENT_ATTEMPTS

AdvancedOcrExtract = Callable[[Path], str | ExtractedMarkdown]
ExtractAssets = dict[str, Any]
MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*]\([^)]*\)")
HTML_IMAGE_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


class EnhancementTransientError(Exception):
    """Raised after a retryable enhancement failure is recorded."""


def handle_enhancement_error(
    queue: IndexingQueue | None,
    node_id: str,
    err: Exception,
    *,
    log: logging.Logger,
) -> None:
    """Record retry bookkeeping and raise for retryable failures."""
    if classify_enhancement_error(err) == "transient":
        attempts = queue.bump_enhancement_attempts(node_id) if queue else 0
        if attempts < MAX_ENHANCEMENT_ATTEMPTS:
            raise EnhancementTransientError(str(err)) from err
    if queue is not None:
        queue.mark_enhancement_failed(node_id)
    log.warning("advanced-OCR enhancement failed terminally for %s: %s", node_id, err)


def classify_enhancement_error(
    exc: Exception,
) -> Literal["transient", "terminal"]:
    if isinstance(
        exc,
        (
            httpx.TransportError,
            httpx.ConnectError,
            httpx.ReadTimeout,
            httpx.WriteTimeout,
            asyncio.TimeoutError,
            ConnectionError,
        ),
    ):
        return "transient"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (429, 500, 502, 503, 504):
            return "transient"
        return "terminal"

    message = str(exc)
    if isinstance(exc, RuntimeError):
        if any(token in message for token in ("429", "500", "502", "503", "504")):
            return "transient"
        return "terminal"
    return "terminal"


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

