"""Extractor factory routing tests — settings binding → callable shape.

Mirrors test_select_embedder_routing / test_rerank_factory style.
"""

from __future__ import annotations

from unittest import mock

import search_sidecar.extract.factory as factory
from search_sidecar.extract.factory import (
    select_caption_extractor,
    select_ocr_extractor,
)
from search_sidecar.settings import (
    FeatureConfig,
    ProviderConfig,
    SearchSettings,
)


def _settings_with(features: dict[str, FeatureConfig], providers=None) -> SearchSettings:
    return SearchSettings(
        providers=providers or {},
        features=features,
    )


# ---- select_ocr_extractor ---------------------------------------------------


def test_ocr_returns_none_when_settings_is_none():
    assert select_ocr_extractor(None) is None


def test_ocr_returns_none_when_feature_disabled():
    s = _settings_with(
        {"image-ocr": FeatureConfig(enabled=False, provider_id="local-paddleocr")}
    )
    assert select_ocr_extractor(s) is None


def test_ocr_returns_none_when_unbound():
    s = _settings_with({"image-ocr": FeatureConfig(enabled=True, provider_id=None)})
    assert select_ocr_extractor(s) is None


def test_ocr_returns_none_when_provider_lacks_ocr_capability():
    """Binding to a non-OCR provider (e.g. local-gte) must downgrade to None."""
    s = _settings_with(
        {"image-ocr": FeatureConfig(enabled=True, provider_id="local-gte")}
    )
    assert select_ocr_extractor(s) is None


def test_ocr_returns_none_for_openai_binding():
    s = _settings_with(
        features={"image-ocr": FeatureConfig(enabled=True, provider_id="openai")},
        providers={"openai": ProviderConfig(provider_id="openai")},
    )
    assert select_ocr_extractor(s) is None


def test_ocr_returns_none_for_qwen_dashscope_binding():
    s = _settings_with(
        features={
            "image-ocr": FeatureConfig(enabled=True, provider_id="qwen-dashscope")
        },
        providers={"qwen-dashscope": ProviderConfig(provider_id="qwen-dashscope")},
    )
    assert select_ocr_extractor(s) is None


def test_ocr_local_path_skips_when_extra_missing():
    """Local OCR routes through rapidocr; without the extra installed,
    the factory logs and returns None instead of crashing."""
    s = _settings_with(
        {"image-ocr": FeatureConfig(enabled=True, provider_id="local-paddleocr")}
    )
    with mock.patch(
        "search_sidecar.extract.factory.can_load_local_ocr",
        return_value=False,
    ):
        assert select_ocr_extractor(s) is None


def test_ocr_local_path_constructs_extractor_when_extra_present():
    s = _settings_with(
        {"image-ocr": FeatureConfig(enabled=True, provider_id="local-paddleocr")}
    )
    fake = mock.Mock()
    with mock.patch(
        "search_sidecar.extract.factory.can_load_local_ocr", return_value=True
    ), mock.patch(
        "search_sidecar.extract.factory.RapidOcrExtractor", return_value=fake
    ):
        extractor = select_ocr_extractor(s)
    assert extractor is fake


# ---- select_caption_extractor -----------------------------------------------


def test_caption_returns_none_when_settings_is_none():
    assert select_caption_extractor(None) is None


def test_caption_returns_none_when_feature_disabled_or_unbound():
    s = _settings_with(
        {"image-captioning": FeatureConfig(enabled=False, provider_id="openai")}
    )
    assert select_caption_extractor(s) is None
    s2 = _settings_with(
        {"image-captioning": FeatureConfig(enabled=True, provider_id=None)}
    )
    assert select_caption_extractor(s2) is None


def test_caption_returns_cloud_extractor_for_openai_binding():
    s = _settings_with(
        features={
            "image-captioning": FeatureConfig(enabled=True, provider_id="openai")
        },
        providers={"openai": ProviderConfig(provider_id="openai")},
    )
    extractor = select_caption_extractor(s)
    assert extractor is not None
    assert extractor.__name__ == "generate_caption"


def test_caption_returns_none_when_provider_lacks_vision_capability():
    s = _settings_with(
        {
            "image-captioning": FeatureConfig(
                enabled=True, provider_id="local-paddleocr"
            )
        }
    )
    # local-paddleocr declares ocr but not vision.
    assert select_caption_extractor(s) is None


# ---- model override path ----------------------------------------------------


def test_provider_model_per_capability_override_wins_over_preset_default():
    """If the user's ProviderConfig overrides the cloud model for a
    capability, the factory threads that into the client instead of
    the preset default. We assert this by inspecting the closure on
    the returned bound method."""
    s = _settings_with(
        features={
            "image-captioning": FeatureConfig(enabled=True, provider_id="openai")
        },
        providers={
            "openai": ProviderConfig(
                provider_id="openai",
                model_per_capability={"vision": "gpt-4o"},
            ),
        },
    )
    extractor = select_caption_extractor(s)
    assert extractor is not None
    client = extractor.__self__  # type: ignore[attr-defined]
    assert client._model == "gpt-4o"
