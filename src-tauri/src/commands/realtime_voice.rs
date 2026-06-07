use tauri::State;

use crate::services::search::{RealtimeVoiceStatusDto, SidecarEnvelope};
use crate::AppState;

pub const REALTIME_VOICE_EVENT: &str = "realtime-voice/event";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeVoiceEventPayload {
    pub kind: String,
    pub session_id: String,
    pub utterance_id: String,
    pub text: String,
    pub sequence: u64,
    pub revision: u64,
    pub start_ms: u64,
    pub end_ms: Option<u64>,
    pub persisted: bool,
}

impl RealtimeVoiceEventPayload {
    pub fn provisional_caption(
        session_id: impl Into<String>,
        utterance_id: impl Into<String>,
        text: impl Into<String>,
        sequence: u64,
        revision: u64,
        start_ms: u64,
        end_ms: Option<u64>,
    ) -> Self {
        Self {
            kind: "provisional_caption".to_string(),
            session_id: session_id.into(),
            utterance_id: utterance_id.into(),
            text: text.into(),
            sequence,
            revision,
            start_ms,
            end_ms,
            persisted: false,
        }
    }

    pub fn final_utterance(
        session_id: impl Into<String>,
        utterance_id: impl Into<String>,
        text: impl Into<String>,
        sequence: u64,
        revision: u64,
        start_ms: u64,
        end_ms: Option<u64>,
        persisted: bool,
    ) -> Self {
        Self {
            kind: "final_utterance".to_string(),
            session_id: session_id.into(),
            utterance_id: utterance_id.into(),
            text: text.into(),
            sequence,
            revision,
            start_ms,
            end_ms,
            persisted,
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRealtimeVoiceStatusResult {
    pub status: SidecarEnvelope<RealtimeVoiceStatusDto>,
}

#[tauri::command]
pub async fn get_realtime_voice_status(
    state: State<'_, AppState>,
) -> Result<GetRealtimeVoiceStatusResult, String> {
    Ok(GetRealtimeVoiceStatusResult {
        status: state.search_client.realtime_voice_status().await,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_utterance_event_serialises_for_frontend_contract() {
        let event = RealtimeVoiceEventPayload::final_utterance(
            "voice-note-1",
            "utt-1",
            "hello realtime",
            7,
            3,
            1_000,
            Some(2_500),
            true,
        );

        let json = serde_json::to_value(event).expect("serialize event");

        assert_eq!(json["kind"], "final_utterance");
        assert_eq!(json["sessionId"], "voice-note-1");
        assert_eq!(json["utteranceId"], "utt-1");
        assert_eq!(json["text"], "hello realtime");
        assert_eq!(json["sequence"], 7);
        assert_eq!(json["revision"], 3);
        assert_eq!(json["startMs"], 1_000);
        assert_eq!(json["endMs"], 2_500);
        assert_eq!(json["persisted"], true);
    }

    #[test]
    fn provisional_caption_event_serialises_for_frontend_contract() {
        let event = RealtimeVoiceEventPayload::provisional_caption(
            "voice-note-1",
            "utt-1",
            "hello",
            3,
            2,
            500,
            None,
        );

        let json = serde_json::to_value(event).expect("serialize event");

        assert_eq!(json["kind"], "provisional_caption");
        assert_eq!(json["sessionId"], "voice-note-1");
        assert_eq!(json["utteranceId"], "utt-1");
        assert_eq!(json["text"], "hello");
        assert_eq!(json["sequence"], 3);
        assert_eq!(json["revision"], 2);
        assert_eq!(json["startMs"], 500);
        assert_eq!(json["endMs"], serde_json::Value::Null);
        assert_eq!(json["persisted"], false);
    }
}
