use tauri::State;

use crate::services::search::{RealtimeVoiceStatusDto, SidecarEnvelope};
use crate::AppState;

pub const REALTIME_VOICE_EVENT: &str = "realtime-voice/event";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeVoiceEventPayload {
    pub kind: String,
    pub session_id: String,
    pub text: String,
    pub sequence: u64,
    pub persisted: bool,
}

impl RealtimeVoiceEventPayload {
    pub fn provisional_caption(
        session_id: impl Into<String>,
        text: impl Into<String>,
        sequence: u64,
    ) -> Self {
        Self {
            kind: "provisional_caption".to_string(),
            session_id: session_id.into(),
            text: text.into(),
            sequence,
            persisted: false,
        }
    }

    pub fn final_utterance(
        session_id: impl Into<String>,
        text: impl Into<String>,
        sequence: u64,
        persisted: bool,
    ) -> Self {
        Self {
            kind: "final_utterance".to_string(),
            session_id: session_id.into(),
            text: text.into(),
            sequence,
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
        let event =
            RealtimeVoiceEventPayload::final_utterance("voice-note-1", "hello realtime", 7, true);

        let json = serde_json::to_value(event).expect("serialize event");

        assert_eq!(json["kind"], "final_utterance");
        assert_eq!(json["sessionId"], "voice-note-1");
        assert_eq!(json["text"], "hello realtime");
        assert_eq!(json["sequence"], 7);
        assert_eq!(json["persisted"], true);
    }

    #[test]
    fn provisional_caption_event_serialises_for_frontend_contract() {
        let event = RealtimeVoiceEventPayload::provisional_caption("voice-note-1", "hello", 3);

        let json = serde_json::to_value(event).expect("serialize event");

        assert_eq!(json["kind"], "provisional_caption");
        assert_eq!(json["sessionId"], "voice-note-1");
        assert_eq!(json["text"], "hello");
        assert_eq!(json["sequence"], 3);
        assert_eq!(json["persisted"], false);
    }
}
