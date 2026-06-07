import type { SidecarEnvelope } from "./search";

export type RealtimeVoiceRuntimeStatus =
  | "unavailable"
  | "installing"
  | "starting"
  | "ready"
  | "degraded"
  | "failed"
  | "stopped";

export interface RealtimeVoiceStatus {
  status: RealtimeVoiceRuntimeStatus | string;
  available: boolean;
  local: boolean;
  provider: string;
  reason: string;
  packaging: "missing" | "supported" | "disabled" | string;
  runtimePath?: string | null;
  websocketUrl?: string | null;
  model?: string | null;
}

export interface RealtimeVoiceCaptionEvent {
  kind: "provisional_caption";
  sessionId: string;
  utteranceId: string;
  text: string;
  sequence: number;
  revision: number;
  startMs: number;
  endMs?: number | null;
  persisted?: boolean;
}

export interface RealtimeVoiceUtteranceEvent {
  kind: "final_utterance";
  sessionId: string;
  utteranceId: string;
  text: string;
  sequence: number;
  revision: number;
  startMs: number;
  endMs?: number | null;
  persisted?: boolean;
}

export type RealtimeVoiceEvent =
  | RealtimeVoiceCaptionEvent
  | RealtimeVoiceUtteranceEvent;

export interface GetRealtimeVoiceStatusResult {
  status: SidecarEnvelope<RealtimeVoiceStatus>;
}
