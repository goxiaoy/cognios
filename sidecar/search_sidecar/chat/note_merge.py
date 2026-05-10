"""Deterministic live-note merge helper.

The provider-prompted merge can become richer later; this helper pins
the v1 contract: the Note is a current readable draft with citations,
not an appended transcript.
"""

from __future__ import annotations


def merge_live_note(*, current_body: str, answer: str, citations: list[dict]) -> str:
    body = "# Chat Note\n\n" + answer.strip() + "\n"
    if citations:
        body += "\n## Sources\n\n"
        for citation in citations:
            kind = citation.get("sourceKind") or citation.get("source_kind") or "source"
            title = citation.get("title") or "Source"
            target = citation.get("citation") or ""
            body += f"- [{kind}] {title}: {target}\n"
    return body
