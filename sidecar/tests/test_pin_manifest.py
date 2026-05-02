"""Pure-transform tests for the pin_manifest patcher.

The network-touching paths (`_fetch_head_commit`, `_download_and_hash`)
are deliberately not exercised here — they're tiny adapters around
httpx and a SHA-256 hasher whose value comes from running them
against the live HF API, not from mocked tests.
"""

from __future__ import annotations

import pytest

from search_sidecar.scripts.pin_manifest import (
    _find_role_block,
    _sha_from_metadata_or_download,
    patch_manifest_text,
)

# A miniature manifest fixture that mirrors the real shape — same
# sentinel constants, same ModelSpec/FileSpec syntax, two roles that
# share a filename so we can verify cross-role isolation.
_FIXTURE_MANIFEST = '''\
PLACEHOLDER_COMMIT = "<pinned>"
PLACEHOLDER_SHA256 = "<pinned>"

DEFAULTS: dict[str, ModelSpec] = {
    "embedding": ModelSpec(
        role="embedding",
        repo="onnx-community/gte-multilingual-base",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("onnx/model_int8.onnx", PLACEHOLDER_SHA256),
            FileSpec("tokenizer.json", PLACEHOLDER_SHA256),
        ),
    ),
    "reranker": ModelSpec(
        role="reranker",
        repo="onnx-community/gte-multilingual-reranker-base",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("onnx/model_int8.onnx", PLACEHOLDER_SHA256),
            FileSpec("tokenizer.json", PLACEHOLDER_SHA256),
        ),
    ),
}
'''


def test_find_role_block_locates_balanced_parens():
    start, end = _find_role_block(_FIXTURE_MANIFEST, "embedding")
    block = _FIXTURE_MANIFEST[start:end]
    assert block.startswith('"embedding": ModelSpec(')
    assert block.endswith(")")
    # Block should include the nested files=(...) tuple.
    assert "files=(" in block
    # Should NOT include the reranker entry.
    assert "reranker" not in block


def test_find_role_block_raises_for_unknown_role():
    with pytest.raises(ValueError, match="ocr"):
        _find_role_block(_FIXTURE_MANIFEST, "ocr")


def test_patch_manifest_text_pins_one_role_only():
    """Pinning embedding must not touch reranker, even though the two
    roles share filenames (onnx/model_int8.onnx, tokenizer.json)."""
    commit = "abcdef0123456789abcdef0123456789abcdef01"
    file_shas = {
        "onnx/model_int8.onnx": "1111" * 16,
        "tokenizer.json": "2222" * 16,
    }
    patched = patch_manifest_text(
        _FIXTURE_MANIFEST, "embedding", commit, file_shas
    )

    # embedding's commit is now the real SHA.
    embed_start, embed_end = _find_role_block(patched, "embedding")
    embed_block = patched[embed_start:embed_end]
    assert f'commit="{commit}"' in embed_block
    assert "PLACEHOLDER_COMMIT" not in embed_block
    assert f'FileSpec("onnx/model_int8.onnx", "{"1111" * 16}")' in embed_block
    assert f'FileSpec("tokenizer.json", "{"2222" * 16}")' in embed_block
    assert "PLACEHOLDER_SHA256" not in embed_block

    # reranker is untouched — same shared filenames, still placeholder.
    rerank_start, rerank_end = _find_role_block(patched, "reranker")
    rerank_block = patched[rerank_start:rerank_end]
    assert "commit=PLACEHOLDER_COMMIT" in rerank_block
    assert (
        'FileSpec("onnx/model_int8.onnx", PLACEHOLDER_SHA256)'
        in rerank_block
    )

    # Module-level constant assignments must survive untouched —
    # the patcher must not rewrite the placeholder definitions.
    assert 'PLACEHOLDER_COMMIT = "<pinned>"' in patched
    assert 'PLACEHOLDER_SHA256 = "<pinned>"' in patched


def test_patch_manifest_text_raises_on_missing_commit_placeholder():
    already_pinned = _FIXTURE_MANIFEST.replace(
        'commit=PLACEHOLDER_COMMIT',
        'commit="aaaa"',
        1,  # only patch embedding
    )
    with pytest.raises(ValueError, match="commit=PLACEHOLDER_COMMIT"):
        patch_manifest_text(
            already_pinned, "embedding", "bbbb", {"onnx/model_int8.onnx": "x"}
        )


