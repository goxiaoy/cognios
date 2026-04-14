---
title: "feat: Add notes node type"
type: feat
status: active
date: 2026-04-14
origin: docs/brainstorms/notes-node-type-requirements.md
---

# feat: Add notes node type

## Overview

Introduce a `note` node kind so users can create and edit first-party markdown content inside the app without leaving the Explorer. Notes are stored as flat UUID-keyed `.md` files in `~/.cogios/notes/`, with titles stored only in the `nodes` table. The Explorer gets a full-page editor view (title field + CodeMirror markdown body + auto-save), wired into the existing tree, inline rename, inspector, and IPC snapshot conventions already established for other node kinds.

## Problem Frame

Cognios currently organizes external content — filesystem mounts, URLs, and their folder hierarchies — but provides no way to create first-party written content. This leaves a gap: users who want a research note, a summary, or a scratch pad alongside their organized resources have to leave the app. A `note` node type closes this gap while staying consistent with the existing tree, creation flow, and mutation model (see origin: `docs/brainstorms/notes-node-type-requirements.md`).

The planning challenge is not the editor widget alone. Several concerns must be coordinated: the Rust domain layer needs a new `NodeKind` variant before any backend command can use it; the `notes/` directory must be created at startup; auto-save requires a synchronous flush on navigation, tree-click, back-button, and window close; and every existing exhaustive switch on `NodeKind` — in Rust, TypeScript, and the presentation utilities — must be extended atomically to avoid compile errors or runtime no-ops.

## Requirements Trace

- R1. `note` kind added to `NodeKind` enum in Rust and TypeScript union.
- R2. Note content persisted as `<storage_dir>/notes/{id}.md`.
- R3. Title stored only in `nodes.name`; `.md` file body contains only markdown.
- R4. Notes nestable under any node that supports children.
- R5. "New Note" creation action in the Explorer.
- R6. Create immediately with name "Untitled", activate inline rename; Escape commits as "Untitled".
- R7. Empty `.md` file created on disk at node creation time.
- R8. Double-click opens full-page editor; single-click shows inspector only; back button and tree-node click exit editor.
- R9. Editor presents large title field, "Stored locally on your device" label, and markdown body area.
- R10. Title committed on blur; rename is a single DB write; title = `nodes.name` always.
- R11. Body auto-saves after debounce; no save button.
- R12. Navigation triggers synchronous flush before view transition; flush error blocks navigation.
- R13. Notes appear with a distinct icon in tree and content grid.
- R14. Inspector shows name, created date, modified date, and `.md` file size in bytes.
- R15. Rename, delete, and move work consistently with other node kinds.
- R16. App quit / window close triggers synchronous flush before the process exits.

## Scope Boundaries

- No markdown preview or render mode (plain markdown input only; preview is an explicit future iteration).
- No rich text / WYSIWYG editor.
- No full-text search or indexing of note content.
- No sync, backup, or sharing.
- No note templates, front-matter support, or tagging beyond existing node metadata.
- The `.md` file contains only the body; title is never written to the file.

## Context & Research

### Relevant Code and Patterns

