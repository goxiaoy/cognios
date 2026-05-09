---
date: 2026-04-12
topic: vfs-node-management
---

# VFS Node Management & Explorer — Milestone 1

## Problem Frame

CogniOS needs a data foundation before any AI features (Topics, Chat, Timeline) can be built. This milestone establishes the Local Virtual File System (VFS) as the single unified layer that ingests user data, and the Explorer as the primary interface for navigating it. Without this, there is no persistent substrate for downstream intelligence.

The three Milestone 1 creation types cover the core ingestion surface: organization (Folder), web content (URL), and local file access (Mount). Folder is the canonical container concept whether it is app-created or mirrored from a mounted local directory; Mount remains a distinct connection/root object. Additional node types from the full product vision (System Logs, Local Chat Threads) are deferred to later milestones.

## Node Creation Flow

```
User
 ├── Create Folder ──────────────────────────────────────────────────┐
 │                                                                    │
 ├── Add URL ──→ Instant Bookmark ──→ [Background: Pipeline Index] ──→│ VFS ──→ Explorer
 │                                                                    │  (tree)
 └── Mount Folder ──→ Apply Ignore Config ─→ FS Watcher (live sync) ─→┘
```

## Requirements

**Folder Nodes**
- R1. Users can create a Folder node with a name. Folders serve as containers and can be nested within other Folders. Circular references (e.g., Folder A nested inside itself) are rejected by the VFS.
- R2. App-created Folders have no filesystem backing and exist purely within the VFS.
- R19. Local directory descendants mirrored under a Mount are also represented as Folder nodes. They are not exposed as a separate `Directory` node type; their mounted origin only changes available operations and safety copy.
- R20. Creating a Folder inside a Mount or mounted Folder creates a real local directory on disk, then refreshes the VFS mirror. Creating a Folder inside an app-created Folder remains VFS-only. Folder creation is rejected when the parent is not a container, the Mount is unavailable, the target path conflicts with an existing file or folder, or the new path would be hidden by the Mount's ignore rules.

**URL Nodes**
- R3. Users can add a URL node by providing a URL. The bookmark is created and visible in the Explorer immediately.
- R4. After creation, URL content is indexed in the background using a pluggable pipeline architecture. Each URL type can have a dedicated processing pipeline registered by scheme or domain pattern. The default web pipeline extracts: structured metadata (title, description, Open Graph tags, canonical URL), a readable text preview, and caches the raw HTML locally. Additional pipelines (e.g., YouTube subtitle extraction) can be registered without modifying core indexing logic.
- R5. URL nodes display their indexing state: `Pending` → `Indexing` → `Indexed`. Failures surface as `Error` with a retry affordance. Failure state persists across app restarts; failed nodes restart from `Pending` on next launch unless the user explicitly retries.

**Mount Nodes**
- R6. Users can mount a local folder as a Mount node. The folder's file tree is mirrored as Folder and file nodes beneath the mount point.
- R7. Each Mount node has a per-mount ignore configuration using gitignore syntax. The configuration is presented as a raw text editor pre-filled with a starter template of common ignore patterns (e.g., `node_modules/`, `.git/`, `dist/`, `*.log`). Files and paths matching ignore patterns are excluded from the VFS mirror.
- R8. The ignore configuration is stored in the app (not in the mounted directory), so it does not pollute the user's filesystem.
- R9. The app watches the mounted directory for filesystem changes (create, delete, rename, modify). The VFS mirror updates in real time without requiring a manual refresh.
- R10. On app restart, Mount nodes resume watching and reconcile any filesystem changes that occurred while the app was closed, including re-evaluating the current ignore configuration against the full directory state so that any changes to the ignore config made between sessions are correctly applied.
- R18. If a mounted directory's path becomes inaccessible (drive ejected, folder deleted, network share offline), the Mount node enters an `Unavailable` state. Existing VFS mirror nodes are preserved in a read-only state. Watching resumes automatically when the path becomes accessible again.

**Node Mutations**
- R16. Users can rename any node (Folder, URL, or Mount). For mounted file and mounted Folder nodes, the rename is applied to the underlying filesystem and the VFS mirror reflects the change.
- R17. Users can delete any node. Behavior by type:
  - **Folder:** If non-empty, the user is prompted to confirm cascade deletion of all children or cancel.
  - **URL:** The bookmark and all cached indexing content are removed.
  - **Mount:** Watching stops and all mirrored VFS nodes are removed. The underlying directory is not affected.
  - **Mounted file or mounted Folder node:** The file or local folder is deleted from the underlying filesystem; the VFS mirror reflects the removal.

**Explorer**
- R11. The Explorer displays all VFS nodes (Folders, URLs, Mounts, and files) as a navigable tree, updating in real time as the VFS changes (see R9 for mount watching, R5 for URL indexing state transitions).
- R12. Breadcrumb navigation reflects the current position within the tree.
- *(R13 removed — merged into R11 during requirements refinement)*
- R14. Each node displays its type and, where applicable, its current state (e.g., `Indexing` for URL nodes, `Unavailable` for inaccessible mounts).

