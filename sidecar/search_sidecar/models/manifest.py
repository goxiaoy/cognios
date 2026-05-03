"""Default model manifest.

Each role pins a HuggingFace repo, a commit hash, and per-file SHA-256
checksums. The commit + SHA-256 values below are placeholders (``"<pinned>"``)
that must be resolved before a release build — the resolution flow is:

1. Pick a HuggingFace revision (e.g. ``main`` snapshot at a known date).
2. ``curl https://huggingface.co/<repo>/resolve/<commit>/<file> > /tmp/x``.
3. ``sha256sum /tmp/x`` → fill the value here.
4. Commit the resolved manifest with a note linking to the HF revision.

Tests that exercise the manager pass their own ``ModelSpec``s pointing
at a localhost fixture server, so the placeholder values do not block
test runs. They only block actual downloads from HF, which is correct —
v1 release builds must commit real pins.
"""

from __future__ import annotations

from dataclasses import dataclass, field

PLACEHOLDER_COMMIT = "<pinned>"
PLACEHOLDER_SHA256 = "<pinned>"


@dataclass(frozen=True)
class FileSpec:
    """One downloadable file inside a model role's commit folder."""

    name: str
    sha256: str


@dataclass(frozen=True)
class ModelSpec:
    """A model role's identity + integrity manifest.

    ``repo`` and ``commit`` together identify the HuggingFace tree;
    ``files`` enumerates every blob the role needs and pins each one's
    SHA-256. ``license`` + ``requires_acceptance`` flag the captioner
    role's Gemma TOS gate.
    """

    role: str
    repo: str
    commit: str
    files: tuple[FileSpec, ...]
    license: str | None = None
    requires_acceptance: bool = False

    def hf_url(self, file: FileSpec) -> str:
        """The download URL for one file at the pinned commit."""
        return f"https://huggingface.co/{self.repo}/resolve/{self.commit}/{file.name}"


# v1 default manifest. Commits and SHA-256s are placeholders — see
# module docstring for the resolution flow before a release build.
DEFAULTS: dict[str, ModelSpec] = {
    "embedding": ModelSpec(
        role="embedding",
        repo="onnx-community/gte-multilingual-base",
        commit="2edbf5e672aab465f9ed4c154a8b61791c082c69",
        files=(
            FileSpec("onnx/model_int8.onnx", "ab2bd164ebd8ca9003dc49a981b611e849b5d326f504c8873ba76e07fa6c0082"),
            FileSpec("tokenizer.json", "3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20"),
            FileSpec("tokenizer_config.json", "24cebbf2ef20fc317256e03e52ac7b2ca326586f946a8427ecac036332bf0933"),
            FileSpec("config.json", "6ef2538d4286a7cd18d05225f659d8a1bceca7adb01c186868e53dbd4f822e17"),
        ),
    ),
    "reranker": ModelSpec(
        role="reranker",
        repo="onnx-community/gte-multilingual-reranker-base",
        commit="ee64367e35a2db0da46bb6497e13a18f8bd585cb",
        files=(
            FileSpec("onnx/model_int8.onnx", "ccf51dba7f8aa9205753761cfaa68c55f741792501463a3bf25d7e5bcdac7c35"),
            FileSpec("tokenizer.json", "3ffb37461c391f096759f4a9bbbc329da0f36952f88bab061fcf84940c022e98"),
            FileSpec("tokenizer_config.json", "6f00514620aff01ba8b7291b2394e98daca5be264cb743805232d9ae27494b2a"),
            FileSpec("config.json", "dfa5713436ecb4616eaa576795c8d3efd1f03122031a1ad4973d0b6b7e7edfd3"),
        ),
    ),
    # OCR + captioner roles intentionally absent from the manifest:
    #
    # - Local OCR is served by ``rapidocr-onnxruntime`` (PP-OCRv4 ONNX
    #   port) which bundles its model files inside the wheel. There's
    #   nothing for ModelManager to download or pin.
    # - Local captioning (Gemma vision) is deferred past v1 — needs
    #   multi-repo manifest support (mmproj lives in a separate HF
    #   repo) and a llama-server runtime. Cloud captioning is the
    #   only path in v1; cloud needs no on-disk model files.
}


def is_pinned(spec: ModelSpec) -> bool:
    """True iff every commit/sha256 value has been resolved away from
    the placeholder. Used by release-build CI to gate shipping with
    unresolved manifests."""
    if spec.commit == PLACEHOLDER_COMMIT:
        return False
    return all(f.sha256 != PLACEHOLDER_SHA256 for f in spec.files)
