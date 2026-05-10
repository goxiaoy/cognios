use serde::{Deserialize, Serialize};
use tauri::State;

use crate::domain::chat::{
    ChatMessageDto, ChatSessionDetailDto, ChatSessionDto, ChatSourceClusterDto,
};
use crate::infrastructure::db::chat_repository::{
    append_message, bind_note, create_session, delete_session, get_session_detail, list_sessions,
    record_cluster, AppendChatMessageInput, BindChatNoteInput, CreateChatSessionInput,
    DeleteChatSessionResult, RecordChatClusterInput,
};
use crate::services::chat::live_note::update_live_note;
use crate::services::search::{
    ChatModelsResponseDto, ChatTurnMessageDto, ChatTurnRequestDto, ChatTurnResponseDto,
    SidecarEnvelope, SidecarEnvelopeState,
};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionInput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartChatTurnInput {
    pub session_id: String,
    pub query: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub accepted_cluster_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub include_web: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartChatTurnResult {
    pub turn: SidecarEnvelope<ChatTurnResponseDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetChatModelsResult {
    pub models: SidecarEnvelope<ChatModelsResponseDto>,
}

#[tauri::command]
pub fn create_chat_session(
    state: State<'_, AppState>,
    input: CreateChatSessionInput,
) -> Result<ChatSessionDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    create_session(&conn, &input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_chat_sessions(state: State<'_, AppState>) -> Result<Vec<ChatSessionDto>, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    list_sessions(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_chat_session(
    state: State<'_, AppState>,
    input: ChatSessionInput,
) -> Result<ChatSessionDetailDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    get_session_detail(&conn, &input.session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "chat session does not exist".to_string())
}

#[tauri::command]
pub fn delete_chat_session(
    state: State<'_, AppState>,
    input: ChatSessionInput,
) -> Result<DeleteChatSessionResult, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    delete_session(&conn, &input.session_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn append_chat_message(
    state: State<'_, AppState>,
    input: AppendChatMessageInput,
) -> Result<ChatMessageDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    append_message(&conn, &input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn record_chat_cluster(
    state: State<'_, AppState>,
    input: RecordChatClusterInput,
) -> Result<ChatSourceClusterDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    record_cluster(&conn, &input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn bind_chat_note(
    state: State<'_, AppState>,
    input: BindChatNoteInput,
) -> Result<ChatSessionDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    bind_note(&conn, &input).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn start_chat_turn(
    state: State<'_, AppState>,
    input: StartChatTurnInput,
) -> Result<StartChatTurnResult, String> {
    let mut conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let accepted_cluster_ids = input.accepted_cluster_ids.clone();
    let user_content = input.query.clone();
    let should_persist_user_message = accepted_cluster_ids.is_empty();
    if should_persist_user_message {
        append_message(
            &conn,
            &AppendChatMessageInput {
                session_id: input.session_id.clone(),
                role: "user".into(),
                body: user_content.clone(),
                metadata_json: Some(r#"{"stage":"submitted"}"#.into()),
            },
        )
        .map_err(|error| error.to_string())?;
    }

    let turn = state
        .search_client
        .chat_turn(&ChatTurnRequestDto {
            query: input.query,
            messages: vec![ChatTurnMessageDto {
                role: "user".into(),
                content: user_content,
            }],
            accepted_cluster_ids,
            include_web: input.include_web,
            model: input.model,
        })
        .await;

    if matches!(turn.state, SidecarEnvelopeState::Ready) {
        if let Some(data) = &turn.data {
            let notes_dir = state.storage_dir.join("notes");
            let emitter = state.emitter.as_ref();
            persist_turn_response(
                &mut conn,
                &input.session_id,
                data,
                &notes_dir,
                emitter,
                should_persist_user_message,
            )?;
        }
    }

    Ok(StartChatTurnResult { turn })
}

#[tauri::command]
pub async fn get_chat_models(state: State<'_, AppState>) -> Result<GetChatModelsResult, String> {
    Ok(GetChatModelsResult {
        models: state.search_client.chat_models().await,
    })
}

fn persist_turn_response(
    conn: &mut rusqlite::Connection,
    session_id: &str,
    data: &ChatTurnResponseDto,
    notes_dir: &std::path::Path,
    emitter: &dyn Fn(crate::services::mounts::watcher::VfsChangeEvent),
    persist_clusters: bool,
) -> Result<(), String> {
    if persist_clusters {
        for cluster in &data.clusters {
            let sources_json =
                serde_json::to_string(&cluster.sources).map_err(|error| error.to_string())?;
            record_cluster(
                conn,
                &RecordChatClusterInput {
                    session_id: session_id.to_string(),
                    turn_message_id: None,
                    title: cluster.title.clone(),
                    source_kind: cluster.source_kind.clone(),
                    status: cluster.status.clone(),
                    summary: cluster.summary.clone(),
                    score: cluster.score,
                    sources_json: Some(sources_json),
                },
            )
            .map_err(|error| error.to_string())?;
        }
    }
    if let Some(answer) = &data.answer {
        let note_id = update_live_note(
            conn,
            session_id,
            answer,
            &data.citations,
            notes_dir,
            emitter,
        )?;
        let metadata_json = serde_json::json!({
            "stage": data.state,
            "citations": data.citations,
            "provider": data.provider,
            "warnings": data.warnings,
            "liveNoteId": note_id,
        })
        .to_string();
        append_message(
            conn,
            &AppendChatMessageInput {
                session_id: session_id.to_string(),
                role: "assistant".into(),
                body: answer.clone(),
                metadata_json: Some(metadata_json),
            },
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn default_true() -> bool {
    true
}
