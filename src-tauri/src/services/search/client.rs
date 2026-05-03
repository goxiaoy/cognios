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

/// One transition row from ``GET /index/changes?since=<seq>``.
/// Used by the live-state mirror task to mirror sidecar transitions
/// into ``cognios.db.nodes.state`` without polling the full snapshot
/// (which is O(corpus); this is O(change rate)).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct IndexChangeDto {
    pub node_id: String,
    pub state: String,
    #[serde(default)]
    pub indexed_at: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub transition_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct IndexChangesDto {
    #[serde(default)]
    pub transitions: Vec<IndexChangeDto>,
    /// Largest ``transition_seq`` among ``transitions``. ``0`` means
    /// no new transitions since the requested cursor — caller keeps
    /// its cursor unchanged.
    #[serde(default)]
    pub next_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsStatusDto {
    /// `HashMap` iteration order is non-deterministic, so the JSON
    /// reaches the frontend with rows in shifting order. The frontend
    /// (see `ModelManagerStatus.tsx::sortRoles`) sorts by canonical
    /// role order before render. If the Tauri layer ever needs to
    /// emit a stable order without frontend cooperation, swap to
    /// `IndexMap` (preserves insertion order) or `BTreeMap` (sorted).
    pub roles: HashMap<String, ModelRoleStatusDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ModelRoleStatusDto {
    pub role: String,
    pub state: String,
    /// Upstream model identifier (today: a HuggingFace ``owner/repo``
    /// slug from the sidecar manifest). Surfaced in Settings →
    /// Models so users can cross-reference docs and open the
    /// upstream page. Defaults to empty string for compatibility
    /// with pre-2026-05 sidecars.
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

// ----- Settings DTOs -------------------------------------------------------
//
// Mirror the sidecar's ``SearchSettings`` Pydantic model. Optional /
// new fields use ``#[serde(default)]`` so a payload from an older
// sidecar still parses cleanly.
//
// Wire-format casing is asymmetric on purpose:
//   * Serialize as camelCase — matches the TS idiom on the Tauri
//     webview AND aligns with the sidecar's Pydantic ``populate_
//     by_name`` shape so the same body works for both consumers.
//   * Deserialize accepts BOTH snake_case (from sidecar JSON
//     responses) AND camelCase (from frontend ``invoke`` args) via
//     per-field ``alias`` annotations — without these, the Tauri
//     command boundary fails with ``missing field provider_id``
//     when the frontend rebroadcasts the camelCase payload it
//     just received from a GET.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ProviderConfigDto {
    #[serde(alias = "providerId")]
    pub provider_id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, alias = "apiKeyRef")]
    pub api_key_ref: Option<String>,
    #[serde(default, alias = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(default, alias = "modelPerCapability")]
    pub model_per_capability: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct FeatureConfigDto {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, alias = "providerId")]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct SearchSettingsDto {
    #[serde(default = "default_settings_version")]
    pub version: u32,
    #[serde(default)]
    pub providers: std::collections::HashMap<String, ProviderConfigDto>,
    #[serde(default)]
    pub features: std::collections::HashMap<String, FeatureConfigDto>,
    #[serde(default, alias = "cloudConsentAcked")]
    pub cloud_consent_acked: Vec<String>,
    #[serde(default, alias = "firstRunSkipped")]
    pub first_run_skipped: bool,
    /// Computed by the sidecar route; ``true`` means the on-disk
    /// settings differ from what the running sidecar booted with in
    /// some dispatcher-affecting way. The frontend uses this to
    /// surface the "Restart sidecar to apply" banner.
    #[serde(default, alias = "needsRestart")]
    pub needs_restart: bool,
}

fn default_settings_version() -> u32 {
    1
}

/// One indexed chunk's body — element of `NodeContentDto.chunks`.
///
/// `role` describes what kind of chunk this is for the rendering
/// layer: `"body"` (literal content — text, OCR, PDF text) or
/// `"summary"` (generated description — image captions today,
/// document summaries in the future). Pre-2026-05 sidecar releases
/// did not emit this field; the deserializer defaults to `"body"`
/// so legacy responses still parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct NodeContentChunkDto {
    pub id: String,
    #[serde(default = "default_chunk_role")]
    pub role: String,
    pub text: String,
}

fn default_chunk_role() -> String {
    "body".to_string()
}

/// Indexed text for a single node, used by the image preview surface
/// (and any future "what did the indexer pull from this file" view).
/// Empty for nodes that produced no chunks (image with no extractors,
/// fresh upload before the runner drains).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct NodeContentDto {
    pub node_id: String,
    #[serde(default)]
    pub kind: Option<String>,
    pub chunks: Vec<NodeContentChunkDto>,
    pub joined: String,
}

