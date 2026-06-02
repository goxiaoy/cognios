"""Read-only Cognios tools exposed to the agentic Chat runtime."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic_ai import FunctionToolset

from ..index.content import NodeContentReader
from ..retrieval import SearchOrchestrator, SearchRequest


DEFAULT_SEARCH_LIMIT = 8
MAX_SEARCH_LIMIT = 10
DEFAULT_READ_MAX_CHARS = 8_000
MAX_READ_CHARS = 16_000
DEFAULT_SCOPE_MAX_NODES = 40
MAX_SCOPE_NODES = 100
DEFAULT_SCOPE_CHARS_PER_NODE = 2_000
MAX_SCOPE_CHARS_PER_NODE = 6_000
DEFAULT_GREP_LIMIT = 20
MAX_GREP_LIMIT = 100


@dataclass
class ChatToolEvent:
    kind: str
    tool_name: str
    status: str
    summary: str
    node_id: str | None = None
    result_count: int | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        body: dict[str, Any] = {
            "kind": self.kind,
            "toolName": self.tool_name,
            "status": self.status,
            "summary": self.summary,
        }
        if self.node_id is not None:
            body["nodeId"] = self.node_id
        if self.result_count is not None:
            body["resultCount"] = self.result_count
        if self.error:
            body["error"] = self.error
        return body


@dataclass
class ToolCitation:
    marker: str
    label: str
    node_id: str
    title: str
    path: str | None = None

    def to_dict(self) -> dict:
        body = {
            "marker": self.marker,
            "label": self.label,
            "nodeId": self.node_id,
            "citation": self.node_id,
            "title": self.title,
            "sourceKind": "workspace",
        }
        if self.path:
            body["path"] = self.path
        return body


@dataclass
class CogniosChatToolset:
    search_orchestrator: SearchOrchestrator | None
    content_reader: NodeContentReader
    citation_offset: int = 0
    event_sink: Callable[[dict], None] | None = None
    events: list[ChatToolEvent] = field(default_factory=list)
    citations: dict[str, ToolCitation] = field(default_factory=dict)
    _known_sources: dict[str, dict[str, Any]] = field(default_factory=dict)

    def as_function_toolset(self) -> FunctionToolset:
        return FunctionToolset(
            [self.grep_workspace],
            id="cognios_workspace_tools",
            instructions=(
                "Use grep_workspace only when the user's request needs Cognios "
                "workspace grounding. Do not call it for greetings or generic "
                "conversation. It works like grep: provide a query and optionally "
                "a scope_node_id such as an attached mount node id."
            ),
        )

    def grep_workspace(
        self,
        query: str = "",
        scope_node_id: str | None = None,
        max_results: int = DEFAULT_GREP_LIMIT,
        max_chars_per_result: int = DEFAULT_SCOPE_CHARS_PER_NODE,
    ) -> dict:
        """Search/read Cognios workspace content, optionally under one scope node."""
        self._emit_transient_event(
            ChatToolEvent(
                kind="tool_call",
                tool_name="grep_workspace",
                status="running",
                summary=(
                    f"Reading workspace scope {scope_node_id}."
                    if scope_node_id
                    else f"Searching workspace for {query!r}."
                ),
                node_id=scope_node_id,
            )
        )
        safe_limit = max(1, min(max_results or DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT))
        safe_chars = max(
            500,
            min(
                max_chars_per_result or DEFAULT_SCOPE_CHARS_PER_NODE,
                MAX_SCOPE_CHARS_PER_NODE,
            ),
        )
        normalized_query = (query or "").strip()
        if scope_node_id:
            return self._grep_scope(
                scope_node_id=scope_node_id,
                query=normalized_query,
                max_results=safe_limit,
                max_chars_per_result=safe_chars,
            )
        if not normalized_query:
            event = ChatToolEvent(
                kind="tool_result",
                tool_name="grep_workspace",
                status="error",
                summary="Workspace grep needs a query or scope.",
                error="query or scope_node_id required",
            )
            self._record_event(event)
            return {"ok": False, "error": event.error, "results": []}
        return self._grep_search(
            query=normalized_query,
            max_results=safe_limit,
            max_chars_per_result=safe_chars,
        )

    def search_workspace(self, query: str, limit: int = DEFAULT_SEARCH_LIMIT) -> dict:
        """Search indexed Cognios workspace content for relevant nodes."""
        if self.search_orchestrator is None:
            event = ChatToolEvent(
                kind="tool_result",
                tool_name="search_workspace",
                status="error",
                summary="Workspace search unavailable.",
                error="workspace search unavailable",
            )
            self._record_event(event)
            return {
                "ok": False,
                "error": event.error,
                "results": [],
            }

        safe_limit = max(1, min(limit or DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT))
        response = self.search_orchestrator.search(
            SearchRequest(query=query, limit=safe_limit)
        )
        results = []
        for result in response.results:
            source = {
                "node_id": result.node_id,
                "kind": result.kind,
                "title": result.name,
                "snippet": result.snippet,
                "path": result.path,
                "score": result.score,
                "matched_in": result.matched_in,
            }
            self._known_sources[result.node_id] = source
            results.append(source)
        self._record_event(
            ChatToolEvent(
                kind="tool_result",
                tool_name="search_workspace",
                status="ok",
                summary=f"Searched workspace for {query!r}; found {len(results)} result(s).",
                result_count=len(results),
            )
        )
        return {
            "ok": True,
            "query": query,
            "results": results,
            "degraded": response.degraded,
            "partial": response.partial,
        }

    def read_node(self, node_id: str, max_chars: int = DEFAULT_READ_MAX_CHARS) -> dict:
        """Read bounded indexed content for a Cognios workspace node."""
        content = self.content_reader.read(node_id)
        text = content.joined
        safe_max = max(1_000, min(max_chars or DEFAULT_READ_MAX_CHARS, MAX_READ_CHARS))
        truncated = len(text) > safe_max
        returned_text = text[:safe_max]
        source = self._known_sources.get(node_id, {})
        title = str(source.get("title") or node_id)
        path = source.get("path") if isinstance(source.get("path"), str) else None
        citation = self._citation_for(node_id=node_id, title=title, path=path)
        if content.kind is None and not content.chunks:
            status = "empty"
            summary = f"Node {node_id} has no indexed content available."
        else:
            status = "ok"
            summary = f"Read node {title}."
        self._record_event(
            ChatToolEvent(
                kind="tool_result",
                tool_name="read_node",
                status=status,
                summary=summary,
                node_id=node_id,
            )
        )
        return {
            "ok": True,
            "node_id": node_id,
            "kind": content.kind,
            "title": title,
            "path": path,
            "citation": citation.marker,
            "text": returned_text,
            "truncated": truncated,
            "chunk_count": len(content.chunks),
        }

    def read_workspace_scope(
        self,
        scope_node_id: str,
        max_nodes: int = DEFAULT_SCOPE_MAX_NODES,
        max_chars_per_node: int = DEFAULT_SCOPE_CHARS_PER_NODE,
    ) -> dict:
        """Read bounded indexed content for many nodes under a Cognios mount."""
        safe_nodes = max(1, min(max_nodes or DEFAULT_SCOPE_MAX_NODES, MAX_SCOPE_NODES))
        safe_chars = max(
            500,
            min(
                max_chars_per_node or DEFAULT_SCOPE_CHARS_PER_NODE,
                MAX_SCOPE_CHARS_PER_NODE,
            ),
        )
        scope_nodes = self.content_reader.list_mount_nodes(
            scope_node_id,
            limit=safe_nodes,
        )
        results = []
        truncated_nodes = 0
        for scope_node in scope_nodes:
            content = self.content_reader.read(scope_node.node_id)
            if not content.joined.strip():
                continue
            text = content.joined[:safe_chars]
            truncated = len(content.joined) > safe_chars
            if truncated:
                truncated_nodes += 1
            citation = self._citation_for(
                node_id=scope_node.node_id,
                title=scope_node.title,
                path=None,
            )
            self._known_sources[scope_node.node_id] = {
                "node_id": scope_node.node_id,
                "kind": scope_node.kind,
                "title": scope_node.title,
                "path": None,
            }
            results.append(
                {
                    "node_id": scope_node.node_id,
                    "kind": scope_node.kind,
                    "title": scope_node.title,
                    "citation": citation.marker,
                    "text": text,
                    "truncated": truncated,
                    "chunk_count": len(content.chunks),
                }
            )
        status = "ok" if results else "empty"
        summary = (
            f"Read {len(results)} node(s) under scope {scope_node_id}."
            if results
            else f"No indexed readable nodes found under scope {scope_node_id}."
        )
        self._record_event(
            ChatToolEvent(
                kind="tool_result",
                tool_name="read_workspace_scope",
                status=status,
                summary=summary,
                node_id=scope_node_id,
                result_count=len(results),
            )
        )
        return {
            "ok": True,
            "scope_node_id": scope_node_id,
            "nodes": results,
            "returned_count": len(results),
            "truncated_node_count": truncated_nodes,
            "max_nodes": safe_nodes,
            "max_chars_per_node": safe_chars,
        }

    def _grep_search(
        self,
        *,
        query: str,
        max_results: int,
        max_chars_per_result: int,
    ) -> dict:
        if self.search_orchestrator is None:
            event = ChatToolEvent(
                kind="tool_result",
                tool_name="grep_workspace",
                status="error",
                summary="Workspace search unavailable.",
                error="workspace search unavailable",
            )
            self._record_event(event)
            return {"ok": False, "error": event.error, "results": []}
        response = self.search_orchestrator.search(
            SearchRequest(query=query, limit=max_results)
        )
        results = []
        for result in response.results:
            self._known_sources[result.node_id] = {
                "node_id": result.node_id,
                "kind": result.kind,
                "title": result.name,
                "snippet": result.snippet,
                "path": result.path,
                "score": result.score,
                "matched_in": result.matched_in,
            }
            results.append(
                self._grep_node_result(
                    node_id=result.node_id,
                    title=result.name,
                    kind=result.kind,
                    path=result.path,
                    max_chars=max_chars_per_result,
                    snippet=result.snippet,
                )
            )
        self._record_event(
            ChatToolEvent(
                kind="tool_result",
                tool_name="grep_workspace",
                status="ok",
                summary=f"Grep workspace for {query!r}; found {len(results)} result(s).",
                result_count=len(results),
            )
        )
        return {
            "ok": True,
            "query": query,
            "scope_node_id": None,
            "results": results,
            "returned_count": len(results),
            "degraded": response.degraded,
            "partial": response.partial,
        }

    def _grep_scope(
        self,
        *,
        scope_node_id: str,
        query: str,
        max_results: int,
        max_chars_per_result: int,
    ) -> dict:
        nodes = self.content_reader.list_mount_nodes(scope_node_id, limit=max_results)
        results = []
        lowered_query = query.lower()
        for node in nodes:
            result = self._grep_node_result(
                node_id=node.node_id,
                title=node.title,
                kind=node.kind,
                path=None,
                max_chars=max_chars_per_result,
            )
            haystack = f"{node.title}\n{result.get('text') or ''}".lower()
            if lowered_query and lowered_query not in haystack:
                continue
            results.append(result)
            if len(results) >= max_results:
                break
        if not results and nodes:
            for node in nodes:
                result = self._grep_node_result(
                    node_id=node.node_id,
                    title=node.title,
                    kind=node.kind,
                    path=None,
                    max_chars=max_chars_per_result,
                )
                if not result.get("chunk_count"):
                    continue
                results.append(result)
                if len(results) >= max_results:
                    break
        if not results and not nodes:
            result = self._grep_node_result(
                node_id=scope_node_id,
                title=self._source_title(scope_node_id),
                kind=None,
                path=self._source_path(scope_node_id),
                max_chars=max_chars_per_result,
            )
            if result.get("chunk_count"):
                results.append(result)
        status = "ok" if results else "empty"
        summary = (
            f"Grep scope {scope_node_id}; returned {len(results)} node(s)."
            if results
            else f"No readable nodes matched scope {scope_node_id}."
        )
        self._record_event(
            ChatToolEvent(
                kind="tool_result",
                tool_name="grep_workspace",
                status=status,
                summary=summary,
                node_id=scope_node_id,
                result_count=len(results),
            )
        )
        return {
            "ok": True,
            "query": query,
            "scope_node_id": scope_node_id,
            "results": results,
            "returned_count": len(results),
        }

    def _grep_node_result(
        self,
        *,
        node_id: str,
        title: str,
        kind: str | None,
        path: str | None,
        max_chars: int,
        snippet: str | None = None,
    ) -> dict:
        content = self.content_reader.read(node_id)
        text = content.joined[:max_chars]
        citation = self._citation_for(node_id=node_id, title=title, path=path)
        return {
            "node_id": node_id,
            "kind": kind or content.kind,
            "title": title,
            "path": path,
            "citation": citation.marker,
            "snippet": snippet,
            "text": text,
            "truncated": len(content.joined) > max_chars,
            "chunk_count": len(content.chunks),
        }

    def _source_title(self, node_id: str) -> str:
        source = self._known_sources.get(node_id, {})
        title = source.get("title")
        return title if isinstance(title, str) and title else node_id

    def _source_path(self, node_id: str) -> str | None:
        source = self._known_sources.get(node_id, {})
        path = source.get("path")
        return path if isinstance(path, str) and path else None

    def citation_dicts(self) -> list[dict]:
        return [citation.to_dict() for citation in self.citations.values()]

    def event_dicts(self) -> list[dict]:
        return [event.to_dict() for event in self.events]

    def _record_event(self, event: ChatToolEvent) -> None:
        self.events.append(event)
        self._emit_transient_event(event)

    def _emit_transient_event(self, event: ChatToolEvent) -> None:
        if self.event_sink is not None:
            self.event_sink(event.to_dict())

    def _citation_for(
        self, *, node_id: str, title: str, path: str | None
    ) -> ToolCitation:
        if node_id in self.citations:
            return self.citations[node_id]
        marker = f"W{self.citation_offset + len(self.citations) + 1}"
        citation = ToolCitation(
            marker=marker,
            label=_citation_display_label(title, path),
            node_id=node_id,
            title=title,
            path=path,
        )
        self.citations[node_id] = citation
        return citation


class CogniosChatToolsetFactory:
    def __init__(
        self,
        *,
        search_orchestrator: SearchOrchestrator | None,
        content_reader: NodeContentReader,
    ) -> None:
        self._search_orchestrator = search_orchestrator
        self._content_reader = content_reader

    def create(
        self,
        *,
        citation_offset: int = 0,
        event_sink: Callable[[dict], None] | None = None,
    ) -> CogniosChatToolset:
        return CogniosChatToolset(
            search_orchestrator=self._search_orchestrator,
            content_reader=self._content_reader,
            citation_offset=citation_offset,
            event_sink=event_sink,
        )


def _citation_display_label(title: str, path: str | None) -> str:
    source = (path or title).rstrip("/\\")
    if not source:
        return title
    return source.replace("\\", "/").rsplit("/", 1)[-1] or title
