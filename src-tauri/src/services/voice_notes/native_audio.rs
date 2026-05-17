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
const REALTIME_SEGMENT_DURATION: Duration = Duration::from_secs(5);

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
    let mut segment_failed = false;
    for &sample in input {
        let sample = i16::from_sample(sample);
        if !source_failed {
            if let Some(Some(writer)) = source_guard.as_deref_mut() {
                if let Err(error) = writer.write_sample(sample) {
                    log::warn!("failed to write voice note microphone sample: {error}");
                    source_failed = true;
                }
            }
        }
        if !segment_failed {
            if let Some(Some(segment_recorder)) = segment_guard.as_deref_mut() {
                if let Err(error) = segment_recorder.write_sample(sample) {
                    log::warn!("failed to write voice note realtime segment: {error}");
                    segment_failed = true;
                }
            }
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
    current_sample_count: u64,
    completed_frame_count: u64,
    frames_per_segment: u64,
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
        let frames_per_segment =
            u64::from(spec.sample_rate) * REALTIME_SEGMENT_DURATION.as_secs().max(1);
        let mut recorder = Self {
            note_id: note_id.to_string(),
            dir: dir.to_path_buf(),
            spec,
            current_writer: None,
            current_index: 1,
            current_sample_count: 0,
            completed_frame_count: 0,
            frames_per_segment,
            backlog,
        };
        recorder.start_current_segment()?;
        Ok(recorder)
    }

    fn write_sample(&mut self, sample: i16) -> Result<(), String> {
        if self.current_writer.is_none() {
            self.start_current_segment()?;
        }
        let writer = self
            .current_writer
            .as_mut()
            .ok_or_else(|| "voice note realtime segment writer is unavailable".to_string())?;
        writer
            .write_sample(sample)
            .map_err(|error| format!("failed to write voice note realtime segment: {error}"))?;
        self.current_sample_count += 1;
        if self.current_frame_count() >= self.frames_per_segment {
            self.finish_current_segment()?;
            self.start_current_segment()?;
        }
        Ok(())
    }

    fn start_current_segment(&mut self) -> Result<(), String> {
        let path = self.current_path();
        let writer = hound::WavWriter::create(&path, self.spec).map_err(|error| {
            format!(
                "failed to open voice note realtime segment {}: {error}",
                path.display()
            )
        })?;
        self.current_writer = Some(writer);
        self.current_sample_count = 0;
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

        let frames = self.current_frame_count();
        if frames == 0 {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }

        let segment = CompletedAudioSegment {
            index: self.current_index,
            path: path.to_string_lossy().to_string(),
            start_ms: frames_to_ms(self.completed_frame_count, self.spec.sample_rate),
            duration_ms: frames_to_ms(frames, self.spec.sample_rate),
        };
        self.completed_frame_count += frames;
        self.current_index += 1;
        self.current_sample_count = 0;

        let mut backlog = self.backlog.lock().map_err(|error| error.to_string())?;
        backlog
            .entry(self.note_id.clone())
            .or_default()
            .push_back(segment);
        Ok(())
    }

    fn current_path(&self) -> std::path::PathBuf {
        self.dir
            .join(format!("segment-{:06}.wav", self.current_index))
    }

    fn current_frame_count(&self) -> u64 {
        let channels = u64::from(self.spec.channels.max(1));
        self.current_sample_count / channels
    }
}

fn frames_to_ms(frames: u64, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    frames.saturating_mul(1_000) / u64::from(sample_rate)
}
