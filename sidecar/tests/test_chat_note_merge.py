from __future__ import annotations

from search_sidecar.chat.note_merge import merge_live_note


def test_live_note_merge_replaces_draft_instead_of_appending_transcript():
    merged = merge_live_note(
        current_body="# Chat Note\n\nold answer",
        answer="new synthesized draft",
        citations=[{"sourceKind": "web", "title": "Report", "citation": "https://example.test"}],
    )

    assert "new synthesized draft" in merged
    assert "old answer" not in merged
    assert "[web] Report" in merged
