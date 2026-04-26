# `src-tauri/binaries/`

Tauri sidecar binaries are placed here at build time. Each entry must be
suffixed with the host triple (e.g. `search-sidecar-aarch64-apple-darwin`)
so Tauri's bundler can find the right one for the target platform.

| Binary | Source | Built by |
|--------|--------|----------|
| `search-sidecar-<host-tuple>` | `sidecar/` (Python; PyInstaller `--onedir`) | `sidecar/packaging/build_macos_arm64.sh` (Phase 5 / Unit 12) |
| `llama-server-<host-tuple>` | Official llama.cpp release | `sidecar/packaging/fetch_llama_server.sh` (Phase 5 / Unit 12) |

In dev mode the runtime supervisor (`src/services/search/supervisor.rs`)
treats a missing binary as `state = Failed { reason: "binary not found",
retryable: false }` and the rest of the app continues to work — search
and captioning are simply unavailable.

`bundle.externalBin` in `tauri.conf.json` lists each binary by its
host-tuple-less name; the matching `shell:allow-execute` and
`shell:allow-spawn` capability scopes are in `capabilities/default.json`.