- `src-tauri/src/domain/vfs/node.rs` — `NodeKind` enum with `Folder/Url/Mount/Directory/File` variants; `from_db` uses a catch-all `_ => Self::Folder`. Add `Note` before the catch-all to avoid all existing "note" rows silently becoming Folder.
- `src-tauri/migrations/0001_initial.sql` — `nodes` table has `kind TEXT NOT NULL` with no CHECK constraint, so adding `"note"` as a kind value requires no schema migration. Confirmed: kind is free-text.
- `src-tauri/src/lib.rs` — `storage_dir_from_home` returns `home_dir.join(".cogios")` (single 'n'). Startup already creates `.cogios/` and `url-cache/`; it does **not** create `notes/`. Must add `fs::create_dir_all(app_data_dir.join("notes"))` to the startup block.
- `src-tauri/src/services/mutations/delete_node.rs` — exhaustive `match` on `NodeKind`; will fail to compile once `Note` is added until a Note arm is added that deletes the `.md` file before the DB record.
- `src/lib/contracts/vfs.ts` — `NodeKind = "folder" | "url" | "mount" | "directory" | "file"`; `CreateFolderInput` is the template shape for `CreateNoteInput`.
- `src/lib/tauri/ipc.ts` — all mutations follow `invoke<ExplorerSnapshot>("command_name", { input })` pattern; need `createNote`, `getNoteContent`, `saveNoteContent`.
- `src/features/explorer/components/ExplorerLayout.tsx` — `handleFolderCreate` is the blueprint for `handleNoteCreate`: calls `store.runAction`, applies snapshot, finds new node ID via `findNewId`, calls `setPendingInlineRenameId`. No existing detail-view state; must add `activeNoteId` via the store.
- `src/features/explorer/store/useExplorerStore.ts` — `activateArtifact` currently short-circuits for non-folder nodes (`if (!node || !isDisplayFolder(node)) return`). Must add a Note branch that sets `activeNoteId` in the store instead of navigating into a folder.
- `src/features/explorer/components/CreateMenu.tsx` — `CreateAction = "mount" | "folder" | "url"`; `MENU_ITEMS` array drives what appears in the menu; add `"note"` and a "New Note" entry.
- `src/features/explorer/utils/presentation.ts` — exhaustive switch blocks for `nodeIconComponent`, `formatNodeKindLabel`, `nodeGlyph`; TypeScript will enforce completeness after the union is updated. `FileText` from `lucide-react` is a suitable note icon (consistent with existing icon set).
- `src/features/explorer/components/ExplorerInspector.tsx` — already renders metadata fields per node kind; needs a note branch showing name, `created_at`, `modified_at`, and size from the node record.
- Tauri window close: no existing `onCloseRequested` handler in the codebase. Must register via `getCurrentWindow().onCloseRequested()` from `@tauri-apps/api/window` on the JS side from `ExplorerLayout` (which owns the flush ref).
- Frontend tests: Vitest + Testing Library. New component tests follow patterns in `src/features/explorer/components/ExplorerContentGrid.test.tsx`.
- Rust integration tests: follow patterns in `src-tauri/tests/vfs_persistence.rs`.

### Institutional Learnings

No `docs/solutions/` corpus is present. Nine pattern observations from codebase scan:
1. All IPC-returning commands emit a full `ExplorerSnapshot` as the return type, never partial updates.
2. `NodeKind` extension is an atomic, multi-file operation (Rust enum, Rust `from_db`, TypeScript union, all switch exhaustion points).
3. Every new Tauri command must be registered in `tauri::generate_handler![]` in `lib.rs`.
4. `activateArtifact` is the single entry point for double-click/activation; it is the right hook for opening the note editor view.
5. Inline rename is initiated via `setPendingInlineRenameId` in the store after a successful create; the create-then-rename pattern is established and should be followed exactly.
6. `ExplorerLayout` already has a view-slot pattern: it conditionally renders different content based on store state; `activeNoteId` fits this pattern.
7. `storage_dir_from_home` is the single authority for the app data path; all disk writes must use this path.
8. No existing handler for Tauri window close events — this is net-new in this plan.
9. Capabilities and CSP in `src-tauri/capabilities/default.json` may need file-system write scope for the `notes/` directory if the current scope does not already cover `~/.cogios/**`.

### Library Decision: Markdown Editor

`@uiw/react-codemirror` with `@codemirror/lang-markdown` extension.

Rationale: fully bundled (no CDN dependency — required for Tauri offline use), thin React wrapper over CodeMirror 6 reduces boilerplate, markdown syntax highlighting is built-in via the language extension, and preview mode is a first-class future extension path (add `@uiw/react-codemirror-extensions-hyper-link` or similar without changing the base component). `react-md-editor` was considered but includes split-view preview UI that is explicitly out of scope and adds carrying cost. A raw `<textarea>` lacks syntax highlighting and has no clean preview migration path. The `framework-docs-researcher` agent was not available; this decision is based on local repo context and known CodeMirror 6 ecosystem posture.