**Persistence**
- R15. All VFS node state persists across app restarts: node metadata, ignore configs, indexing results, and node states (including `Unavailable` for offline mounts and `Error` for failed URL indexing).

## Success Criteria

- A user can create a Folder, add a URL bookmark, and mount a local directory — all visible in the Explorer tree within the same session.
- Adding or deleting a file in a mounted local folder is reflected in the Explorer within ~1 second.
- URL bookmark appears in the Explorer instantly; indexing completes without user interaction.
- A mounted directory containing 10,000+ files with a populated ignore config loads within 3 seconds on reference hardware (M-series Mac).
- Node state (including `Unavailable` and `Error`) survives an app quit and relaunch.
- Renaming or deleting a mounted file or mounted Folder node is reflected both in the Explorer and on disk.
- Creating a Folder under a Mount or mounted Folder creates the corresponding directory on disk and remains visible after mount reconciliation.

## Scope Boundaries

- No AI features: no Topic clustering, no Chat, no Memory Timeline, no Episode Cards.
- No cloud sync or remote storage — all persistence is local to the app.
- No file preview or content rendering within the Explorer (nodes are listed, not opened).
- No drag-and-drop or bulk operations in the Explorer.
- No search or filtering within the Explorer.
- System Logs and Local Chat Thread node types are deferred to later milestones.
- Milestone 1 ships with one built-in indexing pipeline (default web). Additional pipelines (YouTube, etc.) are architected to be pluggable but not bundled until a later milestone.
- No separate user-facing or canonical `Directory` node type. Local directory descendants are represented as Folder nodes under a Mount.

## Key Decisions

- **Tauri (Rust + Web frontend):** Native FS access, file watching, and filesystem mutations via Rust; web layer for the UI.
- **gitignore syntax for Mount ignore config:** Familiar semantics, well-understood by the target audience. Presented as raw text with a starter template to reduce the learning curve for new users.
- **Ignore config stored in-app:** Keeps the mounted directory clean; user's files are untouched.
- **Instant bookmark + background indexing for URLs:** Optimistic UI keeps the app responsive; indexing state is surfaced transparently. Failed states persist across restarts so users can retry at any time.
- **Pluggable URL indexing pipeline:** Default web pipeline caches raw HTML + extracts metadata/preview. Architecture supports per-URL-type pipelines (e.g., YouTube subtitle extraction) without modifying core indexing logic.
- **Mount mutations are bidirectional:** VFS rename/delete operations on mounted file nodes propagate to disk. This makes the VFS a full local file management surface, not a read-only mirror.
- **Mount remains distinct; Directory folds into Folder:** Mount is a local-folder connection/root with watcher, ignore config, availability state, and unlink semantics. Directory is not a separate node type; mounted local subfolders use Folder to match user expectations.
- **Folder creation follows the parent source:** App-created parents create VFS-only Folders; mounted parents create real local directories. This avoids invisible virtual children inside a filesystem-backed tree.
- **Milestone 1 creation types are Folder, URL, Mount:** State machine is `Pending → Indexing → Indexed / Error`. This is the authoritative M1 taxonomy. The PRD's node types (Local Files, System Logs, Local Chat Threads) and `Verified` state belong to the broader product vision and do not apply to M1 implementation; they will be introduced in later milestones.

## Outstanding Questions

### Resolve Before Planning

*(All user decisions from the initial brainstorm have been resolved. No blocking questions remain.)*

### Deferred to Planning

- **[Affects R6, R9] [Technical]** Which Rust file-watching crate and what debounce strategy to use for high-frequency directory changes (e.g., build output folders). The 1-second update criterion must be achievable; debounce window should not exceed 1 second for normal directories.
- **[Affects R15, R19, R20] [Technical]** Persistence backend (likely SQLite) and schema design for VFS nodes, including the parent-child relationship model (whether Folders can contain URL and Mount nodes at the same level) and how mounted Folder capabilities are represented without introducing a separate Directory type.
- **[Affects R11] [Technical]** Frontend framework selection for the Tauri web layer (React, Svelte, SolidJS, etc.). Must support virtualized tree rendering to meet the 3-second load criterion for 10,000+ file mounts.
- **[Affects R10] [Technical]** Reconciliation strategy for changes that occurred while the app was closed (full rescan vs. diff-based). Must also handle ignore-config changes that occurred while the app was closed.
- **[Affects R6] [Needs research]** Performance characteristics for mirrors of very large directories (>50k files) — whether lazy loading or pagination in the tree is needed beyond the 10,000-file baseline.
- **[Affects R4] [Technical]** URL pipeline registry design: how pipelines are registered, selected per URL, and isolated from each other. Milestone 1 ships one built-in pipeline; the registry is the extension point.
- **[Affects R17] [Technical]** Confirmation UX for destructive operations (non-empty Folder delete, mounted file delete). Interaction design for the confirmation prompt.

## Next Steps

-> `-> /ce:plan` for structured implementation planning.
