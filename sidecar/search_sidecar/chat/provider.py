"""Chat provider protocol."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Protocol

from .agent_runtime import AgenticProvider
from .types import ChatGeneration, ChatGenerationChunk, ChatGenerationRequest, ChatModelList


class ChatProvider(Protocol):
    provider_id: str
    model: str

    def generate(self, request: ChatGenerationRequest) -> ChatGeneration:
        """Generate one assistant response from normalized chat messages."""

    def generate_stream(
        self, request: ChatGenerationRequest
    ) -> Iterator[ChatGenerationChunk]:
        """Generate one assistant response as incremental text chunks."""

    def list_models(self) -> ChatModelList:
        """Return provider-supported chat models, preferably cached."""

    def agentic_provider(self, model: str | None = None) -> AgenticProvider | None:
        """Return a native tool-calling model adapter when supported."""