## Key Technical Decisions

- **Add `Note` before the `_ => Self::Folder` catch-all in `NodeKind::from_db`.**
  Rationale: the catch-all means any unrecognised kind silently becomes Folder. Without this placement, existing `"note"` rows (if any) or a startup ordering bug could silently mis-classify. Placing `Note` explicitly keeps the match exhaustive and discoverable.

- **Store `activeNoteId: string | null` in `useExplorerStore`, not local ExplorerLayout state.**
  Rationale: `activateArtifact` runs inside the store; setting note-open state there avoids a split between store-driven activation and component-local state. ExplorerLayout reads this value from the store to choose between rendering `ExplorerContentGrid` and `NoteEditor`, matching how `displayedFolderId` and `selectedArtifactIds` are already managed.

- **Title stored only in `nodes.name`; `.md` file body is title-free.**
  Rationale: single source of truth; rename is one DB write with no file rewrite. The trade-off (file is titleless outside the app) is explicitly accepted in the origin document.

- **`notes/` directory created at startup via `fs::create_dir_all`.**
  Rationale: the directory must exist before any note command runs. `create_dir_all` is idempotent so no startup-ordering fragility is introduced.

- **Two-phase atomicity for `create_note`: DB insert first, then file write; if file write fails, delete DB record.**
  Rationale: no existing transactional helper spans the DB and filesystem in this codebase, so an explicit compensating rollback is the simplest safe approach. The note ID is a UUID so there is no collision risk on retry.

- **Auto-save debounce at 500 ms; flush is synchronous from the caller's perspective.**
  Rationale: 500 ms gives a comfortable typing window without losing more than one keystroke on a crash. The flush is synchronous (awaited) so navigation never races a pending disk write. Window blur is not treated as a separate flush trigger — navigation/back/window-close cover all cases.

- **Title committed on blur only, not on debounce.**
  Rationale: matches origin document R10; avoids mid-keystroke renames appearing in the tree while the user is still typing.

- **`NoteEditor` exposes a `flush(): Promise<void>` imperative handle via `useImperativeHandle`/`forwardRef`.**
  Rationale: ExplorerLayout needs to call flush synchronously before clearing `activeNoteId`; a ref-based handle is the established React pattern for this without lifting all editor state into the store.

- **Window close flush via `getCurrentWindow().onCloseRequested()` on the JS side.**
  Rationale: simpler than adding a Rust `on_window_event` handler; the pending flush state is already in the JS layer. The handler calls `event.preventDefault()`, awaits flush, then calls `getCurrentWindow().close()`.

- **Note size in inspector: updated in DB on each successful `save_note_content` call.**
  Rationale: keeps the snapshot self-contained; the inspector reads size from the node record rather than making a separate disk stat call on every inspector render.

- **No DB migration needed.**
  Rationale: `nodes.kind` is free-text with no CHECK constraint; the `note` kind value is valid as-is. The flat `notes/` directory requires no new table.

## Alternative Approaches Considered

- **Store `activeNoteId` in ExplorerLayout local state.**
  Why not chosen: `activateArtifact` lives in the store and cannot set React component-local state directly; this would require a separate event or callback threading that complicates the activation flow.

- **Write title into the `.md` file as a front-matter heading.**
  Why not chosen: origin document explicitly chose title-in-DB-only; the trade-off is intentional. Adds a file-rewrite path for every rename with no user-visible benefit inside the app.

- **Flush on window blur (tab switch).**
  Why not chosen: origin R12/R16 cover all exit paths (navigation, back, window close); blur adds complexity without closing a meaningful data-loss gap in a desktop app where the window is not shared.

