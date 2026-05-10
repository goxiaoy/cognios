use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::domain::chat::{
    ChatMessageDto, ChatSessionDetailDto, ChatSessionDto, ChatSourceClusterDto,
};
use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::chat_repository::{
    append_message, bind_note, create_session, delete_session, get_session_detail, list_sessions,
    record_cluster, update_session_title, AppendChatMessageInput, BindChatNoteInput,
    CreateChatSessionInput, DeleteChatSessionResult, RecordChatClusterInput,
    UpdateChatSessionTitleInput,
};
use crate::infrastructure::db::connection::Database;
use crate::services::chat::session_memory::{
    begin_refresh, bounded_prompt_messages, complete_refresh, delete_session_memory,
    estimate_text_tokens, fail_refresh, memory_root, read_verified_body, record_successful_turn,
    sanitize_generated_markdown, should_schedule_refresh, MemoryRefreshJob, RefreshReason,
};
use crate::services::notes::create_note::{create_note_with_body, CreateNoteInput};
use crate::services::search::{
    ChatContextNodeDto, ChatMemoryContextDto, ChatMemoryRefreshMessageDto,
    ChatMemoryRefreshRequestDto, ChatMemoryRefreshResponseDto, ChatModelsResponseDto,
    ChatProviderTestRequestDto, ChatTurnMessageDto, ChatTurnRequestDto, ChatTurnResponseDto,
    ChatTurnStreamEventDto, SearchSidecarClient, SidecarEnvelope, SidecarEnvelopeState,
};
use crate::AppState;

