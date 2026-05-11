"""Static catalog of providers the sidecar knows how to talk to.

Each preset declares:

- ``provider_id`` — stable identifier used in settings.json bindings,
  keychain account names (``provider:<id>``), and Tauri IPC commands.
- ``provider_type`` — ``"local"`` (downloadable, lifecycle managed by
  :class:`ModelManager`) or ``"cloud"`` (HTTP API, key in keychain).
- ``capabilities`` — the typed slots this provider can fill.
- ``default_model_per_capability`` — the model to use for each
  capability the provider serves, unless the user overrides it. For
  cloud providers, these are model names sent in the request body.
  For local providers, the manifest pins these.
- ``auth_kind`` — ``"none"`` (local) or ``"api-key"`` (cloud).
- ``base_url`` — only set for cloud providers; cloud HTTP client uses
  ``{base_url}/v1/embeddings``, ``{base_url}/v1/models``, etc.
- ``validation_endpoint`` — relative path under ``base_url`` that the
  Settings UI can ping with the API key to validate it on save.

Adding a new provider is a single dict entry here. Adding a new
capability requires the consumer code to know how to use it (a new
``Embedder``-like protocol, a new dispatcher branch, etc.) — the
preset table's job is just to declare what's available.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# v1 capability vocabulary. Adding a new value here is a coordinated
# change with the consumer code that knows how to use it.
#
# ``advanced-ocr`` is a layout-aware OCR pipeline (PP-StructureV3 for
# local, structured-prompted vision for cloud) that produces markdown
# with embedded tables and LaTeX formulas — distinct from the basic
# ``ocr`` capability which only returns flat detected text.
# ``audio-transcript`` powers Voice Notes transcription from captured
# meeting audio.
Capability = Literal[
    "embedding",
    "reranking",
    "vision",
    "ocr",
    "advanced-ocr",
    "audio-transcript",
    "chat",
    "web-search",
]
ProviderType = Literal["local", "cloud"]
AuthKind = Literal["none", "api-key"]


@dataclass(frozen=True)
class ProviderPreset:
    """Static description of one provider — see module docstring."""

    provider_id: str
    display_name: str
    provider_type: ProviderType
    capabilities: frozenset[Capability]
    default_model_per_capability: dict[Capability, str] = field(
        default_factory=dict
    )
    auth_kind: AuthKind = "none"
    base_url: str | None = None
    validation_endpoint: str | None = None
    # Cosmetic for the Settings UI; tells the masked-key display
    # which prefix to leave intact (e.g. "sk-" for OpenAI).
    api_key_prefix: str | None = None


# v1 preset table. Capability/provider matrix:
#
#                   embedding  reranking  vision  ocr  adv-ocr  audio  chat  web-search
#   local-gte           ✓
#   local-gte-reranker             ✓
#   local-paddleocr                                  ✓
#   local-paddleocr-advanced                                ✓
#   local-qwen-asr                                               ✓
#   local-ollama                                                       ✓
#   openai              ✓                    ✓     ✓       ✓           ✓
#   qwen-dashscope                           ✓     ✓       ✓
#   brave-search                                                               ✓
#   tavily-search                                                              ✓
#
# Cloud "vision" providers also serve OCR — same chat-completions
# endpoint with a transcribe-only prompt; see
# :mod:`search_sidecar.extract.cloud_vision`. Local captioning
# (Gemma / Llama vision) is deferred past v1 — that path needs both
# multi-repo manifest support AND a llama-server runtime.
#
# DeepSeek + Qwen embedding/reranking are explicitly out of v1 scope:
# DeepSeek only offers chat (which is v2), Qwen embedding is 1024-dim
# (incompatible with the locked 768-dim lancedb schema), Qwen
# reranking uses a non-OpenAI-compatible endpoint shape.
PRESETS: dict[str, ProviderPreset] = {
    "local-gte": ProviderPreset(
        provider_id="local-gte",
        display_name="Local GTE",
        provider_type="local",
        capabilities=frozenset({"embedding"}),
        default_model_per_capability={
            "embedding": "gte-multilingual-base",
        },
        auth_kind="none",
    ),
    "local-gte-reranker": ProviderPreset(
        provider_id="local-gte-reranker",
        display_name="Local GTE Reranker",
        provider_type="local",
        capabilities=frozenset({"reranking"}),
        default_model_per_capability={
            "reranking": "gte-multilingual-reranker-base",
        },
        auth_kind="none",
    ),
    "local-paddleocr": ProviderPreset(
        provider_id="local-paddleocr",
        display_name="Local PaddleOCR",
        provider_type="local",
        capabilities=frozenset({"ocr"}),
        # rapidocr-onnxruntime ships its own bundled PP-OCRv4 ONNX
        # files inside the wheel; the model name here is informational
        # for the Settings UI and not consumed by ModelManager.
        default_model_per_capability={
            "ocr": "PP-OCRv4_mobile",
        },
        auth_kind="none",
    ),
    "local-paddleocr-advanced": ProviderPreset(
        provider_id="local-paddleocr-advanced",
        display_name="Local PaddleOCR Advanced",
        provider_type="local",
        capabilities=frozenset({"advanced-ocr"}),
        # PP-StructureV3 pipeline (Apache-2.0). 12 sub-models cover
        # detection / recognition / layout / region / orientation /
        # unwarping / table classification + structure + cells (wired
        # and wireless) / formula recognition. Selecting this provider
        # triggers the ModelManager to download all 12 from
        # huggingface.co/PaddlePaddle/* — the model name below is the
        # umbrella label shown in Settings; per-stage model ids are
        # encoded in the manifest under role-prefixed names
        # (``advanced-ocr-detection``, ``advanced-ocr-recognition``, ...).
        default_model_per_capability={
            "advanced-ocr": "PP-StructureV3",
        },
        auth_kind="none",
    ),
    "local-qwen-asr": ProviderPreset(
        provider_id="local-qwen-asr",
        display_name="Local Qwen ASR",
        provider_type="local",
        capabilities=frozenset({"audio-transcript"}),
        default_model_per_capability={
            "audio-transcript": "Qwen3-ASR-0.6B",
        },
        auth_kind="none",
    ),
    "local-ollama": ProviderPreset(
        provider_id="local-ollama",
        display_name="Local Ollama",
        provider_type="local",
        capabilities=frozenset({"chat"}),
        default_model_per_capability={
            "chat": "llama3.2",
        },
        auth_kind="none",
        base_url="http://127.0.0.1:11434",
    ),
    "openai": ProviderPreset(
        provider_id="openai",
        display_name="OpenAI",
        provider_type="cloud",
        capabilities=frozenset(
            {"embedding", "vision", "ocr", "advanced-ocr", "chat"}
        ),
        default_model_per_capability={
            # 3-small natively returns 1536-dim; the cloud Embedder
            # always passes ``dimensions=768`` to coerce via Matryoshka.
            "embedding": "text-embedding-3-small",
            "vision": "gpt-4o-mini",
            "ocr": "gpt-4o-mini",
            # 4o-mini handles structured-prompt OCR well enough at
            # the entry tier; users can override per-feature in
            # Settings if they want 4o or a beefier upgrade path.
            "advanced-ocr": "gpt-4o-mini",
            "chat": "gpt-4o-mini",
        },
        auth_kind="api-key",
        base_url="https://api.openai.com/v1",
        validation_endpoint="/models",
        api_key_prefix="sk-",
    ),
    "qwen-dashscope": ProviderPreset(
        provider_id="qwen-dashscope",
        display_name="Qwen DashScope",
        provider_type="cloud",
        capabilities=frozenset({"vision", "ocr", "advanced-ocr"}),
        default_model_per_capability={
            "vision": "qwen-vl-plus",
            "ocr": "qwen-vl-plus",
            # qwen-vl-plus handles structured invoice/receipt prompts
            # competitively with 4o-mini on Chinese-language docs.
            "advanced-ocr": "qwen-vl-plus",
        },
        auth_kind="api-key",
        # OpenAI-compatible mode endpoint; Qwen embedding/reranking
        # are intentionally NOT advertised here even though DashScope
        # supports them (incompatible dim / endpoint shape — see
        # plan rationale).
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        validation_endpoint="/models",
        api_key_prefix="sk-",
    ),
    "brave-search": ProviderPreset(
        provider_id="brave-search",
        display_name="Brave Search",
        provider_type="cloud",
        capabilities=frozenset({"web-search"}),
        default_model_per_capability={
            "web-search": "brave-web",
        },
        auth_kind="api-key",
        base_url="https://api.search.brave.com/res/v1",
        validation_endpoint="/web/search",
    ),
    "tavily-search": ProviderPreset(
        provider_id="tavily-search",
        display_name="Tavily Search",
        provider_type="cloud",
        capabilities=frozenset({"web-search"}),
        default_model_per_capability={
            "web-search": "tavily-search",
        },
        auth_kind="api-key",
        base_url="https://api.tavily.com",
        validation_endpoint="/search",
        api_key_prefix="tvly-",
    ),
}


def presets_with_capability(capability: Capability) -> list[ProviderPreset]:
    """Return the providers that declare ``capability`` — used by the
    Settings UI's per-feature provider picker.

    Returned list is in insertion order (locals first, then cloud
    providers) — caller can re-sort if a different presentation is
    wanted.
    """
    return [p for p in PRESETS.values() if capability in p.capabilities]
