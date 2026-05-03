"""Image-extractor factories.

Three parallel selectors, one per feature, mirroring the embedder /
reranker factory pattern:

- :func:`select_ocr_extractor` reads ``settings.features["image-ocr"]``
  and returns a :class:`RapidOcrExtractor` for ``local-paddleocr`` or
  ``None`` when disabled / unbound / unsupported. Cloud OCR bindings
  flow through ``advanced-ocr`` only.
- :func:`select_caption_extractor` does the same for
  ``settings.features["image-captioning"]``. v1 ships cloud-only
  captioning; binding to a local provider currently logs and returns
  ``None`` so the row falls back to OCR-only output.
- :func:`select_advanced_ocr_extractor` reads
  ``settings.features["advanced-ocr"]`` and returns either a
  :class:`PpStructureV3Extractor` (local PP-StructureV3 bundle) or
  a bound method on :class:`OpenAICompatVisionClient` (cloud
  structured-prompt vision). The local path also requires the
  13-stage model bundle to have finished downloading — the factory
  asks the model manager and returns ``None`` until it has.

The factories never raise on misconfiguration. Logging + ``None``
keeps the dispatcher path resilient — a wrong API key or a half-
downloaded model bundle shouldn't park the indexing queue, it
should produce empty extracts and let the user fix Settings.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from ..providers import (
    PRESETS,
    KeychainUnavailableError,
    get_provider_secret,
)
from ..settings import SearchSettings
from .cloud_vision import OpenAICompatVisionClient
from .local_advanced_ocr import PpStructureV3Extractor, can_load_local_advanced_ocr
from .local_ocr import RapidOcrExtractor, can_load_local_ocr

if TYPE_CHECKING:
    from ..models import ModelManager

LOG = logging.getLogger("search_sidecar.extract.factory")

# Type alias for the callable shape ImageProcessor expects. The
# concrete callables (RapidOcrExtractor, OpenAICompatVisionClient
# methods, PpStructureV3Extractor) all take ``Path`` and return str —
# match that signature so type-checkers don't widen ``object`` over
# the actual contract.
Extractor = Callable[[Path], str]


def select_ocr_extractor(
    settings: SearchSettings | None,
) -> Extractor | None:
    """Return an OCR callable or ``None``.

    Routes by ``settings.features["image-ocr"].provider_id``:

    - local-paddleocr → a fresh :class:`RapidOcrExtractor`
    - any other condition (feature disabled, unbound, unknown
      provider, missing extra) → ``None``
    """
    if settings is None:
        return None
    feature = settings.features.get("image-ocr")
    if feature is None or not feature.enabled or feature.provider_id is None:
        LOG.debug("image-ocr disabled or unbound; skipping OCR extractor")
        return None
    preset = PRESETS.get(feature.provider_id)
    if preset is None or "ocr" not in preset.capabilities:
        LOG.warning(
            "image-ocr bound to %r which does not advertise ocr; "
            "skipping OCR extractor",
            feature.provider_id,
        )
        return None
    if feature.provider_id != "local-paddleocr":
        LOG.error(
            "settings_error feature=image-ocr provider=%r code=invalid_image_ocr_provider "
            "image-ocr must stay bound to local-paddleocr; cloud OCR uses advanced-ocr",
            feature.provider_id,
        )
        return None
    # Local OCR: only the rapidocr-backed extractor in v1.
    # ``rapidocr-onnxruntime`` is part of the main package, but the
    # check stays as a defensive net for broken venvs / missing
    # platform wheels — falling back to no-OCR is preferable to
    # crashing the dispatcher path.
    if not can_load_local_ocr():
        LOG.warning(
            "image-ocr bound to local provider %r but rapidocr_onnxruntime "
            "is not importable; skipping OCR extractor",
            preset.provider_id,
        )
        return None
    try:
        extractor = RapidOcrExtractor()
    except Exception as err:
        LOG.warning("local OCR construction failed: %s; skipping", err)
        return None
    LOG.info("OCR extractor: local rapidocr (%s)", preset.provider_id)
    return extractor


def select_caption_extractor(
    settings: SearchSettings | None,
) -> Extractor | None:
    """Return a captioning callable or ``None``.

    v1 supports cloud captioning only (OpenAI / Qwen DashScope). A
    binding to a local provider logs and returns ``None`` — local
    Gemma vision needs llama-server + multi-repo manifest support
    that's deferred past this round.
    """
    if settings is None:
        return None
    feature = settings.features.get("image-captioning")
    if feature is None or not feature.enabled or feature.provider_id is None:
        LOG.debug("image-captioning disabled or unbound; skipping captioner")
        return None
    preset = PRESETS.get(feature.provider_id)
    if preset is None or "vision" not in preset.capabilities:
        LOG.warning(
            "image-captioning bound to %r which does not advertise vision; "
            "skipping captioner",
            feature.provider_id,
        )
        return None
    if preset.provider_type != "cloud":
        LOG.warning(
            "image-captioning bound to local provider %r — local "
            "captioning is not implemented in v1; skipping",
            preset.provider_id,
        )
        return None
    client = _build_cloud_client(preset, settings, capability="vision")
    if client is None:
        return None
    LOG.info("captioner: cloud provider %s", preset.provider_id)
    return client.generate_caption


def select_advanced_ocr_extractor(
    settings: SearchSettings | None,
    model_manager: "ModelManager | None" = None,
) -> Extractor | None:
    """Return a layout-aware OCR callable or ``None``.

    Routes by ``settings.features["advanced-ocr"].provider_id``:

    - cloud preset with ``advanced-ocr`` capability → a
      ``OpenAICompatVisionClient.extract_advanced_ocr`` bound method.
    - ``local-paddleocr-advanced`` → a :class:`PpStructureV3Extractor`
      configured against the model directories the manager has
      downloaded; ``None`` until every PP-StructureV3 stage is ready.
    - feature off / unbound / paddleocr extra missing / model bundle
      not finished downloading → ``None``.

    ``model_manager`` is required for the local path so we can look
    up where each stage's files live on disk. Cloud doesn't need it.
    """
    if settings is None:
        return None
    feature = settings.features.get("advanced-ocr")
    if feature is None or not feature.enabled or feature.provider_id is None:
        LOG.debug("advanced-ocr disabled or unbound; skipping extractor")
        return None
    preset = PRESETS.get(feature.provider_id)
    if preset is None or "advanced-ocr" not in preset.capabilities:
        LOG.warning(
            "advanced-ocr bound to %r which does not advertise advanced-ocr; "
            "skipping extractor",
            feature.provider_id,
        )
        return None
    if preset.provider_type == "cloud":
        client = _build_cloud_client(preset, settings, capability="advanced-ocr")
        if client is None:
            return None
        LOG.info("advanced-ocr extractor: cloud provider %s", preset.provider_id)
        return client.extract_advanced_ocr
    # Local path: paddleocr deps + every PP-StructureV3 stage ready.
    if not can_load_local_advanced_ocr():
        LOG.warning(
            "advanced-ocr bound to local provider %r but paddleocr / "
            "paddlepaddle are not importable; install with "
            "`uv sync --extra advanced-ocr`. Skipping extractor.",
            preset.provider_id,
        )
        return None
    if model_manager is None:
        LOG.warning(
            "advanced-ocr bound to local provider %r but no model_manager "
            "is wired; skipping extractor",
            preset.provider_id,
        )
        return None
    collected = _collect_advanced_ocr_stages(model_manager)
    if collected is None:
        return None
    stage_dirs, stage_names = collected
    try:
        extractor = PpStructureV3Extractor(stage_dirs, stage_names)
    except Exception as err:
        LOG.warning("local PP-StructureV3 construction failed: %s", err)
        return None
    LOG.info("advanced-ocr extractor: local PP-StructureV3 (%s)", preset.provider_id)
    return extractor


def _collect_advanced_ocr_stages(
    model_manager: "ModelManager",
) -> tuple[dict[str, Path], dict[str, str]] | None:
    """Walk every PP-StructureV3 stage role and return both the
    on-disk directory holding the inference files **and** the
    canonical model name paddleocr expects to validate against.

    Returns ``None`` (with a warning) if any stage isn't yet
    downloaded — the caller surfaces that as "advanced OCR will
    activate once downloads finish".

    The model name is the basename of the manifest's HuggingFace
    repo (``PaddlePaddle/PP-OCRv4_mobile_det`` →
    ``PP-OCRv4_mobile_det``). paddleocr's pipeline cross-references
    this against each stage's ``inference.yml`` and refuses to load
    a v4-mobile dir when its own default expected, e.g., a v5-server
    variant.

    Uses the ``<role_dir>/current`` symlink the manager maintains
    after a successful download — that resolves to the active
    commit's directory, which is where the inference files live.
    """
    statuses = model_manager.status()
    manifest = model_manager.manifest
    stage_dirs: dict[str, Path] = {}
    stage_names: dict[str, str] = {}
    for role in PpStructureV3Extractor.STAGE_TO_KWARGS:
        status = statuses.get(role)
        if status is None or status.state != "ready":
            LOG.info(
                "advanced-ocr: stage %r not ready (%s); waiting for download",
                role,
                status.state if status else "missing",
            )
            return None
        directory = model_manager.role_dir(role) / "current"
        if not directory.exists():
            LOG.warning(
                "advanced-ocr: stage %r reports ready but %s is missing; "
                "skipping extractor",
                role,
                directory,
            )
            return None
        stage_dirs[role] = directory
        spec = manifest.get(role)
        if spec is not None and spec.repo:
            # Repo is ``"PaddlePaddle/PP-OCRv4_mobile_det"``; the
            # model name is the segment after the slash.
            stage_names[role] = spec.repo.rsplit("/", 1)[-1]
    return stage_dirs, stage_names


# ----- internals -------------------------------------------------------------


def _build_cloud_client(
    preset, settings: SearchSettings, *, capability: str
) -> OpenAICompatVisionClient | None:
    if preset.base_url is None:
        LOG.warning(
            "cloud provider %r has no base_url in preset; skipping",
            preset.provider_id,
        )
        return None
    provider_cfg = settings.providers.get(preset.provider_id)
    model = (
        (provider_cfg.model_per_capability.get(capability) if provider_cfg else None)
        or preset.default_model_per_capability.get(capability)
    )
    if not model:
        LOG.warning(
            "cloud provider %r has no %s model configured; skipping",
            preset.provider_id,
            capability,
        )
        return None
    base_url = (provider_cfg.base_url if provider_cfg else None) or preset.base_url
    return OpenAICompatVisionClient(
        base_url=base_url,
        model=model,
        provider_label=preset.provider_id,
        api_key_provider=lambda: _resolve_api_key(preset.provider_id),
    )


def _resolve_api_key(provider_id: str) -> str:
    """Lazy keychain read — same shape as the embedder factory."""
    try:
        secret = get_provider_secret(provider_id)
    except KeychainUnavailableError as err:
        raise RuntimeError(
            f"OS keychain unreachable for provider {provider_id!r}: {err}."
        ) from err
    if not secret:
        raise RuntimeError(
            f"no API key configured for provider {provider_id!r} — "
            "add it via Settings → Providers."
        )
    return secret
