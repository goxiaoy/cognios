import type { SearchSettings } from "../../../lib/contracts/search";
import type { ExplorerNode } from "../../explorer/types/explorer";
import { hasExtractArtifacts } from "../../explorer/utils/presentation";

export function isWorkspaceEmpty(nodes: ExplorerNode[]): boolean {
  return nodes.length === 0;
}

export function hasAdvancedOcrCandidate(nodes: ExplorerNode[]): boolean {
  return nodes.some((node) => {
    if (hasExtractArtifacts(node)) return true;
    return hasAdvancedOcrCandidate(node.children);
  });
}

export function shouldPromptForAdvancedOcr(
  nodes: ExplorerNode[],
  settings: SearchSettings | null
): boolean {
  if (!settings || !hasAdvancedOcrCandidate(nodes)) return false;
  return !isFeatureUsable(settings, "advanced-ocr");
}

export function shouldPromptForChatProvider(
  settings: SearchSettings | null
): boolean {
  if (!settings) return false;
  return !isFeatureUsable(settings, "llm", "chat");
}

export function advancedOcrPromptFingerprint(
  nodes: ExplorerNode[],
  settings: SearchSettings | null
): string {
  const candidates: string[] = [];
  collectAdvancedOcrCandidates(nodes, candidates);
  const feature = settings?.features["advanced-ocr"];
  return [
    "advanced-ocr",
    feature?.enabled ? "enabled" : "disabled",
    feature?.providerId ?? "unbound",
    candidates.sort().join(","),
  ].join(":");
}

export function chatPromptFingerprint(settings: SearchSettings | null): string {
  const feature = settings?.features.llm;
  const providerId = feature?.providerId ?? "unbound";
  const provider = settings?.providers[providerId];
  return [
    "chat",
    feature?.enabled ? "enabled" : "disabled",
    providerId,
    provider?.enabled ? "provider-enabled" : "provider-disabled",
  ].join(":");
}

function isFeatureUsable(
  settings: SearchSettings,
  featureId: string,
  fallbackFeatureId?: string
): boolean {
  const feature =
    settings.features[featureId] ??
    (fallbackFeatureId ? settings.features[fallbackFeatureId] : undefined);
  if (!feature?.enabled || !feature.providerId) return false;
  const provider = settings.providers[feature.providerId];
  return provider?.enabled === true;
}

function collectAdvancedOcrCandidates(
  nodes: ExplorerNode[],
  candidates: string[]
) {
  for (const node of nodes) {
    if (hasExtractArtifacts(node)) candidates.push(node.id);
    collectAdvancedOcrCandidates(node.children, candidates);
  }
}
