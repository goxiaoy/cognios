//! Search sidecar wiring.
//!
//! - `runtime_file` — parser for the `(port, token)` rendezvous file.
//! - `supervisor` — spawns + supervises the Python `search-sidecar`.
//! - `client` — async HTTP wrapper Tauri commands call into.
//!
//! `llama-server` (the captioning child process) gets its own
//! supervisor in a Phase 2 follow-up; the two will share this
//! runtime-file pattern but live in separate files because their
//! argument shapes differ materially.

pub mod client;
pub mod forwarder;
pub mod runtime_file;
pub mod supervisor;

pub use client::{
    IndexStatusDto, LicenseAcceptResponseDto, ModelRoleStatusDto, ModelsStatusDto,
    NodeEvent, NodeEventAck, NodeEventKind, NodeIndexStatusDto, SearchInput,
    SearchResponseDto, SearchResultDto, SearchSidecarClient, SidecarEnvelope,
    SidecarEnvelopeState,
};
pub use runtime_file::{read_runtime_file, RuntimeFile, RuntimeFileError};
pub use supervisor::{SearchSidecarSupervisor, SupervisorState};
