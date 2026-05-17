import type { ModelRoleStatus } from "../../lib/contracts/search";
import type { SearchClient } from "./types/search";

const MODEL_DOWNLOAD_PRIORITY = [
  "embedding",
  "reranker",
  "audio-transcript",
] as const;

const NON_STARTABLE_STATES = new Set(["ready", "downloading", "verifying", "queued"]);

export type ModelDownloadStartResult =
  | { role: string; status: "fulfilled" }
  | { role: string; status: "rejected"; reason: unknown };

export function sortModelDownloadRoles(roleIds: string[]): string[] {
  return roleIds
    .map((role, index) => ({ role, index }))
    .sort((a, b) => {
      const priorityDelta = modelDownloadRank(a.role) - modelDownloadRank(b.role);
      if (priorityDelta !== 0) return priorityDelta;
      return a.index - b.index;
    })
    .map((item) => item.role);
}

export function modelRolesAtOrAbovePriority(
  roles: Record<string, ModelRoleStatus>,
  targetRole: string
): ModelRoleStatus[] {
  const targetRank = modelDownloadRank(targetRole);
  return Object.values(roles).filter(
    (role) => modelDownloadRank(role.role) <= targetRank
  );
}

export function startModelDownloadsInPriorityOrder(
  client: SearchClient,
  roles: ModelRoleStatus[]
): Promise<ModelDownloadStartResult[]> {
  return Promise.all(
    sortModelDownloadRoles(
      roles
        .filter((role) => !NON_STARTABLE_STATES.has(role.state))
        .map((role) => role.role)
    ).map(async (role) => {
      try {
        await client.startModelDownload({ role });
        return { role, status: "fulfilled" as const };
      } catch (reason) {
        return { role, status: "rejected" as const, reason };
      }
    })
  );
}

function modelDownloadRank(role: string): number {
  const rank = MODEL_DOWNLOAD_PRIORITY.indexOf(
    role as (typeof MODEL_DOWNLOAD_PRIORITY)[number]
  );
  return rank === -1 ? MODEL_DOWNLOAD_PRIORITY.length : rank;
}