/// One frame of the ``POST /models/download/{role}`` SSE stream.
///
/// The sidecar emits these as ``data: {json}\n\n`` lines; the client
/// re-emits each as a Tauri ``models/progress`` event so the
/// frontend can drive a progress indicator without polling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ModelDownloadEvent {
    pub role: String,
    pub state: String, // "downloading" | "verifying" | "ready" | "error"
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub bytes_downloaded: u64,
    #[serde(default)]
    pub bytes_total: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
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

    pub async fn index_changes(
        &self,
        since: u64,
        limit: u32,
    ) -> SidecarEnvelope<IndexChangesDto> {
        let path = format!("/index/changes?since={since}&limit={limit}");
        self.get_envelope(&path).await
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

    pub async fn settings_get(&self) -> SidecarEnvelope<SearchSettingsDto> {
        self.get_envelope("/settings").await
    }

    pub async fn settings_put(
        &self,
        body: &SearchSettingsDto,
    ) -> SidecarEnvelope<SearchSettingsDto> {
        let (base, token) = match self.rendezvous() {
            Ok(v) => v,
            Err(SidecarEnvelopeState::Initialising) => {
                return SidecarEnvelope::initialising();
            }
            Err(_) => {
                let reason = self.supervisor_failure_reason();
                return SidecarEnvelope::unavailable(reason);
            }
        };
        let url = format!("{base}/settings");
        match self
            .http
            .put(&url)
            .bearer_auth(&token)
            .json(body)
            .send()
            .await
        {
            Ok(resp) => parse_response(resp).await,
            Err(err) => SidecarEnvelope::unavailable(format!("network: {err}")),
        }
    }

    pub async fn node_content(
        &self,
        node_id: &str,
    ) -> SidecarEnvelope<NodeContentDto> {
        let path = format!("/index/node/{}/content", urlencoded(node_id));
        self.get_envelope(&path).await
    }

    /// Subscribe to the SSE stream from `POST /models/download/{role}`.
    ///
    /// `on_event` fires for each parsed `ModelDownloadEvent` (one per
    /// `data: {...}\n\n` SSE frame) and runs to completion when the
    /// stream closes. `Err` is returned for setup-time failures
    /// (sidecar not running, non-2xx HTTP response, network); per-
    /// event errors arrive via the `state: "error"` payload so the
    /// frontend can react with finer granularity than a `Result`.
    ///
    /// The download timeout is intentionally long — multi-GB models
    /// over a slow connection can run for many minutes. The supervisor
    /// is the backstop for a stuck sidecar; this client just streams.
    pub async fn start_model_download<F>(
        &self,
        role: &str,
        on_event: F,
    ) -> Result<(), String>
    where
        F: Fn(ModelDownloadEvent) + Send + Sync + 'static,
    {
        const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);

        let (base, token) = self.rendezvous().map_err(|state| match state {
            SidecarEnvelopeState::Initialising => {
                "sidecar still initialising".to_string()
            }
            _ => self.supervisor_failure_reason(),
        })?;
        let url = format!("{base}/models/download/{}", urlencoded(role));
        let body = serde_json::json!({});

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&token)
            .timeout(DOWNLOAD_TIMEOUT)
            .header("accept", "text/event-stream")
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("network: {err}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let trimmed: String = body.chars().take(200).collect();
            return Err(format!("HTTP {status}: {trimmed}"));
        }

        let mut resp = resp;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    drain_sse_frames(&mut buf, &on_event);
                }
                Ok(None) => break,
                Err(err) => return Err(format!("stream: {err}")),
            }
        }
        // Drain a trailing partial frame (in case the stream ended
        // without a terminating ``\n\n``). The standard sidecar always
        // appends one, but be defensive.
        if !buf.is_empty() {
            buf.extend_from_slice(b"\n\n");
            drain_sse_frames(&mut buf, &on_event);
        }
        Ok(())
    }
}

