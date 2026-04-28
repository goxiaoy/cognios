//! HTTP client for the Python search sidecar.
//!
//! Reads `(port, token)` from the supervisor's `Running` state and
//! issues bearer-authenticated requests to the sidecar's loopback
//! port. Network-level failures and pre-`Running` supervisor states
//! are surfaced as typed [`SidecarEnvelope`] variants rather than as
//! `Err(String)` so the UI can distinguish "still warming up" from
//! "search is broken" without parsing error message text.
//!
//! Phase 2 / Unit 7 part 1 wraps:
//!
//! - `POST /search`
//! - `GET  /index/status`
//! - `GET  /index/status/{node_id}`
//! - `GET  /models/status`
//! - `POST /models/accept-license/{role}`
//!
//! `POST /events/node` (mutation forwarding) and `POST /models/download`
//! (SSE) are deferred — the former needs a synchronous DB query to
//! materialise the absolute_content_path, the latter needs a Tauri-event
//! bridge for streaming progress.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::supervisor::{SearchSidecarSupervisor, SupervisorState};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// All Tauri-facing sidecar commands return one of these envelopes.
///
/// `state` is the discriminator the UI consumer reads first:
/// - `"ready"` — `data` is populated; the call succeeded
/// - `"initialising"` — sidecar exists but isn't yet `Running`. Caller
///   should poll again shortly.
/// - `"unavailable"` — sidecar process is missing or has failed in a
///   way that needs intervention. `error` carries a short reason.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEnvelope<T> {
    pub state: SidecarEnvelopeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SidecarEnvelopeState {
    Ready,
    Initialising,
    Unavailable,
}

impl<T> SidecarEnvelope<T> {
    pub fn ready(data: T) -> Self {
        Self {
            state: SidecarEnvelopeState::Ready,
            data: Some(data),
            error: None,
        }
    }

    pub fn initialising() -> Self {
        Self {
            state: SidecarEnvelopeState::Initialising,
            data: None,
            error: None,
        }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            state: SidecarEnvelopeState::Unavailable,
            data: None,
            error: Some(reason.into()),
        }
    }
}

// ----- mutation forwarding payload (Rust → sidecar /events/node) ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeEventKind {
    NodeChanged,
    NodeDeleted,
}

