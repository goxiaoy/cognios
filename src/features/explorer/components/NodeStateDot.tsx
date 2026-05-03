import type { NodeKind, NodeState } from "../../../lib/contracts/vfs";

const CONTAINER_KINDS: ReadonlyArray<NodeKind> = [
  "folder",
  "directory",
  "mount",
];

type Tone =
  | "indexed"
  | "pending"
  | "error"
  | "unsupported"
  | null;

/**
 * Resolve a node's index/availability state into a presentation
 * tone. Returns ``null`` for the unremarkable cases (clean container
 * folder) so the row stays visually quiet — only states that are
 * interesting to the user get a colored dot.
 *
 * For files we collapse the backend's ``ready`` (discovered by
 * mount scan, not yet enqueued) into the ``pending`` tone — from
 * the user's POV both are "this exists, the indexer hasn't gotten
 * to it yet". Surfacing two different tones for the same outward
 * meaning would be noise.
 */
export function resolveNodeStateTone(
  kind: NodeKind,
  state: NodeState
): Tone {
  if (state === "indexed") return "indexed";
  if (state === "error" || state === "unavailable") return "error";
  if (state === "pending" || state === "indexing") return "pending";
  if (state === "ready") {
    // Container kinds (folder/mount/directory) only carry filesystem
    // availability — they aren't indexable units themselves, so a
    // bare "ready" stays silent. Files/notes/urls in ``ready`` are
    // discovered-but-not-yet-indexed; show them as pending.
    if (CONTAINER_KINDS.includes(kind)) return null;
    return "pending";
  }
  // Anything outside the documented vocabulary surfaces as a
  // neutral "unsupported" hint — better than a silent no-op.
  return "unsupported";
}

const TONE_LABEL: Record<Exclude<Tone, null>, string> = {
  indexed: "Indexed",
  pending: "Pending",
  error: "Error",
  unsupported: "Not indexable",
};

/**
 * Static colored dot used in the tree row + inspector to signal a
 * node's index state. Replaces the pre-Unit-13 spinning Loader and
 * AlertTriangle icons. The dot is purely decorative; the
 * accompanying ``aria-label`` provides the textual state for
 * screen readers.
 */
export function NodeStateDot({
  kind,
  state,
  withLabel = false,
  className,
}: {
  kind: NodeKind;
  state: NodeState;
  /** When true, render the human-readable label after the dot
   * (used in the inspector pane). The tree row uses dot-only. */
  withLabel?: boolean;
  className?: string;
}) {
  const tone = resolveNodeStateTone(kind, state);
  if (!tone) return null;
  const label = TONE_LABEL[tone];
  const cls = `node-state-dot is-${tone}${className ? ` ${className}` : ""}`;
  if (withLabel) {
    return (
      <span className={`node-state-pill is-${tone}`} aria-label={label}>
        <span className={cls} aria-hidden="true" />
        {label}
      </span>
    );
  }
  return <span className={cls} role="img" aria-label={label} title={label} />;
}
