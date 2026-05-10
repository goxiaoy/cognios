"""Provider-neutral chat DTOs used inside the sidecar."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

ChatRole = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class ChatMessage:
    role: ChatRole
    content: str


@dataclass(frozen=True)
class ChatGenerationRequest:
    messages: list[ChatMessage]
    context: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ChatGeneration:
    content: str
    provider_id: str
    model: str
    usage: dict | None = None


class ChatProviderError(RuntimeError):
    """Recoverable provider failure suitable for typed Chat status surfaces."""
