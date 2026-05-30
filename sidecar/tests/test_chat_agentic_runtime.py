from __future__ import annotations

import json

from pydantic_ai.models.test import TestModel
from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.chat.agent_runtime import (
    AgenticProvider,
    AgentRuntimeRequest,
    AgentRuntimeResult,
    PydanticAgentRuntime,
    _looks_like_tool_unsupported_error,
)
from search_sidecar.chat.orchestrator import ChatOrchestrator
from search_sidecar.chat.retrieval import ChatRetrieval
from search_sidecar.chat.tools import CogniosChatToolset
from search_sidecar.chat.tools import CogniosChatToolsetFactory
from search_sidecar.chat.types import ChatMessage
from search_sidecar.index.content import NodeContentResult
from search_sidecar.index.content import ScopeNode
from search_sidecar.retrieval import SearchResponse, SearchResult

TOKEN = "0123456789abcdef" * 4


class _Search:
    def __init__(self) -> None:
        self.calls = []

    def search(self, request):
        self.calls.append(request)
        return SearchResponse(
            results=(
                SearchResult(
                    node_id="n1",
                    kind="note",
                    name="事故报告.md",
                    score=0.9,
                    snippet="事故经过和费用",
                    matched_in="content",
                    path="案件/事故报告.md",
                ),
            ),
            degraded=False,
        )


class _ContentReader:
    def read(self, node_id: str) -> NodeContentResult:
        body = "完整事故报告内容" * 200
        return NodeContentResult(
            node_id=node_id,
            kind="note",
            chunks=[{"id": f"{node_id}:0", "role": "body", "text": body}],
            joined=body,
        )

    def list_mount_nodes(self, mount_id: str, *, limit: int = 100) -> list[ScopeNode]:
        return [
            ScopeNode(node_id="n1", kind="note", title="一月开销.md"),
            ScopeNode(node_id="n2", kind="note", title="二月开销.md"),
        ][:limit]


class _NoRetrieval(ChatRetrieval):
    def __init__(self) -> None:
        pass

    def retrieve(self, query: str, *, limit: int = 8, include_web: bool = True):
        raise AssertionError("agentic chat should not pre-retrieve")


class _AgenticProvider:
    provider_id = "test-agentic"
    model = "test-model"

    def agentic_provider(self, model: str | None = None) -> AgenticProvider:
        return AgenticProvider(
            provider_id=self.provider_id,
            model_id=model or self.model,
            model=TestModel(call_tools=[], custom_output_text="unused"),
        )


class _Runtime:
    def run(self, request: AgentRuntimeRequest) -> AgentRuntimeResult:
        assert request.messages[0].content == "hi"
        assert request.context == []
        assert request.provider is not None
        assert request.toolset is not None
        return AgentRuntimeResult(
            state="ready",
            answer="hello",
            provider={
                "providerId": request.provider.provider_id,
                "model": request.provider.model_id,
            },
        )


class _ToolCallingRuntime:
    def run(self, request: AgentRuntimeRequest) -> AgentRuntimeResult:
        assert request.toolset is not None
        request.toolset.grep_workspace(query="开销", scope_node_id="mount-expenses")
        return AgentRuntimeResult(
            state="ready",
            answer="已读取开销文件 [W1] [W2]",
            tool_events=request.toolset.event_dicts(),
            citations=request.toolset.citation_dicts(),
            provider={"providerId": "test-agentic", "model": "test-model"},
        )


def _auth():
    return {"Authorization": f"Bearer {TOKEN}"}


def test_agentic_chat_route_does_not_pre_search_for_greeting():
    app = build_app(
        token=TOKEN,
        chat_orchestrator=ChatOrchestrator(
            retrieval=_NoRetrieval(),
            chat_provider=_AgenticProvider(),  # type: ignore[arg-type]
            agent_runtime=_Runtime(),  # type: ignore[arg-type]
            toolset_factory=CogniosChatToolsetFactory(
                search_orchestrator=None,
                content_reader=_ContentReader(),  # type: ignore[arg-type]
            ),
        ),
    )

    with TestClient(app) as client:
        resp = client.post("/chat/turns", json={"query": "hi"}, headers=_auth())

    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "ready"
    assert body["answer"] == "hello"
    assert body["clusters"] == []
    assert body["tool_events"] == []


def test_agentic_chat_stream_emits_tool_events_before_final_answer():
    app = build_app(
        token=TOKEN,
        chat_orchestrator=ChatOrchestrator(
            retrieval=_NoRetrieval(),
            chat_provider=_AgenticProvider(),  # type: ignore[arg-type]
            agent_runtime=_ToolCallingRuntime(),  # type: ignore[arg-type]
            toolset_factory=CogniosChatToolsetFactory(
                search_orchestrator=None,
                content_reader=_ContentReader(),  # type: ignore[arg-type]
            ),
        ),
    )

    with TestClient(app) as client:
        with client.stream(
            "POST",
            "/chat/turns/stream",
            json={"query": "汇总开销"},
            headers=_auth(),
        ) as resp:
            events = [
                json.loads(line.removeprefix("data: "))
                for line in resp.iter_lines()
                if line.startswith("data: ")
            ]

    event_names = [event["event"] for event in events]
    assert event_names[:2] == ["metadata", "tool"]
    assert events[1]["tool_events"][0]["status"] == "running"
    assert events[2]["event"] == "tool"
    assert events[2]["tool_events"][0]["status"] == "ok"
    assert events[-2]["event"] == "delta"
    assert events[-1]["event"] == "final"
    assert events[-1]["turn"]["tool_events"][0]["toolName"] == "grep_workspace"


