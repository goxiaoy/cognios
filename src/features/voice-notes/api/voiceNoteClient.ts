import {
  completeVoiceNoteTranscript,
  createVoiceNote,
  deleteVoiceNoteSourceAudio,
  getVoiceNote,
  getVoiceNoteCaptureCapability,
  listVoiceNotes,
  renameVoiceNoteSpeaker,
} from "../../../lib/tauri/ipc";
import type {
  CaptureCapability,
  CompleteVoiceNoteTranscriptInput,
  CreatedVoiceNote,
  CreateVoiceNoteInput,
  RenameVoiceNoteSpeakerInput,
  VoiceNote,
} from "../../../lib/contracts/voiceNote";

export interface VoiceNoteClient {
  captureCapability(): Promise<CaptureCapability>;
  create(input?: CreateVoiceNoteInput): Promise<CreatedVoiceNote>;
  list(): Promise<VoiceNote[]>;
  get(noteId: string): Promise<VoiceNote | null>;
  completeTranscript(input: CompleteVoiceNoteTranscriptInput): Promise<VoiceNote>;
  renameSpeaker(input: RenameVoiceNoteSpeakerInput): Promise<VoiceNote>;
  deleteSourceAudio(noteId: string): Promise<VoiceNote>;
}

export const voiceNoteClient: VoiceNoteClient = {
  captureCapability: getVoiceNoteCaptureCapability,
  create: createVoiceNote,
  list: listVoiceNotes,
  get: getVoiceNote,
  completeTranscript: completeVoiceNoteTranscript,
  renameSpeaker: renameVoiceNoteSpeaker,
  deleteSourceAudio: deleteVoiceNoteSourceAudio,
};
