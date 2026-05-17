use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};

type WavWriter = hound::WavWriter<BufWriter<File>>;
type SharedWavWriter = Arc<Mutex<Option<WavWriter>>>;
type SharedSegmentRecorder = Arc<Mutex<Option<SegmentRecorder>>>;
type SharedSegmentBacklog = Arc<Mutex<HashMap<String, VecDeque<CompletedAudioSegment>>>>;
const MICROPHONE_START_TIMEOUT: Duration = Duration::from_secs(10);
const REALTIME_PREROLL_DURATION: Duration = Duration::from_millis(300);
const REALTIME_VOICE_WINDOW_DURATION: Duration = Duration::from_millis(30);
const REALTIME_VOICE_START_DURATION: Duration = Duration::from_millis(120);
const REALTIME_UTTERANCE_END_SILENCE: Duration = Duration::from_millis(650);
const REALTIME_MIN_UTTERANCE_DURATION: Duration = Duration::from_millis(250);
const REALTIME_FIRST_SEGMENT_MAX_DURATION: Duration = Duration::from_secs(3);
const REALTIME_MAX_UTTERANCE_DURATION: Duration = Duration::from_secs(8);
const REALTIME_VOICE_AVERAGE_THRESHOLD: u64 = 120;

pub struct NativeAudioCapture {
    active: Mutex<Option<ActiveNativeAudioCapture>>,
    segment_backlog: SharedSegmentBacklog,
}

struct ActiveNativeAudioCapture {
    note_id: String,
    started_at: Instant,
    paused_at: Option<Instant>,
    paused_duration: Duration,
    stream: cpal::Stream,
    writer: SharedWavWriter,
    segments: SharedSegmentRecorder,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedAudioSegment {
    pub index: u64,
    pub path: String,
    pub start_ms: u64,
    pub duration_ms: u64,
}

impl NativeAudioCapture {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
            segment_backlog: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn microphone_recording_available() -> bool {
        default_input_config().is_ok()
    }

