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

pub mod advanced_ocr_watcher;
pub mod client;
pub mod forwarder;
pub mod index_state_sync;
#[cfg(debug_assertions)]
pub mod python_dev_watcher;
pub mod runtime_file;
pub mod safe_lifecycle;
pub mod settings_fallback;
pub mod supervisor;

pub use client::{
    ChatContextNodeDto, ChatMemoryContextDto, ChatMemoryRefreshMessageDto,
    ChatMemoryRefreshRequestDto, ChatMemoryRefreshResponseDto, ChatModelsResponseDto,
    ChatProviderTestRequestDto, ChatTurnMessageDto, ChatTurnRequestDto, ChatTurnResponseDto,
    ChatTurnStreamEventDto, FeatureConfigDto, IndexSnapshotDto, IndexSnapshotEntry, IndexStatusDto,
    ModelDownloadEvent, ModelRoleStatusDto, ModelsStatusDto, NodeContentChunkDto, NodeContentDto,
    NodeEvent, NodeEventAck, NodeEventKind, NodeIndexStatusDto, ProviderConfigDto, SearchInput,
    SearchResponseDto, SearchResultDto, SearchSettingsDto, SearchSidecarClient, SidecarEnvelope,
    SidecarEnvelopeState,
};
pub use runtime_file::{read_runtime_file, RuntimeFile, RuntimeFileError};
pub use settings_fallback::read_settings_file_fallback;
pub use supervisor::{SearchSidecarSupervisor, SupervisorState};
