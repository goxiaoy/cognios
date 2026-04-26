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
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("onnx/model_int8.onnx", PLACEHOLDER_SHA256),
            FileSpec("tokenizer.json", PLACEHOLDER_SHA256),
            FileSpec("tokenizer_config.json", PLACEHOLDER_SHA256),
            FileSpec("config.json", PLACEHOLDER_SHA256),
        ),
    ),
    "reranker": ModelSpec(
        role="reranker",
        repo="onnx-community/gte-multilingual-reranker-base",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("onnx/model_int8.onnx", PLACEHOLDER_SHA256),
            FileSpec("tokenizer.json", PLACEHOLDER_SHA256),
            FileSpec("tokenizer_config.json", PLACEHOLDER_SHA256),
            FileSpec("config.json", PLACEHOLDER_SHA256),
        ),
    ),
    "ocr": ModelSpec(
        role="ocr",
        # PP-OCRv4 mobile ships det/rec/cls as three separate ONNX
        # exports; we point at a community ONNX-only mirror to avoid
        # the paddlepaddle Python runtime (see plan Architecture).
        repo="PaddlePaddle/PP-OCRv4_mobile_det",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("det.onnx", PLACEHOLDER_SHA256),
            FileSpec("rec.onnx", PLACEHOLDER_SHA256),
            FileSpec("cls.onnx", PLACEHOLDER_SHA256),
        ),
    ),
    "captioner": ModelSpec(
        role="captioner",
        repo="unsloth/gemma-3n-E2B-it-GGUF",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("gemma-3n-E2B-it-Q4_K_M.gguf", PLACEHOLDER_SHA256),
            FileSpec("mmproj-gemma-3n-E2B-it-f16.gguf", PLACEHOLDER_SHA256),
        ),
        license="gemma",
        requires_acceptance=True,
    ),
}


def is_pinned(spec: ModelSpec) -> bool:
    """True iff every commit/sha256 value has been resolved away from
    the placeholder. Used by release-build CI to gate shipping with
    unresolved manifests."""
    if spec.commit == PLACEHOLDER_COMMIT:
        return False
    return all(f.sha256 != PLACEHOLDER_SHA256 for f in spec.files)
