"""Cluster-first Chat turn orchestration."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .clustering import cluster_sources
from .provider import ChatProvider
from .retrieval import ChatRetrieval
from .sources import SourceCluster
from .types import ChatGenerationRequest, ChatMessage, ChatModelList, ChatProviderError


@dataclass(frozen=True)
class ChatTurnRequest:
    query: str
    messages: list[ChatMessage] = field(default_factory=list)
    accepted_cluster_ids: list[str] = field(default_factory=list)
    include_web: bool = True
    model: str | None = None


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


class ChatOrchestrator:
    def __init__(
        self,
        *,
        retrieval: ChatRetrieval,
        chat_provider: ChatProvider | None = None,
    ) -> None:
        self._retrieval = retrieval
        self._chat_provider = chat_provider

    def run_turn(self, request: ChatTurnRequest) -> ChatTurnResponse:
        sources, warnings = self._retrieval.retrieve(
            request.query,
            include_web=request.include_web,
        )
        clusters = cluster_sources(sources)
        if not request.accepted_cluster_ids:
            return ChatTurnResponse(
                state="awaiting_source_confirmation",
                clusters=clusters,
                warnings=warnings,
            )
        accepted = [
            cluster for cluster in clusters if cluster.cluster_id in set(request.accepted_cluster_ids)
        ]
        if not accepted:
            return ChatTurnResponse(
                state="needs_redirect",
                clusters=clusters,
                warnings=[*warnings, "no accepted source clusters"],
            )
        if self._chat_provider is None:
            return ChatTurnResponse(
                state="provider_unavailable",
                clusters=clusters,
                warnings=[*warnings, "chat provider unavailable"],
            )
        context = [_cluster_context(cluster) for cluster in accepted]
        messages = request.messages or [ChatMessage(role="user", content=request.query)]
        try:
            generation = self._chat_provider.generate(
                ChatGenerationRequest(
                    messages=messages,
                    context=context,
                    model=request.model,
                )
            )
        except ChatProviderError as err:
            return ChatTurnResponse(
                state="provider_error",
                clusters=clusters,
                warnings=[*warnings, str(err)],
            )
        citations = [
            {
                "sourceKind": source.source_kind,
                "title": source.title,
                "citation": source.citation,
            }
            for cluster in accepted
            for source in cluster.sources
        ]
        return ChatTurnResponse(
            state="ready",
            clusters=clusters,
            answer=generation.content,
            citations=citations,
            warnings=warnings,
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
