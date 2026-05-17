import type { VoiceNote } from "../../lib/contracts/voiceNote";
import type { VoiceNoteClient } from "./api/voiceNoteClient";

export interface VoiceNoteRecording {
  voiceNote: VoiceNote;
  startedAt: number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<VoiceNote>;
}

export async function createVoiceNoteRecorder(
  noteId: string,
  client: VoiceNoteClient
): Promise<VoiceNoteRecording> {
  try {
    return await createNativeVoiceNoteRecorder(noteId, client);
  } catch (err) {
    if (!isNativeAudioCaptureUnavailableError(err)) {
      throw err;
    }
  }

  if (isBrowserAudioCaptureAvailable()) {
    try {
      return await createBrowserVoiceNoteRecorder(noteId, client);
    } catch (err) {
      if (!isBrowserAudioCaptureUnavailableError(err)) {
        throw err;
      }
    }
  }
  return createNativeVoiceNoteRecorder(noteId, client);
}

async function createNativeVoiceNoteRecorder(
  noteId: string,
  client: VoiceNoteClient
): Promise<VoiceNoteRecording> {
  const startedAt = Date.now();
  const started = await client.beginNativeAudioCapture({
    noteId,
    mimeType: "audio/wav",
    fileExtension: "wav",
  });
  return {
    voiceNote: started,
    startedAt,
    pause() {
      return client.pauseNativeAudioCapture(noteId);
    },
    resume() {
      return client.resumeNativeAudioCapture(noteId);
    },
    stop() {
      return client.finishNativeAudioCapture({
        noteId,
        durationMs: Date.now() - startedAt,
      });
    },
  };
}

async function createBrowserVoiceNoteRecorder(
  noteId: string,
  client: VoiceNoteClient
): Promise<VoiceNoteRecording> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Audio recording is not available in this WebView.");
  }
  const stream = await requestVoiceNoteAudioStream();
  const mimeType = preferredAudioMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(
      stream,
      mimeType
        ? {
            mimeType,
          }
        : undefined
    );
  } catch (err) {
    stopMediaStream(stream);
    throw err;
  }
  const startedAt = Date.now();
  let writeQueue = Promise.resolve();
  let writeError: unknown = null;

  let started: VoiceNote;
  try {
    started = await client.beginAudioCapture({
      noteId,
      mimeType: recorder.mimeType || mimeType || null,
      fileExtension: audioExtensionForMimeType(recorder.mimeType || mimeType),
    });
  } catch (err) {
    stopMediaStream(stream);
    throw err;
  }

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0) return;
    writeQueue = writeQueue
      .then(async () => {
        const bytes = Array.from(new Uint8Array(await event.data.arrayBuffer()));
        await client.appendAudioChunk({ noteId, bytes });
      })
      .catch((err) => {
        writeError = err;
        throw err;
      });
    void writeQueue.catch(() => {});
  });

  try {
    recorder.start(1_000);
  } catch (err) {
    stopMediaStream(stream);
    throw err;
  }

  return {
    voiceNote: started,
    startedAt,
    pause() {
      if (recorder.state === "recording") recorder.pause();
      return Promise.resolve();
    },
    resume() {
      if (recorder.state === "paused") recorder.resume();
      return Promise.resolve();
    },
    async stop() {
      try {
        if (recorder.state !== "inactive") {
          const stopped = new Promise<void>((resolve, reject) => {
            recorder.addEventListener("stop", () => resolve(), { once: true });
            recorder.addEventListener(
              "error",
              (event) => reject(mediaRecorderError(event)),
              { once: true }
            );
          });
          recorder.requestData();
          recorder.stop();
          await stopped;
        }
        await writeQueue.catch(() => {});
        if (writeError) {
          throw writeError instanceof Error
            ? writeError
            : new Error(String(writeError));
        }
        return await client.finishAudioCapture({
          noteId,
          durationMs: Date.now() - startedAt,
        });
      } finally {
        stopMediaStream(stream);
      }
    },
  };
}

async function requestVoiceNoteAudioStream(): Promise<MediaStream> {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    throw new Error("Audio capture is not available in this environment.");
  }
  return mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
    video: false,
  });
}

function isBrowserAudioCaptureAvailable(): boolean {
  if (typeof MediaRecorder === "undefined") return false;
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

function isBrowserAudioCaptureUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Audio capture is not available") ||
    message.includes("Audio recording is not available")
  );
}

function isNativeAudioCaptureUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unknown command") ||
    normalized.includes("not implemented") ||
    normalized.includes("not available") ||
    normalized.includes("no default input device") ||
    normalized.includes("no default microphone input device")
  );
}

function preferredAudioMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function audioExtensionForMimeType(mimeType?: string): string {
  const baseType = (mimeType || "").split(";")[0];
  if (baseType === "audio/mp4" || baseType === "audio/aac") return "m4a";
  if (baseType === "audio/ogg") return "ogg";
  if (baseType === "audio/wav" || baseType === "audio/wave") return "wav";
  return "webm";
}

function mediaRecorderError(event: Event): Error {
  const maybeError = event as Event & { error?: { message?: string } };
  return new Error(maybeError.error?.message ?? "Audio recording failed.");
}

function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}
