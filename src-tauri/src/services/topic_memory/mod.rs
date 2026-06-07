use serde_json::Value;

use crate::domain::topic_memory::TopicMemoryRefreshResultDto;
use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::topic_memory_repository::{
    apply_topic_proposals, TopicProposalBatchInput,
};
use crate::services::search::{SearchSidecarClient, SidecarEnvelope, SidecarEnvelopeState};

pub async fn refresh_from_sidecar(
    db: &Database,
    client: &SearchSidecarClient,
) -> SidecarEnvelope<TopicMemoryRefreshResultDto> {
    let envelope: SidecarEnvelope<Value> = client.topic_memory_proposals().await;
    match envelope.state {
        SidecarEnvelopeState::Ready => {
            let Some(value) = envelope.data else {
                return SidecarEnvelope::unavailable("topic proposal response missing data");
            };
            let batch = match serde_json::from_value::<TopicProposalBatchInput>(value) {
                Ok(batch) => batch,
                Err(error) => {
                    return SidecarEnvelope::unavailable(format!(
                        "invalid topic proposal response: {error}"
                    ));
                }
            };
            let conn = match db.connect() {
                Ok(conn) => conn,
                Err(error) => return SidecarEnvelope::unavailable(error.to_string()),
            };
            match apply_topic_proposals(&conn, &batch) {
                Ok(result) => SidecarEnvelope::ready(result),
                Err(error) => SidecarEnvelope::unavailable(error.to_string()),
            }
        }
        SidecarEnvelopeState::Initialising => SidecarEnvelope::initialising(),
        SidecarEnvelopeState::Unavailable => SidecarEnvelope::unavailable(
            envelope
                .error
                .unwrap_or_else(|| "sidecar unavailable".into()),
        ),
    }
}
