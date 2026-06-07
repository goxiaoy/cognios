use std::path::Path;
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::services::voice_notes::native_audio::RealtimeAudioChunk;

const VLLM_REALTIME_TARGET_SAMPLE_RATE: u32 = 16_000;
const VLLM_SESSION_START_TIMEOUT: Duration = Duration::from_secs(10);
const VLLM_FINAL_TRANSCRIPT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VllmRealtimeTranscriptEvent {
    Provisional(VllmRealtimeTranscriptSegment),
    Final(VllmRealtimeTranscriptSegment),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VllmRealtimeTranscriptSegment {
    pub text: String,
    pub utterance_id: Option<String>,
    pub revision: Option<u64>,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
}

pub async fn run_vllm_audio_file_transcription(
    websocket_url: String,
    model: Option<String>,
    audio_path: &Path,
    event_tx: mpsc::Sender<VllmRealtimeTranscriptEvent>,
) -> Result<(), String> {
    let chunks = wav_audio_file_chunks(audio_path)?;
    let (audio_tx, audio_rx) = mpsc::channel(32);
    let realtime_task = tokio::spawn(run_vllm_realtime_transcription(
        websocket_url,
        model,
        audio_rx,
        event_tx,
    ));

    for chunk in chunks {
        audio_tx
            .send(chunk)
            .await
            .map_err(|_| "realtime ASR audio stream closed before file finished".to_string())?;
    }
    drop(audio_tx);

    match realtime_task.await {
        Ok(result) => result,
        Err(error) => Err(format!(
            "vLLM saved-audio transcription task failed: {error}"
        )),
    }
}

pub async fn run_vllm_realtime_transcription(
    websocket_url: String,
    model: Option<String>,
    mut audio_rx: mpsc::Receiver<RealtimeAudioChunk>,
    event_tx: mpsc::Sender<VllmRealtimeTranscriptEvent>,
) -> Result<(), String> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(websocket_url.as_str())
        .await
        .map_err(|error| format!("failed to connect to realtime ASR WebSocket: {error}"))?;
    let (mut writer, mut reader) = ws_stream.split();

    let first_message = tokio::time::timeout(VLLM_SESSION_START_TIMEOUT, reader.next())
        .await
        .map_err(|_| "timed out waiting for realtime ASR session".to_string())?;
    match first_message {
        Some(Ok(message)) if session_started(&message) => {}
        Some(Ok(message)) => {
            return Err(format!(
                "realtime ASR returned unexpected session response: {}",
                message_text(&message).unwrap_or("<binary>")
            ));
        }
        Some(Err(error)) => {
            return Err(format!(
                "realtime ASR WebSocket failed during startup: {error}"
            ));
        }
        None => return Err("realtime ASR WebSocket closed during startup".to_string()),
    }

    if let Some(model) = model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        writer
            .send(Message::Text(
                serde_json::json!({
                    "type": "session.update",
                    "model": model,
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|error| format!("failed to configure realtime ASR model: {error}"))?;
    }

    writer
        .send(Message::Text(
            serde_json::json!({ "type": "input_audio_buffer.commit" })
                .to_string()
                .into(),
        ))
        .await
        .map_err(|error| format!("failed to start realtime ASR buffer: {error}"))?;

    let mut provisional = String::new();
    let mut audio_finished = false;
    loop {
        if audio_finished {
            match tokio::time::timeout(VLLM_FINAL_TRANSCRIPT_TIMEOUT, reader.next()).await {
                Ok(Some(Ok(message))) => {
                    if let Some(event) = realtime_event_from_message(&message, &mut provisional)? {
                        let is_final = matches!(event, VllmRealtimeTranscriptEvent::Final(_));
                        let _ = event_tx.send(event).await;
                        if is_final {
                            return Ok(());
                        }
                    }
                    continue;
                }
                Ok(Some(Err(error))) => {
                    return Err(format!("realtime ASR WebSocket receive failed: {error}"));
                }
                Ok(None) | Err(_) => return Ok(()),
            }
        }

        tokio::select! {
            chunk = audio_rx.recv() => {
                let Some(chunk) = chunk else {
                    writer
                        .send(Message::Text(
                            serde_json::json!({
                                "type": "input_audio_buffer.commit",
                                "final": true,
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .map_err(|error| format!("failed to finish realtime ASR buffer: {error}"))?;
                    audio_finished = true;
                    continue;
                };
                let Some(audio) = vllm_pcm16_base64(&chunk) else {
                    continue;
                };
                writer
                    .send(Message::Text(
                        serde_json::json!({
                            "type": "input_audio_buffer.append",
                            "audio": audio,
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .map_err(|error| format!("failed to send realtime ASR audio: {error}"))?;
            }
            message = reader.next() => {
                let Some(message) = message else {
                    return Err("realtime ASR WebSocket closed".to_string());
                };
                let message = message.map_err(|error| {
                    format!("realtime ASR WebSocket receive failed: {error}")
                })?;
                if let Some(event) = realtime_event_from_message(&message, &mut provisional)? {
                    let _ = event_tx.send(event).await;
                }
            }
        }
    }
}

fn wav_audio_file_chunks(audio_path: &Path) -> Result<Vec<RealtimeAudioChunk>, String> {
    let mut reader = hound::WavReader::open(audio_path).map_err(|error| {
        format!("vLLM saved-audio transcription only supports readable WAV files: {error}")
    })?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(
            "vLLM saved-audio transcription only supports 16-bit PCM WAV files".to_string(),
        );
    }
    if spec.channels == 0 || spec.sample_rate == 0 {
        return Err("voice note WAV file has invalid audio format".to_string());
    }

    let samples = reader
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read voice note WAV samples: {error}"))?;
    if samples.is_empty() {
        return Err("voice note audio file has no audio samples".to_string());
    }

    let channels = usize::from(spec.channels);
    let frames_per_chunk = ((spec.sample_rate / 10).max(1)) as usize;
    let samples_per_chunk = frames_per_chunk.saturating_mul(channels).max(channels);
    Ok(samples
        .chunks(samples_per_chunk)
        .map(|samples| RealtimeAudioChunk {
            samples: samples.to_vec(),
            sample_rate: spec.sample_rate,
            channels: spec.channels,
        })
        .collect())
}

fn realtime_event_from_message(
    message: &Message,
    provisional: &mut String,
) -> Result<Option<VllmRealtimeTranscriptEvent>, String> {
    let Some(text) = message_text(message) else {
        return Ok(None);
    };
    match parse_vllm_realtime_message(text) {
        Some(VllmRealtimeTranscriptEvent::Provisional(mut segment)) => {
            provisional.push_str(&segment.text);
            let text = provisional.trim();
            if text.is_empty() {
                Ok(None)
            } else {
                segment.text = text.to_string();
                Ok(Some(VllmRealtimeTranscriptEvent::Provisional(segment)))
            }
        }
        Some(VllmRealtimeTranscriptEvent::Final(mut segment)) => {
            provisional.clear();
            let text = segment.text.trim();
            if text.is_empty() {
                Ok(None)
            } else {
                segment.text = text.to_string();
                Ok(Some(VllmRealtimeTranscriptEvent::Final(segment)))
            }
        }
        Some(VllmRealtimeTranscriptEvent::Error(message)) => Err(message),
        None => Ok(None),
    }
}

pub fn parse_vllm_realtime_message(raw: &str) -> Option<VllmRealtimeTranscriptEvent> {
    let value: Value = serde_json::from_str(raw).ok()?;
    match value.get("type").and_then(Value::as_str)? {
        "transcription.delta" => {
            let delta = value.get("delta").and_then(Value::as_str)?.to_string();
            Some(VllmRealtimeTranscriptEvent::Provisional(
                transcript_segment_from_value(&value, delta),
            ))
        }
        "transcription.done" => {
            let text = value
                .get("text")
                .or_else(|| value.get("transcript"))
                .or_else(|| value.get("transcription"))
                .and_then(Value::as_str)?
                .to_string();
            Some(VllmRealtimeTranscriptEvent::Final(
                transcript_segment_from_value(&value, text),
            ))
        }
        "error" => {
            let message = value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("realtime ASR returned an error");
            Some(VllmRealtimeTranscriptEvent::Error(message.to_string()))
        }
        _ => None,
    }
}

fn transcript_segment_from_value(value: &Value, text: String) -> VllmRealtimeTranscriptSegment {
    VllmRealtimeTranscriptSegment {
        text,
        utterance_id: value
            .get("utterance_id")
            .or_else(|| value.get("utteranceId"))
            .or_else(|| value.get("segment_id"))
            .or_else(|| value.get("segmentId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        revision: value
            .get("revision")
            .or_else(|| value.get("sequence"))
            .and_then(Value::as_u64),
        start_ms: value
            .get("start_ms")
            .or_else(|| value.get("startMs"))
            .and_then(Value::as_u64),
        end_ms: value
            .get("end_ms")
            .or_else(|| value.get("endMs"))
            .and_then(Value::as_u64),
    }
}

pub fn vllm_pcm16_base64(chunk: &RealtimeAudioChunk) -> Option<String> {
    let bytes = pcm16_mono_16khz_bytes(chunk)?;
    if bytes.is_empty() {
        return None;
    }
    Some(general_purpose::STANDARD.encode(bytes))
}

fn pcm16_mono_16khz_bytes(chunk: &RealtimeAudioChunk) -> Option<Vec<u8>> {
    let channels = usize::from(chunk.channels.max(1));
    if chunk.samples.is_empty() || chunk.sample_rate == 0 {
        return None;
    }
    let source_frames = chunk.samples.len() / channels;
    if source_frames == 0 {
        return None;
    }
    let target_frames = ((source_frames as u128 * u128::from(VLLM_REALTIME_TARGET_SAMPLE_RATE))
        / u128::from(chunk.sample_rate))
    .max(1) as usize;
    let mut bytes = Vec::with_capacity(target_frames * 2);
    for target_frame in 0..target_frames {
        let source_frame = ((target_frame as u128 * u128::from(chunk.sample_rate))
            / u128::from(VLLM_REALTIME_TARGET_SAMPLE_RATE)) as usize;
        let source_frame = source_frame.min(source_frames.saturating_sub(1));
        let offset = source_frame * channels;
        let sum = chunk.samples[offset..offset + channels]
            .iter()
            .map(|sample| i32::from(*sample))
            .sum::<i32>();
        let mono = (sum / channels as i32).clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
        bytes.extend_from_slice(&mono.to_le_bytes());
    }
    Some(bytes)
}

fn session_started(message: &Message) -> bool {
    let Some(text) = message_text(message) else {
        return false;
    };
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .map(|event_type| event_type == "session.created")
        .unwrap_or(false)
}

fn message_text(message: &Message) -> Option<&str> {
    match message {
        Message::Text(text) => Some(text.as_ref()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vllm_delta_and_done_events() {
        assert_eq!(
            parse_vllm_realtime_message(
                r#"{"type":"transcription.delta","delta":"hel","utterance_id":"utt-1","revision":2,"start_ms":100,"end_ms":900}"#
            ),
            Some(VllmRealtimeTranscriptEvent::Provisional(
                VllmRealtimeTranscriptSegment {
                    text: "hel".to_string(),
                    utterance_id: Some("utt-1".to_string()),
                    revision: Some(2),
                    start_ms: Some(100),
                    end_ms: Some(900),
                }
            ))
        );
        assert_eq!(
            parse_vllm_realtime_message(r#"{"type":"transcription.done","text":"hello"}"#),
            Some(VllmRealtimeTranscriptEvent::Final(
                VllmRealtimeTranscriptSegment {
                    text: "hello".to_string(),
                    utterance_id: None,
                    revision: None,
                    start_ms: None,
                    end_ms: None,
                }
            ))
        );
    }

    #[test]
    fn converts_stereo_48khz_pcm_to_mono_16khz_base64() {
        let chunk = RealtimeAudioChunk {
            samples: vec![
                1_000, 3_000, 2_000, 4_000, 3_000, 5_000, 4_000, 6_000, 5_000, 7_000, 6_000, 8_000,
            ],
            sample_rate: 48_000,
            channels: 2,
        };

        let bytes = pcm16_mono_16khz_bytes(&chunk).expect("pcm bytes");

        assert_eq!(bytes.len(), 4);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 2_000);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), 5_000);
    }

    #[test]
    fn preserves_16khz_mono_pcm_shape() {
        let chunk = RealtimeAudioChunk {
            samples: vec![10, -20, 30],
            sample_rate: 16_000,
            channels: 1,
        };

        let bytes = pcm16_mono_16khz_bytes(&chunk).expect("pcm bytes");

        assert_eq!(bytes.len(), 6);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 10);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), -20);
        assert_eq!(i16::from_le_bytes([bytes[4], bytes[5]]), 30);
    }

    #[test]
    fn reads_pcm_wav_file_into_realtime_chunks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("voice.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("wav writer");
        for sample in 0..3_200 {
            writer.write_sample(sample as i16).expect("sample");
        }
        writer.finalize().expect("finalize wav");

        let chunks = wav_audio_file_chunks(&path).expect("chunks");

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].sample_rate, 16_000);
        assert_eq!(chunks[0].channels, 1);
        assert_eq!(chunks[0].samples.len(), 1_600);
        assert_eq!(chunks[1].samples[0], 1_600);
    }

    #[tokio::test]
    async fn starts_realtime_buffer_before_streaming_audio() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let websocket_url = format!("ws://{}", listener.local_addr().expect("local addr"));
        let received_types = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let server_received_types = std::sync::Arc::clone(&received_types);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut websocket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("websocket accept");
            websocket
                .send(Message::Text(
                    serde_json::json!({ "type": "session.created" })
                        .to_string()
                        .into(),
                ))
                .await
                .expect("session created");

            while let Some(message) = websocket.next().await {
                let message = message.expect("client message");
                let Some(text) = message_text(&message) else {
                    continue;
                };
                let value: Value = serde_json::from_str(text).expect("json message");
                let event_type = value
                    .get("type")
                    .and_then(Value::as_str)
                    .expect("event type")
                    .to_string();
                server_received_types
                    .lock()
                    .expect("received types")
                    .push(event_type.clone());
                if event_type == "input_audio_buffer.append" {
                    websocket
                        .send(Message::Text(
                            serde_json::json!({
                                "type": "transcription.delta",
                                "delta": "hello",
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .expect("delta");
                }
                if event_type == "input_audio_buffer.commit"
                    && value.get("final").and_then(Value::as_bool) == Some(true)
                {
                    websocket
                        .send(Message::Text(
                            serde_json::json!({
                                "type": "transcription.done",
                                "text": "hello",
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .expect("done");
                    break;
                }
            }
        });

        let (audio_tx, audio_rx) = mpsc::channel(4);
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let client = tokio::spawn(run_vllm_realtime_transcription(
            websocket_url,
            None,
            audio_rx,
            event_tx,
        ));

        audio_tx
            .send(RealtimeAudioChunk {
                samples: vec![1_000; 1_600],
                sample_rate: 16_000,
                channels: 1,
            })
            .await
            .expect("audio send");
        drop(audio_tx);

        let mut events = Vec::new();
        while let Some(event) = event_rx.recv().await {
            let is_final = matches!(event, VllmRealtimeTranscriptEvent::Final(_));
            events.push(event);
            if is_final {
                break;
            }
        }

        client.await.expect("client task").expect("client result");
        server.await.expect("server task");
        assert_eq!(
            received_types.lock().expect("received types").as_slice(),
            &[
                "input_audio_buffer.commit".to_string(),
                "input_audio_buffer.append".to_string(),
                "input_audio_buffer.commit".to_string(),
            ]
        );
        assert_eq!(
            events,
            vec![
                VllmRealtimeTranscriptEvent::Provisional(VllmRealtimeTranscriptSegment {
                    text: "hello".to_string(),
                    utterance_id: None,
                    revision: None,
                    start_ms: None,
                    end_ms: None,
                }),
                VllmRealtimeTranscriptEvent::Final(VllmRealtimeTranscriptSegment {
                    text: "hello".to_string(),
                    utterance_id: None,
                    revision: None,
                    start_ms: None,
                    end_ms: None,
                }),
            ]
        );
    }
}
