import type { ExplorerSnapshot } from "./vfs";

export type VoiceNoteStatus =
  | "pending_audio"
  | "recording"
  | "transcribing"
  | "speaker_processing"
  | "indexing"
  | "completed"
  | "failed";

export type VoiceNoteCaptureStatus =
  | "unsupported"
  | "pending"
  | "recording"
  | "completed"
  | "failed";

export type VoiceNoteTranscriptionStatus =
  | "pending"
  | "transcribing"
  | "completed"
  | "failed"
  | "unavailable";

export type VoiceNoteSummaryStatus =
  | "unavailable"
  | "pending"
  | "ready"
  | "failed";

export interface VoiceNote {
  noteId: string;
  name: string;
  status: VoiceNoteStatus;
  captureStatus: VoiceNoteCaptureStatus;
  transcriptionStatus: VoiceNoteTranscriptionStatus;
  summaryStatus: VoiceNoteSummaryStatus;
  sourceAudioPresent: boolean;
  sourceAudioPath?: string | null;
  sourceAudioDeletedAt?: string | null;
  transcriptPath?: string | null;
  transcriptUpdatedAt?: string | null;
  speakerLabels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureCapability {
  manualAudioRecording: boolean;
  systemAudioRecording: boolean;
  automaticDetection: boolean;
  reason: string;
}

export interface CreateVoiceNoteInput {
  parentId?: string | null;
}

export interface CreatedVoiceNote {
  voiceNote: VoiceNote;
  snapshot: ExplorerSnapshot;
}

export interface CompleteVoiceNoteTranscriptInput {
  noteId: string;
  transcript: string;
  summary?: string | null;
  actionItems?: string[];
  speakerLabels?: Record<string, string>;
}

export interface BeginVoiceNoteAudioCaptureInput {
  noteId: string;
  mimeType?: string | null;
  fileExtension?: string | null;
}

export interface AppendVoiceNoteAudioChunkInput {
  noteId: string;
  bytes: number[];
}

export interface AppendRealtimeVoiceNoteTranscriptInput {
  noteId: string;
  transcript: string;
  startMs?: number | null;
  durationMs?: number | null;
}

export interface FinishVoiceNoteAudioCaptureInput {
  noteId: string;
  durationMs?: number | null;
}

export interface RenameVoiceNoteSpeakerInput {
  noteId: string;
  speakerId: string;
  label: string;
}
