/**
 * Hand-maintained TS mirror of the sidecar's provider preset table
 * (``sidecar/search_sidecar/providers/presets.py``). v1 ships with a
 * static mirror; v2 will fetch via a new GET /providers/presets
 * endpoint to remove the drift risk. A snapshot test pinning these
 * values to the sidecar's response would catch drift in CI.
 *
 * Capability vocabulary v1: ``embedding`` / ``reranking`` / ``vision``
 * / ``ocr``. ``chat`` is intentionally absent until the chat feature
 * ships.
 */

export type ProviderType = "local" | "cloud";
export type AuthKind = "none" | "hf-token" | "api-key";
export type Capability =
  | "embedding"
  | "reranking"
  | "vision"
  | "ocr"
  | "advanced-ocr";

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
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    providerId: "local-gte",
    displayName: "Local GTE",
    providerType: "local",
    capabilities: ["embedding"],
    defaultModelPerCapability: { embedding: "gte-multilingual-base" },
    authKind: "none",
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
  },
  {
    providerId: "local-paddleocr",
    displayName: "Local PaddleOCR",
    providerType: "local",
    capabilities: ["ocr"],
    defaultModelPerCapability: { ocr: "PP-OCRv4_mobile" },
    authKind: "none",
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
  },
  {
    providerId: "openai",
    displayName: "OpenAI",
    providerType: "cloud",
    capabilities: ["embedding", "vision", "ocr", "advanced-ocr"],
    defaultModelPerCapability: {
      embedding: "text-embedding-3-small",
      vision: "gpt-4o-mini",
      ocr: "gpt-4o-mini",
      "advanced-ocr": "gpt-4o-mini",
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
    capabilities: ["vision", "ocr", "advanced-ocr"],
    defaultModelPerCapability: {
      vision: "qwen-vl-plus",
      ocr: "qwen-vl-plus",
      "advanced-ocr": "qwen-vl-plus",
    },
    authKind: "api-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    validationEndpoint: "/models",
    apiKeyPrefix: "sk-",
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

/** UI display order for features. Mirrors the canonical order used
 * elsewhere — Embedding (mandatory) first, then optional in
 * dependency-bundle order. */
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
];
