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
    # OCR + captioner roles intentionally absent from the basic manifest:
    #
    # - Local OCR (basic) is served by ``rapidocr-onnxruntime`` (PP-OCRv4
    #   ONNX port) which bundles its model files inside the wheel.
    #   There's nothing for ModelManager to download or pin.
    # - Local captioning (Gemma vision) is deferred past v1 — needs
    #   multi-repo manifest support and a llama-server runtime. Cloud
    #   captioning is the only path in v1.
    #
    # Local **advanced** OCR (PP-StructureV3) uses the 12-stage roles
    # below. They're added to ``DEFAULTS`` further down so the basic
    # role table stays readable on its own.
}


# PP-StructureV3 model bundle — the 13 stages PaddleOCR 3.x runs in
# series (or in parallel where independent) to produce layout-aware
# OCR with table structure and formula recognition. Each stage is its
# own HuggingFace repo under PaddlePaddle/*; we expose them as 13
# role-prefixed entries so the existing per-role download lifecycle
# (progress, retry, license-acceptance, integrity check) works without
# a schema change.
#
# The Settings UI groups any role starting with ``advanced-ocr-`` under
# a single "Local PaddleOCR Advanced" surface; the underlying model
# manager treats them as 12 independent downloads.
#
# Commits + SHA-256s are placeholders; release-build CI pins them
# (same flow as the basic embedding/reranker roles). The file lists
# capture the typical paddleocr inference layout: ``inference.json``
# describes the model, ``inference.pdmodel`` / ``inference.pdiparams``
# are the weights. Some stages publish ONNX-converted variants — we
# stick with the canonical paddle format because the ``paddleocr``
# Python package loads from those file names by default.
ADVANCED_OCR_ROLES: dict[str, ModelSpec] = {
    "advanced-ocr-detection": ModelSpec(
        role="advanced-ocr-detection",
        repo="PaddlePaddle/PP-OCRv4_mobile_det",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-recognition": ModelSpec(
        role="advanced-ocr-recognition",
        repo="PaddlePaddle/PP-OCRv4_mobile_rec",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-layout": ModelSpec(
        role="advanced-ocr-layout",
        repo="PaddlePaddle/PP-DocLayout_plus-L",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-region": ModelSpec(
        role="advanced-ocr-region",
        repo="PaddlePaddle/PP-DocBlockLayout",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-doc-orientation": ModelSpec(
        role="advanced-ocr-doc-orientation",
        repo="PaddlePaddle/PP-LCNet_x1_0_doc_ori",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-textline-orientation": ModelSpec(
        role="advanced-ocr-textline-orientation",
        repo="PaddlePaddle/PP-LCNet_x1_0_textline_ori",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-doc-unwarping": ModelSpec(
        role="advanced-ocr-doc-unwarping",
        repo="PaddlePaddle/UVDoc",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-table-classification": ModelSpec(
        role="advanced-ocr-table-classification",
        repo="PaddlePaddle/PP-LCNet_x1_0_table_cls",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-table-structure-wired": ModelSpec(
        role="advanced-ocr-table-structure-wired",
        repo="PaddlePaddle/SLANeXt_wired",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-table-structure-wireless": ModelSpec(
        role="advanced-ocr-table-structure-wireless",
        repo="PaddlePaddle/SLANet_plus",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-table-cells-wired": ModelSpec(
        role="advanced-ocr-table-cells-wired",
        repo="PaddlePaddle/RT-DETR-L_wired_table_cell_det",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-table-cells-wireless": ModelSpec(
        role="advanced-ocr-table-cells-wireless",
        repo="PaddlePaddle/RT-DETR-L_wireless_table_cell_det",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
    "advanced-ocr-formula": ModelSpec(
        role="advanced-ocr-formula",
        repo="PaddlePaddle/PP-FormulaNet_plus-L",
        commit=PLACEHOLDER_COMMIT,
        files=(
            FileSpec("inference.json", PLACEHOLDER_SHA256),
            FileSpec("inference.pdmodel", PLACEHOLDER_SHA256),
            FileSpec("inference.pdiparams", PLACEHOLDER_SHA256),
        ),
    ),
}

# Merge the advanced-ocr stages into the public DEFAULTS table so
# ModelManager treats them like any other role. Caller-side grouping
# (the UI / state-sync) keys on the ``advanced-ocr-`` prefix.
DEFAULTS.update(ADVANCED_OCR_ROLES)


def advanced_ocr_role_ids() -> tuple[str, ...]:
    """Stable order for the 12 PP-StructureV3 stages.

    The state-sync layer uses this to decide "are all stages ready?"
    before triggering an auto-reindex; the UI uses it to render the
    grouped progress indicator under "Local PaddleOCR Advanced".
    """
    return tuple(ADVANCED_OCR_ROLES.keys())


def is_pinned(spec: ModelSpec) -> bool:
    """True iff every commit/sha256 value has been resolved away from
    the placeholder. Used by release-build CI to gate shipping with
    unresolved manifests."""
    if spec.commit == PLACEHOLDER_COMMIT:
        return False
    return all(f.sha256 != PLACEHOLDER_SHA256 for f in spec.files)