- **`react-md-editor` for the markdown body.**
  Why not chosen: includes preview pane UI that is explicitly excluded from this iteration; adds carrying cost.

- **Plain `<textarea>` for the markdown body.**
  Why not chosen: no syntax highlighting; no clean upgrade path to preview in a future iteration. CodeMirror 6 via `@uiw/react-codemirror` bundles offline and supports preview as an extension.

## Open Questions

### Resolved During Planning

- **Does adding `note` to `NodeKind` require a DB migration?**
  Resolution: No. The `nodes.kind` column is free-text with no CHECK constraint. The `note` string value is valid as-is (confirmed by reading `src-tauri/migrations/0001_initial.sql`).

- **Does `nodes.name` enforce uniqueness within a parent scope?**
  Resolution: Confirmed no uniqueness constraint on `nodes.name`. Title rename (R10) needs no conflict-resolution strategy — duplicate names are allowed, matching the behavior of other node kinds.

- **Where should `notes/` directory creation live?**
  Resolution: In the startup block of `src-tauri/src/lib.rs`, alongside the existing `url-cache/` creation, using `fs::create_dir_all`. This is idempotent and runs before any command handler.

- **How should the editor view integrate with `ExplorerLayout`?**
  Resolution: `activeNoteId: string | null` state in `useExplorerStore`. ExplorerLayout conditionally renders `NoteEditor` when this is set, replacing `ExplorerContentGrid`. The left tree stays mounted. `activateArtifact` sets this state for note nodes.

- **What markdown editor library?**
  Resolution: `@uiw/react-codemirror` with `@codemirror/lang-markdown`. Fully offline-bundled, supports preview as a future extension. See Library Decision section above.

- **Which code extension points must be updated atomically?**
  Resolution (from origin): Rust `NodeKind` enum + `from_db` dispatcher, TypeScript `NodeKind` type, `activateArtifact`, `delete_node` match arm, `CreateMenu` `CreateAction` union, and presentation switch blocks. These are all addressed across Units 1–4.

- **Should size in the inspector come from disk or from the DB?**
  Resolution: from the DB node record (`size_bytes`), updated by `save_note_content` on each successful write. Avoids an extra stat call on inspector render; stays within one auto-save cycle of the real size.

### Deferred to Implementation

- Exact debounce implementation (setTimeout vs a utility library) — any correct 500 ms debounce with cancellable reset is acceptable.
- Exact CodeMirror theme styling (light/dark) — follow the existing app token system once the component renders.
- Whether the Tauri capabilities file needs expansion for writing to `~/.cogios/notes/` — verify at implementation time by attempting a write and checking for permission errors in the console.
- Exact error UX when a flush fails (R12) — a visible inline error message blocking navigation is required; exact styling deferred.

## Implementation Units

---

- [ ] **Unit 1: Rust domain extension + app startup**

**Goal:** Add `NodeKind::Note` to the Rust domain layer, create the `notes/` subdirectory at startup, and confirm no DB migration is required.

**Requirements:** R1, R2 (storage path), R4

**Dependencies:** None

**Files:**
- Modify: `src-tauri/src/domain/vfs/node.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/vfs_persistence.rs` (extend or create adjacent test)

**Approach:**
- Add `Note` variant to `NodeKind` in the enum declaration.
- Add `"note" => Self::Note` to `NodeKind::from_db` **before** the catch-all `_ => Self::Folder` arm.
- In the startup block of `lib.rs`, add `fs::create_dir_all(storage_dir.join("notes"))` after the existing directory setup. Use the value returned by `storage_dir_from_home` — do not hardcode the path.
- No migration file is needed; confirm by re-reading `src-tauri/migrations/0001_initial.sql` at implementation time.

**Patterns to follow:**
- Existing variant declarations and `from_db` match arms in `src-tauri/src/domain/vfs/node.rs`
- Existing `fs::create_dir_all` call for `url-cache/` in `src-tauri/src/lib.rs`

