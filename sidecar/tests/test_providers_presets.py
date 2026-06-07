"""Static checks on the provider preset catalog."""

from __future__ import annotations

from search_sidecar.providers.presets import (
    PRESETS,
    AuthKind,
    Capability,
    ProviderPreset,
    ProviderType,
    presets_with_capability,
)


def test_v1_presets_cover_known_providers():
    """The v1 preset set is fixed by the brainstorm — any addition or
    removal should be a deliberate scope change, not an accident.
    ``local-gemma`` was dropped from v1 (multi-repo manifest +
    llama-server runtime deferred); local captioning routes through
    cloud providers only. ``local-paddleocr-advanced`` (PP-StructureV3)
    was added when layout-aware OCR became its own feature."""
    assert set(PRESETS) == {
        "local-gte",
        "local-gte-reranker",
        "local-paddleocr",
        "local-paddleocr-advanced",
        "local-vllm-asr",
        "local-ollama",
        "openai",
        "qwen-dashscope",
        "deepseek",
        "brave-search",
        "tavily-search",
    }


def test_each_preset_is_well_formed():
    valid_capabilities: set[Capability] = {
        "embedding",
        "reranking",
        "vision",
        "ocr",
        "advanced-ocr",
        "audio-transcript",
        "llm",
        "web-search",
    }
    valid_types: set[ProviderType] = {"local", "cloud"}
    valid_auth: set[AuthKind] = {"none", "api-key"}
    for provider_id, preset in PRESETS.items():
        assert isinstance(preset, ProviderPreset)
        assert preset.provider_id == provider_id
        assert preset.display_name, provider_id
        assert preset.provider_type in valid_types
        assert preset.auth_kind in valid_auth
        assert preset.capabilities, f"{provider_id} declares no capabilities"
        assert preset.capabilities <= valid_capabilities
        # Every declared capability has a default model.
        for cap in preset.capabilities:
            assert cap in preset.default_model_per_capability, (
                f"{provider_id} missing default model for capability {cap}"
            )


def test_cloud_providers_carry_base_url_and_validation_endpoint():
    for preset in PRESETS.values():
        if preset.provider_type == "cloud":
            assert preset.base_url, preset.provider_id
            assert preset.base_url.startswith("https://"), preset.provider_id
            assert preset.validation_endpoint, preset.provider_id
            assert preset.auth_kind == "api-key", preset.provider_id


def test_local_providers_have_no_base_url():
    for preset in PRESETS.values():
        if preset.provider_type == "local" and preset.provider_id != "local-ollama":
            assert preset.base_url is None, preset.provider_id


def test_capability_matrix_matches_v1_decision():
    """v1 capability matrix:
    - local-gte → embedding
    - local-gte-reranker → reranking
    - local-paddleocr → ocr
    - local-paddleocr-advanced → advanced-ocr (PP-StructureV3 bundle)
    - local-vllm-asr → audio-transcript (packaged realtime voice runtime)
    - local-ollama → llm
    - openai → embedding + vision + ocr + advanced-ocr + llm
    - qwen-dashscope → vision + ocr + advanced-ocr + llm
    - deepseek → llm
    - brave-search → web-search
    - tavily-search → web-search
    """
    assert PRESETS["local-gte"].capabilities == frozenset({"embedding"})
    assert PRESETS["local-gte-reranker"].capabilities == frozenset({"reranking"})
    assert PRESETS["local-paddleocr"].capabilities == frozenset({"ocr"})
    assert PRESETS["local-paddleocr-advanced"].capabilities == frozenset(
        {"advanced-ocr"}
    )
    assert PRESETS["local-vllm-asr"].capabilities == frozenset(
        {"audio-transcript"}
    )
    assert PRESETS["local-ollama"].capabilities == frozenset({"llm"})
    assert PRESETS["openai"].capabilities == frozenset(
        {"embedding", "vision", "ocr", "advanced-ocr", "llm"}
    )
    assert PRESETS["qwen-dashscope"].capabilities == frozenset(
        {"vision", "ocr", "advanced-ocr", "llm"}
    )
    assert PRESETS["deepseek"].capabilities == frozenset({"llm"})
    assert PRESETS["brave-search"].capabilities == frozenset({"web-search"})
    assert PRESETS["tavily-search"].capabilities == frozenset({"web-search"})


def test_llm_and_web_search_capabilities_are_explicit():
    llm_ids = {p.provider_id for p in presets_with_capability("llm")}
    web_ids = {p.provider_id for p in presets_with_capability("web-search")}

    assert llm_ids == {"local-ollama", "openai", "qwen-dashscope", "deepseek"}
    assert web_ids == {"brave-search", "tavily-search"}


def test_presets_with_capability_filters_correctly():
    embedding_providers = presets_with_capability("embedding")
    ids = [p.provider_id for p in embedding_providers]
    assert "local-gte" in ids
    assert "openai" in ids
    assert "qwen-dashscope" not in ids  # excluded — 1024-dim incompatible

    vision_providers = presets_with_capability("vision")
    vision_ids = {p.provider_id for p in vision_providers}
    assert vision_ids == {"openai", "qwen-dashscope"}

    ocr_providers = presets_with_capability("ocr")
    ocr_ids = {p.provider_id for p in ocr_providers}
    assert ocr_ids == {"local-paddleocr", "openai", "qwen-dashscope"}

    advanced_ocr_providers = presets_with_capability("advanced-ocr")
    advanced_ocr_ids = {p.provider_id for p in advanced_ocr_providers}
    assert advanced_ocr_ids == {
        "local-paddleocr-advanced",
        "openai",
        "qwen-dashscope",
    }

    llm_providers = presets_with_capability("llm")
    llm_ids = {p.provider_id for p in llm_providers}
    assert llm_ids == {"local-ollama", "openai", "qwen-dashscope", "deepseek"}

    audio_transcript_providers = presets_with_capability("audio-transcript")
    audio_transcript_ids = {p.provider_id for p in audio_transcript_providers}
    assert audio_transcript_ids == {"local-vllm-asr"}

    web_providers = presets_with_capability("web-search")
    web_ids = {p.provider_id for p in web_providers}
    assert web_ids == {"brave-search", "tavily-search"}


def test_openai_embedding_default_is_3_small():
    """Locked at text-embedding-3-small because it supports the
    `dimensions=768` Matryoshka reduction needed to match lancedb's
    768-dim schema. Changing this default requires re-validating
    dimension compatibility."""
    assert (
        PRESETS["openai"].default_model_per_capability["embedding"]
        == "text-embedding-3-small"
    )
