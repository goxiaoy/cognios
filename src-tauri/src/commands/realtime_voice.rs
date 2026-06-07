use tauri::State;

use crate::services::search::{RealtimeVoiceStatusDto, SidecarEnvelope};
use crate::AppState;

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