**Test scenarios:**
- Happy path: `NodeKind::from_db("note")` returns `NodeKind::Note` without triggering the catch-all.
- Regression: existing kind strings (`"folder"`, `"url"`, `"mount"`, `"directory"`, `"file"`) still parse correctly.
- Happy path: app startup creates `~/.cogios/notes/` when it does not exist.
- Edge case: startup does not fail or panic when `~/.cogios/notes/` already exists.

**Verification:**
- `cargo build` succeeds with the new variant. `from_db` round-trip test passes. Startup test confirms directory creation.

---

- [ ] **Unit 2: Rust backend commands for notes**

**Goal:** Implement the four note-specific Tauri commands — `create_note`, `get_note_content`, `save_note_content`, and the Note arm of `delete_node` — and register them.

**Requirements:** R2, R3, R5, R6 (create), R7, R11, R12, R14 (size update on save), R15 (delete)

**Dependencies:** Unit 1 (NodeKind::Note must exist)

**Files:**
- Create: `src-tauri/src/services/mutations/create_note.rs`
- Create: `src-tauri/src/services/queries/get_note_content.rs`
- Create: `src-tauri/src/services/mutations/save_note_content.rs`
- Modify: `src-tauri/src/services/mutations/delete_node.rs`
- Modify: `src-tauri/src/lib.rs` (register commands in `tauri::generate_handler![]`)
- Test: `src-tauri/tests/notes_commands.rs` (new integration test file)

**Approach:**
- **`create_note`**: Accept parent node ID. DB-insert a node with `kind = "note"`, `name = "Untitled"`, generating a UUID as the ID. Then write an empty file at `<storage_dir>/notes/<id>.md`. If the file write fails, delete the DB record and return an error. Return the full `ExplorerSnapshot`.
- **`get_note_content`**: Accept note node ID. Read `<storage_dir>/notes/<id>.md` and return the file contents as a string. Return an empty string if the file does not exist yet.
- **`save_note_content`**: Accept note node ID and body string. Write the body to `<storage_dir>/notes/<id>.md`. Update `nodes.updated_at` and `nodes.size_bytes` (byte length of the written content) in the same DB transaction. Return unit or a lightweight success signal (not a full snapshot — callers do not need to refresh the tree on save).
- **`delete_node` Note arm**: Delete the `.md` file from disk first. Then delete the DB record. If the file is missing on disk, continue with the DB delete (idempotent). Return the full `ExplorerSnapshot`.
- Register all three new commands in `tauri::generate_handler![]` in `lib.rs`.

**Patterns to follow:**
- Existing command structure in `src-tauri/src/services/mutations/create_folder.rs` and `rename_node.rs`
- Existing snapshot return pattern in any mutation command
- Existing `delete_node.rs` for the match arm structure

**Test scenarios:**
- Happy path: `create_note` inserts a node, creates a `.md` file, and the returned snapshot includes the new node with kind `"note"` and name `"Untitled"`.
- Happy path: `get_note_content` returns the exact string previously written by `save_note_content`.
- Happy path: `save_note_content` updates `nodes.size_bytes` to the byte length of the saved content.
- Happy path: `delete_node` on a note deletes the `.md` file from disk and removes the node from the returned snapshot.
- Edge case: `get_note_content` returns an empty string when the `.md` file has not been written yet.
- Edge case: `delete_node` on a note where the `.md` file is already missing still completes without error.
- Error path: if `create_note` file write fails, the DB record is not left behind (compensating rollback).
- Integration: the note node appears correctly in a full snapshot alongside folder and file nodes.

**Verification:**
- `cargo test` passes for all new integration test scenarios. `cargo build` succeeds (no unmatched NodeKind arms in `delete_node`).

---

- [ ] **Unit 3: TypeScript type surface + presentation**

**Goal:** Extend the TypeScript type surface with the `note` kind, add IPC client functions, update `CreateMenu`, and extend presentation utilities so all exhaustive switches compile.

