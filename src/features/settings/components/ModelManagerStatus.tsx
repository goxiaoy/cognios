import type {
  ModelRoleStatus,
  SidecarEnvelope,
  ModelsStatus,
} from "../../../lib/contracts/search";

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

export function ModelManagerStatus({
  envelope,
}: {
  envelope: SidecarEnvelope<ModelsStatus> | null;
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
          <ModelRoleRow key={role.role} role={role} />
        ))}
      </ul>
    </div>
  );
}

function ModelRoleRow({ role }: { role: ModelRoleStatus }) {
  const tone = STATE_TONES[role.state] ?? "is-pending";
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
    </li>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}
