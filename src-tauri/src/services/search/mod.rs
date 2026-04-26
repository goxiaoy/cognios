//! Search sidecar wiring (Phase 1 / Unit 2 — `search-sidecar` only).
//!
//! `llama-server` (the captioning child process) gets its own supervisor
//! in Phase 2 / Unit 4 once the model-manifest layer exists. The two
//! supervisors will share the runtime-file pattern but live in separate
//! files because their argument shapes differ materially.

pub mod runtime_file;
pub mod supervisor;

pub use runtime_file::{read_runtime_file, RuntimeFile, RuntimeFileError};
pub use supervisor::{SearchSidecarSupervisor, SupervisorState};
