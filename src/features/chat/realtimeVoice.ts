import type { RealtimeVoiceStatus } from "../../lib/contracts/realtimeVoice";

export function realtimeVoiceUnavailableReason(
  status: RealtimeVoiceStatus | null
): string {
  if (!status) return "Checking local realtime voice...";
  if (status.available && status.status === "ready") return "Realtime voice ready";
  return status.reason || "Local realtime voice is unavailable.";
}