def test_agent_runtime_does_not_search_for_direct_model_response():
    search = _Search()
    toolset = CogniosChatToolset(
        search_orchestrator=search,
        content_reader=_ContentReader(),  # type: ignore[arg-type]
    )

    result = PydanticAgentRuntime().run(
        AgentRuntimeRequest(
            messages=[ChatMessage(role="user", content="hi")],
            provider=AgenticProvider(
                provider_id="test",
                model_id="test",
                model=TestModel(call_tools=[], custom_output_text="hello"),
            ),
            toolset=toolset,
        )
    )

    assert result.state == "ready"
    assert result.answer == "hello"
    assert search.calls == []
    assert result.tool_events == []
    assert result.citations == []


def test_agent_runtime_classifies_tool_unsupported_provider_errors():
    err = RuntimeError(
        "status_code: 400, model_name: gemma3:4b, body: {'message': "
        "'registry.ollama.ai/library/gemma3:4b does not support tools'}"
    )

    assert _looks_like_tool_unsupported_error(err) is True


def test_cognios_toolset_searches_and_reads_workspace_nodes():
    search = _Search()
    toolset = CogniosChatToolset(
        search_orchestrator=search,
        content_reader=_ContentReader(),  # type: ignore[arg-type]
    )

    search_result = toolset.search_workspace("事故", limit=50)
    read_result = toolset.read_node("n1", max_chars=4)

    assert search.calls[0].query == "事故"
    assert search.calls[0].limit == 10
    assert search_result["results"][0]["node_id"] == "n1"
    assert read_result["citation"] == "W1"
    assert read_result["text"].startswith("完整事故报告内容")
    assert len(read_result["text"]) == 1000
    assert read_result["truncated"] is True
    assert toolset.event_dicts() == [
        {
            "kind": "tool_result",
            "toolName": "search_workspace",
            "status": "ok",
            "summary": "Searched workspace for '事故'; found 1 result(s).",
            "resultCount": 1,
        },
        {
            "kind": "tool_result",
            "toolName": "read_node",
            "status": "ok",
            "summary": "Read node 事故报告.md.",
            "nodeId": "n1",
        },
    ]
    assert toolset.citation_dicts()[0]["marker"] == "W1"
    assert toolset.citation_dicts()[0]["label"] == "事故报告.md"


def test_cognios_toolset_reads_mount_scope_in_one_tool_call():
    toolset = CogniosChatToolset(
        search_orchestrator=None,
        content_reader=_ContentReader(),  # type: ignore[arg-type]
    )

    result = toolset.read_workspace_scope(
        "mount-expenses",
        max_nodes=10,
        max_chars_per_node=1200,
    )

    assert result["returned_count"] == 2
    assert [node["title"] for node in result["nodes"]] == ["一月开销.md", "二月开销.md"]
    assert result["nodes"][0]["citation"] == "W1"
    assert result["nodes"][1]["citation"] == "W2"
    assert toolset.event_dicts() == [
        {
            "kind": "tool_result",
            "toolName": "read_workspace_scope",
            "status": "ok",
            "summary": "Read 2 node(s) under scope mount-expenses.",
            "nodeId": "mount-expenses",
            "resultCount": 2,
        }
    ]


def test_cognios_toolset_exposes_one_grep_like_tool_to_agent():
    toolset = CogniosChatToolset(
        search_orchestrator=None,
        content_reader=_ContentReader(),  # type: ignore[arg-type]
    )

    function_toolset = toolset.as_function_toolset()

    assert [tool.name for tool in function_toolset.tools.values()] == ["grep_workspace"]


def test_cognios_grep_workspace_reads_scope_content():
    toolset = CogniosChatToolset(
        search_orchestrator=None,
        content_reader=_ContentReader(),  # type: ignore[arg-type]
    )

    result = toolset.grep_workspace(
        query="开销",
        scope_node_id="mount-expenses",
        max_results=10,
        max_chars_per_result=1200,
    )

    assert result["returned_count"] == 2
    assert [node["title"] for node in result["results"]] == ["一月开销.md", "二月开销.md"]
    assert result["results"][0]["citation"] == "W1"
    assert toolset.event_dicts() == [
        {
            "kind": "tool_result",
            "toolName": "grep_workspace",
            "status": "ok",
            "summary": "Grep scope mount-expenses; returned 2 node(s).",
            "nodeId": "mount-expenses",
            "resultCount": 2,
        }
    ]
