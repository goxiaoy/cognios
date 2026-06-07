"""Deterministic Topic Memory proposal generation.

This is the local baseline for the memory layer. It compiles indexed
chunks into topic candidates with citations and reviewable proposals,
without requiring a chat provider. Model-backed synthesis can replace or
enrich this later, but the durable contract stays the same.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..storage import LanceDBStore, role_or_default

STOPWORDS = {
    "about",
    "action",
    "after",
    "also",
    "and",
    "are",
    "because",
    "before",
    "from",
    "have",
    "meeting",
    "notes",
    "that",
    "the",
    "this",
    "with",
    "will",
    "would",
    "your",
}
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{3,}")
DATE_RE = re.compile(r"\b(20\d{2}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?)\b")
SENTENCE_RE = re.compile(r"(?<=[.!?。！？])\s+")


@dataclass(frozen=True)
class TopicMemoryProposer:
    store: LanceDBStore
    max_chunks: int = 2_000
    max_topics: int = 8
    max_sources_per_topic: int = 8

    def propose(self) -> dict[str, list[dict[str, Any]]]:
        rows = self.store.scan_user_chunks(limit=self.max_chunks)
        if not rows:
            return {"topics": []}

        term_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
        term_node_counts: dict[str, Counter[str]] = defaultdict(Counter)
        for row in rows:
            node_id = str(row.get("node_id") or "")
            text = _evidence_text(row)
            for term in _terms(text):
                term_rows[term].append(row)
                if node_id:
                    term_node_counts[term][node_id] += 1

        ranked_terms = sorted(
            (
                (term, len(node_counts), sum(node_counts.values()))
                for term, node_counts in term_node_counts.items()
                if len(node_counts) >= 2
            ),
            key=lambda item: (item[1], item[2], item[0]),
            reverse=True,
        )

        topics = [
            self._topic_for_term(term, term_rows[term], node_count, hit_count)
            for term, node_count, hit_count in ranked_terms[: self.max_topics]
        ]
        return {"topics": topics}

    def _topic_for_term(
        self,
        term: str,
        rows: list[dict[str, Any]],
        node_count: int,
        hit_count: int,
    ) -> dict[str, Any]:
        by_node: dict[str, dict[str, Any]] = {}
        for row in rows:
            node_id = str(row.get("node_id") or "")
            if not node_id or node_id in by_node:
                continue
            by_node[node_id] = row
            if len(by_node) >= self.max_sources_per_topic:
                break

        sources = [self._source_for_row(term, row) for row in by_node.values()]
        claims = [
            self._claim_for_row(term, row)
            for row in list(by_node.values())[:3]
            if _sentence_containing(row.get("text") or "", term)
        ]
        events = [
            event
            for row in list(by_node.values())[:4]
            for event in [self._event_for_row(term, row)]
            if event is not None
        ]
        relationships = self._relationships(term, list(by_node.values()))
        confidence = min(0.95, 0.62 + (node_count * 0.08) + min(hit_count, 8) * 0.01)
        title = _title(term)
        return {
            "title": title,
            "summary": f"{title} appears across {node_count} indexed sources.",
            "confidence": round(confidence, 3),
            "rationale": f"Repeated term across {node_count} sources and {hit_count} matching chunks.",
            "sources": sources,
            "claims": claims,
            "events": events,
            "relationships": relationships,
        }

    def _source_for_row(self, term: str, row: dict[str, Any]) -> dict[str, Any]:
        node_id = str(row.get("node_id") or "")
        chunk_id = _chunk_id(row)
        role = role_or_default(row)
        return {
            "nodeId": node_id,
            "nodeTitle": str(row.get("name") or node_id),
            "nodeKind": str(row.get("kind") or ""),
            "path": row.get("path"),
            "chunkId": chunk_id,
            "chunkRole": role,
            "anchorLabel": _anchor_label(role, chunk_id),
            "confidence": 0.88,
            "rationale": f"Source chunk mentions {_title(term)}.",
            "signature": f"source:{_slug(term)}:{node_id}:{chunk_id}",
        }

    def _claim_for_row(self, term: str, row: dict[str, Any]) -> dict[str, Any]:
        sentence = _sentence_containing(str(row.get("text") or ""), term)
        citation = _citation(row)
        return {
            "title": _truncate(sentence, 96),
            "body": sentence,
            "citation": citation,
            "confidence": 0.68,
            "rationale": "Candidate claim extracted from an indexed chunk; review before trusting.",
            "signature": f"claim:{_slug(term)}:{row.get('id')}",
        }

    def _event_for_row(self, term: str, row: dict[str, Any]) -> dict[str, Any] | None:
        text = str(row.get("text") or "")
        match = DATE_RE.search(text)
        if match is None:
            return None
        sentence = _sentence_containing(text, term) or _truncate(text, 140)
        return {
            "title": _truncate(sentence, 90),
            "body": sentence,
            "occurredAt": _normalise_date(match.group(1)),
            "citation": _citation(row),
            "confidence": 0.64,
            "rationale": "Candidate event contains a date-like expression and topic term.",
            "signature": f"event:{_slug(term)}:{row.get('id')}:{match.group(1)}",
        }

    def _relationships(self, term: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        names = [
            str(row.get("name") or "")
            for row in rows
            if str(row.get("name") or "").strip()
        ]
        if len(names) < 2:
            return []
        return [
            {
                "sourceLabel": _title(term),
                "targetLabel": _truncate(name, 80),
                "relationType": "mentioned_in",
                "citation": _citation(row),
                "confidence": 0.58,
                "rationale": "Relationship is derived from source membership and should be reviewed.",
                "signature": f"relationship:{_slug(term)}:{row.get('node_id')}",
            }
            for name, row in zip(names[:3], rows[:3], strict=False)
        ]


def _evidence_text(row: dict[str, Any]) -> str:
    return f"{row.get('name') or ''}\n{row.get('text') or ''}"


def _terms(text: str) -> set[str]:
    words = [word.lower() for word in WORD_RE.findall(text)]
    candidates = {
        word
        for word in words
        if len(word) >= 3 and word not in STOPWORDS and not word.isdigit()
    }
    for left, right in zip(words, words[1:], strict=False):
        if left not in STOPWORDS and right not in STOPWORDS:
            candidates.add(f"{left} {right}")
    return candidates


def _sentence_containing(text: str, term: str) -> str:
    term_lower = term.lower()
    for sentence in SENTENCE_RE.split(text.strip()):
        if term_lower in sentence.lower():
            return _truncate(sentence.strip(), 240)
    return ""


def _citation(row: dict[str, Any]) -> dict[str, Any]:
    chunk_id = _chunk_id(row)
    role = role_or_default(row)
    return {
        "nodeId": str(row.get("node_id") or ""),
        "chunkId": chunk_id,
        "chunkRole": role,
        "anchorLabel": _anchor_label(role, chunk_id),
        "path": row.get("path"),
        "page": None,
        "timestampMs": None,
    }


def _chunk_id(row: dict[str, Any]) -> str:
    return str(row.get("id") or row.get("chunk_id") or "")


def _anchor_label(role: str, chunk_id: str) -> str:
    suffix = chunk_id.rsplit(":", 1)[-1] if chunk_id else "0"
    if role == "voice_transcript":
        return f"Transcript segment {suffix}"
    if role == "summary":
        return f"Summary chunk {suffix}"
    return f"Chunk {suffix}"


def _title(term: str) -> str:
    if re.search(r"[A-Za-z]", term):
        return " ".join(part.capitalize() for part in term.split())
    return term


def _slug(term: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", term.lower()).strip("-")


def _truncate(value: str, max_len: int) -> str:
    value = " ".join(value.split())
    if len(value) <= max_len:
        return value
    return f"{value[: max_len - 1].rstrip()}…"


def _normalise_date(value: str) -> str:
    normalized = value.replace("年", "-").replace("月", "-").replace("日", "")
    normalized = normalized.replace("/", "-")
    parts = [part for part in normalized.split("-") if part]
    if len(parts) >= 3:
        try:
            return datetime(int(parts[0]), int(parts[1]), int(parts[2])).date().isoformat()
        except ValueError:
            return value
    if len(parts) == 2:
        try:
            return datetime(int(parts[0]), int(parts[1]), 1).date().isoformat()
        except ValueError:
            return value
    return value
