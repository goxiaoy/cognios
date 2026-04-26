"""Sanity checks on the default manifest's structure."""

from __future__ import annotations

from search_sidecar.models.manifest import (
    DEFAULTS,
    PLACEHOLDER_COMMIT,
    PLACEHOLDER_SHA256,
    is_pinned,
)


def test_manifest_covers_four_roles():
    assert set(DEFAULTS.keys()) == {"embedding", "reranker", "ocr", "captioner"}


def test_each_role_lists_at_least_one_file():
    for role, spec in DEFAULTS.items():
        assert spec.files, f"{role!r} has no files"
        assert all(f.name for f in spec.files), f"{role!r} has empty file names"


def test_only_captioner_requires_acceptance():
    assert DEFAULTS["captioner"].requires_acceptance is True
    for role in ("embedding", "reranker", "ocr"):
        assert DEFAULTS[role].requires_acceptance is False, role


def test_captioner_carries_license_tag():
    assert DEFAULTS["captioner"].license == "gemma"


def test_defaults_are_unpinned_until_release():
    """Until release-build CI pins commits and SHA-256s, ``is_pinned``
    must return False so a release build with placeholder values fails
    its CI gate."""
    for role, spec in DEFAULTS.items():
        assert not is_pinned(spec), f"{role!r} should still be unpinned"


def test_hf_url_format():
    spec = DEFAULTS["embedding"]
    file = spec.files[0]
    url = spec.hf_url(file)
    assert url == (
        f"https://huggingface.co/{spec.repo}/resolve/{PLACEHOLDER_COMMIT}/{file.name}"
    )


def test_placeholder_constants_match():
    assert "<" in PLACEHOLDER_COMMIT and ">" in PLACEHOLDER_COMMIT
    assert "<" in PLACEHOLDER_SHA256 and ">" in PLACEHOLDER_SHA256
