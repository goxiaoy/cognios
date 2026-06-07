from search_sidecar.topic_memory import TopicMemoryProposer


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


def test_topic_memory_proposer_groups_cross_source_topic_with_citations():
    payload = TopicMemoryProposer(StubStore()).propose()

    topics = payload["topics"]
    atlas = next(topic for topic in topics if topic["title"] == "Atlas")

    assert len(atlas["sources"]) == 3
    assert atlas["sources"][0]["nodeId"] == "meeting-1"
    assert atlas["sources"][0]["chunkId"] == "meeting-1:0"
    assert atlas["sources"][0]["chunkRole"] == "voice_transcript"
    assert atlas["claims"]
    assert atlas["events"][0]["occurredAt"] == "2026-06-01"
    assert atlas["relationships"]
