import { useState } from "react";

import type { SearchSettings } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";

const READY_POLL_INTERVAL_MS = 250;
const READY_POLL_TIMEOUT_MS = 10_000;

/**
 * Modal-style confirmation rendered inline in SettingsLayout when
 * the user clicks "Restart sidecar to apply". Provider swaps that
 * affect the dispatcher require a restart in v1; this surface
 * makes the restart explicit (rather than auto-restart) so the
 * user knows search is briefly unavailable.
 *
 * After issuing the restart, polls ``client.settings()`` until the
 * envelope returns ``ready`` (or the timeout elapses) — without
 * the wait, the parent's post-close re-fetch races the new
 * sidecar's boot, gets ``initialising``, and silently keeps the
 * pre-restart state (with the stale ``needsRestart=true`` flag)
 * which leaves the "Restart sidecar" banner on screen forever.
 */
export function RestartConfirmation({
  client,
  onClose,
  onRestarted,
}: {
  client: SearchClient;
  onClose: () => void;
  /** Called with the fresh post-restart settings once the new
   * sidecar reports ``ready``. Bypassing the parent's separate
   * re-fetch is what guarantees the banner clears. */
  onRestarted?: (settings: SearchSettings) => void;
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
      // Poll until the new sidecar comes up and returns a ready
      // settings envelope.
      const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
      let fresh: SearchSettings | null = null;
      while (Date.now() < deadline) {
        const env = await client.settings();
        if (env.state === "ready" && env.data) {
          fresh = env.data;
          break;
        }
        await sleep(READY_POLL_INTERVAL_MS);
      }
      if (fresh) {
        onRestarted?.(fresh);
        onClose();
      } else {
        setState({
          kind: "error",
          message:
            "Restart issued but the search subsystem hasn't come back online yet. Try again in a moment.",
        });
      }
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="confirm-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="confirm-dialog">
        <h2 className="confirm-dialog-title">Restart sidecar to apply</h2>
        <p className="muted-copy">
          Your search subsystem will restart and reload settings. This
          takes a few seconds; search will be briefly unavailable.
        </p>
        {state.kind === "error" ? (
          <p className="settings-role-error" role="alert">
            Restart failed: {state.message}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
