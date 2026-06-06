/**
 * Hand-maintained TS mirror of the sidecar's provider preset table
 * (``sidecar/search_sidecar/providers/presets.py``). v1 ships with a
 * static mirror; v2 will fetch via a new GET /providers/presets
 * endpoint to remove the drift risk. A snapshot test pinning these
 * values to the sidecar's response would catch drift in CI.
 *
 * Capability vocabulary v1: ``embedding`` / ``reranking`` / ``vision``
 * / ``ocr`` / ``advanced-ocr`` / ``audio-transcript`` / ``llm`` /
 * ``web-search``.
 */

export type ProviderType = "local" | "cloud";
export type AuthKind = "none" | "api-key";
export type Capability =
  | "embedding"
  | "reranking"
  | "vision"
  | "ocr"
  | "advanced-ocr"
  | "audio-transcript"
  | "llm"
  | "web-search";

export interface ProviderPreset {
  providerId: string;
  displayName: string;
  providerType: ProviderType;
  capabilities: readonly Capability[];
  defaultModelPerCapability: Partial<Record<Capability, string>>;
  authKind: AuthKind;
  baseUrl?: string;
  validationEndpoint?: string;
  /** UI hint for masked-key display. ``"sk-"`` for OpenAI etc. */
  apiKeyPrefix?: string;
  /** Identifies the ModelManager role(s) this provider owns. The
   * frontend consults this when the user binds a feature to a
   * local provider so it can kick off downloads for any missing
   * stages without waiting for the user to click 13 buttons.
   *
   * - Single role (``"embedding"``): exact-match lookup.
   * - Prefix (``"advanced-ocr-"``, ending in ``-``): matches every
   *   role whose id starts with the prefix (the PP-StructureV3
   *   bundle exposes 13 such stages).
   * - ``undefined``: the provider doesn't have downloadable models
   *   (cloud providers, or local providers like rapidocr whose
   *   models ship inside the wheel). */
  localRoleId?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    providerId: "local-gte",
    displayName: "Local GTE",
    providerType: "local",
    capabilities: ["embedding"],
    defaultModelPerCapability: { embedding: "gte-multilingual-base" },
    authKind: "none",
    localRoleId: "embedding",
  },
  {
    providerId: "local-gte-reranker",
    displayName: "Local GTE Reranker",
    providerType: "local",
    capabilities: ["reranking"],
    defaultModelPerCapability: {
      reranking: "gte-multilingual-reranker-base",
    },
    authKind: "none",
    localRoleId: "reranker",
  },
  {
    providerId: "local-paddleocr",
    displayName: "Local PaddleOCR",
    providerType: "local",
    capabilities: ["ocr"],
    defaultModelPerCapability: { ocr: "PP-OCRv4_mobile" },
    authKind: "none",
    // No localRoleId — rapidocr-onnxruntime ships its models inside
    // the wheel; ModelManager has nothing to download.
  },
  {
    // PP-StructureV3 — layout-aware OCR with table + formula
    // recognition. Selecting this provider triggers a 13-stage
    // model download (~600MB) and requires the optional
    // ``advanced-ocr`` Python extra (paddleocr + paddlepaddle).
    providerId: "local-paddleocr-advanced",
    displayName: "Local PaddleOCR Advanced",
    providerType: "local",
    capabilities: ["advanced-ocr"],
    defaultModelPerCapability: {
      "advanced-ocr": "PP-StructureV3",
    },
    authKind: "none",
    // Prefix match — every ``advanced-ocr-*`` stage role belongs
    // to this provider.
    localRoleId: "advanced-ocr-",
  },
  {
    providerId: "local-qwen-asr",
    displayName: "Local Qwen ASR",
    providerType: "local",
    capabilities: ["audio-transcript"],
    defaultModelPerCapability: {
      "audio-transcript": "Qwen3-ASR-0.6B",
    },
    authKind: "none",
    localRoleId: "audio-transcript",
  },
  {
    providerId: "local-ollama",
    displayName: "Local Ollama",
    providerType: "local",
    capabilities: ["llm"],
    defaultModelPerCapability: { llm: "llama3.2" },
    authKind: "none",
    baseUrl: "http://127.0.0.1:11434",
  },
  {
    providerId: "openai",
    displayName: "OpenAI",
    providerType: "cloud",
    capabilities: ["embedding", "vision", "ocr", "advanced-ocr", "llm"],
    defaultModelPerCapability: {
      embedding: "text-embedding-3-small",
      vision: "gpt-4o-mini",
      ocr: "gpt-4o-mini",
      "advanced-ocr": "gpt-4o-mini",
      llm: "gpt-4o-mini",
    },
    authKind: "api-key",
    baseUrl: "https://api.openai.com/v1",
    validationEndpoint: "/models",
    apiKeyPrefix: "sk-",
  },
  {
    providerId: "qwen-dashscope",
    displayName: "Qwen DashScope",
    providerType: "cloud",
    capabilities: ["vision", "ocr", "advanced-ocr", "llm"],
    defaultModelPerCapability: {
      vision: "qwen-vl-plus",
      ocr: "qwen-vl-plus",
      "advanced-ocr": "qwen-vl-plus",
      llm: "qwen-plus",
    },
    authKind: "api-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    validationEndpoint: "/models",
    apiKeyPrefix: "sk-",
  },
  {
    providerId: "deepseek",
    displayName: "DeepSeek",
    providerType: "cloud",
    capabilities: ["llm"],
    defaultModelPerCapability: { llm: "deepseek-v4-flash" },
    authKind: "api-key",
    baseUrl: "https://api.deepseek.com",
    validationEndpoint: "/models",
    apiKeyPrefix: "sk-",
  },
  {
    providerId: "brave-search",
    displayName: "Brave Search",
    providerType: "cloud",
    capabilities: ["web-search"],
    defaultModelPerCapability: { "web-search": "brave-web" },
    authKind: "api-key",
    baseUrl: "https://api.search.brave.com/res/v1",
    validationEndpoint: "/web/search",
  },
  {
    providerId: "tavily-search",
    displayName: "Tavily Search",
    providerType: "cloud",
    capabilities: ["web-search"],
    defaultModelPerCapability: { "web-search": "tavily-search" },
    authKind: "api-key",
    baseUrl: "https://api.tavily.com",
    validationEndpoint: "/search",
    apiKeyPrefix: "tvly-",
  },
];

