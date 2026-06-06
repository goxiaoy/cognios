import type { NodeStatusView } from "../../../lib/contracts/nodeStatus";
import type { NodeKind, NodeState } from "../../../lib/contracts/vfs";
import { NodeStateDot } from "./NodeStateDot";

const OVERALL_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  ready: "Ready",
  partial: "Partial",
  failed: "Failed",
  unsupported: "Not indexable",
  idle: "Idle",
};

export function NodeStatusIndicator({
  fallbackKind,
  fallbackState,
  status,
  withLabel = false,
}: {
  fallbackKind: NodeKind;
  fallbackState: NodeState;
  status?: NodeStatusView | null;
  withLabel?: boolean;
}) {
  if (!status || status.stages.length === 0) {
    return (
      <NodeStateDot
        kind={fallbackKind}
        state={fallbackState}
        withLabel={withLabel}
      />
    );
  }

  const tone = toneForOverall(status.overall);
  if (!tone) return null;
  if (!withLabel && tone === "indexed") return null;

  const primary = status.stages.find((stage) => stage.id === status.primaryStageId);
  const label = labelForStatus(status, primary?.label);
  const title = status.stages
    .filter((stage) => !(stage.importance === "optional" && stage.state === "skipped"))
    .map((stage) => {
      const message = stage.error?.message ?? stage.message;
      return message
        ? `${stage.label}: ${stage.state} - ${message}`
        : `${stage.label}: ${stage.state}`;
    })
    .join("\n");

  if (withLabel) {
    return (
      <span className={`node-state-pill is-${tone}`} aria-label={label} title={title}>
        <span className={`node-state-dot is-${tone}`} aria-hidden="true" />
        {label}
      </span>
    );
  }

  return (
    <span
      className={`node-state-dot is-${tone}`}
      role="img"
      aria-label={label}
      title={title || label}
    />
  );
}

export function labelForStatus(status: NodeStatusView, primaryLabel?: string): string {
  const overall = OVERALL_LABEL[status.overall] ?? status.overall;
  if (status.overall === "running" && primaryLabel) return primaryLabel;
  if (status.overall === "queued" && primaryLabel) return `${primaryLabel} queued`;
  if (status.overall === "failed" && primaryLabel) return `${primaryLabel} failed`;
  if (status.overall === "partial") return "Partially ready";
  return overall;
}

function toneForOverall(overall: NodeStatusView["overall"]) {
  if (overall === "ready") return "indexed";
  if (overall === "queued" || overall === "running") return "pending";
  if (overall === "failed") return "error";
  if (overall === "partial") return "partial";
  if (overall === "unsupported") return "unsupported";
  return null;
}