    pub fn start(&self, note_id: &str, audio_path: &Path) -> Result<(), String> {
        let mut active = self.active.lock().map_err(|error| error.to_string())?;
        if active.is_some() {
            return Err("another voice note recording is already active".to_string());
        }

        let (device, config) = default_input_config()?;
        let spec = hound::WavSpec {
            channels: config.channels(),
            sample_rate: config.sample_rate(),
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(audio_path, spec).map_err(|error| {
            format!(
                "failed to open native voice note audio file {}: {error}",
                audio_path.display()
            )
        })?;
        let writer = Arc::new(Mutex::new(Some(writer)));
        let segment_dir = audio_path
            .parent()
            .ok_or_else(|| "voice note source audio path has no parent directory".to_string())?
            .join("segments");
        let segments = Arc::new(Mutex::new(Some(SegmentRecorder::new(
            note_id,
            &segment_dir,
            spec,
            Arc::clone(&self.segment_backlog),
        )?)));
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let stream = build_input_stream(
            &device,
            &config,
            Arc::clone(&writer),
            Arc::clone(&segments),
            started_tx,
        )?;
        stream
            .play()
            .map_err(|error| format!("failed to start microphone recording: {error}"))?;
        started_rx.recv_timeout(MICROPHONE_START_TIMEOUT).map_err(|_| {
            "microphone recording did not receive input. Check microphone permission and selected input device.".to_string()
        })?;

        *active = Some(ActiveNativeAudioCapture {
            note_id: note_id.to_string(),
            started_at: Instant::now(),
            paused_at: None,
            paused_duration: Duration::ZERO,
            stream,
            writer,
            segments,
        });
        Ok(())
    }

    pub fn pause(&self, note_id: &str) -> Result<(), String> {
        let mut guard = self.active.lock().map_err(|error| error.to_string())?;
        let active = active_recording_mut(&mut guard, note_id)?;
        if active.paused_at.is_some() {
            return Ok(());
        }
        active
            .stream
            .pause()
            .map_err(|error| format!("failed to pause microphone recording: {error}"))?;
        active.paused_at = Some(Instant::now());
        Ok(())
    }

    pub fn resume(&self, note_id: &str) -> Result<(), String> {
        let mut guard = self.active.lock().map_err(|error| error.to_string())?;
        let active = active_recording_mut(&mut guard, note_id)?;
        let Some(paused_at) = active.paused_at.take() else {
            return Ok(());
        };
        active.paused_duration += paused_at.elapsed();
        active
            .stream
            .play()
            .map_err(|error| format!("failed to resume microphone recording: {error}"))?;
        Ok(())
    }

    pub fn stop(&self, note_id: &str) -> Result<u64, String> {
        let mut guard = self.active.lock().map_err(|error| error.to_string())?;
        let active = guard
            .as_ref()
            .ok_or_else(|| "no voice note recording is active".to_string())?;
        if active.note_id != note_id {
            return Err(format!(
                "voice note recording is active for {}, not {}",
                active.note_id, note_id
            ));
        }
        let active = guard
            .take()
            .ok_or_else(|| "no voice note recording is active".to_string())?;
        drop(guard);

        let paused_duration = active.paused_duration
            + active
                .paused_at
                .map(|paused_at| paused_at.elapsed())
                .unwrap_or(Duration::ZERO);
        let duration_ms = active
            .started_at
            .elapsed()
            .saturating_sub(paused_duration)
            .as_millis() as u64;
        drop(active.stream);
        let mut writer_guard = active.writer.lock().map_err(|error| error.to_string())?;
        let writer = writer_guard
            .take()
            .ok_or_else(|| "native voice note audio writer is already closed".to_string())?;
        drop(writer_guard);
        writer
            .finalize()
            .map_err(|error| format!("failed to finalize voice note WAV file: {error}"))?;
        finalize_active_segments(&active.segments)?;
        Ok(duration_ms)
    }

    pub fn take_completed_segments(
        &self,
        note_id: &str,
    ) -> Result<Vec<CompletedAudioSegment>, String> {
        let mut backlog = self
            .segment_backlog
            .lock()
            .map_err(|error| error.to_string())?;
        let drained = {
            let Some(segments) = backlog.get_mut(note_id) else {
                return Ok(Vec::new());
            };
            segments.drain(..).collect::<Vec<_>>()
        };
        backlog.remove(note_id);
        Ok(drained)
    }

    pub fn is_recording_active(&self, note_id: &str) -> bool {
        let Ok(active) = self.active.lock() else {
            return false;
        };
        active
            .as_ref()
            .map(|active| active.note_id == note_id)
            .unwrap_or(false)
    }
}

fn active_recording_mut<'a>(
    active: &'a mut Option<ActiveNativeAudioCapture>,
    note_id: &str,
) -> Result<&'a mut ActiveNativeAudioCapture, String> {
    let active = active
        .as_mut()
        .ok_or_else(|| "no voice note recording is active".to_string())?;
    if active.note_id != note_id {
        return Err(format!(
            "voice note recording is active for {}, not {}",
            active.note_id, note_id
        ));
    }
    Ok(active)
}

impl Default for NativeAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

pub fn microphone_recording_available() -> bool {
    NativeAudioCapture::microphone_recording_available()
}

