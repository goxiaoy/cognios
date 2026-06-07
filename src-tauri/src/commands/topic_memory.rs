use tauri::State;

use crate::domain::topic_memory::{
    TopicMemoryDetailDto, TopicMemoryDto, TopicMemoryRefreshResultDto,
};
use crate::infrastructure::db::topic_memory_repository::{
    accept_proposal, archive_topic, dismiss_proposal, get_topic_detail, list_topics,
    list_topics_for_node, ArchiveTopicInput, TopicMemoryInput, TopicMemoryNodeInput,
    TopicProposalActionInput,
};
use crate::services::search::SidecarEnvelope;
use crate::services::topic_memory::refresh_from_sidecar;
use crate::AppState;

#[tauri::command]
pub fn list_topic_memories(state: State<'_, AppState>) -> Result<Vec<TopicMemoryDto>, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    list_topics(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_topic_memories_for_node(
    state: State<'_, AppState>,
    input: TopicMemoryNodeInput,
) -> Result<Vec<TopicMemoryDto>, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    list_topics_for_node(&conn, &input.node_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_topic_memory(
    state: State<'_, AppState>,
    input: TopicMemoryInput,
) -> Result<TopicMemoryDetailDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    get_topic_detail(&conn, &input.topic_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "topic memory does not exist".to_string())
}

#[tauri::command]
pub async fn refresh_topic_memories(
    state: State<'_, AppState>,
) -> Result<SidecarEnvelope<TopicMemoryRefreshResultDto>, String> {
    Ok(refresh_from_sidecar(&state.db, &state.search_client).await)
}

#[tauri::command]
pub fn accept_topic_memory_proposal(
    state: State<'_, AppState>,
    input: TopicProposalActionInput,
) -> Result<TopicMemoryDetailDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    accept_proposal(&conn, &input.proposal_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "topic memory proposal does not exist".to_string())
}

#[tauri::command]
pub fn dismiss_topic_memory_proposal(
    state: State<'_, AppState>,
    input: TopicProposalActionInput,
) -> Result<bool, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    dismiss_proposal(&conn, &input.proposal_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn archive_topic_memory(
    state: State<'_, AppState>,
    input: ArchiveTopicInput,
) -> Result<bool, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    archive_topic(&conn, &input.topic_id).map_err(|error| error.to_string())
}
