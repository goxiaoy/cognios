"""Image-extractor factories.

Two parallel selectors, one per feature, mirroring the embedder /
reranker factory pattern:

- :func:`select_ocr_extractor` reads ``settings.features["image-ocr"]``
  and returns either a :class:`RapidOcrExtractor` (local), a bound
  method on :class:`OpenAICompatVisionClient` (cloud), or ``None``
  when the feature is disabled / unbound / unsupported. ``None`` is
  the signal to ImageProcessor that body chunks won't be produced
  for images.
- :func:`select_caption_extractor` does the same for
  ``settings.features["image-captioning"]``. v1 ships cloud-only
  captioning; binding to a local provider currently logs and returns
  ``None`` so the row falls back to OCR-only output.

The factories never raise on misconfiguration. Logging + ``None``
keeps the dispatcher path resilient — a wrong API key shouldn't
park the indexing queue, it should produce empty extracts and let
the user fix Settings.
"""

from __future__ import annotations

import logging
from typing import Callable

from ..providers import (
    PRESETS,
    KeychainUnavailableError,
    get_provider_secret,
)
from ..settings import SearchSettings
from .cloud_vision import OpenAICompatVisionClient
from .local_ocr import RapidOcrExtractor, can_load_local_ocr

LOG = logging.getLogger("search_sidecar.extract.factory")

# Type alias for the callable shape ImageProcessor expects.
Extractor = Callable[[object], str]


def select_ocr_extractor(
    settings: SearchSettings | None,
) -> Extractor | None:
    """Return an OCR callable or ``None``.

    Routes by ``settings.features["image-ocr"].provider_id``:

    - cloud preset with ``ocr`` capability → the matching method on
      a fresh :class:`OpenAICompatVisionClient`
    - local-paddleocr (or any local preset with ``ocr``) → a fresh
      :class:`RapidOcrExtractor`
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
    if preset.provider_type == "cloud":
        client = _build_cloud_client(preset, settings, capability="ocr")
        if client is None:
            return None
        LOG.info("OCR extractor: cloud provider %s", preset.provider_id)
        return client.extract_ocr
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
