import { useState } from "react";

import type { SearchClient } from "../../search/types/search";

/**
 * Modal-style confirmation rendered inline in SettingsLayout when
 * the user clicks "Restart sidecar to apply". Provider swaps that
 * affect the dispatcher require a restart in v1; this surface
 * makes the restart explicit (rather than auto-restart) so the
 * user knows search is briefly unavailable.
 */
export function RestartConfirmation({
  client,
  onClose,
}: {
  client: SearchClient;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "restarting" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleConfirm() {
    setState({ kind: "restarting" });
    try {
      await client.restartSidecar();
      // Wait briefly for settings GET to succeed against the new
      // sidecar — confirms the runtime file rendezvous worked.
      await client.settings();
      onClose();
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="settings-modal-backdrop" role="dialog" aria-modal="true">
      <div className="settings-modal">
        <h2 className="settings-modal-title">Restart sidecar to apply</h2>
        <p className="muted-copy">
          Your search subsystem will restart and reload settings. This
          takes a few seconds; search will be briefly unavailable.
        </p>
        {state.kind === "error" ? (
          <p className="settings-role-error" role="alert">
            Restart failed: {state.message}
          </p>
        ) : null}
        <div className="settings-modal-actions">
          <button
            type="button"
            className="settings-action"
            disabled={state.kind === "restarting"}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="settings-action is-primary"
            disabled={state.kind === "restarting"}
            onClick={() => void handleConfirm()}
          >
            {state.kind === "restarting" ? "Reconnecting…" : "Restart"}
          </button>
        </div>
      </div>
    </div>
  );
}