/// Pull every complete ``data: {...}\n\n`` frame out of `buf`, parse
/// each as a `ModelDownloadEvent`, and invoke `on_event`. Leaves any
/// partial trailing frame in place for the next chunk.
fn drain_sse_frames<F>(buf: &mut Vec<u8>, on_event: &F)
where
    F: Fn(ModelDownloadEvent),
{
    while let Some(end) = find_double_newline(buf) {
        let frame = buf[..end].to_vec();
        buf.drain(..end + 2);
        let frame_text = match std::str::from_utf8(&frame) {
            Ok(t) => t,
            Err(_) => continue,
        };
        // SSE frame may have multiple lines; we only consume "data:".
        for line in frame_text.split('\n') {
            let payload = match line.strip_prefix("data:") {
                Some(rest) => rest.trim_start(),
                None => continue,
            };
            match serde_json::from_str::<ModelDownloadEvent>(payload) {
                Ok(event) => on_event(event),
                Err(err) => {
                    log::warn!(
                        "models/progress: dropping malformed SSE frame: {err}; payload={payload:?}"
                    );
                }
            }
        }
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
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
            "role": "embedding",
            "state": "missing",
            "repo": "onnx-community/gte-multilingual-base",
            "commit": null,
            "error": null
        }"#;
        let parsed: ModelRoleStatusDto = serde_json::from_str(from_python).expect("decode");
        assert_eq!(parsed.role, "embedding");
        assert_eq!(parsed.repo, "onnx-community/gte-multilingual-base");
        let to_ts = serde_json::to_value(&parsed).unwrap();
        assert_eq!(to_ts["repo"], "onnx-community/gte-multilingual-base");
        // Legacy ``license_accepted`` / ``requires_acceptance`` keys
        // were dropped when the gated-repo path went away — neither
        // serializes anymore.
        assert!(to_ts.get("licenseAccepted").is_none());
        assert!(to_ts.get("requiresAcceptance").is_none());
    }

    #[test]
    fn model_role_status_defaults_repo_for_legacy_payloads() {
        // Pre-2026-05 sidecars omit ``repo`` entirely. The serde
        // default keeps the decode alive; the frontend renders the
        // empty string as a missing repo (no link).
        let legacy = r#"{
            "role": "embedding",
            "state": "missing"
        }"#;
        let parsed: ModelRoleStatusDto = serde_json::from_str(legacy).expect("legacy decode");
        assert_eq!(parsed.repo, "");
    }

    #[test]
    fn search_settings_round_trips_snake_to_camel() {
        let from_python = r#"{
            "version": 1,
            "providers": {
                "openai": {
                    "provider_id": "openai",
                    "enabled": true,
                    "api_key_ref": "keychain://cognios-search/provider:openai",
                    "base_url": null,
                    "model_per_capability": {"embedding": "text-embedding-3-small"}
                }
            },
            "features": {
                "semantic-search": {"enabled": true, "provider_id": "openai"},
                "result-reranking": {"enabled": false, "provider_id": null}
            },
            "cloud_consent_acked": ["openai"],
            "first_run_skipped": false,
            "needs_restart": true
        }"#;
        let parsed: SearchSettingsDto =
            serde_json::from_str(from_python).expect("decode settings");
        assert_eq!(parsed.version, 1);
        assert_eq!(
            parsed.providers["openai"].api_key_ref.as_deref(),
            Some("keychain://cognios-search/provider:openai")
        );
        assert_eq!(
            parsed.features["semantic-search"].provider_id.as_deref(),
            Some("openai")
        );
        assert_eq!(parsed.cloud_consent_acked, vec!["openai".to_string()]);
        assert!(parsed.needs_restart);

        let to_ts = serde_json::to_value(&parsed).unwrap();
        assert_eq!(to_ts["version"], 1);
        assert_eq!(
            to_ts["providers"]["openai"]["providerId"],
            "openai"
        );
        assert_eq!(
            to_ts["providers"]["openai"]["apiKeyRef"],
            "keychain://cognios-search/provider:openai"
        );
        assert_eq!(
            to_ts["features"]["semantic-search"]["providerId"],
            "openai"
        );
        assert_eq!(to_ts["needsRestart"], true);
        assert_eq!(to_ts["firstRunSkipped"], false);
        assert!(to_ts["providers"]["openai"]
            .get("provider_id")
            .is_none());
        assert!(to_ts.get("first_run_skipped").is_none());
        assert!(to_ts.get("needs_restart").is_none());
    }

    #[test]
    fn search_settings_defaults_optional_fields_for_legacy_payloads() {
        // Pre-Phase-1 sidecars (none in the wild) didn't emit
        // ``needs_restart``; the serde default keeps the decode alive.
        let minimal = r#"{
            "version": 1,
            "providers": {},
            "features": {},
            "cloud_consent_acked": [],
            "first_run_skipped": false
        }"#;
        let parsed: SearchSettingsDto =
            serde_json::from_str(minimal).expect("legacy decode");
        assert!(!parsed.needs_restart);
    }

    #[test]
    fn drain_sse_frames_emits_each_complete_frame() {
        let collected = std::sync::Arc::new(std::sync::Mutex::new(
            Vec::<ModelDownloadEvent>::new(),
        ));
        let store = std::sync::Arc::clone(&collected);
        let on_event = move |ev: ModelDownloadEvent| {
            store.lock().unwrap().push(ev);
        };
        let mut buf: Vec<u8> = Vec::new();
        // Two complete frames.
        buf.extend_from_slice(
            br#"data: {"role":"embedding","state":"downloading","file":"a","bytes_downloaded":1024,"bytes_total":2048}
"#,
        );
        buf.push(b'\n');
        buf.extend_from_slice(
            br#"data: {"role":"embedding","state":"verifying","bytes_downloaded":2048,"bytes_total":2048}
"#,
        );
        buf.push(b'\n');
        // A partial trailing frame — must remain in the buffer.
        buf.extend_from_slice(b"data: {\"role\":\"embedding");

        drain_sse_frames(&mut buf, &on_event);

        let collected = collected.lock().unwrap();
        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0].state, "downloading");
        assert_eq!(collected[0].bytes_downloaded, 1024);
        assert_eq!(collected[0].bytes_total, Some(2048));
        assert_eq!(collected[1].state, "verifying");
        // Partial frame stayed in buf for the next chunk to complete.
        assert!(buf.starts_with(b"data: {"));
    }

    #[test]
    fn drain_sse_frames_skips_malformed_payloads() {
        let count = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let n = std::sync::Arc::clone(&count);
        let on_event = move |_ev: ModelDownloadEvent| {
            *n.lock().unwrap() += 1;
        };
        let mut buf = Vec::new();
        buf.extend_from_slice(b"data: {garbage json\n\n");
        buf.extend_from_slice(
            br#"data: {"role":"embedding","state":"downloading"}
"#,
        );
        buf.push(b'\n');
        drain_sse_frames(&mut buf, &on_event);
        // Only the well-formed frame counts; the bad one is dropped.
        assert_eq!(*count.lock().unwrap(), 1);
    }

    #[test]
    fn node_content_round_trips_role_through_snake_camel() {
        let from_python = r#"{
            "node_id": "img-1",
            "kind": "file",
            "chunks": [
                {"id": "img-1:0", "role": "body", "text": "OCR text"},
                {"id": "img-1:summary:0", "role": "summary", "text": "A diagram."}
            ],
            "joined": "OCR text\n\nA diagram."
        }"#;
        let parsed: NodeContentDto =
            serde_json::from_str(from_python).expect("decode node content");
        assert_eq!(parsed.chunks.len(), 2);
        assert_eq!(parsed.chunks[0].role, "body");
        assert_eq!(parsed.chunks[1].role, "summary");

        let to_ts = serde_json::to_value(&parsed).unwrap();
        assert_eq!(to_ts["nodeId"], "img-1");
        assert_eq!(to_ts["chunks"][0]["role"], "body");
        assert_eq!(to_ts["chunks"][1]["role"], "summary");
        // ``role`` is a single word — no camelCase rename should
        // mangle it. Asserting both spellings catches a future
        // typo in the rename rule.
        assert!(to_ts["chunks"][0].get("role").is_some());
    }

    #[test]
    fn node_content_chunk_defaults_role_to_body_for_legacy_payloads() {
        // Pre-2026-05 sidecars don't emit ``role`` at all. The
        // serde default keeps these decodes alive.
        let legacy = r#"{
            "node_id": "old-node",
            "chunks": [{"id": "old-node:0", "text": "hello"}],
            "joined": "hello"
        }"#;
        let parsed: NodeContentDto =
            serde_json::from_str(legacy).expect("legacy decode");
        assert_eq!(parsed.chunks[0].role, "body");
    }

    #[test]
    fn model_download_event_round_trips_snake_to_camel() {
        let from_python = r#"{
            "role": "embedding",
            "state": "downloading",
            "file": "onnx/model_int8.onnx",
            "bytes_downloaded": 12345,
            "bytes_total": 100000,
            "error": null
        }"#;
        let parsed: ModelDownloadEvent =
            serde_json::from_str(from_python).expect("decode");
        assert_eq!(parsed.role, "embedding");
        assert_eq!(parsed.bytes_downloaded, 12345);
        let to_ts = serde_json::to_value(&parsed).unwrap();
        assert_eq!(to_ts["bytesDownloaded"], 12345);
        assert_eq!(to_ts["bytesTotal"], 100000);
        assert!(to_ts.get("bytes_downloaded").is_none());
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
