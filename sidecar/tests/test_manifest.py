"""Sanity checks on the default manifest's structure."""

from __future__ import annotations

from search_sidecar.models.manifest import (
    DEFAULTS,
    PLACEHOLDER_COMMIT,
    PLACEHOLDER_SHA256,
    FileSpec,
    ModelSpec,
    is_pinned,
)


def test_manifest_covers_v1_local_roles():
    """v1 ships local model files for embedding + reranker only.
    OCR is served by rapidocr-onnxruntime (bundled in the wheel; no
    ModelManager involvement) and captioning is cloud-only — both
    intentionally absent from the manifest."""
    assert set(DEFAULTS.keys()) == {"embedding", "reranker"}


def test_each_role_lists_at_least_one_file():
    for role, spec in DEFAULTS.items():
        assert spec.files, f"{role!r} has no files"
        assert all(f.name for f in spec.files), f"{role!r} has empty file names"


def test_v1_roles_do_not_require_acceptance():
    """No gated repo in v1 (Gemma was the only one and it's deferred)."""
    for role, spec in DEFAULTS.items():
        assert spec.requires_acceptance is False, role
        assert spec.license is None, role


def test_is_pinned_detects_placeholder_state():
    """``is_pinned`` returns False when either the commit or any file
    SHA is still the placeholder string. Used by release-build CI to
    refuse shipping with unresolved manifests, and by the pin script
    to skip already-pinned roles."""
    unpinned = ModelSpec(
        role="test",
        repo="owner/repo",
        commit=PLACEHOLDER_COMMIT,
        files=(FileSpec("a.bin", PLACEHOLDER_SHA256),),
    )
    assert not is_pinned(unpinned)

    pinned_commit_only = ModelSpec(
        role="test",
        repo="owner/repo",
        commit="abc123",
        files=(FileSpec("a.bin", PLACEHOLDER_SHA256),),
    )
    assert not is_pinned(pinned_commit_only)

    fully_pinned = ModelSpec(
        role="test",
        repo="owner/repo",
        commit="abc123",
        files=(FileSpec("a.bin", "deadbeef" * 8),),
    )
    assert is_pinned(fully_pinned)


def test_hf_url_format():
    """``hf_url`` builds the canonical HuggingFace resolve URL from
    the spec's repo + commit + file name. Tested against a fixture
    spec so the assertion doesn't break when DEFAULTS roles get
    pinned (or unpinned) over the release lifecycle."""
    spec = ModelSpec(
        role="test",
        repo="owner/repo",
        commit="abc123def456",
        files=(FileSpec("path/to/file.bin", "deadbeef"),),
    )
    file = spec.files[0]
    url = spec.hf_url(file)
    assert url == (
        f"https://huggingface.co/owner/repo/resolve/abc123def456/path/to/file.bin"
    )


def test_placeholder_constants_match():
    assert "<" in PLACEHOLDER_COMMIT and ">" in PLACEHOLDER_COMMIT
    assert "<" in PLACEHOLDER_SHA256 and ">" in PLACEHOLDER_SHA256
