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
    removal should be a deliberate scope change, not an accident."""
    assert set(PRESETS) == {
        "local-gte",
        "local-gte-reranker",
        "local-gemma",
        "local-paddleocr",
        "openai",
        "qwen-dashscope",
    }


def test_each_preset_is_well_formed():
    valid_capabilities: set[Capability] = {
        "embedding",
        "reranking",
        "vision",
        "ocr",
    }
    valid_types: set[ProviderType] = {"local", "cloud"}
    valid_auth: set[AuthKind] = {"none", "hf-token", "api-key"}
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
        if preset.provider_type == "local":
            assert preset.base_url is None, preset.provider_id


def test_only_local_gemma_requires_hf_token():
    for preset in PRESETS.values():
        if preset.auth_kind == "hf-token":
            assert preset.provider_id == "local-gemma"


def test_capability_matrix_matches_brainstorm_decision():
    """The brainstorm's matrix:
    - local-gte → embedding
    - local-gte-reranker → reranking
    - local-gemma → vision
    - local-paddleocr → ocr
    - openai → embedding + vision
    - qwen-dashscope → vision (NOT embedding/reranking — incompatible)
    """
    assert PRESETS["local-gte"].capabilities == frozenset({"embedding"})
    assert PRESETS["local-gte-reranker"].capabilities == frozenset({"reranking"})
    assert PRESETS["local-gemma"].capabilities == frozenset({"vision"})
    assert PRESETS["local-paddleocr"].capabilities == frozenset({"ocr"})
    assert PRESETS["openai"].capabilities == frozenset({"embedding", "vision"})
    assert PRESETS["qwen-dashscope"].capabilities == frozenset({"vision"})


def test_chat_capability_intentionally_absent_in_v1():
    """Chat is out of v1 scope. No preset advertises it; no consumer
    code references it. If chat lands later, both this assertion and
    the Capability Literal need updating in the same change."""
    for preset in PRESETS.values():
        assert "chat" not in preset.capabilities, preset.provider_id


def test_presets_with_capability_filters_correctly():
    embedding_providers = presets_with_capability("embedding")
    ids = [p.provider_id for p in embedding_providers]
    assert "local-gte" in ids
    assert "openai" in ids
    assert "qwen-dashscope" not in ids  # excluded — 1024-dim incompatible
    assert "local-gemma" not in ids

    vision_providers = presets_with_capability("vision")
    vision_ids = {p.provider_id for p in vision_providers}
    assert vision_ids == {"local-gemma", "openai", "qwen-dashscope"}


def test_openai_embedding_default_is_3_small():
    """Locked at text-embedding-3-small because it supports the
    `dimensions=768` Matryoshka reduction needed to match lancedb's
    768-dim schema. Changing this default requires re-validating
    dimension compatibility."""
    assert (
        PRESETS["openai"].default_model_per_capability["embedding"]
        == "text-embedding-3-small"
    )
