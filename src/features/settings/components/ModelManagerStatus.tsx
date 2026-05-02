import { useState } from "react";
import type {
  ModelDownloadEvent,
  ModelRoleStatus,
  ModelsStatus,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import type { ProgressByRole } from "../hooks/useModelDownloadProgress";

const ROLE_LABELS: Record<string, string> = {
  embedding: "Embedding",
  reranker: "Reranker",
  ocr: "OCR",
  captioner: "Captioner",
};

const STATE_LABELS: Record<string, string> = {
  ready: "Ready",
  missing: "Not downloaded",
  downloading: "Downloading",
  verifying: "Verifying",
  error: "Error",
};

const STATE_TONES: Record<string, string> = {
  ready: "is-ready",
  missing: "is-missing",
  downloading: "is-pending",
  verifying: "is-pending",
  error: "is-error",
};

type ActionState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "error"; message: string };

export function ModelManagerStatus({
  envelope,
  client,
  progress,
}: {
  envelope: SidecarEnvelope<ModelsStatus> | null;
  /** When provided, action buttons (Accept license / Download) render
   * and dispatch through this client. Test harnesses without an
   * action surface omit this prop. */
  client?: SearchClient;
  /** Live download progress keyed on role, supplied by
   * :func:`useModelDownloadProgress`. */
  progress?: ProgressByRole;
}) {
  if (envelope === null) {
    return (
      <div className="settings-card">
        <h2 className="settings-card-title">Models</h2>
        <p className="muted-copy">Loading…</p>
      </div>
    );
  }

  if (envelope.state !== "ready" || !envelope.data) {
    const message =
      envelope.state === "initialising"
        ? "Search subsystem is starting up…"
        : envelope.error ?? "Unable to reach the search subsystem.";
    return (
      <div className="settings-card">
        <h2 className="settings-card-title">Models</h2>
        <p className="muted-copy">{message}</p>
      </div>
    );
  }

  const roles = Object.values(envelope.data.roles);
  if (roles.length === 0) {
    return (
      <div className="settings-card">
        <h2 className="settings-card-title">Models</h2>
        <p className="muted-copy">No model roles configured.</p>
      </div>
    );
  }

  return (
    <div className="settings-card">
      <h2 className="settings-card-title">Models</h2>
      <ul className="settings-role-list">
        {roles.map((role) => (
          <ModelRoleRow
            key={role.role}
            role={role}
            client={client}
            progress={progress?.[role.role]}
          />
        ))}
      </ul>
    </div>
  );
}

function ModelRoleRow({
  role,
  client,
  progress,
}: {
  role: ModelRoleStatus;
  client?: SearchClient;
  progress?: ModelDownloadEvent;
}) {
  const tone = STATE_TONES[role.state] ?? "is-pending";
  const liveState = progress?.state;
  const isLiveDownloading =
    liveState === "downloading" || liveState === "verifying";
  return (
    <li className="settings-role-row">
      <div className="settings-role-meta">
        <span className="settings-role-name">
          {ROLE_LABELS[role.role] ?? role.role}
        </span>
        {role.commit ? (
          <span className="settings-role-commit" title={role.commit}>
            commit {role.commit.slice(0, 8)}
          </span>
        ) : null}
      </div>
      <div className="settings-role-status">
        <span className={`settings-role-state ${tone}`}>
          {STATE_LABELS[role.state] ?? role.state}
        </span>
        {role.requiresAcceptance ? (
          <span className="settings-role-license">
            {role.licenseAccepted ? "License accepted" : "License pending"}
          </span>
        ) : null}
        {role.error ? (
          <span className="settings-role-error" title={role.error}>
            {truncate(role.error, 80)}
          </span>
        ) : null}
      </div>
      {client ? (
        <ModelRoleActions role={role} client={client} progress={progress} />
      ) : null}
      {isLiveDownloading ? <DownloadProgressBar progress={progress!} /> : null}
    </li>
  );
}

function ModelRoleActions({
  role,
  client,
  progress,
}: {
  role: ModelRoleStatus;
  client: SearchClient;
  progress?: ModelDownloadEvent;
}) {
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

  const liveState = progress?.state;
  const liveError = progress?.error;
  const isLiveDownloading =
    liveState === "downloading" || liveState === "verifying";

  // Acceptance gate: a role that requires license acceptance must
  // be accepted before download is offered.
  const needsLicense = role.requiresAcceptance && !role.licenseAccepted;
  const canDownload =
    role.state === "missing" && !needsLicense && !isLiveDownloading;

  async function handleAccept() {
    setAction({ kind: "starting" });
    try {
      const env = await client.acceptModelLicense(role.role);
      if (env.state !== "ready") {
        setAction({
          kind: "error",
          message: env.error ?? "License acceptance failed.",
        });
        return;
      }
      setAction({ kind: "idle" });
    } catch (err) {
      setAction({
        kind: "error",
        message: err instanceof Error ? err.message : "License acceptance failed.",
      });
    }
  }

  async function handleDownload() {
    setAction({ kind: "starting" });
    try {
      await client.startModelDownload({ role: role.role });
      setAction({ kind: "idle" });
    } catch (err) {
      setAction({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Download failed to start.",
      });
    }
  }

  return (
    <div className="settings-role-actions">
      {needsLicense ? (
        <button
          type="button"
          className="settings-action"
          disabled={action.kind === "starting"}
          onClick={() => void handleAccept()}
        >
          {action.kind === "starting" ? "Accepting…" : "Accept license"}
        </button>
      ) : null}
      {canDownload ? (
        <button
          type="button"
          className="settings-action"
          disabled={action.kind === "starting"}
          onClick={() => void handleDownload()}
        >
          {action.kind === "starting" ? "Starting…" : "Download"}
        </button>
      ) : null}
      {role.state === "error" ? (
        <button
          type="button"
          className="settings-action"
          disabled={action.kind === "starting" || isLiveDownloading}
          onClick={() => void handleDownload()}
        >
          Retry
        </button>
      ) : null}
      {action.kind === "error" ? (
        <span className="settings-role-error" role="status">
          {action.message}
        </span>
      ) : null}
      {liveError ? (
        <span className="settings-role-error" role="status">
          {liveError}
        </span>
      ) : null}
    </div>
  );
}

function DownloadProgressBar({ progress }: { progress: ModelDownloadEvent }) {
  const { bytesDownloaded, bytesTotal, file, state } = progress;
  const known = bytesTotal && bytesTotal > 0;
  const percent = known
    ? Math.min(100, Math.round((bytesDownloaded / (bytesTotal as number)) * 100))
    : null;
  return (
    <div className="settings-role-progress" role="progressbar"
      aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-label={file ? `Downloading ${file}` : "Downloading"}
    >
      <div className="settings-role-progress-track">
        {percent !== null ? (
          <div
            className="settings-role-progress-fill"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="settings-role-progress-fill is-indeterminate" />
        )}
      </div>
      <span className="settings-role-progress-meta">
        {state === "verifying" ? "Verifying…" : null}
        {state === "downloading" && percent !== null ? `${percent}%` : null}
        {state === "downloading" && percent === null ? "Connecting…" : null}
        {file ? <span className="settings-role-progress-file">{file}</span> : null}
      </span>
    </div>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}
