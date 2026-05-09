"""Cached extraction artifacts for image preview and diagnostics."""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping

ArtifactKind = Literal["basic", "advanced", "caption"]
ArtifactRole = Literal["body", "summary"]

BODY_ARTIFACT_PRIORITY: tuple[ArtifactKind, ...] = ("advanced", "basic")
ALL_ARTIFACT_KINDS: tuple[ArtifactKind, ...] = ("basic", "advanced", "caption")
LOG = logging.getLogger("search_sidecar.index.extract_artifacts")


@dataclass(frozen=True)
class ExtractArtifact:
    kind: ArtifactKind
    role: ArtifactRole
    text: str
    assets: dict[str, Path]


def write_extract_artifact(
    extract_dir: Path,
    node_id: str,
    kind: ArtifactKind,
    text: str,
    *,
    assets: Mapping[str, Any] | None = None,
) -> Path:
    """Persist OCR/caption text beside the search index for inspection."""
    node_dir = extract_artifact_node_dir(extract_dir, node_id)
    node_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{kind}.md"
    artifact_path = node_dir / filename
    tmp_path = node_dir / f".{filename}.tmp"
    tmp_path.write_text(text.strip() + "\n", encoding="utf-8")
    tmp_path.replace(artifact_path)
    if assets is not None:
        _write_asset_manifest(node_dir, kind, assets)
    return artifact_path


def clear_extract_artifacts(
    extract_dir: Path,
    node_id: str,
    kinds: tuple[ArtifactKind, ...] = ALL_ARTIFACT_KINDS,
) -> None:
    """Remove stale extraction artifacts for a node."""
    node_dir = extract_artifact_node_dir(extract_dir, node_id)
    for kind in kinds:
        (node_dir / f"{kind}.md").unlink(missing_ok=True)
        (node_dir / f"{kind}.assets.json").unlink(missing_ok=True)
        shutil.rmtree(node_dir / "assets" / kind, ignore_errors=True)


def read_image_preview_artifacts(
    extract_dir: Path | None,
    node_id: str,
) -> list[ExtractArtifact]:
    """Return preview artifacts, preferring advanced OCR over basic OCR."""
    if extract_dir is None:
        return []
    node_dir = extract_artifact_node_dir(extract_dir, node_id)
    if not node_dir.is_dir():
        return []

    artifacts: list[ExtractArtifact] = []
    body = _read_first_nonempty(node_dir, BODY_ARTIFACT_PRIORITY)
    if body is not None:
        kind, text = body
        artifacts.append(
            ExtractArtifact(
                kind=kind,
                role="body",
                text=text,
                assets=_read_asset_manifest(node_dir, kind),
            )
        )

    caption = _read_nonempty(node_dir / "caption.md")
    if caption is not None:
        artifacts.append(
            ExtractArtifact(kind="caption", role="summary", text=caption, assets={})
        )
    return artifacts


def extract_artifact_node_dir(extract_dir: Path, node_id: str) -> Path:
    return extract_dir / _safe_path_segment(node_id, "node")


def _read_first_nonempty(
    node_dir: Path,
    kinds: tuple[ArtifactKind, ...],
) -> tuple[ArtifactKind, str] | None:
    for kind in kinds:
        text = _read_nonempty(node_dir / f"{kind}.md")
        if text is not None:
            return kind, text
    return None


def _read_nonempty(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    if not text:
        return None
    return text


def _write_asset_manifest(
    node_dir: Path,
    kind: ArtifactKind,
    assets: Mapping[str, Any],
) -> None:
    asset_dir = node_dir / "assets" / kind
    shutil.rmtree(asset_dir, ignore_errors=True)
    (node_dir / f"{kind}.assets.json").unlink(missing_ok=True)
    if not assets:
        return

    asset_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, str] = {}
    used_paths: set[Path] = set()
    for source, value in assets.items():
        rel_path = _unique_asset_path(str(source), used_paths)
        target = asset_dir / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            _write_asset_value(target, value)
        except Exception as err:
            LOG.warning("failed to persist OCR asset %s: %s", source, err)
            continue
        used_paths.add(rel_path)
        manifest[str(source)] = (Path("assets") / kind / rel_path).as_posix()

    if manifest:
        tmp_path = node_dir / f".{kind}.assets.json.tmp"
        tmp_path.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        tmp_path.replace(node_dir / f"{kind}.assets.json")


def _read_asset_manifest(node_dir: Path, kind: ArtifactKind) -> dict[str, Path]:
    manifest_path = node_dir / f"{kind}.assets.json"
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    assets: dict[str, Path] = {}
    for source, rel in raw.items():
        if not isinstance(source, str) or not isinstance(rel, str):
            continue
        rel_path = Path(rel)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            continue
        target = node_dir / rel_path
        if target.is_file():
            assets[source] = target
    return assets


def _write_asset_value(path: Path, value: Any) -> None:
    if isinstance(value, bytes):
        path.write_bytes(value)
        return
    save = getattr(value, "save", None)
    if callable(save):
        save(path, format="PNG")
        return
    raise TypeError(f"unsupported asset value {type(value)!r}")


def _unique_asset_path(source: str, used_paths: set[Path]) -> Path:
    source_path = Path(source.replace("\\", "/"))
    safe_parts = [
        _safe_path_segment(part, "asset")
        for part in source_path.parts
        if part not in {"", ".", "..", "/"}
    ]
    if not safe_parts:
        safe_parts = ["asset"]
    filename = safe_parts[-1]
    stem = Path(filename).stem or "asset"
    # Persist extracted PIL images as PNG regardless of Paddle's
    # original reference extension; the manifest maps the original
    # reference to the actual file path.
    safe_parts[-1] = f"{stem}.png"
    candidate = Path(*safe_parts)
    if candidate not in used_paths:
        return candidate
    for idx in range(2, len(used_paths) + 3):
        safe_parts[-1] = f"{stem}-{idx}.png"
        candidate = Path(*safe_parts)
        if candidate not in used_paths:
            return candidate
    return Path(f"{stem}-{len(used_paths) + 1}.png")


def _safe_path_segment(value: str, fallback: str) -> str:
    cleaned_chars: list[str] = []
    last_was_dash = False
    for char in value.strip():
        if char.isalnum() or char in {"_", ".", "-"}:
            cleaned_chars.append(char)
            last_was_dash = False
        elif not last_was_dash:
            cleaned_chars.append("-")
            last_was_dash = True
    cleaned = "".join(cleaned_chars).strip(".-")
    if not cleaned:
        cleaned = fallback
    return cleaned[:120]