export function presetById(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.providerId === providerId);
}

export function presetsWithCapability(
  capability: Capability
): readonly ProviderPreset[] {
  return PROVIDER_PRESETS.filter((p) => p.capabilities.includes(capability));
}

/** True when ``role`` is one of the model-manager roles this preset
 * owns. Resolves both exact-match and prefix-match conventions for
 * ``localRoleId``. Used by the auto-download path in FeatureRow to
 * decide which roles to kick off when the user binds a feature to a
 * local provider.
 */
export function presetOwnsRole(preset: ProviderPreset, role: string): boolean {
  if (!preset.localRoleId) return false;
  if (preset.localRoleId.endsWith("-")) {
    return role.startsWith(preset.localRoleId);
  }
  return role === preset.localRoleId;
}

/** UI display order for features. User-configurable capabilities
 * come first; mandatory pipeline stages sit at the end so the
 * Settings page leads with choices the user can act on. */
export interface FeatureMeta {
  featureId: string;
  displayName: string;
  description: string;
  capability: Capability;
  mandatory: boolean;
  /** When true the row renders disabled with an "available in next
   * release" hint — used for Phase-2 features whose extractor wiring
   * isn't shipped yet. */
  comingSoon: boolean;
}

export const FEATURE_CATALOG: readonly FeatureMeta[] = [
  {
    featureId: "image-captioning",
    displayName: "Image captioning",
    description:
      "Generate searchable descriptions of images. Cloud-only in v1 " +
      "(OpenAI / Qwen DashScope).",
    capability: "vision",
    mandatory: false,
    comingSoon: false,
  },
  {
    featureId: "advanced-ocr",
    displayName: "Advanced OCR",
    description:
      "Layout-aware OCR for invoices, receipts, tables and formulas. " +
      "Cloud uses structured-prompt vision; local PP-StructureV3 " +
      "downloads a 13-model bundle (~600MB) on enable, then " +
      "auto-reindexes existing images.",
    capability: "advanced-ocr",
    mandatory: false,
    comingSoon: false,
  },
  {
    featureId: "llm",
    displayName: "LLM",
    description:
      "Answers questions from selected workspace and web sources. Local Ollama stays on-device; cloud providers send prompt context off-device.",
    capability: "llm",
    mandatory: false,
    comingSoon: false,
  },
  {
    featureId: "web-search",
    displayName: "Web search",
    description:
      "Adds current web sources to Chat research. Results are cited in-session and are not saved as Cognios URL nodes by default.",
    capability: "web-search",
    mandatory: false,
    comingSoon: false,
  },
  {
    featureId: "semantic-search",
    displayName: "Semantic search",
    description:
      "Required. Powers semantic search across your indexed content.",
    capability: "embedding",
    mandatory: true,
    comingSoon: false,
  },
  {
    featureId: "result-reranking",
    displayName: "Result reranking",
    description:
      "Required. Refines top search results with a second-pass quality check.",
    capability: "reranking",
    mandatory: true,
    comingSoon: false,
  },
  {
    featureId: "image-ocr",
    displayName: "Image OCR",
    description:
      "Required. Extracts text from screenshots and scans. " +
      "Local PaddleOCR ships bundled with no download; cloud providers " +
      "transcribe via vision API.",
    capability: "ocr",
    mandatory: true,
    comingSoon: false,
  },
  {
    featureId: "voice-notes",
    displayName: "Voice notes",
    description:
      "Required. Transcribes meeting audio locally with Qwen3-ASR 0.6B. The model downloads automatically on startup.",
    capability: "audio-transcript",
    mandatory: true,
    comingSoon: false,
  },
];
