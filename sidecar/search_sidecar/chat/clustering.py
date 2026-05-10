"""Simple inspectable source clustering for Chat."""

from __future__ import annotations

import re
from collections import defaultdict

from .sources import ChatSource, SourceCluster

_NON_WORD = re.compile(r"[/\\]+")


def cluster_sources(sources: list[ChatSource]) -> list[SourceCluster]:
    workspace = [source for source in sources if source.source_kind == "workspace"]
    web = [source for source in sources if source.source_kind == "web"]
    clusters: list[SourceCluster] = []
    clusters.extend(_cluster_workspace_by_path(workspace))
    if web:
        clusters.append(
            SourceCluster(
                cluster_id="web:results",
                title="Web sources",
                source_kind="web",
                status="candidate",
                summary=f"{len(web)} current web result(s) related to the prompt.",
                score=max(source.score for source in web),
                sources=web,
            )
        )
    return sorted(clusters, key=lambda cluster: cluster.score, reverse=True)


def _cluster_workspace_by_path(sources: list[ChatSource]) -> list[SourceCluster]:
    groups: dict[str, list[ChatSource]] = defaultdict(list)
    for source in sources:
        key = _path_group(source.path) or "workspace"
        groups[key].append(source)
    clusters: list[SourceCluster] = []
    for key, items in groups.items():
        title = key if key != "workspace" else "Workspace matches"
        clusters.append(
            SourceCluster(
                cluster_id=f"workspace:{key}",
                title=title,
                source_kind="workspace",
                status="candidate",
                summary=f"{len(items)} workspace source(s) clustered by path and relevance.",
                score=max(source.score for source in items) + min(len(items), 5) * 0.01,
                sources=items,
            )
        )
    return clusters


def _path_group(path: str | None) -> str | None:
    if not path:
        return None
    parts = [part.strip() for part in _NON_WORD.split(path) if part.strip()]
    if len(parts) >= 2:
        return "/".join(parts[:2])
    return parts[0] if parts else None