**Requirements:** R1, R3, R5, R13 (icon)

**Dependencies:** Unit 1 (Rust must compile before IPC is usable end-to-end, but TypeScript can be written in parallel)

**Files:**
- Modify: `src/lib/contracts/vfs.ts`
- Modify: `src/lib/tauri/ipc.ts`
- Modify: `src/features/explorer/components/CreateMenu.tsx`
- Modify: `src/features/explorer/utils/presentation.ts`
- Test: `src/features/explorer/components/CreateMenu.test.tsx` (create if missing)
- Test: `src/features/explorer/utils/presentation.test.ts` (create if missing)

**Approach:**
- Add `"note"` to the `NodeKind` union in `src/lib/contracts/vfs.ts`. Add a `CreateNoteInput` type modelled on `CreateFolderInput` (parent node ID).
- Add `createNote(input: CreateNoteInput): Promise<ExplorerSnapshot>`, `getNoteContent(nodeId: string): Promise<string>`, and `saveNoteContent(nodeId: string, body: string): Promise<void>` to `src/lib/tauri/ipc.ts` following the `invoke<T>` pattern.
- Add `"note"` to `CreateAction` union in `CreateMenu.tsx` and add a "New Note" entry to `MENU_ITEMS` with an appropriate label and icon.
- In `presentation.ts`, add a `note` case to every exhaustive switch: `nodeIconComponent` returns `FileText` (already imported from lucide-react for other uses; verify or add import), `formatNodeKindLabel` returns `"Note"`, `nodeGlyph` returns an appropriate glyph character or string.

**Patterns to follow:**
- Existing entries in `MENU_ITEMS` for `"folder"` and `"url"` in `CreateMenu.tsx`
- Existing switch exhaustion pattern in `presentation.ts`
- Existing `invoke` usage in `ipc.ts`

**Test scenarios:**
- Happy path: `CreateMenu` renders a "New Note" item alongside the existing creation actions.
- Happy path: `nodeIconComponent("note")` returns the `FileText` icon component without throwing.
- Happy path: `formatNodeKindLabel("note")` returns `"Note"`.
- Regression: TypeScript compilation (`tsc --noEmit`) passes with no new type errors after the union extension.
- Regression: existing creation menu items (folder, mount, URL) still render correctly.

**Verification:**
- `tsc --noEmit` passes. `npm test` passes for affected test files. All presentation switches handle `"note"` without a default/fallback arm.

---

- [ ] **Unit 4: Explorer store + layout wiring**

**Goal:** Wire note activation, creation, and editor exit into the Explorer store and `ExplorerLayout`, including tree-click flush and window-close flush.

**Requirements:** R5, R6, R8, R12, R16

**Dependencies:** Unit 3 (TypeScript types needed), Unit 5 (NoteEditor component + flush handle — window close handler must be added after Unit 5 is available)

**Files:**
- Modify: `src/features/explorer/store/useExplorerStore.ts`
- Modify: `src/features/explorer/store/useExplorerStore.test.ts`
- Modify: `src/features/explorer/components/ExplorerLayout.tsx`
- Test: `src/features/explorer/components/ExplorerLayout.test.tsx` (create or extend)

