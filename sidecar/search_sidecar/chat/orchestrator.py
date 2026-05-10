"""Cluster-first Chat turn orchestration."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import asdict, dataclass, field

from .clustering import cluster_sources
from .provider import ChatProvider
from .retrieval import ChatRetrieval
from .sources import SourceCluster
from .types import (
    ChatGeneration,
    ChatGenerationRequest,
    ChatMessage,
    ChatModelList,
    ChatProviderError,
)
from ..web_search.brave import BraveWebSearchProvider


@dataclass(frozen=True)
class ChatContextNode:
    node_id: str
    title: str
    kind: str | None = None
    path: str | None = None
    snippet: str | None = None
    content: str | None = None


@dataclass(frozen=True)
class ChatTurnRequest:
    query: str
    messages: list[ChatMessage] = field(default_factory=list)
    accepted_cluster_ids: list[str] = field(default_factory=list)
    include_web: bool = True
    model: str | None = None
    context_nodes: list[ChatContextNode] = field(default_factory=list)


@dataclass(frozen=True)
class ChatTurnResponse:
    state: str
    clusters: list[SourceCluster]
    answer: str | None = None
    citations: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    provider: dict | None = None

    def to_dict(self) -> dict:
        body = asdict(self)
        body["clusters"] = [cluster.to_dict() for cluster in self.clusters]
        return body


@dataclass(frozen=True)
class ChatTurnStreamEvent:
    event: str
    delta: str | None = None
    turn: ChatTurnResponse | None = None
    clusters: list[SourceCluster] = field(default_factory=list)
    citations: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict:
        body = asdict(self)
        body["clusters"] = [cluster.to_dict() for cluster in self.clusters]
        if self.turn is not None:
            body["turn"] = self.turn.to_dict()
        return body


@dataclass(frozen=True)
class _PreparedTurn:
    clusters: list[SourceCluster]
    accepted: list[SourceCluster]
    context: list[str]
    messages: list[ChatMessage]
    warnings: list[str]
    citations: list[dict]


class ChatOrchestrator:
    def __init__(
        self,
        *,
        retrieval: ChatRetrieval,
        chat_provider: ChatProvider | None = None,
    ) -> None:
        self._retrieval = retrieval
        self._chat_provider = chat_provider

    def set_chat_provider(self, chat_provider: ChatProvider | None) -> None:
        _close_if_supported(self._chat_provider)
        self._chat_provider = chat_provider

    def set_web_search_provider(
        self, web_search_provider: BraveWebSearchProvider | None
    ) -> None:
        self._retrieval.set_web_search_provider(web_search_provider)

    def run_turn(self, request: ChatTurnRequest) -> ChatTurnResponse:
        prepared = self._prepare_turn(request)
        if request.accepted_cluster_ids and not prepared.accepted:
            return ChatTurnResponse(
                state="needs_redirect",
                clusters=prepared.clusters,
                warnings=[*prepared.warnings, "no accepted source clusters"],
            )
        if self._chat_provider is None:
            return ChatTurnResponse(
                state="provider_unavailable",
                clusters=prepared.clusters,
                warnings=[*prepared.warnings, "chat provider unavailable"],
            )
        try:
            generation = self._chat_provider.generate(
                ChatGenerationRequest(
                    messages=prepared.messages,
                    context=prepared.context,
                    model=request.model,
                )
            )
        except ChatProviderError as err:
            return ChatTurnResponse(
                state="provider_error",
                clusters=prepared.clusters,
                warnings=[*prepared.warnings, str(err)],
            )
        return self._ready_response(prepared, generation)

    def stream_turn(self, request: ChatTurnRequest) -> Iterator[ChatTurnStreamEvent]:
        prepared = self._prepare_turn(request)
        if request.accepted_cluster_ids and not prepared.accepted:
            yield ChatTurnStreamEvent(
                event="final",
                turn=ChatTurnResponse(
                    state="needs_redirect",
                    clusters=prepared.clusters,
                    warnings=[*prepared.warnings, "no accepted source clusters"],
                ),
            )
            return
        if self._chat_provider is None:
            yield ChatTurnStreamEvent(
                event="final",
                turn=ChatTurnResponse(
                    state="provider_unavailable",
                    clusters=prepared.clusters,
                    warnings=[*prepared.warnings, "chat provider unavailable"],
                ),
            )
            return

        yield ChatTurnStreamEvent(
            event="metadata",
            clusters=prepared.clusters,
            citations=prepared.citations,
            warnings=prepared.warnings,
        )

        answer_parts: list[str] = []
        provider_id = self._chat_provider.provider_id
        model = request.model or self._chat_provider.model
        usage: dict | None = None
        try:
            stream = getattr(self._chat_provider, "generate_stream", None)
            if callable(stream):
                for chunk in stream(
                    ChatGenerationRequest(
                        messages=prepared.messages,
                        context=prepared.context,
                        model=request.model,
                    )
                ):
                    if chunk.content_delta:
                        answer_parts.append(chunk.content_delta)
                        yield ChatTurnStreamEvent(event="delta", delta=chunk.content_delta)
                    if chunk.provider_id:
                        provider_id = chunk.provider_id
                    if chunk.model:
                        model = chunk.model
                    if chunk.usage:
                        usage = chunk.usage
            else:
                generation = self._chat_provider.generate(
                    ChatGenerationRequest(
                        messages=prepared.messages,
                        context=prepared.context,
                        model=request.model,
                    )
                )
                answer_parts.append(generation.content)
                provider_id = generation.provider_id
                model = generation.model
                usage = generation.usage
                yield ChatTurnStreamEvent(event="delta", delta=generation.content)
        except ChatProviderError as err:
            yield ChatTurnStreamEvent(
                event="final",
                turn=ChatTurnResponse(
                    state="provider_error",
                    clusters=prepared.clusters,
                    warnings=[*prepared.warnings, str(err)],
                ),
                error=str(err),
            )
            return

        answer = "".join(answer_parts).strip()
        if not answer:
            warning = "chat provider returned an empty response"
            yield ChatTurnStreamEvent(
                event="final",
                turn=ChatTurnResponse(
                    state="provider_error",
                    clusters=prepared.clusters,
                    warnings=[*prepared.warnings, warning],
                ),
                error=warning,
            )
            return
        yield ChatTurnStreamEvent(
            event="final",
            turn=self._ready_response(
                prepared,
                ChatGeneration(
                    content=answer,
                    provider_id=provider_id,
                    model=model,
                    usage=usage,
                ),
            ),
        )

    def _prepare_turn(self, request: ChatTurnRequest) -> _PreparedTurn:
        sources, warnings = self._retrieval.retrieve(
            request.query,
            include_web=request.include_web,
        )
        clusters = cluster_sources(sources)
        if request.accepted_cluster_ids:
            accepted = [
                cluster
                for cluster in clusters
                if cluster.cluster_id in set(request.accepted_cluster_ids)
            ]
        else:
            accepted = clusters
        context = [
            *[_manual_context(node) for node in request.context_nodes],
            *[_cluster_context(cluster) for cluster in accepted],
        ]
        messages = request.messages or [ChatMessage(role="user", content=request.query)]
        citations = [
            {
                "sourceKind": "workspace",
                "title": node.title,
                "citation": node.node_id,
            }
            for node in request.context_nodes
        ] + [
            {
                "sourceKind": source.source_kind,
                "title": source.title,
                "citation": source.citation,
            }
            for cluster in accepted
            for source in cluster.sources
        ]
        return _PreparedTurn(
            clusters=clusters,
            accepted=accepted,
            context=context,
            messages=messages,
            warnings=warnings,
            citations=citations,
        )

    def _ready_response(
        self, prepared: _PreparedTurn, generation: ChatGeneration
    ) -> ChatTurnResponse:
        return ChatTurnResponse(
            state="ready",
            clusters=prepared.clusters,
            answer=generation.content,
            citations=prepared.citations,
            warnings=prepared.warnings,
            provider={
                "providerId": generation.provider_id,
                "model": generation.model,
                "usage": generation.usage,
            },
        )

    def list_models(self) -> ChatModelList | None:
        if self._chat_provider is None:
            return None
        return self._chat_provider.list_models()


def _cluster_context(cluster: SourceCluster) -> str:
    lines = [f"Cluster: {cluster.title}", cluster.summary]
    for source in cluster.sources:
        lines.append(f"- [{source.source_kind}] {source.title}: {source.snippet} ({source.citation})")
    return "\n".join(lines)


def _manual_context(node: ChatContextNode) -> str:
    lines = [f"User-attached node: {node.title}"]
    if node.kind:
        lines.append(f"Kind: {node.kind}")
    if node.path:
        lines.append(f"Path: {node.path}")
    body = (node.content or node.snippet or "").strip()
    if body:
        lines.append(body)
    return "\n".join(lines)


def _close_if_supported(provider: object | None) -> None:
    close = getattr(provider, "close", None)
    if callable(close):
        close()
