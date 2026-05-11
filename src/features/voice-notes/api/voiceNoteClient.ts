import {
  appendVoiceNoteAudioChunk,
  beginVoiceNoteAudioCapture,
  completeVoiceNoteTranscript,
  createVoiceNote,
  deleteVoiceNoteSourceAudio,
  finishVoiceNoteAudioCapture,
  getVoiceNote,
  getVoiceNoteCaptureCapability,
  listVoiceNotes,
  renameVoiceNoteSpeaker,
} from "../../../lib/tauri/ipc";
import type {
  AppendVoiceNoteAudioChunkInput,
  BeginVoiceNoteAudioCaptureInput,
  CaptureCapability,
  CompleteVoiceNoteTranscriptInput,
  CreatedVoiceNote,
  CreateVoiceNoteInput,
  FinishVoiceNoteAudioCaptureInput,
  RenameVoiceNoteSpeakerInput,
  VoiceNote,
} from "../../../lib/contracts/voiceNote";

export interface VoiceNoteClient {
  captureCapability(): Promise<CaptureCapability>;
  create(input?: CreateVoiceNoteInput): Promise<CreatedVoiceNote>;
  list(): Promise<VoiceNote[]>;
  get(noteId: string): Promise<VoiceNote | null>;
  completeTranscript(input: CompleteVoiceNoteTranscriptInput): Promise<VoiceNote>;
  beginAudioCapture(input: BeginVoiceNoteAudioCaptureInput): Promise<VoiceNote>;
  appendAudioChunk(input: AppendVoiceNoteAudioChunkInput): Promise<void>;
  finishAudioCapture(input: FinishVoiceNoteAudioCaptureInput): Promise<VoiceNote>;
  renameSpeaker(input: RenameVoiceNoteSpeakerInput): Promise<VoiceNote>;
  deleteSourceAudio(noteId: string): Promise<VoiceNote>;
}

export const voiceNoteClient: VoiceNoteClient = {
  captureCapability: getVoiceNoteCaptureCapability,
  create: createVoiceNote,
  list: listVoiceNotes,
  get: getVoiceNote,
  completeTranscript: completeVoiceNoteTranscript,
  beginAudioCapture: beginVoiceNoteAudioCapture,
  appendAudioChunk: appendVoiceNoteAudioChunk,
  finishAudioCapture: finishVoiceNoteAudioCapture,
  renameSpeaker: renameVoiceNoteSpeaker,
  deleteSourceAudio: deleteVoiceNoteSourceAudio,
};
