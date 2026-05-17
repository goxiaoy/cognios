import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Lock, Mic2, Pause, Play, Square } from "lucide-react";
import type { VoiceNote } from "../../../lib/contracts/voiceNote";

export type VoiceNoteRecordingPhase =
  | "preparing"
  | "recording"
  | "paused"
  | "stopping"
  | "transcribing"
  | "complete"
  | "failed";

export interface VoiceNotePreviewSession {
  note: VoiceNote;
  elapsedMs: number;
  phase: VoiceNoteRecordingPhase;
  error: string | null;
  transcript?: string | null;
  onTogglePause(): void;
  onStop(): void;
}

export interface VoiceNotePlaybackState {
  currentMs: number;
  durationMs: number;
  isPlaying: boolean;
}

export function VoiceNoteRecordingPreview({
  session,
}: {
  session: VoiceNotePreviewSession;
}) {
  const isPaused = session.phase === "paused";
  const canPause = session.phase === "recording" || session.phase === "paused";
  const canStop = session.phase === "recording" || session.phase === "paused";
  const showPlayback = isPlaybackPhase(session.phase);
  const audioUrl = showPlayback ? sourceAudioUrl(session.note.sourceAudioPath) : null;
  const title = session.note.name || "Voice Note";
  const liveTranscript = session.transcript?.trim() ?? "";

  return (
    <section className="voice-recording-preview" aria-label="Voice note recording">
      <header className="voice-recording-hero">
        <div className="voice-recording-title-row">
          <Mic2 size={22} aria-hidden="true" />
          <div>
            <p>Voice Note</p>
            <h2>{title}</h2>
          </div>
        </div>
        <div className="voice-recording-local-banner">
          <Lock size={17} aria-hidden="true" />
          <p>Audio is saved locally on this device.</p>
        </div>
      </header>

      {showPlayback ? (
        <div
          className="voice-recording-controls voice-recording-controls--playback"
          aria-label="Source audio playback"
        >
          {audioUrl ? (
            <SourceAudioPlayer
              durationMs={session.elapsedMs}
              src={audioUrl}
            />
          ) : (
            <>
              <time>{formatElapsed(session.elapsedMs)}</time>
              <p className="voice-recording-audio-unavailable">
                {session.phase === "failed"
                  ? "Source audio was not captured."
                  : "Source audio is still being saved."}
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="voice-recording-controls" aria-label="Recording controls">
          <time>{formatElapsed(session.elapsedMs)}</time>
          <Waveform paused={isPaused || session.phase !== "recording"} />
          <button
            className="voice-recording-icon-button"
            disabled={!canPause}
            onClick={session.onTogglePause}
            type="button"
            aria-label={isPaused ? "Resume recording" : "Pause recording"}
          >
            {isPaused ? <Play size={18} aria-hidden="true" /> : <Pause size={18} aria-hidden="true" />}
          </button>
          <button
            className="voice-recording-stop-button"
            disabled={!canStop}
            onClick={session.onStop}
            type="button"
            aria-label="Stop recording"
          >
            <Square size={15} aria-hidden="true" />
          </button>
        </div>
      )}

      <section className="voice-recording-transcript" aria-label="Voice note status">
        <div>
          <p>{transcriptStatus(session.phase)}</p>
          <span className={`voice-recording-dot voice-recording-dot--${dotTone(session.phase)}`} />
        </div>
        {session.error ? <p className="voice-recording-error">{session.error}</p> : null}
        <div className="voice-recording-transcript-body">
          {liveTranscript ? (
            <pre className="voice-recording-live-transcript">{liveTranscript}</pre>
          ) : (
            <>
              {session.phase === "recording" || session.phase === "paused" ? (
                <p>Recording microphone audio locally. Transcript is being written to this voice note.</p>
              ) : null}
              {session.phase === "transcribing" ? (
                <p>Finalizing the saved audio with Qwen ASR.</p>
              ) : null}
              {session.phase === "complete" ? (
                <p>Transcript saved. Source recording remains available above.</p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </section>
  );
}

export function VoiceNoteSourceAudioBar({
  durationMs,
  note,
  onPlaybackChange,
}: {
  durationMs?: number;
  note: VoiceNote;
  onPlaybackChange?(state: VoiceNotePlaybackState): void;
}) {
  const audioUrl = sourceAudioUrl(note.sourceAudioPath);
  return (
    <div
      className="voice-recording-controls voice-recording-controls--playback voice-note-source-audio-bar"
      aria-label="Source audio playback"
    >
      {audioUrl ? (
        <SourceAudioPlayer
          durationMs={durationMs ?? 0}
          onPlaybackChange={onPlaybackChange}
          src={audioUrl}
        />
      ) : (
        <>
          <time>{formatElapsed(durationMs ?? 0)}</time>
          <p className="voice-recording-audio-unavailable">
            {note.sourceAudioDeletedAt
              ? "Source audio has been deleted."
              : "Source audio unavailable."}
          </p>
        </>
      )}
    </div>
  );
}

function SourceAudioPlayer({
  durationMs,
  onPlaybackChange,
  src,
}: {
  durationMs: number;
  onPlaybackChange?(state: VoiceNotePlaybackState): void;
  src: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const fallbackDurationSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(fallbackDurationSeconds);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasPlaybackError, setHasPlaybackError] = useState(false);

  useEffect(() => {
    setCurrentSeconds(0);
    setDurationSeconds(fallbackDurationSeconds);
    setIsPlaying(false);
    setHasPlaybackError(false);
  }, [fallbackDurationSeconds, src]);

  useEffect(() => {
    onPlaybackChange?.({
      currentMs: Math.round(currentSeconds * 1_000),
      durationMs: Math.round(durationSeconds * 1_000),
      isPlaying,
    });
  }, [currentSeconds, durationSeconds, isPlaying, onPlaybackChange]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const activeAudio: HTMLAudioElement = audio;

    function syncDuration() {
      setDurationSeconds(readAudioDuration(activeAudio, fallbackDurationSeconds));
    }

    function syncCurrentTime() {
      setCurrentSeconds(activeAudio.currentTime);
    }

    function markPlaying() {
      setIsPlaying(true);
    }

    function markPaused() {
      setIsPlaying(false);
    }

    function markError() {
      setHasPlaybackError(true);
      setIsPlaying(false);
    }

    activeAudio.addEventListener("loadedmetadata", syncDuration);
    activeAudio.addEventListener("durationchange", syncDuration);
    activeAudio.addEventListener("timeupdate", syncCurrentTime);
    activeAudio.addEventListener("play", markPlaying);
    activeAudio.addEventListener("pause", markPaused);
    activeAudio.addEventListener("ended", markPaused);
    activeAudio.addEventListener("error", markError);

    return () => {
      activeAudio.removeEventListener("loadedmetadata", syncDuration);
      activeAudio.removeEventListener("durationchange", syncDuration);
      activeAudio.removeEventListener("timeupdate", syncCurrentTime);
      activeAudio.removeEventListener("play", markPlaying);
      activeAudio.removeEventListener("pause", markPaused);
      activeAudio.removeEventListener("ended", markPaused);
      activeAudio.removeEventListener("error", markError);
    };
  }, [fallbackDurationSeconds, src]);

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || hasPlaybackError) return;
    if (audio.paused) {
      void audio.play().catch(() => {
        setHasPlaybackError(true);
        setIsPlaying(false);
      });
    } else {
      audio.pause();
    }
  }

  function handleSeek(value: string) {
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    setCurrentSeconds(next);
    if (audioRef.current) {
      audioRef.current.currentTime = next;
    }
  }

  return (
    <>
      <time>{formatElapsed(durationSeconds * 1_000)}</time>
      <button
        aria-label={isPlaying ? "Pause source audio" : "Play source audio"}
        className="voice-recording-icon-button"
        disabled={hasPlaybackError}
        onClick={togglePlayback}
        type="button"
      >
        {isPlaying ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
      </button>
      <div className="voice-recording-playback-track">
        {hasPlaybackError ? (
          <p className="voice-recording-audio-unavailable">Audio unavailable</p>
        ) : (
          <input
            aria-label="Playback position"
            max={Math.max(durationSeconds, 1)}
            min="0"
            onChange={(event) => handleSeek(event.currentTarget.value)}
            step="0.1"
            type="range"
            value={Math.min(currentSeconds, Math.max(durationSeconds, 1))}
          />
        )}
      </div>
      <time className="voice-recording-playback-position">
        {formatElapsed(currentSeconds * 1_000)}
      </time>
      <audio
        aria-hidden="true"
        className="voice-recording-audio-native"
        preload="metadata"
        ref={audioRef}
        src={src}
      />
    </>
  );
}

function readAudioDuration(
  audio: HTMLAudioElement,
  fallbackDurationSeconds: number
): number {
  return Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : fallbackDurationSeconds;
}

function Waveform({ paused }: { paused: boolean }) {
  return (
    <div className={`voice-recording-waveform${paused ? " is-paused" : ""}`} aria-hidden="true">
      {Array.from({ length: 18 }).map((_, index) => (
        <span key={index} style={{ animationDelay: `${index * 54}ms` }} />
      ))}
    </div>
  );
}

function transcriptStatus(phase: VoiceNoteRecordingPhase): string {
  if (phase === "paused") return "Paused";
  if (phase === "stopping") return "Saving recording...";
  if (phase === "transcribing") return "Transcribing...";
  if (phase === "complete") return "Transcript saved";
  if (phase === "failed") return "Recording failed";
  if (phase === "preparing") return "Preparing recorder...";
  return "Recording";
}

function dotTone(phase: VoiceNoteRecordingPhase): "live" | "idle" | "error" {
  if (phase === "failed") return "error";
  if (phase === "paused" || phase === "complete") return "idle";
  return "live";
}

function isPlaybackPhase(phase: VoiceNoteRecordingPhase): boolean {
  return phase === "transcribing" || phase === "complete" || phase === "failed";
}

function sourceAudioUrl(filePath?: string | null): string | null {
  if (!filePath) return null;
  try {
    return convertFileSrc(filePath);
  } catch {
    return filePath;
  }
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
