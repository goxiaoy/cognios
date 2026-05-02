import type { ProviderPreset } from "../data/providerPresets";

/**
 * One-shot per-provider consent dialog. Triggered the first time a
 * user binds *any* feature to a cloud provider (or adds a cloud
 * provider via the Providers section). Once the user accepts, the
 * provider id is added to ``settings.cloudConsentAcked`` and the
 * dialog never appears again for that provider — even after the user
 * removes and re-adds it.
 *
 * The brainstorm review flagged this as the highest-impact privacy
 * gap; this dialog is the in-product control informing users that
 * indexed content leaves their machine when a cloud provider is
 * active.
 */
export function CloudEgressConsentDialog({
  preset,
  onAccept,
  onCancel,
}: {
  preset: ProviderPreset;
  onAccept: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="settings-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-dialog-title"
    >
      <div className="settings-modal">
        <h2 className="settings-modal-title" id="consent-dialog-title">
          Send data to {preset.displayName}?
        </h2>
        <p className="muted-copy">
          Enabling {preset.displayName} means content from your
          workspace — text, images, and other indexed material — will
          be sent to {preset.displayName}'s servers when this feature
          is active. This data leaves your machine.
        </p>
        <p className="muted-copy">
          You can revoke this provider at any time in Settings →
          Providers.
        </p>
        <div className="settings-modal-actions">
          <button
            type="button"
            className="settings-action"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="settings-action is-primary"
            onClick={onAccept}
          >
            I understand, enable {preset.displayName}
          </button>
        </div>
      </div>
    </div>
  );
}