/// Payload Rust posts to ``POST /events/node`` after a node mutation.
/// Mirrors the sidecar's :class:`NodeEvent` Pydantic model — Python
/// expects snake_case keys, so we serialize as snake_case here.
#[derive(Debug, Clone, Serialize)]
pub struct NodeEvent {
    pub event: NodeEventKind,
    pub node_id: String,
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub absolute_content_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeEventAck {
    pub accepted: bool,
    pub action: String,
}

// ----- DTOs (mirror the sidecar's JSON shapes) ----------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchInput {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Result ordering. Sidecar accepts ``"relevance"`` (default) or
    /// ``"modified"``. Unknown values are coerced to ``"relevance"``
    /// sidecar-side, but Rust passes the raw string through so the UI
    /// can be the source of truth on naming.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    /// Opaque pagination cursor returned in ``nextCursor`` from a
    /// previous page. v1 form is ``offset:N``; treat as opaque.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

// Wire convention for sidecar-bound DTOs:
// - Python emits snake_case JSON (dataclass.asdict / Pydantic default).
// - Rust struct fields are snake_case (Rust idiom).
// - The Tauri webview wants camelCase (TS idiom).
//
// `rename_all(serialize = "camelCase", deserialize = "snake_case")`
// satisfies all three: deserialize from Python's snake_case, serialize
// out to TS as camelCase, struct fields stay Rust-idiomatic.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct SearchResultDto {
    pub node_id: String,
    pub kind: String,
    pub name: String,
    pub score: f64,
    pub snippet: String,
    pub matched_in: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub modified_at: Option<String>,
    /// Inclusive-start, exclusive-end character offsets of query
    /// matches within `snippet`. Sorted, non-overlapping. The
    /// frontend wraps these in `<mark>` spans via React text nodes
    /// only — the offset list is the security-relevant boundary.
    #[serde(default)]
    pub match_offsets: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct SearchResponseDto {
    pub results: Vec<SearchResultDto>,
    pub degraded: bool,
    #[serde(default)]
    pub partial: Option<Value>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct IndexStatusDto {
    pub queue_depth: u64,
    pub in_flight: Vec<String>,
    pub indexed_chunks: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct NodeIndexStatusDto {
    pub node_id: String,
    pub state: String,
    #[serde(default)]
    pub indexed_at: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub attempts: u32,
}

/// Lean per-node summary the resync flow uses to compute the diff
/// against ``cognios.db``. Mirrors the sidecar's ``GET /index/snapshot``
/// response shape — Python keeps it lightweight on purpose.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct IndexSnapshotEntry {
    pub state: String,
    #[serde(default)]
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IndexSnapshotDto {
    pub nodes: HashMap<String, IndexSnapshotEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsStatusDto {
    pub roles: HashMap<String, ModelRoleStatusDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ModelRoleStatusDto {
    pub role: String,
    pub state: String,
    #[serde(default)]
    pub commit: Option<String>,
    pub license_accepted: bool,
    pub requires_acceptance: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseAcceptResponseDto {
    pub accepted: bool,
    pub role: String,
}

// ----- client ------------------------------------------------------------

/// Async HTTP wrapper. One instance is shared across all Tauri commands
/// and lives on `AppState`. The supervisor reference lets every call
/// re-read `(port, token)` from the latest `Running` state — important
/// because a supervisor restart rotates both.
#[derive(Clone)]
pub struct SearchSidecarClient {
    supervisor: Arc<SearchSidecarSupervisor>,
    http: Client,
}

impl SearchSidecarClient {
    pub fn new(supervisor: Arc<SearchSidecarSupervisor>) -> Self {
        let http = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { supervisor, http }
    }

    #[cfg(test)]
    pub fn with_http_client(
        supervisor: Arc<SearchSidecarSupervisor>,
        http: Client,
    ) -> Self {
        Self { supervisor, http }
    }

    fn rendezvous(&self) -> Result<(String, String), SidecarEnvelopeState> {
        match self.supervisor.state() {
            SupervisorState::Running { runtime } => {
                let url = format!("http://127.0.0.1:{}", runtime.port);
                Ok((url, runtime.token))
            }
            SupervisorState::NotStarted | SupervisorState::Spawning => {
                Err(SidecarEnvelopeState::Initialising)
            }
            SupervisorState::Failed { .. } | SupervisorState::Stopped => {
                Err(SidecarEnvelopeState::Unavailable)
            }
        }
    }

    async fn get_envelope<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
    ) -> SidecarEnvelope<T> {
        let (base, token) = match self.rendezvous() {
            Ok(v) => v,
            Err(SidecarEnvelopeState::Initialising) => return SidecarEnvelope::initialising(),
            Err(_) => {
                let reason = self.supervisor_failure_reason();
                return SidecarEnvelope::unavailable(reason);
            }
        };
        let url = format!("{base}{path}");
        match self.http.get(&url).bearer_auth(&token).send().await {
            Ok(resp) => parse_response(resp).await,
            Err(err) => SidecarEnvelope::unavailable(format!("network: {err}")),
        }
    }

    async fn post_envelope<B, T>(&self, path: &str, body: &B) -> SidecarEnvelope<T>
    where
        B: Serialize + ?Sized,
        T: for<'de> Deserialize<'de>,
    {
        let (base, token) = match self.rendezvous() {
            Ok(v) => v,
            Err(SidecarEnvelopeState::Initialising) => return SidecarEnvelope::initialising(),
            Err(_) => {
                let reason = self.supervisor_failure_reason();
                return SidecarEnvelope::unavailable(reason);
            }
        };
        let url = format!("{base}{path}");
        match self
            .http
            .post(&url)
            .bearer_auth(&token)
            .json(body)
            .send()
            .await
        {
            Ok(resp) => parse_response(resp).await,
            Err(err) => SidecarEnvelope::unavailable(format!("network: {err}")),
        }
    }

    fn supervisor_failure_reason(&self) -> String {
        match self.supervisor.state() {
            SupervisorState::Failed { reason, .. } => reason,
            SupervisorState::Stopped => "sidecar stopped".to_string(),
            other => format!("sidecar in unexpected state: {other:?}"),
        }
    }

    // ----- public API ---------------------------------------------------

    pub async fn search(&self, body: &SearchInput) -> SidecarEnvelope<SearchResponseDto> {
        self.post_envelope("/search", body).await
    }

    /// Fire-and-forget forward of a node mutation to the sidecar's
    /// ``POST /events/node`` route. Errors are logged but never bubble
    /// up — the resync ping is the safety net for missed events.
    pub async fn forward_node_event(&self, event: &NodeEvent) {
        if matches!(self.supervisor.state(), SupervisorState::NotStarted | SupervisorState::Spawning) {
            log::debug!("dropping node event for {} (sidecar not yet running)", event.node_id);
            return;
        }
        let envelope: SidecarEnvelope<NodeEventAck> =
            self.post_envelope("/events/node", event).await;
        match envelope.state {
            SidecarEnvelopeState::Ready => {}
            SidecarEnvelopeState::Initialising => {
                log::debug!(
                    "sidecar still initialising; node event for {} will be picked up by next resync",
                    event.node_id
                );
            }
            SidecarEnvelopeState::Unavailable => {
                log::warn!(
                    "sidecar unavailable while forwarding event for {}: {}",
                    event.node_id,
                    envelope.error.as_deref().unwrap_or("(no detail)")
                );
            }
        }
    }

    pub async fn index_status(&self) -> SidecarEnvelope<IndexStatusDto> {
        self.get_envelope("/index/status").await
    }

    pub async fn index_snapshot(&self) -> SidecarEnvelope<IndexSnapshotDto> {
        self.get_envelope("/index/snapshot").await
    }

    pub async fn node_index_status(
        &self,
        node_id: &str,
    ) -> SidecarEnvelope<NodeIndexStatusDto> {
        let path = format!("/index/status/{}", urlencoded(node_id));
        self.get_envelope(&path).await
    }

    pub async fn models_status(&self) -> SidecarEnvelope<ModelsStatusDto> {
        self.get_envelope("/models/status").await
    }

    pub async fn accept_model_license(
        &self,
        role: &str,
    ) -> SidecarEnvelope<LicenseAcceptResponseDto> {
        let path = format!("/models/accept-license/{}", urlencoded(role));
        // The endpoint takes no body; an empty JSON object satisfies
        // the route's body-required contract.
        self.post_envelope(&path, &serde_json::json!({})).await
    }
}

async fn parse_response<T: for<'de> Deserialize<'de>>(
    resp: reqwest::Response,
) -> SidecarEnvelope<T> {
    let status = resp.status();
    if status.is_success() {
        match resp.json::<T>().await {
            Ok(data) => SidecarEnvelope::ready(data),
            Err(err) => SidecarEnvelope::unavailable(format!("decode: {err}")),
        }
    } else if status.as_u16() == 503 {
        SidecarEnvelope::initialising()
    } else if status.as_u16() == 401 {
        SidecarEnvelope::unavailable("authentication failed (token rotated?)")
    } else {
        let body = resp.text().await.unwrap_or_default();
        let trimmed = body.chars().take(200).collect::<String>();
        SidecarEnvelope::unavailable(format!("HTTP {status}: {trimmed}"))
    }
}

/// Tiny URL encoder for the path-segment positions we use (UUIDs and
/// short role names). We don't need the full RFC 3986 surface — just
/// escape the characters the sidecar's path validators would reject.
fn urlencoded(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_serialises_ready_state() {
        let env: SidecarEnvelope<u32> = SidecarEnvelope::ready(42);
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["state"], "ready");
        assert_eq!(json["data"], 42);
        assert!(json.get("error").is_none());
    }

    #[test]
    fn envelope_serialises_initialising() {
        let env: SidecarEnvelope<u32> = SidecarEnvelope::initialising();
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["state"], "initialising");
        assert!(json.get("data").is_none());
    }

    #[test]
    fn envelope_serialises_unavailable_with_reason() {
        let env: SidecarEnvelope<u32> = SidecarEnvelope::unavailable("network");
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["state"], "unavailable");
        assert_eq!(json["error"], "network");
    }

    #[test]
    fn url_encoder_escapes_dangerous_characters() {
        assert_eq!(urlencoded("abc-123"), "abc-123");
        assert_eq!(urlencoded("a/b"), "a%2Fb");
        assert_eq!(urlencoded("a b"), "a%20b");
    }

    /// Pins the wire convention. Python's sidecar emits snake_case;
    /// the Rust DTO must deserialize that, and serialise to camelCase
    /// for the Tauri webview. If this regresses we'll see a Cmd+K
    /// "decode: error decoding response body" again.
    #[test]
    fn search_response_round_trips_snake_to_camel() {
        let from_python = r#"{
            "results": [{
                "node_id": "abc-123",
                "kind": "note",
                "name": "x.md",
                "score": 1.5,
                "snippet": "hello world",
                "matched_in": "content",
                "path": null,
                "modified_at": "2026-04-27T10:00:00Z",
                "match_offsets": [[0, 5]]
            }],
            "degraded": true,
            "partial": null,
            "state": "ready",
            "next_cursor": "offset:50"
        }"#;
        let parsed: SearchResponseDto =
            serde_json::from_str(from_python).expect("snake_case deserialize");
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].node_id, "abc-123");
        assert_eq!(parsed.results[0].matched_in, "content");
        assert_eq!(
            parsed.results[0].modified_at.as_deref(),
            Some("2026-04-27T10:00:00Z")
        );
        assert_eq!(parsed.results[0].match_offsets, vec![(0u32, 5u32)]);
        assert_eq!(parsed.next_cursor.as_deref(), Some("offset:50"));

