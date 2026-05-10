from __future__ import annotations

from search_sidecar.chat.clustering import cluster_sources
from search_sidecar.chat.sources import ChatSource


def test_workspace_sources_cluster_by_nearby_path():
    clusters = cluster_sources(
        [
            ChatSource(
                source_id="n1",
                source_kind="workspace",
                title="photo.jpg",
                snippet="front bumper",
                citation="n1",
                path="事故/照片/photo.jpg",
                score=0.8,
            ),
            ChatSource(
                source_id="n2",
                source_kind="workspace",
                title="invoice.pdf",
                snippet="repair cost",
                citation="n2",
                path="事故/照片/invoice.pdf",
                score=0.7,
            ),
        ]
    )

    assert len(clusters) == 1
    assert clusters[0].cluster_id == "workspace:事故/照片"
    assert len(clusters[0].sources) == 2


def test_web_sources_are_clustered_separately():
    clusters = cluster_sources(
        [
            ChatSource(
                source_id="https://example.test",
                source_kind="web",
                title="External report",
                snippet="public record",
                citation="https://example.test",
                score=0.9,
            )
        ]
    )

    assert clusters[0].source_kind == "web"
    assert clusters[0].cluster_id == "web:results"