fn default_input_config() -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default microphone input device is available".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|error| format!("failed to read microphone input config: {error}"))?;
    Ok((device, config))
}

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    writer: SharedWavWriter,
    segments: SharedSegmentRecorder,
    started_tx: mpsc::SyncSender<()>,
) -> Result<cpal::Stream, String> {
    let stream_config = cpal::StreamConfig::from(config.clone());
    match config.sample_format() {
        cpal::SampleFormat::I8 => {
            build_typed_input_stream::<i8>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::I16 => {
            build_typed_input_stream::<i16>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::I24 => build_typed_input_stream::<cpal::I24>(
            device,
            &stream_config,
            writer,
            segments,
            started_tx,
        ),
        cpal::SampleFormat::I32 => {
            build_typed_input_stream::<i32>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::I64 => {
            build_typed_input_stream::<i64>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::U8 => {
            build_typed_input_stream::<u8>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::U16 => {
            build_typed_input_stream::<u16>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::U24 => build_typed_input_stream::<cpal::U24>(
            device,
            &stream_config,
            writer,
            segments,
            started_tx,
        ),
        cpal::SampleFormat::U32 => {
            build_typed_input_stream::<u32>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::U64 => {
            build_typed_input_stream::<u64>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::F32 => {
            build_typed_input_stream::<f32>(device, &stream_config, writer, segments, started_tx)
        }
        cpal::SampleFormat::F64 => {
            build_typed_input_stream::<f64>(device, &stream_config, writer, segments, started_tx)
        }
        sample_format => Err(format!(
            "unsupported microphone sample format: {sample_format}"
        )),
    }
}

fn build_typed_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    writer: SharedWavWriter,
    segments: SharedSegmentRecorder,
    started_tx: mpsc::SyncSender<()>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    i16: FromSample<T>,
{
    let err_fn = |error| {
        log::warn!("voice note microphone stream error: {error}");
    };
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if !data.is_empty() {
                    let _ = started_tx.try_send(());
                }
                write_input_data::<T>(data, &writer, &segments);
            },
            err_fn,
            None,
        )
        .map_err(|error| format!("failed to open microphone input stream: {error}"))
}

fn write_input_data<T>(input: &[T], writer: &SharedWavWriter, segments: &SharedSegmentRecorder)
where
    T: Sample,
    i16: FromSample<T>,
{
    let mut source_guard = writer.try_lock().ok();
    let mut segment_guard = segments.try_lock().ok();
    let mut source_failed = false;
    let mut converted = Vec::with_capacity(input.len());
    for &sample in input {
        let sample = i16::from_sample(sample);
        converted.push(sample);
        if !source_failed {
            if let Some(Some(writer)) = source_guard.as_deref_mut() {
                if let Err(error) = writer.write_sample(sample) {
                    log::warn!("failed to write voice note microphone sample: {error}");
                    source_failed = true;
                }
            }
        }
    }
    if let Some(Some(segment_recorder)) = segment_guard.as_deref_mut() {
        if let Err(error) = segment_recorder.write_samples(&converted) {
            log::warn!("failed to write voice note realtime segment: {error}");
        }
    }
}

fn finalize_active_segments(segments: &SharedSegmentRecorder) -> Result<(), String> {
    let mut guard = segments.lock().map_err(|error| error.to_string())?;
    let Some(mut recorder) = guard.take() else {
        return Ok(());
    };
    recorder.finish_current_segment()
}

struct SegmentRecorder {
    note_id: String,
    dir: std::path::PathBuf,
    spec: hound::WavSpec,
    current_writer: Option<WavWriter>,
    current_index: u64,
    current_start_frame: u64,
    current_frame_count: u64,
    completed_segment_count: u64,
    total_frame_count: u64,
    pre_roll: VecDeque<BufferedFrame>,
    pre_roll_frames: usize,
    voice_detector: VoiceActivityDetector,
    voice_start_frames: u64,
    utterance_end_silence_frames: u64,
    min_utterance_frames: u64,
    max_utterance_frames: u64,
    voiced_run_frames: u64,
    silence_run_frames: u64,
    speech_frames_in_segment: u64,
    backlog: SharedSegmentBacklog,
}

impl SegmentRecorder {
    fn new(
        note_id: &str,
        dir: &Path,
        spec: hound::WavSpec,
        backlog: SharedSegmentBacklog,
    ) -> Result<Self, String> {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|error| error.to_string())?;
        }
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let pre_roll_frames =
            duration_to_frames(REALTIME_PREROLL_DURATION, spec.sample_rate).max(1) as usize;
        let recorder = Self {
            note_id: note_id.to_string(),
            dir: dir.to_path_buf(),
            spec,
            current_writer: None,
            current_index: 1,
            current_start_frame: 0,
            current_frame_count: 0,
            completed_segment_count: 0,
            total_frame_count: 0,
            pre_roll: VecDeque::with_capacity(pre_roll_frames),
            pre_roll_frames,
            voice_detector: VoiceActivityDetector::new(
                duration_to_frames(REALTIME_VOICE_WINDOW_DURATION, spec.sample_rate).max(1)
                    as usize,
            ),
            voice_start_frames: duration_to_frames(REALTIME_VOICE_START_DURATION, spec.sample_rate)
                .max(1),
            utterance_end_silence_frames: duration_to_frames(
                REALTIME_UTTERANCE_END_SILENCE,
                spec.sample_rate,
            )
            .max(1),
            min_utterance_frames: duration_to_frames(
                REALTIME_MIN_UTTERANCE_DURATION,
                spec.sample_rate,
            )
            .max(1),
            max_utterance_frames: duration_to_frames(
                REALTIME_MAX_UTTERANCE_DURATION,
                spec.sample_rate,
            )
            .max(1),
            voiced_run_frames: 0,
            silence_run_frames: 0,
            speech_frames_in_segment: 0,
            backlog,
        };
        Ok(recorder)
    }

    fn write_samples(&mut self, samples: &[i16]) -> Result<(), String> {
        let channels = usize::from(self.spec.channels.max(1));
        for frame in samples.chunks(channels) {
            if frame.len() < channels {
                continue;
            }
            self.write_frame(frame)?;
        }
        Ok(())
    }

    fn write_frame(&mut self, frame: &[i16]) -> Result<(), String> {
        let is_voice = self.voice_detector.observe(frame);
        let buffered = BufferedFrame {
            samples: frame.to_vec(),
            is_voice,
        };
        self.push_pre_roll(buffered.clone());

        if self.current_writer.is_some() {
            self.write_current_frame(&buffered.samples)?;
            if is_voice {
                self.speech_frames_in_segment += 1;
                self.silence_run_frames = 0;
            } else {
                self.silence_run_frames += 1;
            }

            if self.silence_run_frames >= self.utterance_end_silence_frames
                && self.speech_frames_in_segment >= self.min_utterance_frames
            {
                self.finish_current_segment()?;
            } else if self.current_frame_count >= self.current_max_segment_frames() {
                self.finish_current_segment()?;
                if is_voice {
                    self.start_current_segment_from_pre_roll()?;
                }
            }
        } else if is_voice {
            self.voiced_run_frames += 1;
            if self.voiced_run_frames >= self.voice_start_frames {
                self.start_current_segment_from_pre_roll()?;
            }
        } else {
            self.voiced_run_frames = 0;
        }

        self.total_frame_count += 1;
        Ok(())
    }

    fn start_current_segment_from_pre_roll(&mut self) -> Result<(), String> {
        if self.current_writer.is_some() {
            return Ok(());
        }
        let path = self.current_path();
        let writer = hound::WavWriter::create(&path, self.spec).map_err(|error| {
            format!(
                "failed to open voice note realtime segment {}: {error}",
                path.display()
            )
        })?;
        self.current_writer = Some(writer);
        self.current_start_frame = self
            .total_frame_count
            .saturating_add(1)
            .saturating_sub(self.pre_roll.len() as u64);
        self.current_frame_count = 0;
        self.speech_frames_in_segment = 0;
        self.silence_run_frames = 0;

        let frames = self.pre_roll.iter().cloned().collect::<Vec<_>>();
        for frame in frames {
            if frame.is_voice {
                self.speech_frames_in_segment += 1;
            } else {
                self.silence_run_frames += 1;
            }
            self.write_current_frame(&frame.samples)?;
        }
        Ok(())
    }

    fn finish_current_segment(&mut self) -> Result<(), String> {
        let Some(writer) = self.current_writer.take() else {
            return Ok(());
        };
        let path = self.current_path();
        writer.finalize().map_err(|error| {
            format!(
                "failed to finalize voice note realtime segment {}: {error}",
                path.display()
            )
        })?;

        let frames = self.current_frame_count;
        if frames == 0 || self.speech_frames_in_segment < self.min_utterance_frames {
            let _ = std::fs::remove_file(&path);
            self.reset_current_segment_state();
            return Ok(());
        }

        let segment = CompletedAudioSegment {
            index: self.current_index,
            path: path.to_string_lossy().to_string(),
            start_ms: frames_to_ms(self.current_start_frame, self.spec.sample_rate),
            duration_ms: frames_to_ms(frames, self.spec.sample_rate),
        };
        self.current_index += 1;
        self.completed_segment_count += 1;
        self.reset_current_segment_state();

        let mut backlog = self.backlog.lock().map_err(|error| error.to_string())?;
        backlog
            .entry(self.note_id.clone())
            .or_default()
            .push_back(segment);
        Ok(())
    }

    fn push_pre_roll(&mut self, frame: BufferedFrame) {
        self.pre_roll.push_back(frame);
        while self.pre_roll.len() > self.pre_roll_frames {
            self.pre_roll.pop_front();
        }
    }

    fn write_current_frame(&mut self, frame: &[i16]) -> Result<(), String> {
        let writer = self
            .current_writer
            .as_mut()
            .ok_or_else(|| "voice note realtime segment writer is unavailable".to_string())?;
        for &sample in frame {
            writer
                .write_sample(sample)
                .map_err(|error| format!("failed to write voice note realtime segment: {error}"))?;
        }
        self.current_frame_count += 1;
        Ok(())
    }

    fn reset_current_segment_state(&mut self) {
        self.current_start_frame = 0;
        self.current_frame_count = 0;
        self.voiced_run_frames = 0;
        self.silence_run_frames = 0;
        self.speech_frames_in_segment = 0;
    }

    fn current_path(&self) -> std::path::PathBuf {
        self.dir
            .join(format!("segment-{:06}.wav", self.current_index))
    }

    fn current_max_segment_frames(&self) -> u64 {
        if self.completed_segment_count == 0 {
            duration_to_frames(REALTIME_FIRST_SEGMENT_MAX_DURATION, self.spec.sample_rate).max(1)
        } else {
            self.max_utterance_frames
        }
    }
}

#[derive(Clone)]
struct BufferedFrame {
    samples: Vec<i16>,
    is_voice: bool,
}

struct VoiceActivityDetector {
    window_abs: VecDeque<u64>,
    window_frames: usize,
    window_abs_sum: u64,
}

impl VoiceActivityDetector {
    fn new(window_frames: usize) -> Self {
        Self {
            window_abs: VecDeque::with_capacity(window_frames),
            window_frames: window_frames.max(1),
            window_abs_sum: 0,
        }
    }

    fn observe(&mut self, frame: &[i16]) -> bool {
        let amplitude = frame_peak_abs(frame);
        self.window_abs.push_back(amplitude);
        self.window_abs_sum = self.window_abs_sum.saturating_add(amplitude);
        while self.window_abs.len() > self.window_frames {
            if let Some(removed) = self.window_abs.pop_front() {
                self.window_abs_sum = self.window_abs_sum.saturating_sub(removed);
            }
        }
        let frame_count = self.window_abs.len().max(1) as u64;
        self.window_abs_sum / frame_count >= REALTIME_VOICE_AVERAGE_THRESHOLD
    }
}

fn frames_to_ms(frames: u64, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    frames.saturating_mul(1_000) / u64::from(sample_rate)
}

fn duration_to_frames(duration: Duration, sample_rate: u32) -> u64 {
    let nanos = duration.as_nanos();
    ((nanos * u128::from(sample_rate)) / 1_000_000_000) as u64
}

fn frame_peak_abs(frame: &[i16]) -> u64 {
    frame
        .iter()
        .map(|sample| u64::from(sample.saturating_abs() as u16))
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_spec() -> hound::WavSpec {
        hound::WavSpec {
            channels: 1,
            sample_rate: 1_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        }
    }

    fn recorder(temp: &tempfile::TempDir, backlog: SharedSegmentBacklog) -> SegmentRecorder {
        SegmentRecorder::new("note-1", temp.path(), test_spec(), backlog).expect("segment recorder")
    }

    fn drain(backlog: &SharedSegmentBacklog) -> Vec<CompletedAudioSegment> {
        backlog
            .lock()
            .expect("backlog")
            .remove("note-1")
            .unwrap_or_default()
            .into_iter()
            .collect()
    }

    fn samples(count: usize, value: i16) -> Vec<i16> {
        vec![value; count]
    }

    fn zero_crossing_speech_samples(count: usize, amplitude: i16) -> Vec<i16> {
        (0..count)
            .map(|index| match index % 8 {
                0 => 0,
                1 | 2 => amplitude / 2,
                3 => amplitude,
                4 => 0,
                5 | 6 => -(amplitude / 2),
                _ => -amplitude,
            })
            .collect()
    }

    #[test]
    fn commits_short_utterance_after_silence_without_waiting_five_seconds() {
        let temp = tempfile::tempdir().expect("temp dir");
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let mut recorder = recorder(&temp, Arc::clone(&backlog));

        recorder
            .write_samples(&samples(300, 0))
            .expect("initial silence");
        recorder
            .write_samples(&samples(
                420,
                (REALTIME_VOICE_AVERAGE_THRESHOLD as i16) + 1_000,
            ))
            .expect("speech");
        recorder
            .write_samples(&samples(700, 0))
            .expect("ending silence");

        let segments = drain(&backlog);
        assert_eq!(segments.len(), 1);
        assert!(
            segments[0].duration_ms < 2_000,
            "short utterance should not wait for a fixed 5s segment: {segments:?}"
        );
        assert!(
            segments[0].start_ms < 300,
            "segment should keep a small pre-roll before detected speech"
        );
    }

    #[test]
    fn silence_does_not_create_realtime_transcription_segments() {
        let temp = tempfile::tempdir().expect("temp dir");
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let mut recorder = recorder(&temp, Arc::clone(&backlog));

        recorder.write_samples(&samples(3_000, 0)).expect("silence");
        recorder.finish_current_segment().expect("finish");

        assert!(drain(&backlog).is_empty());
    }

    #[test]
    fn zero_crossing_speech_starts_realtime_transcription_segment() {
        let temp = tempfile::tempdir().expect("temp dir");
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let mut recorder = recorder(&temp, Arc::clone(&backlog));

        recorder
            .write_samples(&samples(300, 0))
            .expect("initial silence");
        recorder
            .write_samples(&zero_crossing_speech_samples(600, 700))
            .expect("speech");
        recorder
            .write_samples(&samples(700, 0))
            .expect("ending silence");

        let segments = drain(&backlog);
        assert_eq!(
            segments.len(),
            1,
            "speech with natural zero crossings should still produce realtime segments"
        );
    }

    #[test]
    fn first_continuous_speech_segment_uses_short_preview_cut() {
        let temp = tempfile::tempdir().expect("temp dir");
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let mut recorder = recorder(&temp, Arc::clone(&backlog));

        recorder
            .write_samples(&samples(
                4_000,
                (REALTIME_VOICE_AVERAGE_THRESHOLD as i16) + 1_000,
            ))
            .expect("continuous speech");

        let segments = drain(&backlog);
        assert_eq!(segments.len(), 1);
        assert!(
            segments[0].duration_ms <= 3_200,
            "first continuous segment should close quickly for initial realtime feedback: {segments:?}"
        );
    }

    #[test]
    fn continuous_speech_uses_long_soft_cut_instead_of_five_second_chunks() {
        let temp = tempfile::tempdir().expect("temp dir");
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let mut recorder = recorder(&temp, Arc::clone(&backlog));

        recorder
            .write_samples(&samples(
                13_000,
                (REALTIME_VOICE_AVERAGE_THRESHOLD as i16) + 1_000,
            ))
            .expect("continuous speech");

        let segments = drain(&backlog);
        assert_eq!(segments.len(), 2);
        assert!(
            segments[0].duration_ms <= 3_200,
            "first continuous segment should prioritize initial feedback: {segments:?}"
        );
        assert!(
            segments[1].duration_ms >= 7_500,
            "continuous speech should not be hard-cut into 5s chunks: {segments:?}"
        );
    }
}
