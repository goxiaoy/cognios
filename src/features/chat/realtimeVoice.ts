import type {
  RealtimeVoiceEvent,
  RealtimeVoiceStatus,
} from "../../lib/contracts/realtimeVoice";

export function chatQueryFromRealtimeVoiceEvent(
  event: RealtimeVoiceEvent
): string | null {
  if (event.persisted) return null;
  if (event.kind !== "final_utterance") return null;
  const text = event.text.trim();
  return text || null;
}

export function realtimeVoiceUnavailableReason(
  status: RealtimeVoiceStatus | null
): string {
  if (!status) return "Checking local realtime voice...";
  if (status.available && status.status === "ready") return "Realtime voice ready";
  return status.reason || "Local realtime voice is unavailable.";
}
