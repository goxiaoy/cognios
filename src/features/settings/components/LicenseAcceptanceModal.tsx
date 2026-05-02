import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import type { SearchClient } from "../../search/types/search";

/**
 * Modal that walks the user through the Gemma TOS acceptance + HF
 * token entry flow. Closing options:
 *
 * - **Cancel** — clicks the close button or backdrop. The role
 *   stays unaccepted.
 * - **Accept** — saves the HF token to the OS keychain (via
 *   ``setHfToken``) and posts ``acceptModelLicense`` to the
 *   sidecar. Both must succeed for the modal to dismiss; partial
 *   failure leaves the modal open with an error message so the
 *   user can correct.
 *
 * The token field is a password input — the visible characters are
 * masked, the field never auto-fills, and the value is sent to the
 * Tauri command directly (never persisted to localStorage or any
 * other renderer-side store).
 */
export function LicenseAcceptanceModal({
  role,
  client,
  onAccepted,
  onCancel,
  setHfToken,
}: {
  role: string;
  client: SearchClient;
  onAccepted(): void;
  onCancel(): void;
  /** Injectable so tests don't have to mock @tauri-apps/api/core. */
  setHfToken: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleAccept() {
    const trimmed = token.trim();
    if (!trimmed) {
      setError("HuggingFace token is required for the Gemma download.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setHfToken(trimmed);
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "Failed to save token."
      );
      return;
    }
    try {
      const env = await client.acceptModelLicense(role);
      if (env.state !== "ready") {
        setBusy(false);
        setError(env.error ?? "License acceptance failed.");
        return;
      }
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "License acceptance failed."
      );
      return;
    }
    setBusy(false);
    onAccepted();
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="license-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="license-modal-title"
      >
        <header className="license-modal-header">
          <h2 id="license-modal-title" className="license-modal-title">
            Accept Gemma license
          </h2>
          <button
            type="button"
            className="license-modal-close"
            aria-label="Cancel"
            onClick={onCancel}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="license-modal-body">
          <p>
            Google Gemma is licensed under the{" "}
            <a
              href="https://ai.google.dev/gemma/terms"
              target="_blank"
              rel="noreferrer noopener"
            >
              Gemma Terms of Use
            </a>
            . By accepting you agree to those terms; CogniOS will then
            download the multimodal model from HuggingFace.
          </p>
          <p className="muted-copy">
            Gemma's HuggingFace repo is gated. After accepting the
            terms on{" "}
            <a
              href="https://huggingface.co/google/gemma-3n-E2B-it"
              target="_blank"
              rel="noreferrer noopener"
            >
              huggingface.co
            </a>
            , paste your{" "}
            <a
              href="https://huggingface.co/settings/tokens"
              target="_blank"
              rel="noreferrer noopener"
            >
              HuggingFace access token
            </a>{" "}
            below. The token is stored in your OS keychain and never
            leaves this machine.
          </p>

          <label className="license-modal-field">
            <span className="license-modal-field-label">
              HuggingFace token
            </span>
            <input
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="license-modal-input"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleAccept();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancel();
                }
              }}
              placeholder="hf_xxxxxxxxxxxxxxxxxxxx"
            />
          </label>

          {error ? (
            <p className="license-modal-error" role="status">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="license-modal-footer">
          <button
            type="button"
            className="license-modal-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="license-modal-primary"
            onClick={() => void handleAccept()}
            disabled={busy}
          >
            {busy ? "Saving…" : "Accept and save token"}
          </button>
        </footer>
      </div>
    </div>
  );
}
