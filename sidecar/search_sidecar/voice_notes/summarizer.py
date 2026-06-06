"""LLM-backed Voice Note summarization."""

from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any

from ..chat.provider import ChatProvider
from ..chat.types import ChatGenerationRequest, ChatMessage


@dataclass(frozen=True)
class VoiceNoteSummary:
    summary: str
    action_items: list[str]
    provider_id: str
    model: str
    usage: dict | None = None


def summarize_voice_note_transcript(
    provider: ChatProvider,
    transcript: str,
    *,
    model: str | None = None,
) -> VoiceNoteSummary:
    text = transcript.strip()
    if not text:
        raise ValueError("voice note transcript cannot be blank")

    generation = provider.generate(
        ChatGenerationRequest(
            messages=[
                ChatMessage(
                    role="system",
                    content=(
                        "You summarize voice-note transcripts for a desktop notes app. "
                        "Return only a strict JSON object with keys `summary` and "
                        "`action_items`. `summary` must be concise but specific. "
                        "`action_items` must be an array of concrete follow-up tasks; "
                        "use an empty array when none are present."
                    ),
                ),
                ChatMessage(
                    role="user",
                    content=f"Transcript:\n\n{text}",
                ),
            ],
            model=model,
        )
    )
    payload = _parse_summary_payload(generation.content)
    summary = str(payload.get("summary") or "").strip()
    if not summary:
        raise ValueError("LLM returned an empty voice note summary")
    raw_items = payload.get("action_items")
    action_items = [
        str(item).strip()
        for item in raw_items
        if isinstance(item, str) and item.strip()
    ] if isinstance(raw_items, list) else []
    return VoiceNoteSummary(
        summary=summary,
        action_items=action_items,
        provider_id=generation.provider_id,
        model=generation.model,
        usage=generation.usage,
    )


def _parse_summary_payload(content: str) -> dict[str, Any]:
    text = content.strip()
    if not text:
        raise ValueError("LLM returned an empty voice note summary response")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if match is None:
            raise ValueError("LLM summary response was not JSON") from None
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError as err:
            raise ValueError("LLM summary response was not valid JSON") from err
    if not isinstance(payload, dict):
        raise ValueError("LLM summary response must be a JSON object")
    return payload
