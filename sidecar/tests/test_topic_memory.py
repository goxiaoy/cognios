from search_sidecar.topic_memory import TopicMemoryProposer
from search_sidecar.chat.types import (
    ChatGeneration,
    ChatGenerationRequest,
    ChatProviderError,
)


class StubStore:
    def scan_user_chunks(self, *, limit: int = 2_000):
        assert limit == 2_000
        return [
            {
                "node_id": "meeting-1",
                "chunk_id": "meeting-1:0",
                "kind": "voice-note",
                "name": "Meeting Alpha",
                "path": "Voice Notes/Meeting Alpha.md",
                "role": "voice_transcript",
                "text": "Project Atlas launch plan was reviewed on 2026-06-01. Budget owner is Mei.",
            },
            {
                "node_id": "vault-1",
                "chunk_id": "vault-1:intro",
                "kind": "note",
                "name": "Atlas Brief",
                "path": "Obsidian/Atlas/Brief.md",
                "role": "body",
                "text": "Atlas launch depends on data migration and customer timeline alignment.",
            },
            {
                "node_id": "folder-1",
                "chunk_id": "folder-1:summary",
                "kind": "file",
                "name": "Migration Memo",
                "path": "Materials/Atlas/Migration.md",
                "role": "summary",
                "text": "The Atlas migration memo names launch risk and budget follow-up.",
            },
        ]


class NoiseStore:
    def scan_user_chunks(self, *, limit: int = 2_000):
        return [
            {
                "node_id": "css-1",
                "chunk_id": "css-1:0",
                "kind": "file",
                "name": "layout.css",
                "role": "body",
                "text": ".hero { text-align: center; display: flex; margin: 0; padding: 8px; }",
            },
            {
                "node_id": "html-1",
                "chunk_id": "html-1:0",
                "kind": "file",
                "name": "index.html",
                "role": "body",
                "text": '<div style="text-align: center"><img src="hero.jpeg"></div>',
            },
        ]


class FakeProvider:
    provider_id = "fake"
    model = "fake-model"

    def __init__(self, content: str):
        self.content = content
        self.requests: list[ChatGenerationRequest] = []

    def generate(self, request: ChatGenerationRequest) -> ChatGeneration:
        self.requests.append(request)
        return ChatGeneration(
            content=self.content,
            provider_id=self.provider_id,
            model=self.model,
        )


def test_topic_memory_proposer_requires_llm_for_valid_evidence():
    try:
        TopicMemoryProposer(StubStore()).propose()
    except ChatProviderError as err:
        assert "requires a configured LLM provider" in str(err)
    else:
        raise AssertionError("Topic Memory should not use a deterministic fallback")


def test_topic_memory_proposer_uses_llm_structured_topics_with_citations():
    provider = FakeProvider(
        """
        {
          "topics": [
            {
              "title": "Atlas Launch",
              "summary": "Atlas launch planning spans the meeting and migration memo.",
              "confidence": 0.86,
              "rationale": "The launch appears in multiple cited evidence chunks.",
              "sourceCitationIds": ["E1", "E2"],
              "claims": [
                {
                  "title": "Budget owner is Mei",
                  "body": "Budget owner is Mei.",
                  "citationId": "E1",
                  "confidence": 0.72,
                  "rationale": "Explicitly stated in the meeting transcript."
                }
              ],
              "events": [],
              "relationships": [
                {
                  "sourceLabel": "Atlas Launch",
                  "targetLabel": "Migration Memo",
                  "relationType": "depends_on",
                  "citationId": "E2",
                  "confidence": 0.66,
                  "rationale": "The brief names migration as a dependency."
                }
              ]
            }
          ]
        }
        """
    )

    payload = TopicMemoryProposer(StubStore(), chat_provider=provider).propose()

    assert provider.requests
    topics = payload["topics"]
    assert [topic["title"] for topic in topics] == ["Atlas Launch"]
    atlas = topics[0]
    assert atlas["sources"][0]["chunkId"] == "meeting-1:0"
    assert atlas["claims"][0]["citation"]["chunkId"] == "meeting-1:0"
    assert atlas["relationships"][0]["citation"]["chunkId"] == "vault-1:intro"


def test_topic_memory_ignores_css_and_html_noise_before_llm():
    payload = TopicMemoryProposer(NoiseStore()).propose()

    assert payload == {"topics": []}
