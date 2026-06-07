"""LLM-backed Topic Memory proposal generation.

The sidecar compiles indexed chunks into a bounded evidence pack, asks
the configured chat provider to synthesize durable topics, and validates
that every proposed source, claim, event, and relationship cites one of
those chunks. There is intentionally no deterministic topic fallback:
without an LLM provider, Topic Memory refresh fails instead of inventing
low-signal memory from token frequency.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..chat.provider import ChatProvider
from ..chat.types import ChatGenerationRequest, ChatMessage, ChatProviderError
from ..storage import LanceDBStore, role_or_default

JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.IGNORECASE | re.DOTALL)


@dataclass(frozen=True)
class TopicMemoryProposer:
    store: LanceDBStore
    chat_provider: ChatProvider | None = None
    max_chunks: int = 2_000
    max_topics: int = 8
    max_sources_per_topic: int = 8

    def propose(self) -> dict[str, list[dict[str, Any]]]:
        rows = [
            row
            for row in self.store.scan_user_chunks(limit=self.max_chunks)
            if str(row.get("text") or "").strip()
        ]
        if not rows:
            return {"topics": []}

        if self.chat_provider is None:
            raise ChatProviderError("Topic Memory requires a configured LLM provider.")

        return {"topics": self._llm_topics(rows)[: self.max_topics]}

    def _llm_topics(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        evidence = _evidence_pack(rows)
        if not evidence:
            return []
        evidence_by_id = {item["citationId"]: item for item in evidence}
        generation = self.chat_provider.generate(
            ChatGenerationRequest(
                messages=[
                    ChatMessage(
                        role="system",
                        content=(
                            "You synthesize durable personal Topic Memory from "
                            "indexed evidence. Create only meaningful topics a user "
                            "may ask about later: projects, people, decisions, plans, "
                            "meetings, research areas, tasks, and recurring themes. "
                            "You are responsible for deciding what is not memory: "
                            "do not create topics for UI tokens, CSS/HTML/code syntax, "
                            "file formats, generic layout words, or isolated keywords. "
                            "Every source, "
                            "claim, event, and relationship must cite evidence by "
                            "citationId from the supplied list. Return only JSON."
                        ),
                    ),
                    ChatMessage(
                        role="user",
                        content=(
                            "Evidence:\n"
                            + json.dumps(evidence, ensure_ascii=False)
                            + "\n\nReturn this JSON shape:\n"
                            "{\n"
                            '  "topics": [\n'
                            "    {\n"
                            '      "title": "short canonical topic name",\n'
                            '      "summary": "one sentence memory summary",\n'
                            '      "confidence": 0.0,\n'
                            '      "rationale": "why this is a durable topic",\n'
                            '      "sourceCitationIds": ["E1"],\n'
                            '      "claims": [{"title": "...", "body": "...", "citationId": "E1", "confidence": 0.0, "rationale": "..."}],\n'
                            '      "events": [{"title": "...", "body": "...", "occurredAt": "YYYY-MM-DD", "citationId": "E1", "confidence": 0.0, "rationale": "..."}],\n'
                            '      "relationships": [{"sourceLabel": "...", "targetLabel": "...", "relationType": "...", "citationId": "E1", "confidence": 0.0, "rationale": "..."}]\n'
                            "    }\n"
                            "  ]\n"
                            "}\n\n"
                            "Rules:\n"
                            "- Prefer 3-8 high-signal topics over broad recall.\n"
                            "- Do not create a topic from a formatting term, code token, CSS property, image format, or generic word.\n"
                            "- Do not include facts that are not directly supported by a citationId.\n"
                            "- If no durable topics are supported, return {\"topics\": []}."
                        ),
                    ),
                ],
                model=self.chat_provider.model,
            )
        )
        try:
            payload = _json_object(generation.content)
        except (json.JSONDecodeError, ValueError, TypeError) as err:
            raise ChatProviderError(f"Topic Memory LLM returned invalid JSON: {err}") from err
        return _topics_from_llm_payload(payload, evidence_by_id, self.max_sources_per_topic)


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


def _slug(term: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", term.lower()).strip("-")


def _truncate(value: str, max_len: int) -> str:
    value = " ".join(value.split())
    if len(value) <= max_len:
        return value
    return f"{value[: max_len - 1].rstrip()}…"


def _evidence_pack(rows: list[dict[str, Any]], *, limit: int = 80) -> list[dict[str, Any]]:
    packed: list[dict[str, Any]] = []
    seen_chunks: set[str] = set()
    for row in rows:
        chunk_id = _chunk_id(row)
        if chunk_id in seen_chunks:
            continue
        seen_chunks.add(chunk_id)
        citation_id = f"E{len(packed) + 1}"
        packed.append(
            {
                "citationId": citation_id,
                "nodeId": str(row.get("node_id") or ""),
                "nodeTitle": str(row.get("name") or row.get("node_id") or ""),
                "nodeKind": str(row.get("kind") or ""),
                "chunkId": chunk_id,
                "chunkRole": role_or_default(row),
                "anchorLabel": _anchor_label(role_or_default(row), chunk_id),
                "text": _truncate(str(row.get("text") or ""), 1_400),
            }
        )
        if len(packed) >= limit:
            break
    return packed


def _json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    fence = JSON_FENCE_RE.search(text)
    if fence is not None:
        text = fence.group(1).strip()
    if not text.startswith("{"):
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("topic memory response is not an object")
    return payload


def _topics_from_llm_payload(
    payload: dict[str, Any],
    evidence_by_id: dict[str, dict[str, Any]],
    max_sources_per_topic: int,
) -> list[dict[str, Any]]:
    raw_topics = payload.get("topics")
    if not isinstance(raw_topics, list):
        return []
    topics: list[dict[str, Any]] = []
    for raw_topic in raw_topics:
        if not isinstance(raw_topic, dict):
            continue
        title = str(raw_topic.get("title") or "").strip()
        if not title:
            continue
        source_ids = _citation_ids(raw_topic.get("sourceCitationIds"))
        for key in ("claims", "events", "relationships"):
            for item in raw_topic.get(key) if isinstance(raw_topic.get(key), list) else []:
                if isinstance(item, dict):
                    source_ids.extend(_citation_ids([item.get("citationId")]))
        source_ids = _dedupe([citation_id for citation_id in source_ids if citation_id in evidence_by_id])
        if not source_ids:
            continue

        rows = [_row_from_evidence(evidence_by_id[citation_id]) for citation_id in source_ids]
        topic = {
            "title": title,
            "summary": _truncate(str(raw_topic.get("summary") or ""), 220)
            or f"{title} is a synthesized memory topic.",
            "confidence": _confidence(raw_topic.get("confidence"), default=0.78),
            "rationale": _truncate(str(raw_topic.get("rationale") or "LLM synthesized from cited evidence."), 240),
            "sources": [
                _source_from_evidence(title, evidence_by_id[citation_id])
                for citation_id in source_ids[:max_sources_per_topic]
            ],
            "claims": _items_from_llm(raw_topic.get("claims"), evidence_by_id, title, "claim"),
            "events": _items_from_llm(raw_topic.get("events"), evidence_by_id, title, "event"),
            "relationships": _relationships_from_llm(
                raw_topic.get("relationships"), evidence_by_id, title
            ),
        }
        if not topic["claims"] and not topic["events"] and not topic["relationships"] and len(rows) < 2:
            continue
        topics.append(topic)
    return topics


def _citation_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _row_from_evidence(evidence: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": evidence.get("chunkId"),
        "node_id": evidence.get("nodeId"),
        "kind": evidence.get("nodeKind"),
        "name": evidence.get("nodeTitle"),
        "role": evidence.get("chunkRole"),
        "text": evidence.get("text"),
    }


def _source_from_evidence(title: str, evidence: dict[str, Any]) -> dict[str, Any]:
    row = _row_from_evidence(evidence)
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
        "confidence": 0.9,
        "rationale": "LLM selected this chunk as evidence for the topic.",
        "signature": f"source:{_slug(title)}:{node_id}:{chunk_id}",
    }


def _items_from_llm(
    value: Any,
    evidence_by_id: dict[str, dict[str, Any]],
    topic_title: str,
    item_type: str,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    items: list[dict[str, Any]] = []
    for raw in value[:6]:
        if not isinstance(raw, dict):
            continue
        citation_id = str(raw.get("citationId") or "").strip()
        evidence = evidence_by_id.get(citation_id)
        if evidence is None:
            continue
        title = _truncate(str(raw.get("title") or raw.get("body") or ""), 96)
        body = _truncate(str(raw.get("body") or title), 240)
        if not title or not body:
            continue
        row = _row_from_evidence(evidence)
        item = {
            "title": title,
            "body": body,
            "citation": _citation(row),
            "confidence": _confidence(raw.get("confidence"), default=0.7),
            "rationale": _truncate(str(raw.get("rationale") or "LLM extracted from cited evidence."), 220),
            "signature": f"{item_type}:{_slug(topic_title)}:{_slug(title)}:{citation_id}",
        }
        if item_type == "event":
            item["occurredAt"] = _normalise_date(str(raw.get("occurredAt") or ""))
        items.append(item)
    return items


def _relationships_from_llm(
    value: Any,
    evidence_by_id: dict[str, dict[str, Any]],
    topic_title: str,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    relationships: list[dict[str, Any]] = []
    for raw in value[:6]:
        if not isinstance(raw, dict):
            continue
        citation_id = str(raw.get("citationId") or "").strip()
        evidence = evidence_by_id.get(citation_id)
        if evidence is None:
            continue
        source_label = _truncate(str(raw.get("sourceLabel") or topic_title), 80)
        target_label = _truncate(str(raw.get("targetLabel") or ""), 80)
        relation_type = _truncate(str(raw.get("relationType") or "related_to"), 40)
        if not target_label:
            continue
        relationships.append(
            {
                "sourceLabel": source_label,
                "targetLabel": target_label,
                "relationType": relation_type,
                "citation": _citation(_row_from_evidence(evidence)),
                "confidence": _confidence(raw.get("confidence"), default=0.64),
                "rationale": _truncate(str(raw.get("rationale") or "LLM inferred from cited evidence."), 220),
                "signature": f"relationship:{_slug(topic_title)}:{_slug(source_label)}:{_slug(relation_type)}:{_slug(target_label)}:{citation_id}",
            }
        )
    return relationships


def _confidence(value: Any, *, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, parsed))


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
