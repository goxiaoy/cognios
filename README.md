# CogniOS

Local-first desktop memory substrate built with Tauri, Rust, React, and Vite.

Current milestone:
- Virtual folder nodes
- URL bookmark nodes with background indexing
- Local directory mounts with ignore config, restart reconciliation, unavailable-state handling, and live sync
- Explorer UI with breadcrumbs, inspector actions, rename/delete flows, and real-time refresh from backend events

## Stack

- Desktop shell: Tauri v2
- Backend: Rust + SQLite
- Frontend: React + TypeScript + Vite
- Storage:
  - SQLite database: `~/.cogios/cognios.db`
  - URL HTML cache: `~/.cogios/url-cache/`

## Development

Install dependencies:

```bash
npm install --cache .npm-cache
```

Run the desktop app:

```bash
npm run tauri:dev
```

Run frontend tests:

```bash
npm test
```

Run Rust tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Build the frontend bundle:

```bash
npm run build
```

## Key Paths

- Frontend entry: `src/app/App.tsx`
- Explorer feature: `src/features/explorer/`
- Tauri entry: `src-tauri/src/lib.rs`
- Migrations: `src-tauri/migrations/`
- Current implementation plan: `docs/plans/2026-04-12-001-feat-vfs-node-management-plan.md`