**Approach:**
- Add `activeNoteId: string | null` to the store state (default `null`). Add `setActiveNoteId(id: string | null)` action.
- In `activateArtifact`, add a note branch: when the activated node has `kind === "note"`, call `setActiveNoteId(node.id)` instead of navigating into a folder. The existing folder branch is unchanged.
- Add `handleNoteCreate` to `ExplorerLayout` mirroring `handleFolderCreate`: call `createNote` IPC, apply the snapshot, find the new note ID via `findNewId`, call `store.setPendingInlineRenameId`. This satisfies R6 (inline rename is activated immediately).
- In `ExplorerLayout`, read `activeNoteId` from the store. When non-null, render `<NoteEditor>` (Unit 5) instead of `<ExplorerContentGrid>`. Pass the `noteEditorRef` to `NoteEditor` via `forwardRef` / `useImperativeHandle`.
- On tree-node click (the handler that normally selects a node): if `activeNoteId` is set and the clicked node is not the active note, call `await noteEditorRef.current.flush()` before clearing `activeNoteId`. If flush throws, show an inline error and do not clear `activeNoteId` (R12 blocking).
- On back button click: same flush-then-clear pattern.
- Window close handler (add after Unit 5): in `useEffect` on mount, register `getCurrentWindow().onCloseRequested(async (event) => { if (noteEditorRef.current) { event.preventDefault(); await noteEditorRef.current.flush(); getCurrentWindow().close(); } })`. Import `getCurrentWindow` from `@tauri-apps/api/window`.

**Patterns to follow:**
- `handleFolderCreate` in `ExplorerLayout.tsx` for the create flow
- `activateArtifact` existing folder branch for the activation flow
- Existing `useEffect` cleanup patterns in `ExplorerLayout.tsx`

**Test scenarios:**
- Happy path: double-clicking a note node calls `setActiveNoteId` and the NoteEditor is rendered in place of the content grid.
- Happy path: clicking the back button calls flush and clears `activeNoteId`, returning to the content grid.
- Happy path: clicking a non-note tree node while a note is open calls flush, then clears `activeNoteId`.
- Happy path: `handleNoteCreate` inserts a note and activates inline rename on the new node.
- Edge case: clicking the same note node that is already open does not trigger a flush or re-mount.
- Error path: if flush rejects, `activeNoteId` remains set (navigation is blocked) and an error message is rendered.
- Integration: tree-click, back button, and window close all go through the same flush path.

**Verification:**
- All test scenarios pass. The content grid is never visible at the same time as the note editor. Inline rename activates on note creation.

---

- [ ] **Unit 5: NoteEditor component**

**Goal:** Build the full-page note editor: title field, "Stored locally" label, CodeMirror markdown body, debounced auto-save, and a synchronous-flush imperative handle.

**Requirements:** R8, R9, R10, R11, R12

**Dependencies:** Unit 3 (IPC functions), Unit 2 (commands must exist end-to-end)

**Files:**
- Create: `src/features/explorer/components/NoteEditor.tsx`
- Test: `src/features/explorer/components/NoteEditor.test.tsx`
- Modify: `package.json` / `package-lock.json` (add `@uiw/react-codemirror`, `@codemirror/lang-markdown`)

**Approach:**
- Props: `nodeId: string`, `initialTitle: string`, `onTitleChange: (newTitle: string) => void`, `onBack: () => void`.
- Expose a `flush(): Promise<void>` handle via `forwardRef` + `useImperativeHandle` so callers can await a synchronous flush.
- On mount: call `getNoteContent(nodeId)` to load the initial body. Set it as the CodeMirror editor value.
- Title: a large `<input>` at the top. On blur, call the rename IPC (`renameNode` or equivalent) with the current title value, then call `onTitleChange` with the new value so the parent can reflect it in the tree.
- Below the title: a `"Stored locally on your device"` label (R9).
- Body: `<ReactCodeMirror value={body} onChange={handleBodyChange} extensions={[markdown()]} />`. Keep body in local state.
- Auto-save: on `handleBodyChange`, clear the existing debounce timer and schedule `saveNoteContent(nodeId, body)` after 500 ms.
- `flush()`: cancel the timer if running, call `saveNoteContent(nodeId, body)` immediately, and await the promise. Surface any thrown error to the caller (do not swallow it — ExplorerLayout needs the rejection to block navigation).
- Back button: calls `onBack`. The parent (ExplorerLayout) calls flush before clearing `activeNoteId`; NoteEditor does not flush itself on back.