        let to_ts = serde_json::to_value(&parsed).expect("serialize");
        assert_eq!(to_ts["results"][0]["nodeId"], "abc-123");
        assert_eq!(to_ts["results"][0]["matchedIn"], "content");
        assert_eq!(to_ts["results"][0]["modifiedAt"], "2026-04-27T10:00:00Z");
        assert_eq!(to_ts["results"][0]["matchOffsets"], serde_json::json!([[0, 5]]));
        assert_eq!(to_ts["nextCursor"], "offset:50");
        // Rust idiom keys must NOT leak through to the TS payload.
        assert!(to_ts["results"][0].get("node_id").is_none());
        assert!(to_ts["results"][0].get("matched_in").is_none());
        assert!(to_ts["results"][0].get("modified_at").is_none());
        assert!(to_ts["results"][0].get("match_offsets").is_none());
        assert!(to_ts.get("next_cursor").is_none());
    }

    #[test]
    fn index_status_round_trips_snake_to_camel() {
        let from_python = r#"{"queue_depth": 3, "in_flight": ["a"], "indexed_chunks": 100}"#;
        let parsed: IndexStatusDto = serde_json::from_str(from_python).expect("decode");
        assert_eq!(parsed.queue_depth, 3);
        let to_ts = serde_json::to_value(&parsed).unwrap();
        assert_eq!(to_ts["queueDepth"], 3);
        assert_eq!(to_ts["indexedChunks"], 100);
    }

    #[test]
    fn node_index_status_round_trips_snake_to_camel() {
        let from_python = r#"{
            "node_id": "abc",
            "state": "indexed",
            "indexed_at": "2026-04-27T00:00:00Z",
            "error": null,
            "attempts": 1
        }"#;
        let parsed: NodeIndexStatusDto = serde_json::from_str(from_python).expect("decode");
        assert_eq!(parsed.node_id, "abc");
        let to_ts = serde_json::to_value(&parsed).unwrap();
        assert_eq!(to_ts["nodeId"], "abc");
        assert_eq!(to_ts["indexedAt"], "2026-04-27T00:00:00Z");
    }

    #[test]
    fn model_role_status_round_trips_snake_to_camel() {
        let from_python = r#"{
            "role": "captioner",
            "state": "missing",
            "commit": null,
            "license_accepted": false,
            "requires_acceptance": true,
            "error": null
        }"#;
        let parsed: ModelRoleStatusDto = serde_json::from_str(from_python).expect("decode");
        assert!(!parsed.license_accepted);
        assert!(parsed.requires_acceptance);
        let to_ts = serde_json::to_value(&parsed).unwrap();
        assert_eq!(to_ts["licenseAccepted"], false);
        assert_eq!(to_ts["requiresAcceptance"], true);
        assert!(to_ts.get("license_accepted").is_none());
    }

    #[test]
    fn node_event_serialises_snake_case_for_python() {
        let ev = NodeEvent {
            event: NodeEventKind::NodeChanged,
            node_id: "abc".into(),
            kind: "note".into(),
            name: "x.md".into(),
            absolute_content_path: Some("/tmp/x.md".into()),
            mount_id: None,
            created_at: None,
            updated_at: None,
        };
        let json = serde_json::to_value(&ev).unwrap();
        // Python's Pydantic NodeEvent expects snake_case keys.
        assert_eq!(json["event"], "node_changed");
        assert_eq!(json["node_id"], "abc");
        assert_eq!(json["absolute_content_path"], "/tmp/x.md");
        // Optional fields with None must be skipped.
        assert!(json.get("mount_id").is_none());
    }
}
