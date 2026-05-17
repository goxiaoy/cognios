import {
  appendVoiceNoteAudioChunk,
  beginVoiceNoteAudioCapture,
  beginNativeVoiceNoteAudioCapture,
  completeVoiceNoteTranscript,
  createVoiceNote,
  deleteVoiceNoteSourceAudio,
  finishVoiceNoteAudioCapture,
  finishNativeVoiceNoteAudioCapture,
  getVoiceNote,
  getVoiceNoteCaptureCapability,
  getVoiceNoteTranscript,
  listVoiceNotes,
  pauseNativeVoiceNoteAudioCapture,
  renameVoiceNoteSpeaker,
  resumeNativeVoiceNoteAudioCapture,
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
  getTranscript(noteId: string): Promise<string>;
  completeTranscript(input: CompleteVoiceNoteTranscriptInput): Promise<VoiceNote>;
  beginAudioCapture(input: BeginVoiceNoteAudioCaptureInput): Promise<VoiceNote>;
  appendAudioChunk(input: AppendVoiceNoteAudioChunkInput): Promise<void>;
  finishAudioCapture(input: FinishVoiceNoteAudioCaptureInput): Promise<VoiceNote>;
  beginNativeAudioCapture(input: BeginVoiceNoteAudioCaptureInput): Promise<VoiceNote>;
  finishNativeAudioCapture(input: FinishVoiceNoteAudioCaptureInput): Promise<VoiceNote>;
  pauseNativeAudioCapture(noteId: string): Promise<void>;
  resumeNativeAudioCapture(noteId: string): Promise<void>;
  renameSpeaker(input: RenameVoiceNoteSpeakerInput): Promise<VoiceNote>;
  deleteSourceAudio(noteId: string): Promise<VoiceNote>;
}

export const voiceNoteClient: VoiceNoteClient = {
  captureCapability: getVoiceNoteCaptureCapability,
  create: createVoiceNote,
  list: listVoiceNotes,
  get: getVoiceNote,
  getTranscript: getVoiceNoteTranscript,
  completeTranscript: completeVoiceNoteTranscript,
  beginAudioCapture: beginVoiceNoteAudioCapture,
  appendAudioChunk: appendVoiceNoteAudioChunk,
  finishAudioCapture: finishVoiceNoteAudioCapture,
  beginNativeAudioCapture: beginNativeVoiceNoteAudioCapture,
  finishNativeAudioCapture: finishNativeVoiceNoteAudioCapture,
  pauseNativeAudioCapture: pauseNativeVoiceNoteAudioCapture,
  resumeNativeAudioCapture: resumeNativeVoiceNoteAudioCapture,
  renameSpeaker: renameVoiceNoteSpeaker,
  deleteSourceAudio: deleteVoiceNoteSourceAudio,
};