**Patterns to follow:**
- `useImperativeHandle` / `forwardRef` patterns in the React codebase (search for existing usage first)
- Existing inline rename blur pattern in `ExplorerRow.tsx` for the title blur commit
- Existing IPC invocation style in `src/lib/tauri/ipc.ts`

**Test scenarios:**
- Happy path: NoteEditor loads and renders the content returned by `getNoteContent` on mount.
- Happy path: typing in the body schedules a debounced save; no IPC call fires until after the debounce interval.
- Happy path: `flush()` cancels the debounce and calls `saveNoteContent` immediately, resolving when the write completes.
- Happy path: title blur calls the rename IPC and invokes `onTitleChange` with the new title.
- Happy path: the text "Stored locally on your device" is visible in the rendered output.
- Edge case: calling `flush()` when there are no pending changes completes without error and without making an IPC call.
- Edge case: rapid successive `flush()` calls do not result in multiple concurrent writes for the same pending content.
- Error path: if `saveNoteContent` rejects, `flush()` propagates the rejection to the caller.
- Integration: back button calls `onBack`; it does not attempt to flush directly (flush is the parent's responsibility).

**Verification:**
- All test scenarios pass. CodeMirror renders without console errors in the test environment. `flush()` is testable via the imperative ref.

---

- [ ] **Unit 6: Inspector metadata + tree consistency**

**Goal:** Display correct note metadata in the inspector panel, and confirm rename, delete, and move operations are consistent with other node kinds.

**Requirements:** R13, R14, R15

**Dependencies:** Unit 3 (node kind type), Unit 2 (size_bytes written on save), Unit 5 (notes must be creatable to test inspector)

**Files:**
- Modify: `src/features/explorer/components/ExplorerInspector.tsx`
- Test: `src/features/explorer/components/ExplorerInspector.test.tsx` (extend or create)

**Approach:**
- In `ExplorerInspector`, add a `note` branch (or extend the existing metadata section) to display: node name, `created_at`, `modified_at`, and `size_bytes` formatted as a human-readable byte count. This is consistent with the display for `file` nodes.
- Confirm (by reading the existing inspector) whether the current metadata display is generic enough to cover notes without a special branch, or whether a dedicated branch is needed for the `size_bytes` label wording (e.g., "File size" vs "Note size").
- Rename: the existing rename flow uses `renameNode` IPC which operates on `nodes.name`; this is already the title for notes and no special handling is needed. Confirm that `ExplorerRow` inline rename is available for note nodes (not gated behind an `isDisplayFolder` check that would exclude notes).
- Delete: Unit 2 already handles the Note arm in `delete_node`. No frontend special-casing is needed beyond confirming the delete action is accessible for note nodes.
- Move: the existing move IPC operates on `nodes.parent_id` (tree position only); note files are flat on disk and do not move. No special handling needed — confirm at implementation time.

**Patterns to follow:**
- Existing metadata section in `ExplorerInspector.tsx` for `file` nodes
- Existing `formatBytes` or size-formatting utility if one exists

**Test scenarios:**
- Happy path: inspector renders `created_at`, `modified_at`, and `size_bytes` for a note node.
- Happy path: `size_bytes` in the inspector reflects the byte count of the most recently saved body content (within one auto-save cycle).
- Happy path: renaming a note via inline rename updates the displayed name in the inspector.
- Integration: single-clicking a note node (without double-clicking) shows the inspector metadata and does not open the editor.

**Verification:**
- Inspector correctly renders note metadata. Rename, delete, and move operations complete without errors for note nodes.

---

## Overall Verification

- A user can create a note, write content, relaunch the app, and find the title, body, tree position, and modification date intact.
- Notes nest naturally inside folders and other notes with no special handling.
- The title in the tree always matches the title shown in the editor.
- Navigating away (tree click, back button, window close) always flushes the auto-save buffer; no content is lost.
- `cargo build` succeeds with no unmatched `NodeKind` arms.
- `tsc --noEmit` succeeds with no new type errors.
- `cargo test` and `npm test` pass.
