"""Resolve a model role's HuggingFace pin and write it back to manifest.py.

Background
----------
``search_sidecar/models/manifest.py`` ships with placeholder commit
hashes (``"<pinned>"``) and placeholder SHA-256s. The placeholders are
intentional: production release builds must commit real, verifiable
pins so the download path can detect tampering. But every developer
who wants to actually run the sidecar against real models needs a way
to resolve those placeholders.

Usage
-----
::

    cd sidecar
    uv run python -m search_sidecar.scripts.pin_manifest embedding

    # All four roles in one go:
    uv run python -m search_sidecar.scripts.pin_manifest --all

What it does
------------
For each requested role:

1. Fetch the current ``HEAD`` commit SHA from the HuggingFace model
   API (``GET /api/models/{repo}``).
2. Download every file declared in the role's ``ModelSpec.files``
   from the resolved commit, streaming through a SHA-256 hasher so
   memory stays bounded for large blobs (the captioner GGUF is ~3 GB).
3. Patch ``manifest.py`` in place — replace ``commit=PLACEHOLDER_COMMIT``
   inside the role's ``ModelSpec(...)`` block with the resolved SHA,
   and replace each ``FileSpec("name", PLACEHOLDER_SHA256)`` with the
   computed digest.

The patcher operates on the role's parenthesis-balanced block only,
so two roles that share a filename (embedding + reranker both list
``onnx/model_int8.onnx``) get independent SHAs without crosstalk.

Auth
----
Gated repos (currently ``unsloth/gemma-3n-E2B-it-GGUF`` for the
captioner) require a HuggingFace token. The script reads it from the
``HF_TOKEN`` environment variable; without it, the captioner download
will surface a 401 and the script aborts before patching.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path
from typing import Any, cast

import httpx

from ..models.manifest import (
    DEFAULTS,
    PLACEHOLDER_COMMIT,
    PLACEHOLDER_SHA256,
    ModelSpec,
    is_pinned,
)

# 1 MB is small enough to keep memory bounded but large enough that
# the per-chunk hashing overhead is negligible against network IO.
_CHUNK_BYTES = 1 << 20

_API_TIMEOUT = httpx.Timeout(30.0)
_DOWNLOAD_TIMEOUT = httpx.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pin_manifest",
        description="Resolve <pinned> placeholders in models/manifest.py.",
    )
    parser.add_argument(
        "roles",
        nargs="*",
        help="Role names to pin (e.g. embedding reranker). Default: none.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Pin every role in the manifest.",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).parent.parent / "models" / "manifest.py",
        help="Path to manifest.py (default: the bundled one).",
    )
    args = parser.parse_args(argv)

    if args.all:
        roles_to_pin = sorted(DEFAULTS.keys())
    elif args.roles:
        unknown = [r for r in args.roles if r not in DEFAULTS]
        if unknown:
            print(
                f"unknown role(s): {', '.join(unknown)}. "
                f"Known: {', '.join(sorted(DEFAULTS))}",
                file=sys.stderr,
            )
            return 2
        roles_to_pin = args.roles
    else:
        parser.print_usage(sys.stderr)
        print("error: pass at least one role name or --all", file=sys.stderr)
        return 2

    hf_token = os.environ.get("HF_TOKEN")

    for role in roles_to_pin:
        spec = DEFAULTS[role]
        if is_pinned(spec):
            print(f"[{role}] already pinned (commit {spec.commit[:8]}); skipping")
            continue
        try:
            commit, file_shas = _resolve_role(spec, hf_token=hf_token)
        except _PinError as err:
            print(f"[{role}] pin failed: {err}", file=sys.stderr)
            return 1
        _patch_manifest_file(args.manifest, role, commit, file_shas)
        print(f"[{role}] ✓ pinned to commit {commit[:8]}")
    return 0


# ----- core -----------------------------------------------------------------


class _PinError(RuntimeError):
    """Raised when a HuggingFace fetch or hash step fails fatally."""


def _resolve_role(
    spec: ModelSpec,
    *,
    hf_token: str | None,
) -> tuple[str, dict[str, str]]:
    """Fetch the current commit SHA and per-file SHA-256 for ``spec``.

    Returns ``(commit, {file_name: sha256_hex})``. Raises ``_PinError``
    on fatal HTTP errors so the caller can stop before mutating the
    manifest.

    Strategy: fetch the HF tree API for the resolved commit; for files
    stored in LFS (every model weight blob — `.onnx`, `.gguf`,
    `.safetensors`, etc.) read sha256 directly from the API metadata
    so we never download the bytes. Only non-LFS files (small JSON
    config / tokenizer files) fall back to download-and-hash.
    """
    print(f"[{spec.role}] resolving {spec.repo}")
    commit = _fetch_head_commit(spec.repo, hf_token=hf_token)
    print(f"[{spec.role}]   commit: {commit}")
    tree = _fetch_tree(spec.repo, commit, hf_token=hf_token)
    file_shas: dict[str, str] = {}
    for file_spec in spec.files:
        meta = tree.get(file_spec.name)
        if meta is None:
            raise _PinError(
                f"file {file_spec.name!r} not present in {spec.repo}@{commit[:8]} tree"
            )
        digest, source = _sha_from_metadata_or_download(
            spec.repo, commit, file_spec.name, meta, hf_token=hf_token
        )
        print(f"[{spec.role}]   {file_spec.name}  →  {digest} ({source})")
        file_shas[file_spec.name] = digest
    return commit, file_shas


def _fetch_tree(
    repo: str,
    commit: str,
    *,
    hf_token: str | None,
) -> dict[str, dict[str, Any]]:
    """Return ``{path: metadata}`` for every file in ``repo`` at ``commit``.

    The HF tree API includes ``lfs.oid`` as ``"sha256:<hex>"`` for
    every LFS-stored file, which lets us avoid downloading multi-GB
    weight blobs just to compute their digest.
    """
    url = f"https://huggingface.co/api/models/{repo}/tree/{commit}?recursive=true"
    try:
        resp = httpx.get(
            url, headers=_auth_headers(hf_token), timeout=_API_TIMEOUT
        )
    except httpx.HTTPError as err:
        raise _PinError(f"GET {url}: {err}") from err
    if resp.status_code in (401, 403):
        raise _PinError(
            f"GET {url} returned {resp.status_code} — set HF_TOKEN if "
            f"the repo is gated (e.g. Gemma)."
        )
    if resp.status_code >= 400:
        raise _PinError(f"GET {url} returned {resp.status_code}: {resp.text[:200]}")
    payload: Any = resp.json()
    if not isinstance(payload, list):
        raise _PinError(
            f"GET {url}: expected list, got {type(payload).__name__}"
        )
    raw_entries = cast(list[Any], payload)
    out: dict[str, dict[str, Any]] = {}
    for raw in raw_entries:
        if not isinstance(raw, dict):
            continue
        entry = cast(dict[str, Any], raw)
        if entry.get("type") != "file":
            continue
        path = entry.get("path")
        if isinstance(path, str):
            out[path] = entry
    return out


def _sha_from_metadata_or_download(
    repo: str,
    commit: str,
    file_name: str,
    meta: dict[str, Any],
    *,
    hf_token: str | None,
) -> tuple[str, str]:
    """Resolve the sha256 for one file, preferring API metadata.

    Returns ``(sha256_hex, source)`` where ``source`` is ``"lfs"`` or
    ``"download"`` so the caller can log the path it took. The HF
    tree API exposes ``lfs.oid`` for LFS-stored files as a 64-char
    SHA-256 hex digest (no ``"sha256:"`` prefix — that prefix is the
    git-LFS pointer-file spec, not what the HTTP API returns). Both
    forms are accepted defensively. Regular git-stored files have
    no LFS section, so we download them (they're small — config.json
    / tokenizer.json sizes only).
    """
    lfs_raw = meta.get("lfs")
    if isinstance(lfs_raw, dict):
        lfs = cast(dict[str, Any], lfs_raw)
        raw = lfs.get("oid")
        if isinstance(raw, str):
            sha = raw[len("sha256:") :] if raw.startswith("sha256:") else raw
            # Defensive: HF currently returns a 64-char hex digest;
            # if someone hands us anything weirder, fall through to
            # the download path rather than write garbage.
            if len(sha) == 64 and all(c in "0123456789abcdef" for c in sha):
                return sha, "lfs"
    digest = _download_and_hash(repo, commit, file_name, hf_token=hf_token)
    return digest, "download"


def _fetch_head_commit(repo: str, *, hf_token: str | None) -> str:
    """Return the HEAD commit SHA of ``repo`` on its default branch."""
    url = f"https://huggingface.co/api/models/{repo}"
    headers = _auth_headers(hf_token)
    try:
        resp = httpx.get(url, headers=headers, timeout=_API_TIMEOUT)
    except httpx.HTTPError as err:
        raise _PinError(f"GET {url}: {err}") from err
    if resp.status_code == 401 or resp.status_code == 403:
        raise _PinError(
            f"GET {url} returned {resp.status_code} — set HF_TOKEN if "
            f"the repo is gated (e.g. Gemma)."
        )
    if resp.status_code >= 400:
        raise _PinError(f"GET {url} returned {resp.status_code}: {resp.text[:200]}")
    payload = resp.json()
    sha = payload.get("sha")
    if not isinstance(sha, str) or not sha:
        raise _PinError(f"GET {url}: response missing 'sha' field")
    return sha


def _download_and_hash(
    repo: str,
    commit: str,
    file_name: str,
    *,
    hf_token: str | None,
) -> str:
    """Stream-download the resolved file and return its SHA-256 hex digest."""
    url = f"https://huggingface.co/{repo}/resolve/{commit}/{file_name}"
    hasher = hashlib.sha256()
    try:
        with httpx.stream(
            "GET",
            url,
            headers=_auth_headers(hf_token),
            timeout=_DOWNLOAD_TIMEOUT,
            follow_redirects=True,
        ) as resp:
            if resp.status_code == 401 or resp.status_code == 403:
                raise _PinError(
                    f"GET {url} returned {resp.status_code} — set HF_TOKEN if "
                    f"the repo is gated."
                )
            if resp.status_code >= 400:
                raise _PinError(f"GET {url} returned {resp.status_code}")
            for chunk in resp.iter_bytes(chunk_size=_CHUNK_BYTES):
                hasher.update(chunk)
    except httpx.HTTPError as err:
        raise _PinError(f"GET {url}: {err}") from err
    return hasher.hexdigest()


def _auth_headers(hf_token: str | None) -> dict[str, str]:
    if hf_token:
        return {"Authorization": f"Bearer {hf_token}"}
    return {}


# ----- manifest patching ----------------------------------------------------


def _patch_manifest_file(
    manifest_path: Path,
    role: str,
    commit: str,
    file_shas: dict[str, str],
) -> None:
    """Mutate ``manifest_path`` in place by patching the role's block.

    The patch is intentionally narrow — it only touches the
    parenthesis-balanced ``ModelSpec(...)`` block for ``role`` and
    replaces ``PLACEHOLDER_COMMIT`` / per-file ``PLACEHOLDER_SHA256``
    inside it. Other roles, comments, and surrounding code stay
    byte-identical.
    """
    text = manifest_path.read_text(encoding="utf-8")
    new_text = patch_manifest_text(text, role, commit, file_shas)
    manifest_path.write_text(new_text, encoding="utf-8")


def patch_manifest_text(
    text: str,
    role: str,
    commit: str,
    file_shas: dict[str, str],
) -> str:
    """Pure transform: return ``text`` with ``role``'s block patched.

    Exposed for tests. Raises ``ValueError`` if the role is not found
    or any expected placeholder is missing — the caller should not
    silently drop these errors.
    """
    start, end = _find_role_block(text, role)
    block = text[start:end]
    if "commit=PLACEHOLDER_COMMIT" not in block:
        raise ValueError(
            f"role {role!r}: commit=PLACEHOLDER_COMMIT not found in block"
        )
    block = block.replace(
        "commit=PLACEHOLDER_COMMIT",
        f'commit="{commit}"',
        1,
    )
    for file_name, sha in file_shas.items():
        old = f'FileSpec("{file_name}", PLACEHOLDER_SHA256)'
        if old not in block:
            raise ValueError(
                f"role {role!r}: FileSpec line for {file_name!r} not found "
                f"(was it already pinned, or is the file name wrong?)"
            )
        new = f'FileSpec("{file_name}", "{sha}")'
        block = block.replace(old, new, 1)
    return text[:start] + block + text[end:]


def _find_role_block(text: str, role: str) -> tuple[int, int]:
    """Return ``(start, end)`` byte offsets for the role's ModelSpec block.

    ``start`` points at the opening ``"<role>": ModelSpec(`` marker;
    ``end`` is one past the matching closing parenthesis. Walking the
    parens by hand (vs a regex) keeps us correct for nested tuples
    like ``files=(...)``.
    """
    marker = f'"{role}": ModelSpec('
    start = text.find(marker)
    if start == -1:
        raise ValueError(f"role {role!r}: marker {marker!r} not found")
    paren_open = start + len(marker) - 1  # position of '(' in ModelSpec(
    depth = 1
    i = paren_open + 1
    while i < len(text) and depth > 0:
        c = text[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        i += 1
    if depth != 0:
        raise ValueError(
            f"role {role!r}: unbalanced parens starting at offset {start}"
        )
    return start, i


if __name__ == "__main__":
    raise SystemExit(main())
