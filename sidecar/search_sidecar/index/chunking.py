"""Shared text chunking helper.

The chunker is used by every text-bearing processor. It keeps the old
contract that short Markdown paragraphs become independent chunks, but
does a better job on long content:

1. Normalize line endings and parse a lightweight Markdown/HTML block
   tree.
2. Keep structural blocks such as headings, fenced code, tables, and
   HTML tables together when they fit.
3. Split overlong structured blocks by line, overlong prose by sentence,
   and pathological long spans by word boundary before falling back to
   a hard character cut.

The implementation remains dependency-free and character-count based.
A tokenizer-aware splitter can replace the final sizing heuristic once
we measure it against the production embedder.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

BlockKind = Literal["paragraph", "heading", "code", "table", "html_table"]


@dataclass(frozen=True)
class TextBlock:
    kind: BlockKind
    text: str


# 512 unicode chars is intentionally conservative for mixed English,
# Chinese, Markdown, and OCR output.
# Safe inside gte-multilingual's 8192-token window.
MAX_CHUNK_CHARS = 512
MIN_SOFT_BREAK_CHARS = int(MAX_CHUNK_CHARS * 0.55)

_ASCII_SENTENCE_TERMINATORS = ".!?"
_CJK_SENTENCE_TERMINATORS = "。！？；"
_CLOSING_PUNCTUATION = "\"'”’)]}）】》"
_FENCE_MARKERS = ("```", "~~~")


def chunk_text(text: str) -> list[str]:
    """Return ``text`` split into chunks of at most :data:`MAX_CHUNK_CHARS`."""
    normalized = _normalize_text(text)
    if not normalized:
        return []

    out: list[str] = []
    for block in _parse_blocks(normalized):
        text = block.text.strip()
        if not text:
            continue
        out.extend(_split_block(block))
    return out


def _normalize_text(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def _parse_blocks(text: str) -> list[TextBlock]:
    blocks: list[TextBlock] = []
    paragraph: list[str] = []
    lines = text.split("\n")
    i = 0

    def flush_paragraph() -> None:
        if paragraph:
            blocks.append(TextBlock("paragraph", "\n".join(paragraph).strip()))
            paragraph.clear()

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            flush_paragraph()
            i += 1
            continue

        fence_marker = _fence_marker(stripped)
        if fence_marker is not None:
            flush_paragraph()
            block, i = _consume_fenced_block(lines, i, fence_marker)
            blocks.append(TextBlock("code", block))
            continue

        if _starts_html_table(stripped):
            flush_paragraph()
            block, i = _consume_until(lines, i, "</table>")
            blocks.append(TextBlock("html_table", block))
            continue

        if _is_heading(stripped):
            flush_paragraph()
            blocks.append(TextBlock("heading", stripped))
            i += 1
            continue

        if _is_table_row(stripped):
            flush_paragraph()
            block, i = _consume_while(lines, i, _is_table_row)
            blocks.append(TextBlock("table", block))
            continue

        paragraph.append(line.rstrip())
        i += 1

    flush_paragraph()
    return blocks


def _split_block(block: TextBlock) -> list[str]:
    text = block.text.strip()
    if len(text) <= MAX_CHUNK_CHARS:
        return [text]
    if block.kind in {"code", "table", "html_table"}:
        return _split_by_lines(text)
    return _split_prose(text)


def _split_by_lines(block: str) -> list[str]:
    out: list[str] = []
    buf = ""

    for line in block.split("\n"):
        line = line.rstrip()
        if not line:
            continue

        if len(line) > MAX_CHUNK_CHARS:
            if buf:
                out.append(buf)
                buf = ""
            out.extend(_hard_wrap(line))
            continue

        candidate = line if not buf else f"{buf}\n{line}"
        if len(candidate) <= MAX_CHUNK_CHARS:
            buf = candidate
        else:
            out.append(buf)
            buf = line

    if buf:
        out.append(buf)
    return out


def _split_prose(text: str) -> list[str]:
    sentences = _split_sentences(text)
    if not sentences:
        return []

    out: list[str] = []
    buf = ""
    for sentence in sentences:
        pieces = (
            _hard_wrap(sentence)
            if len(sentence) > MAX_CHUNK_CHARS
            else [sentence]
        )
        for piece in pieces:
            if not piece:
                continue
            if not buf:
                buf = piece
                continue
            candidate = f"{buf} {piece}"
            if len(candidate) <= MAX_CHUNK_CHARS:
                buf = candidate
            else:
                out.append(buf)
                buf = piece

    if buf:
        out.append(buf)
    return out


def _split_sentences(text: str) -> list[str]:
    """Split prose on common English and CJK sentence boundaries."""
    out: list[str] = []
    start = 0
    i = 0
    while i < len(text):
        if not _is_sentence_boundary(text, i):
            i += 1
            continue

        end = i + 1
        while end < len(text) and text[end] in _CLOSING_PUNCTUATION:
            end += 1
        while end < len(text) and text[end].isspace():
            end += 1

        sentence = text[start:end].strip()
        if sentence:
            out.append(sentence)
        start = end
        i = end

    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return out


def _is_sentence_boundary(text: str, idx: int) -> bool:
    char = text[idx]
    if char in _CJK_SENTENCE_TERMINATORS:
        return True
    if char not in _ASCII_SENTENCE_TERMINATORS:
        return False

    prev_char = text[idx - 1] if idx > 0 else ""
    next_char = text[idx + 1] if idx + 1 < len(text) else ""
    if char == "." and prev_char.isdigit() and next_char.isdigit():
        return False
    return (
        not next_char
        or next_char.isspace()
        or next_char in _CLOSING_PUNCTUATION
        or next_char.isupper()
    )


def _hard_wrap(text: str) -> list[str]:
    chunks: list[str] = []
    remaining = text.strip()

    while len(remaining) > MAX_CHUNK_CHARS:
        cut = _best_soft_cut(remaining)
        chunk = remaining[:cut].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[cut:].strip()

    if remaining:
        chunks.append(remaining)
    return chunks


def _best_soft_cut(text: str) -> int:
    window = text[:MAX_CHUNK_CHARS]
    for separator in ("\n", " ", "\t"):
        idx = window.rfind(separator)
        if idx >= MIN_SOFT_BREAK_CHARS:
            return idx + 1
    return MAX_CHUNK_CHARS


def _fence_marker(stripped_line: str) -> str | None:
    for marker in _FENCE_MARKERS:
        if stripped_line.startswith(marker):
            return marker
    return None


def _consume_fenced_block(
    lines: list[str],
    start: int,
    marker: str,
) -> tuple[str, int]:
    out = [lines[start].rstrip()]
    i = start + 1
    while i < len(lines):
        line = lines[i].rstrip()
        out.append(line)
        if line.strip().startswith(marker):
            i += 1
            break
        i += 1
    return "\n".join(out).strip(), i


def _consume_until(
    lines: list[str],
    start: int,
    closing_token: str,
) -> tuple[str, int]:
    out: list[str] = []
    i = start
    closing = closing_token.lower()
    while i < len(lines):
        line = lines[i].rstrip()
        out.append(line)
        i += 1
        if closing in line.lower():
            break
    return "\n".join(out).strip(), i


def _consume_while(
    lines: list[str],
    start: int,
    predicate: Callable[[str], bool],
) -> tuple[str, int]:
    out: list[str] = []
    i = start
    while i < len(lines) and predicate(lines[i].strip()):
        out.append(lines[i].rstrip())
        i += 1
    return "\n".join(out).strip(), i


def _starts_html_table(stripped_line: str) -> bool:
    return "<table" in stripped_line.lower()


def _is_heading(stripped_line: str) -> bool:
    hashes = len(stripped_line) - len(stripped_line.lstrip("#"))
    return (
        1 <= hashes <= 6
        and len(stripped_line) > hashes
        and stripped_line[hashes] == " "
    )


def _is_table_row(stripped_line: str) -> bool:
    return (
        stripped_line.startswith("|")
        and stripped_line.endswith("|")
        and stripped_line.count("|") >= 2
    )