pub const CHAT_TURN_EVENT: &str = "chat/turn";
pub const CHAT_MEMORY_EVENT: &str = "chat/session-memory";
const MEMORY_REFRESH_TIMEOUT: Duration = Duration::from_secs(4 * 60 + 10);

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
    pub turn_event_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub accepted_cluster_ids: Vec<String>,
    #[serde(default = "default_true")]
    pub include_web: bool,
    #[serde(default)]
    pub context_nodes: Vec<ChatContextNodeDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartChatTurnResult {
    pub turn: SidecarEnvelope<ChatTurnResponseDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionMemoryEventPayload {
    pub session_id: String,
    pub revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetChatSessionMemoryResult {
    pub available: bool,
    pub body: Option<String>,
    pub revision: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChatSessionMemoryResult {
    pub note_id: String,
    pub snapshot: ExplorerSnapshotDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerChatSessionMemoryOpportunityInput {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnStreamPayload {
    pub turn_event_id: String,
    pub event: ChatTurnStreamEventDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetChatModelsResult {
    pub models: SidecarEnvelope<ChatModelsResponseDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestChatProviderInput {
    pub provider_id: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestChatProviderResult {
    pub result: SidecarEnvelope<ChatModelsResponseDto>,
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
pub fn get_chat_session_memory(
    state: State<'_, AppState>,
    input: ChatSessionInput,
) -> Result<GetChatSessionMemoryResult, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let root = memory_root(&state.storage_dir);
    let Some(memory) = read_verified_body(&conn, &root, &input.session_id)? else {
        return Ok(GetChatSessionMemoryResult {
            available: false,
            body: None,
            revision: None,
        });
    };
    Ok(GetChatSessionMemoryResult {
        available: true,
        body: Some(memory.body),
        revision: Some(memory.revision),
    })
}

#[tauri::command]
pub fn export_chat_session_memory(
    state: State<'_, AppState>,
    input: ChatSessionInput,
) -> Result<ExportChatSessionMemoryResult, String> {
    let mut conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let root = memory_root(&state.storage_dir);
    let memory = read_verified_body(&conn, &root, &input.session_id)?
        .ok_or_else(|| "Session Memory is not available yet.".to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let body = sanitize_generated_markdown(&memory.body);
    let created = create_note_with_body(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &body,
        state.emitter.as_ref(),
    )?;
    Ok(ExportChatSessionMemoryResult {
        note_id: created.node_id,
        snapshot: created.snapshot,
    })
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
    let root = memory_root(&state.storage_dir);
    delete_session_memory(&conn, &root, &input.session_id)?;
    delete_session(&conn, &input.session_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_chat_session_title(
    state: State<'_, AppState>,
    input: UpdateChatSessionTitleInput,
) -> Result<ChatSessionDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    update_session_title(&conn, &input).map_err(|error| error.to_string())
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
    app: tauri::AppHandle,
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
        let context_metadata: Vec<serde_json::Value> = input
            .context_nodes
            .iter()
            .map(|node| {
                serde_json::json!({
                    "nodeId": node.node_id,
                    "title": node.title,
                    "kind": node.kind,
                    "path": node.path,
                })
            })
            .collect();
        append_message(
            &conn,
            &AppendChatMessageInput {
                session_id: input.session_id.clone(),
                role: "user".into(),
                body: user_content.clone(),
                metadata_json: Some(
                    serde_json::json!({
                        "stage": "submitted",
                        "contextNodes": context_metadata,
                    })
                    .to_string(),
                ),
            },
        )
        .map_err(|error| error.to_string())?;
    }
    let detail = get_session_detail(&conn, &input.session_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "chat session does not exist".to_string())?;
    let memory = read_verified_body(&conn, &memory_root(&state.storage_dir), &input.session_id)?;
    let messages = bounded_prompt_messages(&detail.messages, memory.as_ref())
        .into_iter()
        .map(|message| ChatTurnMessageDto {
            role: message.role,
            content: message.body,
        })
        .collect();
    let session_memory = memory.as_ref().map(|memory| ChatMemoryContextDto {
        body: memory.body.clone(),
        revision: memory.revision,
        last_included_message_ordinal: memory.last_included_message_ordinal,
    });
    let selected_model = input.model.clone();

    let turn_request = ChatTurnRequestDto {
        query: input.query,
        messages,
        session_memory,
        accepted_cluster_ids,
        include_web: input.include_web,
        model: selected_model.clone(),
        context_nodes: input.context_nodes,
    };
    let turn_event_id = input
        .turn_event_id
        .unwrap_or_else(|| format!("legacy-{}", input.session_id));
    let emit_turn_event_id = turn_event_id.clone();
    let emit_app = app.clone();

    let turn = state
        .search_client
        .chat_turn_stream(&turn_request, move |event| {
            if let Err(err) = emit_app.emit(
                CHAT_TURN_EVENT,
                ChatTurnStreamPayload {
                    turn_event_id: emit_turn_event_id.clone(),
                    event,
                },
            ) {
                log::warn!("failed to emit {CHAT_TURN_EVENT}: {err}");
            }
        })
        .await;

    if matches!(turn.state, SidecarEnvelopeState::Ready) {
        if let Some(data) = &turn.data {
            let assistant = persist_turn_response(
                &mut conn,
                &input.session_id,
                data,
                should_persist_user_message,
            )?;
            if let Some(assistant) = assistant {
                let provider_id = provider_field(data, "providerId");
                let model_id = provider_field(data, "model")
                    .or_else(|| selected_model.as_deref().map(str::to_string));
                let should_refresh = record_successful_turn(
                    &conn,
                    &input.session_id,
                    provider_id.as_deref(),
                    model_id.as_deref(),
                    estimate_text_tokens(&assistant.body),
                )?;
                if should_refresh {
                    log::info!(
                        "session memory refresh scheduled after successful turn: session_id={} provider_id={:?} model_id={:?}",
                        input.session_id,
                        provider_id,
                        model_id
                    );
                    spawn_memory_refresh(
                        app.clone(),
                        state.db.clone(),
                        state.storage_dir.clone(),
                        Arc::clone(&state.search_client),
                        input.session_id.clone(),
                    );
                }
            }
        }
    }

    Ok(StartChatTurnResult { turn })
}

#[tauri::command]
pub fn trigger_chat_session_memory_opportunity(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: TriggerChatSessionMemoryOpportunityInput,
) -> Result<(), String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let reason = match input.reason.as_str() {
        "session_switch" => RefreshReason::SessionSwitch,
        "idle" => RefreshReason::Idle,
        _ => RefreshReason::Idle,
    };
    if should_schedule_refresh(&conn, &input.session_id, reason)? {
        log::info!(
            "session memory refresh scheduled by opportunity: session_id={} reason={:?}",
            input.session_id,
            reason
        );
        spawn_memory_refresh(
            app,
            state.db.clone(),
            state.storage_dir.clone(),
            Arc::clone(&state.search_client),
            input.session_id,
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn get_chat_models(state: State<'_, AppState>) -> Result<GetChatModelsResult, String> {
    Ok(GetChatModelsResult {
        models: state.search_client.chat_models().await,
    })
}

#[tauri::command]
pub async fn test_chat_provider(
    state: State<'_, AppState>,
    input: TestChatProviderInput,
) -> Result<TestChatProviderResult, String> {
    Ok(TestChatProviderResult {
        result: state
            .search_client
            .chat_provider_test(&ChatProviderTestRequestDto {
                provider_id: input.provider_id,
                base_url: input.base_url,
            })
            .await,
    })
}

fn persist_turn_response(
    conn: &mut rusqlite::Connection,
    session_id: &str,
    data: &ChatTurnResponseDto,
    persist_clusters: bool,
) -> Result<Option<ChatMessageDto>, String> {
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
        let metadata_json = serde_json::json!({
            "stage": data.state,
            "citations": data.citations,
            "provider": data.provider,
            "warnings": data.warnings,
        })
        .to_string();
        let message = append_message(
            conn,
            &AppendChatMessageInput {
                session_id: session_id.to_string(),
                role: "assistant".into(),
                body: answer.clone(),
                metadata_json: Some(metadata_json),
            },
        )
        .map_err(|error| error.to_string())?;
        return Ok(Some(message));
    }
    Ok(None)
}

pub(crate) fn spawn_memory_refresh(
    app: tauri::AppHandle,
    db: Database,
    storage_dir: std::path::PathBuf,
    search_client: Arc<SearchSidecarClient>,
    session_id: String,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            run_memory_refresh(app, db, storage_dir, search_client, session_id.clone()).await
        {
            log::warn!("session memory refresh failed for {session_id}: {error}");
        }
    });
}

async fn run_memory_refresh(
    app: tauri::AppHandle,
    db: Database,
    storage_dir: std::path::PathBuf,
    search_client: Arc<SearchSidecarClient>,
    session_id: String,
) -> Result<(), String> {
    let root = memory_root(&storage_dir);
    let job = {
        let conn = db
            .connect()
            .map_err(|error: rusqlite::Error| error.to_string())?;
        begin_refresh(&conn, &root, &session_id)?
    };
    let Some(job) = job else {
        log::info!("session memory refresh skipped: session_id={session_id} reason=no_job");
        return Ok(());
    };
    log::info!(
        "session memory refresh started: session_id={} revision={} messages={} dirty_round_count={} dirty_token_count={} provider_id={:?} model_id={:?}",
        job.session_id,
        job.revision,
        job.messages.len(),
        job.dirty_round_count,
        job.dirty_token_count,
        job.provider_id,
        job.model_id
    );

    let request = memory_refresh_request(&job);
    let conn = db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let envelope: SidecarEnvelope<ChatMemoryRefreshResponseDto> = match tokio::time::timeout(
        MEMORY_REFRESH_TIMEOUT,
        search_client.chat_memory_refresh(&request),
    )
    .await
    {
        Ok(envelope) => envelope,
        Err(_) => {
            log::warn!(
                "session memory refresh timed out: session_id={} revision={} timeout_seconds={}",
                job.session_id,
                job.revision,
                MEMORY_REFRESH_TIMEOUT.as_secs()
            );
            fail_refresh(&conn, &job, "session memory refresh timed out")?;
            return Ok(());
        }
    };
    let data = match envelope.state {
        SidecarEnvelopeState::Ready => envelope.data,
        SidecarEnvelopeState::Initialising => {
            log::warn!(
                "session memory refresh failed: session_id={} revision={} reason=sidecar_initialising",
                job.session_id,
                job.revision
            );
            fail_refresh(&conn, &job, "sidecar initialising")?;
            return Ok(());
        }
        SidecarEnvelopeState::Unavailable => {
            let reason = envelope.error.as_deref().unwrap_or("sidecar unavailable");
            log::warn!(
                "session memory refresh failed: session_id={} revision={} reason={}",
                job.session_id,
                job.revision,
                reason
            );
            fail_refresh(&conn, &job, reason)?;
            return Ok(());
        }
    };
    let Some(data) = data else {
        log::warn!(
            "session memory refresh failed: session_id={} revision={} reason=empty_response",
            job.session_id,
            job.revision
        );
        fail_refresh(&conn, &job, "empty session memory response")?;
        return Ok(());
    };
    if data.state != "ready" {
        let reason = data
            .warnings
            .first()
            .map(String::as_str)
            .unwrap_or("session memory refresh failed");
        log::warn!(
            "session memory refresh failed: session_id={} revision={} reason={}",
            job.session_id,
            job.revision,
            reason
        );
        fail_refresh(&conn, &job, reason)?;
        return Ok(());
    }
    let Some(body) = data.body.as_deref() else {
        log::warn!(
            "session memory refresh failed: session_id={} revision={} reason=missing_body",
            job.session_id,
            job.revision
        );
        fail_refresh(&conn, &job, "session memory body missing")?;
        return Ok(());
    };
    let provider_id = data
        .provider
        .as_ref()
        .and_then(|provider| provider.get("providerId"))
        .and_then(|value| value.as_str());
    let model_id = data
        .provider
        .as_ref()
        .and_then(|provider| provider.get("model"))
        .and_then(|value| value.as_str());
    let revision = match complete_refresh(
        &conn,
        &root,
        &job,
        body,
        data.last_included_message_ordinal
            .unwrap_or(job.last_message_ordinal),
        provider_id,
        model_id,
    ) {
        Ok(revision) => revision,
        Err(error) => {
            let _ = fail_refresh(&conn, &job, &error);
            return Err(error);
        }
    };
    log::info!(
        "session memory refresh completed: session_id={} revision={} included_message_ordinal={}",
        job.session_id,
        revision,
        data.last_included_message_ordinal
            .unwrap_or(job.last_message_ordinal)
    );
    let _ = app.emit(
        CHAT_MEMORY_EVENT,
        ChatSessionMemoryEventPayload {
            session_id: session_id.clone(),
            revision,
        },
    );
    if should_schedule_refresh(&conn, &job.session_id, RefreshReason::Idle)? {
        spawn_memory_refresh(app, db, storage_dir, search_client, job.session_id.clone());
    }
    Ok(())
}

fn memory_refresh_request(job: &MemoryRefreshJob) -> ChatMemoryRefreshRequestDto {
    ChatMemoryRefreshRequestDto {
        previous_memory: job.previous_memory.clone(),
        messages: job
            .messages
            .iter()
            .map(|message| ChatMemoryRefreshMessageDto {
                role: message.role.clone(),
                content: message.content.clone(),
                ordinal: message.ordinal,
            })
            .collect(),
        provider_id: job.provider_id.clone(),
        model: job.model_id.clone(),
    }
}

fn provider_field(data: &ChatTurnResponseDto, key: &str) -> Option<String> {
    data.provider
        .as_ref()
        .and_then(|provider| provider.get(key))
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn default_true() -> bool {
    true
}
