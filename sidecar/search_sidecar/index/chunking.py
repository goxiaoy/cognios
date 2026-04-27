"""Shared chunking helper.

Used by every text-bearing processor (text/markdown, url_cache, future
PDF). Strategy:

1. Split on paragraph boundaries (blank-line separators).
2. If any paragraph is still longer than :data:`MAX_CHUNK_CHARS`, split
   it on sentence terminators (period/exclamation/question marks plus
   the Chinese variants) and pack sentences greedily into the cap.
3. If a single sentence is still too long (no terminators at all),
   hard-break at :data:`MAX_CHUNK_CHARS`.

Cheap, language-agnostic, and good enough until we measure recall
against the real embedder. A tokenizer-aware splitter is a v1b
optimisation.
"""

from __future__ import annotations

# 512 unicode chars ≈ 100-150 tokens for English, fewer for Chinese.
# Safe inside gte-multilingual's 8192-token window.
MAX_CHUNK_CHARS = 512
PARAGRAPH_SEPARATORS = ("\n\n", "\r\n\r\n")
SENTENCE_TERMINATORS = (". ", "! ", "? ", "。", "！", "？")


def chunk_text(text: str) -> list[str]:
    """Return ``text`` split into chunks of at most :data:`MAX_CHUNK_CHARS`."""
    if not text or not text.strip():
        return []
    paragraphs = _split_paragraphs(text)
    out: list[str] = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) <= MAX_CHUNK_CHARS:
            out.append(para)
            continue
        out.extend(_split_long_paragraph(para))
    return out


def _split_paragraphs(text: str) -> list[str]:
    parts: list[str] = [text]
    for sep in PARAGRAPH_SEPARATORS:
        next_parts: list[str] = []
        for piece in parts:
            next_parts.extend(piece.split(sep))
        parts = next_parts
    return parts


def _split_long_paragraph(paragraph: str) -> list[str]:
    sentences = _split_sentences(paragraph)
    out: list[str] = []
    buf = ""
    for sentence in sentences:
        # Hard-break sentences longer than the cap.
        while len(sentence) > MAX_CHUNK_CHARS:
            head, sentence = sentence[:MAX_CHUNK_CHARS], sentence[MAX_CHUNK_CHARS:]
            if buf:
                out.append(buf)
                buf = ""
            out.append(head)
        if not sentence:
            continue
        if not buf:
            buf = sentence
        elif len(buf) + 1 + len(sentence) <= MAX_CHUNK_CHARS:
            buf = f"{buf} {sentence}"
        else:
            out.append(buf)
            buf = sentence
    if buf:
        out.append(buf)
    return out


def _split_sentences(paragraph: str) -> list[str]:
    """Greedy split on a small set of sentence terminators."""
    sentences: list[str] = []
    buf = ""
    i = 0
    while i < len(paragraph):
        match = None
        for term in SENTENCE_TERMINATORS:
            if paragraph.startswith(term, i):
                match = term
                break
        if match is not None:
            buf += match
            sentences.append(buf.strip())
            buf = ""
            i += len(match)
            continue
        buf += paragraph[i]
        i += 1
    if buf.strip():
        sentences.append(buf.strip())
    return sentences