def test_patch_manifest_text_raises_on_unknown_filename():
    with pytest.raises(ValueError, match="config.json"):
        patch_manifest_text(
            _FIXTURE_MANIFEST,
            "embedding",
            "abc",
            {"config.json": "ffff" * 16},  # not in fixture
        )


def test_sha_resolver_reads_raw_hex_oid_from_hf_tree_api(
    monkeypatch: pytest.MonkeyPatch,
):
    """HF's tree API returns ``lfs.oid`` as a raw 64-char hex digest
    (NOT prefixed with ``sha256:``). The resolver must accept this
    form without downloading the file."""
    download_called = {"n": 0}

    def boom(*_args, **_kwargs):
        download_called["n"] += 1
        raise AssertionError("download_and_hash must not run for LFS files")

    monkeypatch.setattr(
        "search_sidecar.scripts.pin_manifest._download_and_hash", boom
    )
    expected_sha = "abcd" * 16  # 64-char hex
    # Shape mirrors the actual HF tree API response — bare hex oid.
    meta = {
        "type": "file",
        "path": "onnx/model_int8.onnx",
        "lfs": {"oid": expected_sha, "size": 75_000_000},
    }
    digest, source = _sha_from_metadata_or_download(
        "owner/repo", "commit_sha", "onnx/model_int8.onnx", meta, hf_token=None
    )
    assert digest == expected_sha
    assert source == "lfs"
    assert download_called["n"] == 0


def test_sha_resolver_also_accepts_sha256_prefixed_oid(
    monkeypatch: pytest.MonkeyPatch,
):
    """Defensive: the git-LFS pointer-file spec uses ``sha256:<hex>``;
    accept that form too in case HF or another consumer ever returns
    it."""

    def boom(*_args, **_kwargs):
        raise AssertionError("download must not run when LFS oid is valid")

    monkeypatch.setattr(
        "search_sidecar.scripts.pin_manifest._download_and_hash", boom
    )
    expected_sha = "1234" * 16
    meta = {
        "type": "file",
        "path": "onnx/m.onnx",
        "lfs": {"oid": f"sha256:{expected_sha}", "size": 1},
    }
    digest, source = _sha_from_metadata_or_download(
        "owner/repo", "c", "onnx/m.onnx", meta, hf_token=None
    )
    assert digest == expected_sha
    assert source == "lfs"


def test_sha_resolver_falls_back_to_download_for_non_lfs(
    monkeypatch: pytest.MonkeyPatch,
):
    """Small git-stored files (config.json / tokenizer.json) have no
    LFS metadata; the resolver downloads them to compute sha256."""

    def fake_download(_repo, _commit, _file_name, *, hf_token):
        return "deadbeef" * 8

    monkeypatch.setattr(
        "search_sidecar.scripts.pin_manifest._download_and_hash", fake_download
    )
    meta = {"type": "file", "path": "config.json", "size": 1234}
    digest, source = _sha_from_metadata_or_download(
        "owner/repo", "commit_sha", "config.json", meta, hf_token=None
    )
    assert digest == "deadbeef" * 8
    assert source == "download"


def test_sha_resolver_treats_malformed_lfs_as_non_lfs(
    monkeypatch: pytest.MonkeyPatch,
):
    """If lfs.oid is missing or doesn't carry the sha256: prefix,
    fall back to download rather than guess."""
    download_called = {"n": 0}

    def fake_download(_repo, _commit, _file_name, *, hf_token):
        download_called["n"] += 1
        return "fallback" * 8

    monkeypatch.setattr(
        "search_sidecar.scripts.pin_manifest._download_and_hash", fake_download
    )
    # Missing oid entirely.
    meta = {"type": "file", "path": "weird.bin", "lfs": {"size": 100}}
    digest, source = _sha_from_metadata_or_download(
        "owner/repo", "c", "weird.bin", meta, hf_token=None
    )
    assert source == "download"
    assert digest == "fallback" * 8
    assert download_called["n"] == 1


def test_patch_manifest_text_handles_idempotent_partial_state():
    """If a previous run pinned commit but crashed before pinning files,
    re-running should refuse rather than silently leaving placeholders."""
    half = _FIXTURE_MANIFEST.replace(
        'commit=PLACEHOLDER_COMMIT', 'commit="abc"', 1
    )
    with pytest.raises(ValueError, match="commit=PLACEHOLDER_COMMIT"):
        patch_manifest_text(
            half, "embedding", "abc", {"onnx/model_int8.onnx": "1234"}
        )
