"""Chat provider protocol."""

from __future__ import annotations

from typing import Protocol

from .types import ChatGeneration, ChatGenerationRequest, ChatModelList


class ChatProvider(Protocol):
    provider_id: str
    model: str

    def generate(self, request: ChatGenerationRequest) -> ChatGeneration:
        """Generate one assistant response from normalized chat messages."""

    def list_models(self) -> ChatModelList:
        """Return provider-supported chat models, preferably cached."""
