"""Default model manifest.

Each role pins a HuggingFace repo, a commit hash, per-file SHA-256
checksums, and optional file sizes for aggregate progress. Commit
and SHA-256 values below are placeholders (``"<pinned>"``) that must be
resolved before a release build — the resolution flow is:

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

from dataclasses import dataclass

PLACEHOLDER_COMMIT = "<pinned>"
PLACEHOLDER_SHA256 = "<pinned>"


@dataclass(frozen=True)
class FileSpec:
    """One downloadable file inside a model role's commit folder."""

    name: str
    sha256: str
    size_bytes: int | None = None


@dataclass(frozen=True)
class ModelSpec:
    """A model role's identity + integrity manifest.

    ``repo`` and ``commit`` together identify the HuggingFace tree;
    ``files`` enumerates every blob the role needs and pins each one's
    SHA-256. ``size_bytes`` is optional but should be filled for roles
    with multiple files so download progress can be reported for the
    full role instead of resetting per file. v1 ships no gated repos —
    the gated-Gemma path was
    deferred and the dedicated license-acceptance fields were
    removed when local captioning moved to Ollama.
    """

    role: str
    repo: str
    commit: str
    files: tuple[FileSpec, ...]

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
            FileSpec("onnx/model_int8.onnx", "ab2bd164ebd8ca9003dc49a981b611e849b5d326f504c8873ba76e07fa6c0082", 340318797),
            FileSpec("tokenizer.json", "3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20", 17082734),
            FileSpec("tokenizer_config.json", "24cebbf2ef20fc317256e03e52ac7b2ca326586f946a8427ecac036332bf0933", 1149),
            FileSpec("config.json", "6ef2538d4286a7cd18d05225f659d8a1bceca7adb01c186868e53dbd4f822e17", 1648),
        ),
    ),
    "reranker": ModelSpec(
        role="reranker",
        repo="onnx-community/gte-multilingual-reranker-base",
        commit="ee64367e35a2db0da46bb6497e13a18f8bd585cb",
        files=(
            FileSpec("onnx/model_int8.onnx", "ccf51dba7f8aa9205753761cfaa68c55f741792501463a3bf25d7e5bcdac7c35", 340858200),
            FileSpec("tokenizer.json", "3ffb37461c391f096759f4a9bbbc329da0f36952f88bab061fcf84940c022e98", 17082999),
            FileSpec("tokenizer_config.json", "6f00514620aff01ba8b7291b2394e98daca5be264cb743805232d9ae27494b2a", 1340),
            FileSpec("config.json", "dfa5713436ecb4616eaa576795c8d3efd1f03122031a1ad4973d0b6b7e7edfd3", 1578),
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
# (same flow as the basic embedding/reranker roles). The file list
# matches the canonical layout PaddlePaddle/* repos publish on
# HuggingFace: ``inference.json`` (model graph in PaddleOCR 3.x's
# replacement for the older ``inference.pdmodel``), ``inference.pdiparams``
# (weights), ``inference.yml`` (preprocessing config), ``config.json``
# (model metadata). All four are required at runtime — paddleocr's
# loader fails fast if any are missing.
ADVANCED_OCR_ROLES: dict[str, ModelSpec] = {
    "advanced-ocr-detection": ModelSpec(
        role="advanced-ocr-detection",
        repo="PaddlePaddle/PP-OCRv4_mobile_det",
        commit="3cc09f3a5b424e8e010abc7a4271aea12999c2f7",
        files=(
            FileSpec("inference.json", "05feef1acb00aa4cd7362b15f7f501fc4f99d7b1fa73c1c871e0c7b1504b0f5c"),
            FileSpec("inference.yml", "4f5bd0def48e20194d87d4c184a3ae3007a1299de7fed0ef763d3e7e873e77f6"),
            FileSpec("config.json", "25b95390ab0264dc56cd61f88f61e110700eec419bf799e235230a50ff7591a9"),
            FileSpec("inference.pdiparams", "54a85087b4d31fa3ea4e4aba100169a1ec3e3274cd3352b9068b3cfccbca7829"),
        ),
    ),
    "advanced-ocr-recognition": ModelSpec(
        role="advanced-ocr-recognition",
        repo="PaddlePaddle/PP-OCRv4_mobile_rec",
        commit="a2deb05cb05813be2da3365672881aa496d1452b",
        files=(
            FileSpec("inference.json", "30f78ace76b2cce756abba97eb17f4c79e776d88ad68dd44a787a3db84b407a7"),
            FileSpec("inference.yml", "1207e8ba3d3dad6b99115f7febf515f5ffc0d87ed77366d7a4b4b3f1709c005d"),
            FileSpec("config.json", "26773626e73d17b4a6a6a39d15ee3a7820ddd05c3b71251894dc687e8174e81c"),
            FileSpec("inference.pdiparams", "948b8d2ca6ad4bd7b64c0ee3fb838a06db87d4cf57137173ce409c995df21012"),
        ),
    ),
    "advanced-ocr-layout": ModelSpec(
        role="advanced-ocr-layout",
        repo="PaddlePaddle/PP-DocLayout_plus-L",
        commit="aa52b8528c84f9b1a34ac3a88fe0e576edb9d11d",
        files=(
            FileSpec("inference.json", "99bd09c0a1b9e88d35c65c305b91711d98055fc94b4a6eecd50da02e04729384"),
            FileSpec("inference.yml", "d60f782a16f96afb27e8280399899a94c3e9ffc694ffb2f913ea00af1c522f1e"),
            FileSpec("config.json", "adc92346e7ecc5d54dc9ed224c754c9237f56e5d88b0c9208db08cb315d66c09"),
            FileSpec("inference.pdiparams", "24ca3e2e442164505e250deef59f7ee9a54ea12dd32875c9cd6155d959dc97da"),
        ),
    ),
    "advanced-ocr-region": ModelSpec(
        role="advanced-ocr-region",
        repo="PaddlePaddle/PP-DocBlockLayout",
        commit="f270657da59d956ab69ffc2c4722fe1f557bf17b",
        files=(
            FileSpec("inference.json", "abea237f1e53d3dc3bf7ea1321dfebe78552a6070e567dfc94028b622fd575e8"),
            FileSpec("inference.yml", "3d3d5035825b1a2de3348c646e463798d85b9f8c7c5155a81757172261036e1b"),
            FileSpec("config.json", "77b3ed49207f2e36f3973c59c23343b4d26ce993749f15b69452fc04941658d7"),
            FileSpec("inference.pdiparams", "0ab733dcabfee41517b68b37fde4c696129b88096a93f8b9d8feaa43c27c8942"),
        ),
    ),
    "advanced-ocr-doc-orientation": ModelSpec(
        role="advanced-ocr-doc-orientation",
        repo="PaddlePaddle/PP-LCNet_x1_0_doc_ori",
        commit="d3b95a6dff5fe8a94f2748e12b61cb26818a0df8",
        files=(
            FileSpec("inference.json", "3580978602f309c3554508dd85d4fe09b73a7e0d80d7f9e63258f5b72c390c69"),
            FileSpec("inference.yml", "9e195eb729a8173588cd0e8a852c8b373aa606e79e77b4ac7d8346f5426caf26"),
            FileSpec("config.json", "e49f6be2fe4034232b05fb80d983a7b9bde4592d4a52812129c9a348057d3147"),
            FileSpec("inference.pdiparams", "e8d6e7c5d264507e40e58a655779059d616b20d7441ea22047d829eb3931989c"),
        ),
    ),
    "advanced-ocr-textline-orientation": ModelSpec(
        role="advanced-ocr-textline-orientation",
        repo="PaddlePaddle/PP-LCNet_x1_0_textline_ori",
        commit="cd237a44b0e359d4fe38310a416203cf7403faa5",
        files=(
            FileSpec("inference.json", "b81929eeaff8e52db0fafb49c9fbfc5bc0572f81641fe0179cc52096323fb4d4"),
            FileSpec("inference.yml", "8d5120d0e1a30a9df7ed46aa9119da3796ed066777089d1c1d705f132d5e90f9"),
            FileSpec("config.json", "c1a2576f9713adabdc4a58d9d654fcc9ea93b6efd0e2d3581d5aab409a33f14f"),
            FileSpec("inference.pdiparams", "0de2bcf996cf553e2b848dd7b1769dafffc6917b1ccdf55c1d8efe7909fbf743"),
        ),
    ),
    "advanced-ocr-doc-unwarping": ModelSpec(
        role="advanced-ocr-doc-unwarping",
        repo="PaddlePaddle/UVDoc",
        commit="16c3f0ea9c2f0c6a57e24160f7eeaa7574613fa3",
        files=(
            FileSpec("inference.json", "2c2bc3e0f15e782cf8f2ad411b5033d99ca504fe88648f8054a5e925ba2336e0"),
            FileSpec("inference.yml", "be83d537b358f3ff87740e77e14a83ee9e9a7bb215c33d091b69e8bd5904fe39"),
            FileSpec("config.json", "0ffdb1f399eee3eb7816fb79b1380f97f89039b955eee2e60d3f7336f6f30875"),
            FileSpec("inference.pdiparams", "810488899520e0da843b9bd9769ba4949f1c81e357f0eceb12d4a7da459c3eca"),
        ),
    ),
    "advanced-ocr-table-classification": ModelSpec(
        role="advanced-ocr-table-classification",
        repo="PaddlePaddle/PP-LCNet_x1_0_table_cls",
        commit="2fa6323e7dab88fa883081db1460995f46af2922",
        files=(
            FileSpec("inference.json", "43401e76ed7b0e34787533016ea4ec9193d5b5964c3f948991fc5b531651ef33"),
            FileSpec("inference.yml", "891b1f4b0ccddaf6aca0fce8c8a38e5ab5da9f62fb9adaa7c75e161ee03bb787"),
            FileSpec("config.json", "3ba2c2754d073d0e91b54fa11bcfff987dead2f94d7a8d3d57c1804071b176ab"),
            FileSpec("inference.pdiparams", "d0224afd9cfddf22da17407c6c78491baaa1f25922fbb312c9b0d2037c802db0"),
        ),
    ),
    "advanced-ocr-table-structure-wired": ModelSpec(
        role="advanced-ocr-table-structure-wired",
        repo="PaddlePaddle/SLANeXt_wired",
        commit="763069fcda6a065f2171753205a32bf899a88d15",
        files=(
            FileSpec("inference.json", "5b872f08e74f628ca1db8405db147e82e6e0c7cb358e101fd01cdafc946632d8"),
            FileSpec("inference.yml", "abbbd1b4dc6b1a2e9cd34c035514da53a1a6b1ec267292b0b8802025650a33bf"),
            FileSpec("config.json", "1379eb21de34e69e3c5e68492304751db7f139037487c2c62133cdb22233993d"),
            FileSpec("inference.pdiparams", "ff0362a30f707fa7d27d8453c4396b992fca287377a42d01515bca6eeb3908f5"),
        ),
    ),
    "advanced-ocr-table-structure-wireless": ModelSpec(
        role="advanced-ocr-table-structure-wireless",
        repo="PaddlePaddle/SLANet_plus",
        commit="bae6e5f8c3c4e7da0c0b7639fdf3228fe76184e2",
        files=(
            FileSpec("inference.json", "aba91cd956f4a1648b0f89df94c3cf8acaa066b47e2b689d109843b40d8545a2"),
            FileSpec("inference.yml", "8a6372d3269a6f112fe13a2da7952a84da6e112c10a3146cbb43de5bd01d19fa"),
            FileSpec("config.json", "de63f29e0096cbfc7dcf772ae7dabc47c3e5348f29e949d9b4dda8875e90ea31"),
            FileSpec("inference.pdiparams", "012986b0e2bfe90410618bfb4b7cf4fcb6c978caefd84c63c2934f8387b09ab8"),
        ),
    ),
    "advanced-ocr-table-cells-wired": ModelSpec(
        role="advanced-ocr-table-cells-wired",
        repo="PaddlePaddle/RT-DETR-L_wired_table_cell_det",
        commit="e2bd53c06b3a815d86acbf5c6779dada58819cfe",
        files=(
            FileSpec("inference.json", "abea237f1e53d3dc3bf7ea1321dfebe78552a6070e567dfc94028b622fd575e8"),
            FileSpec("inference.yml", "edf6d6180f2b9e3e666c744ee5ded38a72c6ef9056cd193250e3e55ba268acef"),
            FileSpec("config.json", "411eaf19f4cbdfcc5bf4da8aaf15eeb57e7e98213cb721cdb890ec0fa2c1930e"),
            FileSpec("inference.pdiparams", "357321c2845f0a035e8d118622649685a3cdb89d28b09a64e45a5a3df7a9fedc"),
        ),
    ),
    "advanced-ocr-table-cells-wireless": ModelSpec(
        role="advanced-ocr-table-cells-wireless",
        repo="PaddlePaddle/RT-DETR-L_wireless_table_cell_det",
        commit="25ca86356a601c877476bb0dcc5fd09153d9d64d",
        files=(
            FileSpec("inference.json", "abea237f1e53d3dc3bf7ea1321dfebe78552a6070e567dfc94028b622fd575e8"),
            FileSpec("inference.yml", "f2d0f00ea42aacc162f72a35cf54330e392a7d669e9a1b43896d3bd77a512621"),
            FileSpec("config.json", "cf38c6c63c0c5c5b1598c19019cd4d4e6af35a14667c6ec2656aeb215b7e97e1"),
            FileSpec("inference.pdiparams", "c0f8c9ea07be8916ece73a8acf807bd21aed3ef11969b319c2dccb2406774c34"),
        ),
    ),
    "advanced-ocr-formula": ModelSpec(
        role="advanced-ocr-formula",
        repo="PaddlePaddle/PP-FormulaNet_plus-L",
        commit="0809597a77f735bfb35354edb632f2e6dff606f3",
        files=(
            FileSpec("inference.json", "ad259c4b896d99aa3479336b9121112fb40ff1ababfbf8765a3428a3b86df582"),
            FileSpec("inference.yml", "afc92a2737268da0499c37b0b6741da268c369fd7424667fcfeb8fa6c7b22d30"),
            FileSpec("config.json", "44e0be0fd39b676cc409c2ef537b4a52509db55cc79bacbbe65b55fe8d64c6a4"),
            FileSpec("inference.pdiparams", "4245c39c181d1d21e472bc85c7434df9b23f177be46552c0542bf153addbc355"),
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
