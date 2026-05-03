import { useEffect, useRef } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Cpu, X } from "lucide-react";

import type {
  ModelDownloadEvent,
  ModelRoleStatus,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import type { ProviderPreset } from "../data/providerPresets";

const CAPABILITY_LABEL: Record<string, string> = {
  embedding: "Embedding",
  reranking: "Reranking",
  vision: "Vision",
  ocr: "OCR",
  "advanced-ocr": "Advanced OCR",
};

const STATE_LABEL: Record<string, string> = {
  ready: "Ready",
  missing: "Missing",
  downloading: "Downloading",
  verifying: "Verifying",
  queued: "Queued",
  error: "Error",
};

/**
 * Modal sheet that lists every model role a local provider owns,
 * with per-stage state, progress, and a one-click retry for any
 * stages that are missing or errored. Mirrors the visual shape of
 * :class:`ProviderEditorModal` (paper card, accented header,
 * close button) so the two surfaces feel like the same family.
 *
 * Cloud providers route through the editor modal instead — they
 * have credentials to enter, no per-stage download state to
 * surface. This modal is local-only.
 */
export function ProviderStagesModal({
  preset,
  ownedRoles,
  progressByRole,
  client,
  onClose,
}: {
  preset: ProviderPreset;
  ownedRoles: ModelRoleStatus[];
  progressByRole: Record<string, ModelDownloadEvent>;
  client: SearchClient;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const sorted = [...ownedRoles].sort((a, b) => a.role.localeCompare(b.role));
  const allReady = ownedRoles.every((r) => r.state === "ready");
  const anyMissing = ownedRoles.some(
    (r) => r.state === "missing" || r.state === "error"
  );
  const readyCount = ownedRoles.filter((r) => r.state === "ready").length;
  const capLabel = preset.capabilities
    .map((c) => CAPABILITY_LABEL[c] ?? c)
    .join(", ");

  async function handleRetryAll() {
    const missing = ownedRoles.filter(
      (r) => r.state === "missing" || r.state === "error"
    );
    for (const r of missing) {
      void client.startModelDownload({ role: r.role }).catch(() => {});
    }
  }

  return (
    <div
      className="modal-overlay provider-modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="provider-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-stages-title"
      >
        <header className="provider-modal-head">
          <div
            className={`provider-avatar provider-avatar--local provider-modal-avatar`}
          >
            {avatarText(preset)}
          </div>
          <div className="provider-modal-head-text">
            <h2 id="provider-stages-title" className="provider-modal-title">
              {preset.displayName}
            </h2>
            <p className="provider-modal-sub">
              <span className="provider-modal-runtime">
                <Cpu size={11} aria-hidden="true" />
                Local
              </span>
              <span className="provider-modal-sub-sep">·</span>
              <span>{capLabel}</span>
            </p>
          </div>
          <button
            type="button"
            className="provider-modal-close"
            aria-label="Close stage details"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="provider-modal-body">
          <div className="provider-stage-summary">
            <span className="provider-stage-summary-label">
              {ownedRoles.length === 1 ? "Model" : `${ownedRoles.length} stages`}
            </span>
            <span className="provider-stage-summary-state">
              {allReady ? "All ready" : `${readyCount} / ${ownedRoles.length} ready`}
            </span>
            {anyMissing && !allReady ? (
              <button
                type="button"
                className="provider-stage-retry"
                onClick={() => void handleRetryAll()}
              >
                Download missing
              </button>
            ) : null}
          </div>
          <ul className="provider-stage-list">
            {sorted.map((r) => (
              <ProviderStageRow
                key={r.role}
                preset={preset}
                role={r}
                progress={progressByRole[r.role]}
              />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ProviderStageRow({
  preset,
  role,
  progress,
}: {
  preset: ProviderPreset;
  role: ModelRoleStatus;
  progress: ModelDownloadEvent | undefined;
}) {
  const liveState = progress?.state;
  const effectiveState = liveState ?? role.state;
  const label = stageLabelFor(preset, role.role);
  const pct = progressPercent(progress);
  const isActive =
    effectiveState === "downloading" || effectiveState === "verifying";
  return (
    <li className={`provider-stage-item is-${effectiveState}`}>
      <span className="provider-stage-name" title={role.role}>
        {label}
      </span>
      <span className="provider-stage-state">
        {STATE_LABEL[effectiveState] ?? effectiveState}
      </span>
      {role.repo ? <ProviderRepoBadge role={role} /> : null}
      {isActive ? (
        <span className="provider-stage-bar" aria-label={`${label}: ${pct}%`}>
          <span
            className="provider-stage-bar-fill"
            style={{ width: `${pct}%` }}
          />
        </span>
      ) : null}
      {role.error ? (
        <span className="provider-stage-error" title={role.error}>
          {truncate(role.error, 60)}
        </span>
      ) : null}
    </li>
  );
}

function ProviderRepoBadge({ role }: { role: ModelRoleStatus }) {
  const commit = role.commit && !role.commit.startsWith("<") ? role.commit : null;
  const url = role.repo
    ? commit
      ? `https://huggingface.co/${role.repo}/tree/${commit}`
      : `https://huggingface.co/${role.repo}`
    : null;

  async function handleClick() {
    if (!url) return;
    try {
      await openExternal(url);
    } catch {
      // Tauri's shell-open failures are rare in practice and not
      // recoverable from the UI.
    }
  }

  return (
    <button
      type="button"
      className="provider-card-repo provider-stage-repo"
      onClick={() => void handleClick()}
      title={url ?? role.repo}
    >
      {role.repo}
      {commit ? (
        <span className="provider-card-repo-commit">@{commit.slice(0, 7)}</span>
      ) : null}
    </button>
  );
}

function avatarText(preset: ProviderPreset): string {
  const stripped = preset.displayName.replace(/^Local\s+/, "");
  const parts = stripped.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Strip the provider's role prefix and humanise the remainder.
 * ``advanced-ocr-table-cells-wired`` → ``Table cells (wired)``. */
function stageLabelFor(preset: ProviderPreset, roleId: string): string {
  let stem = roleId;
  if (preset.localRoleId && preset.localRoleId.endsWith("-")) {
    stem = roleId.slice(preset.localRoleId.length);
  } else if (preset.localRoleId) {
    stem = preset.localRoleId;
  }
  const wiredMatch = stem.match(/^(.*)-(wired|wireless)$/);
  if (wiredMatch) {
    return `${humanize(wiredMatch[1])} (${wiredMatch[2]})`;
  }
  return humanize(stem);
}

function humanize(s: string): string {
  if (!s) return s;
  const spaced = s.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function progressPercent(event: ModelDownloadEvent | undefined): number {
  if (!event) return 0;
  if (event.bytesTotal && event.bytesTotal > 0) {
    return Math.min(
      100,
      Math.floor((event.bytesDownloaded / event.bytesTotal) * 100)
    );
  }
  if (event.state === "verifying" || event.state === "ready") return 100;
  return 0;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
