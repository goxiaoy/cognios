---
title: "feat: Read-only markdown preview for mounted .md files"
type: feat
status: active
date: 2026-04-26
deepened: 2026-04-26
---

# feat: Read-only markdown preview for mounted .md files

## Overview

Reuse the markdown editor infrastructure built for notes to support a **read-only preview** of `.md` / `.mdx` files that live inside mounted directories. Notes (`kind: "note"`) remain fully editable; mounted file previews are display-only with no auto-save, no rename, and no debounce. The shared editor surface is split so notes and previews share the CodeMirror component but diverge on chrome and write semantics. The frontend never receives the absolute path of a mounted file — a new `read_file_content(nodeId)` IPC command resolves the mount-relative path on the backend and returns the content as a string, mirroring the existing `get_node_thumbnail` pattern.

## Problem Frame

Cognios already mounts arbitrary directories and exposes their files in the explorer tree. With the notes editor in place, a user who double-clicks a `.md` file in a mount currently does nothing — there is no in-app way to read markdown that lives outside the notes folder. Adding read-only preview is a high-value, low-risk reuse of existing infrastructure: same CodeMirror + markdown extension, same back-button + window-close discipline, just no writes.

The planning challenge is small but not trivial. The current `NoteEditor` is purpose-built for the notes lifecycle (auto-save, debounce, title rename, flush-on-close). Wedging a `readOnly` flag into it would entangle two concerns that have different invariants. Instead, factor out a shared `MarkdownView` and let the two callers wrap it with their own chrome and write behavior. The backend command needs the same path-traversal protection as `get_node_thumbnail` (canonicalize, verify candidate is inside the mount root) plus a sane file-size cap to avoid loading multi-megabyte markdown into JS strings. The activation pipeline must also gain a flush-before-navigate hook in `ExplorerLayout` — `store.activateArtifact` is currently passed straight through to grid double-click, so any flush logic must live in a layout-level wrapper, not in the store.

## Requirements Trace

**Activation & regression**
- R1. Double-clicking a file node whose extension is in `MARKDOWN_EXTENSIONS` opens a read-only preview in the same UI region as the note editor.
- R2. Other file kinds (images, code, plain files) keep their current activation behavior — no regression.
- R4. Notes (`kind: "note"`) continue to behave exactly as today — editable title, auto-save, flush-on-close. No regression.

**Display**
- R3. The preview shows: the file name as a heading (read-only display), a "Read-only preview" indicator placed in the same DOM position and with the same muted style class as the note editor's "Stored locally on your device" hint, and the markdown source displayed in CodeMirror with syntax highlighting (no HTML rendering).

**Lifecycle & surface management**
- R5. The preview surface and the note editor are mutually exclusive in the rendered UI. Opening a preview while a note editor has unsaved changes triggers the same flush-or-block discipline used by tree-click navigation today (R12 of the notes plan). The store does **not** enforce mutual exclusion as an invariant; `ExplorerLayout` is the single arbiter.
- R6. The back button exits the preview and returns to the explorer grid. Window close does **not** require a flush (no pending writes), and the existing close handler must continue to gate on `noteEditorRef.current` (i.e., must not be widened to "any active surface").

**Backend safety**
- R7. The frontend never receives or constructs an absolute filesystem path. The new `read_file_content(nodeId)` IPC command resolves the path server-side from the mount join, with the same path-traversal safety check used by `get_node_thumbnail`.
- R8. Reads are capped at a sane file size (default: `MAX_PREVIEW_BYTES = 1 MB`, see Key Decisions for rationale). Larger files return a typed error that the UI surfaces as a user-visible error message rather than freezing the editor.

## Scope Boundaries

- **Read-only.** No save button, no auto-save, no debounce, no edits. The CodeMirror instance is configured with `EditorState.readOnly.of(true)`.
- **Source view only.** No rendered HTML preview. Markdown is shown as syntax-highlighted source. Adding HTML render mode is a follow-up iteration with explicit security implications (see Risks).
- **Markdown only.** Other text file types (`.txt`, `.json`, `.yaml`, code files) are out of scope. Activation behavior for non-markdown files is unchanged.
- **No external-change reload.** If the underlying file is modified outside the app while the preview is open, the preview shows the originally loaded content. File watcher integration is a follow-up iteration.
- **No editing of mounted files.** Even for `.md` files, the user cannot save changes back to the mount through this preview. If editing of mounted markdown ever ships, it is a separate plan with its own conflict-resolution and write-permission story.
- **No rename or delete from inside the preview.** Those actions are still available via the tree context menu and operate on the underlying node.
- **No threat model expansion for the existing webview trust boundary.** This plan inherits the current null-CSP webview model (see Risks) — it does not introduce per-command capability scoping. Any future iteration that ships HTML rendering of markdown content must address CSP and IPC scoping before merging.

## Context & Research

### Relevant Code and Patterns

- `src-tauri/src/commands/thumbnails.rs` — exact pattern to mirror for the new command:
  - SQL: `SELECT n.name, m.absolute_path, n.relative_path FROM nodes n INNER JOIN mounts m ON m.node_id = n.mount_id WHERE n.id = ?1 AND n.kind = 'file'`
  - Path resolution: `canonicalize(mount_root).join(relative_path)`, then `canonicalize` again and assert `starts_with(canonical_mount_root)` to defeat path traversal via symlinks.
  - File-size cap: `MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024` (image-specific; preview will use a separate, smaller `MAX_PREVIEW_BYTES` — see Key Decisions).
  - Error vocabulary: `map_err(|_| "thumbnail unavailable".to_string())` everywhere — opaque, no path leakage. **Mirror this discipline; do not replicate the `get_note_content` pattern of `Err(e) => Err(e.to_string())` for non-`NotFound` cases, which leaks paths.**
- `src-tauri/src/commands/notes.rs` — the note IPC pattern to mirror for `read_file_content`: a `#[tauri::command]` taking `state: State<'_, AppState>` plus an input struct with `#[serde(rename_all = "camelCase")]`.
- `src-tauri/src/services/notes/get_note_content.rs` — **only** the `match` on `io::ErrorKind::NotFound` arm is reusable. The non-`NotFound` arm there returns `Err(e.to_string())`, which leaks absolute filesystem paths in error strings; do not copy that arm.
- `src/features/explorer/components/NoteEditor.tsx` — the source of the shared `MarkdownView` extraction. Lines 132-141 are the literal CodeMirror block to lift. The title input + auto-save + flush + title-rename are notes-specific and stay in `NoteEditor`. Loading state pattern (lines 131-141): the CodeMirror surface simply does not render until content has loaded — `MarkdownPreview` mirrors this.
- `src/features/explorer/store/useExplorerStore.ts` — `activeNoteId`, `activeNote`, and the `activateArtifact` switch on `node.kind === "note"` is the template for `activePreviewId`. The store proves the pattern of UI-state-in-store for a full-page editor surface, but does not (and must not) enforce mutual exclusion between `activeNoteId` and `activePreviewId` — that is the layout's job.
- `src/features/explorer/components/ExplorerLayout.tsx` — `noteIsOpen` gating, `flushAndCloseEditor`, `handleDeleteById`, and the conditional render between `NoteEditor`, `ExplorerContentGrid`, and the `inspector-panel` is the template for the preview surface gating. **Critical: `onActivate={store.activateArtifact}` (line 224) is a direct passthrough — flush-before-navigate must be inserted via a `handleActivate` wrapper in this file, not in the store.** The store lacks the ref needed to call `flush()`.
- `src/features/explorer/utils/presentation.ts` — `MARKDOWN_EXTENSIONS = new Set(["md", "mdx"])` and `extensionOf(name)` are currently **module-private**. They become single-source-of-truth (for the frontend) only by adding an exported `isMarkdownFile(node)` helper that wraps them; the constant itself stays private. The Rust backend has its own extension allowlist — see Risks for the duplication caveat.

### Institutional Learnings

No `docs/solutions/` corpus exists yet. The recent notes review (`.context/compound-engineering/ce-review/2026-04-15-notes-node-type/summary.md`) flagged several editor-lifecycle issues worth carrying into this work:
- `NoteEditor` had no debounce-cleanup on unmount → ghost file on delete. Preview has no debounce, but extracting `MarkdownView` should not regress this fix.
- Stale `nodeId` captured in callbacks → fix landed in `feat/notes-node-type`. The preview component will not have the same risk because it has no async write callbacks, but the body-load effect needs the same `cancelled` ignore-flag pattern.
- Window close handler swallowed flush errors → fixed. The handler currently checks `noteEditorRef.current`. Preview has no flush capability; the close handler must continue to gate on the note editor ref specifically — do not refactor it to a generic "any active surface" check.
- Active-note delete left `activeNoteId` set, leading to ghost files → guard added in `handleDeleteById`. Preview needs the symmetric guard for `activePreviewId`.

### External References

None. The CodeMirror 6 + `@codemirror/lang-markdown` stack is the same one used by the notes editor; no new external dependencies. `EditorState` is imported from `@codemirror/state`, currently a transitive dep of `@uiw/react-codemirror`; verify at implementation time and add as a direct dep if pinning becomes necessary.

## Key Technical Decisions

- **Extract `MarkdownView` rather than add a `readOnly` prop.** Trade-off acknowledged: `NoteEditor`'s CodeMirror block is only ~10 lines (NoteEditor.tsx:132-141), so the immediate code-savings argument is weak. The case for extraction rests on (1) the read-only path is structurally distinct from the writable path (no `onChange`, no debounce, different visual indicator), and (2) two future consumers — HTML render preview and code-file preview — would re-discover the same shared shape. If those follow-ups are abandoned, the extraction is a small unnecessary indirection; this is judged acceptable.

- **Use `EditorState.readOnly.of(true)` for the read-only mode.** The documented CodeMirror 6 facet for disabling edits without disabling cursor/selection. `EditorView.editable.of(false)` is an alternative but disables click/select; we want the user to select and copy text, so `readOnly` is correct.

- **Define a separate `MAX_PREVIEW_BYTES = 1 * 1024 * 1024` (1 MB) constant rather than reusing `MAX_THUMBNAIL_BYTES`.** Rationale: the 5 MB image cap exists because base64-encoding 5 MB of bytes produces ~7 MB of JS string and a slow CodeMirror layout pass is irrelevant. For markdown source, CodeMirror's syntax-highlighting layout and the round-trip through the IPC string are both linear in content length and become noticeably laggy well below 5 MB. 1 MB covers virtually all hand-authored and most generated markdown files; pathological multi-megabyte machine-generated docs return the typed "too large" error and the user can open them externally. The constant lives in `src-tauri/src/services/files/read_file_content.rs` (or a shared `services/files/limits.rs` if other file readers join later); do not modify `MAX_THUMBNAIL_BYTES`.

- **Mirror `get_node_thumbnail` for SQL, path safety, and error opacity.** Same SQL join, same canonicalize-then-`starts_with` guard, same `map_err(|_| "<opaque>".to_string())` pattern for all error arms. The only deviation is that the read returns a UTF-8 string (`fs::read_to_string`) instead of bytes; UTF-8 decode failure is mapped to the same opaque error.

- **Reject non-markdown file kinds at the IPC boundary.** The command checks the node's `kind` in SQL (`WHERE n.kind = 'file'`) and the file's extension in application code (using `relative_path`, the actual disk filename, not the display `name`). A frontend bug or a malicious agent invoking `read_file_content(some_image_node_id)` gets a typed error, not arbitrary file contents.

- **`activePreviewId` lives in `useExplorerStore` next to `activeNoteId`.** Same shape (`string | null`), same justification: `activateArtifact` runs inside the store. The two fields are **not** mutually exclusive at the store level — the store accepts any combination — and `ExplorerLayout` enforces the UI invariant by computing a single `editorIsOpen = noteIsOpen || previewIsOpen` boolean used in every gating site.

- **Flush-before-navigate enforced via `ExplorerLayout.handleActivate` wrapper.** `store.activateArtifact` cannot synchronously await a flush — it has no ref. So `ExplorerLayout` defines an `async function handleActivate(nodeId)` that (1) checks `noteIsOpen`, (2) awaits `flushAndCloseEditor()` if a note is open, (3) returns early if `noteFlushError` is set after the flush, (4) delegates to `store.activateArtifact(nodeId)`. The wrapper is wired as `onActivate={handleActivate}` in place of the current direct passthrough. The store branch added in Unit 4 must NOT contain async logic. Note: today `ExplorerContentGrid` is hidden when `noteIsOpen`, so the immediate user path can't reach this scenario through grid double-click; the wrapper is forward-compat insurance for `ExplorerTree` (sidebar tree double-click, currently unwired but present in the codebase) and for any future programmatic activation.

- **No file watcher in this iteration.** The preview shows the content captured at load time. If the user wants fresh content they close and reopen.

- **Body-load effect uses the `cancelled` ignore-flag pattern from the notes review fix.** Prevents a slow IPC response from overwriting state if the user navigates away mid-load.

## Open Questions

### Resolved During Planning

- **How is the absolute path of a mounted file resolved server-side?** `nodes.mount_id` joins to `mounts.node_id`, giving `mount.absolute_path`; combine with `nodes.relative_path`. Confirmed in `src-tauri/src/commands/thumbnails.rs:60-79`.

- **What extensions count as markdown?** Use `MARKDOWN_EXTENSIONS` from `src/features/explorer/utils/presentation.ts` (currently `{"md", "mdx"}`). Front-end check uses an exported `isMarkdownFile` helper; backend has an independent allowlist (see Risks).

- **How is path-traversal blocked?** Same canonicalize-then-`starts_with` check as `get_node_thumbnail`. The backend treats the stored mount root as the trust anchor; if a user replaces the mount root with a symlink after creation, re-canonicalize will resolve to the new target and the trust anchor effectively shifts — this is documented as a single-user-desktop accepted limitation (see Risks).

- **Is the preview surface mutually exclusive with the note editor in the UI?** Yes, in the rendered UI. The store does not enforce mutual exclusion (Unit 4 explicitly notes both fields can be set during the close-then-open handoff). `ExplorerLayout` derives `editorIsOpen = noteIsOpen || previewIsOpen` and uses it in every gating site (workspace `has-inspector` className, `ExplorerContentGrid` render, inspector aside render, plus a render-priority ordering that favors note over preview if both are inadvertently set so the dirty content always wins).

- **Should preview block window close?** No — there is no pending write to flush. The window close handler must continue to gate specifically on `noteEditorRef.current`. Do not widen to "any active surface".

- **Where does focus land on preview open and close?** Focus moves to the back button on mount (matches the conventional pattern for a header back action and gives keyboard users an aria-labeled landing). On Back, focus returns to the body element by default (matching today's note-close behavior — improving focus-restoration to the triggering grid cell is a separate cross-feature improvement, not scoped here).

- **Is grid state preserved across preview open/close?** Yes, by reusing the existing pattern: `activateArtifact` does not mutate `selectedArtifactIds` or `displayedFolderId`, so the grid is frozen while the preview is open and Back restores the user to their exact position.

### Deferred to Implementation

- **Exact CodeMirror configuration for read-only mode.** Match the notes editor configuration exactly (`basicSetup={{ lineNumbers: false, foldGutter: false }}`, no word wrap) as the starting point. If word wrap is wanted later, change it for both surfaces in `MarkdownView` simultaneously.
- **Exact user-visible error message wording.** The IPC returns typed result categories (`"file unavailable"`, `"file too large"`, `"not previewable"`); the user-visible string per category is a UI decision aligned with the existing `note-editor-flush-error` style. Defer the exact copy.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
ExplorerLayout
├── handleActivate(nodeId)   ── async wrapper, flushes notes before navigate
├── activeNoteId  (existing)  ─→ renders <NoteEditor>
├── activePreviewId (NEW)     ─→ renders <MarkdownPreview>
└── neither                    ─→ renders <ExplorerContentGrid> + <ExplorerInspector>

Single derived: editorIsOpen = noteIsOpen || previewIsOpen
  ↳ used in ALL of:
     - workspace className "has-inspector" guard
     - ExplorerContentGrid render condition
     - inspector aside render condition
     - any future surface-level gating

NoteEditor (refactored)              MarkdownPreview (NEW)
├── title <input> + onBlur rename    ├── file name as static <h2>
├── debounce + auto-save + flush     ├── "Read-only preview" hint
└── <MarkdownView readOnly={false}>  └── <MarkdownView readOnly={true}>
                  │                                    │
                  └─────────── MarkdownView (NEW shared) ───────────┐
                              ReactCodeMirror + markdown() extension│
                              + EditorState.readOnly.of(readOnly)   │
                              + onChange? (only used by NoteEditor) │

activateArtifact(nodeId):                       (called THROUGH handleActivate)
  if (isDisplayFolder(node))                    -> selectDisplayedFolder
  if (node.kind === "note")                     -> setActiveNoteId
  if (node.kind === "file" && isMarkdownFile)   -> setActivePreviewId  (NEW)
  else                                          -> no-op (current behavior)

read_file_content(nodeId):
  SQL: nodes JOIN mounts WHERE n.id = ? AND n.kind = 'file'
  guard: extensionOf(relative_path) ∈ ALLOWLIST
  resolve: canonicalize(mount_root).join(relative_path)
  guard: symlink_metadata: !is_symlink && is_file && len ≤ MAX_PREVIEW_BYTES
  resolve: canonicalize(candidate)
  guard: canonical_candidate.starts_with(canonical_mount_root)
  return fs::read_to_string(canonical_candidate)
  on any non-NotFound error: return Err("file unavailable")
```

## Implementation Units

---

- [ ] **Unit 1: Backend `read_file_content` IPC + service**

**Goal:** Add a `#[tauri::command]` that reads the contents of a `kind: "file"` node whose extension is markdown, with the same path-traversal safety and size cap as `get_node_thumbnail`, and with consistently opaque error strings.

**Requirements:** R1, R7, R8

**Dependencies:** None

**Files:**
- Create: `src-tauri/src/services/files/mod.rs`
- Create: `src-tauri/src/services/files/read_file_content.rs`
- Create: `src-tauri/src/commands/files.rs`
- Modify: `src-tauri/src/commands/mod.rs` (register `pub mod files;`)
- Modify: `src-tauri/src/services/mod.rs` (register `pub mod files;`)
- Modify: `src-tauri/src/lib.rs` (register `commands::files::read_file_content` in `tauri::generate_handler![]`)
- Test: `src-tauri/tests/file_preview_commands.rs`

**Approach:**
- Command takes `ReadFileContentInput { node_id: String }` with `#[serde(rename_all = "camelCase")]`.
- Service function takes `&Connection`, `&str` node ID, and a `&Path` notes_dir is **not** needed — the command resolves only mount-derived files.
- Define `pub const MAX_PREVIEW_BYTES: u64 = 1 * 1024 * 1024;` in the service file (or a sibling `limits.rs`). Document the rationale inline (text vs image scaling).
- Define a fixed extension allowlist in the service: `&["md", "mdx"]`. Document next to it that `src/features/explorer/utils/presentation.ts::MARKDOWN_EXTENSIONS` must be kept in sync; both lists must change together.
- SQL query mirrors `get_node_thumbnail`'s `load_thumbnail_record` join — pull `name`, `relative_path`, and `mount.absolute_path` for the node where `n.kind = 'file'`. If the row is missing, return `Err("file unavailable")`.
- Extension check: `extensionOf(relative_path)` (lowercase suffix after the final `.`) must be in the allowlist; otherwise `Err("not previewable")`. Use `relative_path` (disk filename), not `name` (display name) — they can differ if a future feature decouples display name from filename.
- Path-resolution sequence (must follow this exact order, mirroring `thumbnails.rs:31-49`):
  1. `let canonical_root = PathBuf::from(&record.mount_root).canonicalize().map_err(|_| "file unavailable".to_string())?;`
  2. `let candidate = canonical_root.join(&record.relative_path);`
  3. `let meta = fs::symlink_metadata(&candidate).map_err(|_| "file unavailable".to_string())?;`
  4. `if meta.file_type().is_symlink() || !meta.is_file() { return Err("file unavailable".into()); }`
  5. `if meta.len() > MAX_PREVIEW_BYTES { return Err("file too large".into()); }`
  6. `let canonical_candidate = candidate.canonicalize().map_err(|_| "file unavailable".to_string())?;`
  7. `if !canonical_candidate.starts_with(&canonical_root) { return Err("file unavailable".into()); }`
  8. `fs::read_to_string(canonical_candidate).map_err(|_| "file unavailable".to_string())`
- **Error vocabulary discipline:** every error arm returns one of three opaque strings — `"file unavailable"`, `"file too large"`, `"not previewable"`. **Never** return `e.to_string()` for any error type; raw `io::Error` strings include absolute paths (this is why the `get_note_content` non-NotFound arm is excluded from the reusable pattern). The TOCTOU race between `symlink_metadata` and `read_to_string` is documented as accepted in Risks (single-user desktop threat model).

**Patterns to follow:**
- `src-tauri/src/commands/thumbnails.rs` — overall command shape, SQL join, path-traversal guard sequence, opaque error strings.
- `src-tauri/src/commands/notes.rs` — `State<'_, AppState>` plus camelCase input struct.

**Test scenarios:**
- Happy path: a `.md` file inside a mount returns its UTF-8 contents.
- Happy path: a `.mdx` file is also accepted.
- Edge case: empty `.md` file returns `Ok("")`.
- Edge case: file at exactly `MAX_PREVIEW_BYTES` is accepted; one byte over is rejected with `Err("file too large")`.
- Error path: node ID points to a non-file node (folder, mount, url, note) — returns `Err("file unavailable")`.
- Error path: node ID points to a file with a non-markdown extension (`.txt`, `.png`) — returns `Err("not previewable")` without opening the file.
- Error path: node ID does not exist — returns `Err("file unavailable")`.
- Error path: file on disk is missing (mount unmounted, file deleted externally) — returns `Err("file unavailable")`, does not panic.
- Error path: symlink that escapes the mount root — rejected by the canonicalize-and-verify guard, returns `Err("file unavailable")`.
- Error path: file that is a symlink itself — rejected by the symlink guard, returns `Err("file unavailable")`.
- Error path: permission denied on file read — returns `Err("file unavailable")`; assert the error string contains no filesystem path components (regression guard against the `get_note_content` leakage anti-pattern).
- Error path: file contents are not valid UTF-8 — returns `Err("file unavailable")`.
- Integration: command registered in `tauri::generate_handler![]` and reachable via `invoke` (verified by build, since unregistered commands fail at startup).

**Verification:** `cargo build` succeeds with the new command registered. All test scenarios pass. The path-traversal test must use a real symlink in a `tempdir` to prove the guard. The permission-denied test must assert the absence of path strings in the returned error.

---

- [ ] **Unit 2: TypeScript IPC client + ExplorerClient extension**

**Goal:** Expose `readFileContent(nodeId)` through the TypeScript IPC client and the `ExplorerClient` interface so the UI layer can consume it.

**Requirements:** R7

**Dependencies:** Unit 1 (Rust command must exist for the contract to mean anything)

**Files:**
- Modify: `src/lib/tauri/ipc.ts`
- Modify: `src/features/explorer/types/explorer.ts` (extend `ExplorerClient`)
- Modify: `src/features/explorer/api/explorerClient.ts` (wire the concrete client)
- Modify: `src/app/App.test.tsx` (add `readFileContent` to the IPC mock)
- Modify: `src/features/explorer/store/useExplorerStore.test.ts` (add `readFileContent` to the mock client)

**Approach:**
- IPC function: `readFileContent(nodeId: string): Promise<string>` invoking `"read_file_content"` with `{ input: { nodeId } }` (the `input` wrapper convention every other command — including the recently fixed `getNoteContent` — uses).
- `ExplorerClient` interface gets `readFileContent(nodeId: string): Promise<string>`.
- Test mocks gain a `readFileContent` field returning a resolved string by default.

**Patterns to follow:**
- `getNoteContent` and `saveNoteContent` in `src/lib/tauri/ipc.ts` for the invoke shape.
- The `{ input: { noteId } }` wrapper convention — do not regress to bare-arg shape.

**Test scenarios:**
- Test expectation: none for the IPC function itself (thin wrapper, no behavior to test). Component-level tests in Units 3 and 5 cover usage.
- Regression: `App.test.tsx` and `useExplorerStore.test.ts` continue to pass after the mock client field is added.

**Verification:** `tsc --noEmit` and `npx vitest run` both pass.

---

- [ ] **Unit 3: Extract shared `MarkdownView` from `NoteEditor`**

**Goal:** Pull the CodeMirror surface out of `NoteEditor` into a presentation-only `MarkdownView` component so both `NoteEditor` (writable) and `MarkdownPreview` (read-only) can share it.

**Requirements:** R3, R4 (no regression)

**Dependencies:** None

**Files:**
- Create: `src/features/explorer/components/MarkdownView.tsx`
- Modify: `src/features/explorer/components/NoteEditor.tsx`
- Test: `src/features/explorer/components/MarkdownView.test.tsx`

**Approach:**
- `MarkdownView` accepts: `value: string`, `readOnly: boolean`, `onChange?: (value: string) => void`, `placeholder?: string`, `className?: string`.
- Internally renders `<ReactCodeMirror>` with `extensions={[markdown(), ...(readOnly ? [EditorState.readOnly.of(true)] : [])]}`. The `EditorState` import comes from `@codemirror/state`. Verify the package is resolvable (it ships as a transitive dep of `@uiw/react-codemirror`); if pinning becomes necessary later, add it as a direct dep. Do not gate this unit on a package.json change.
- `basicSetup={{ lineNumbers: false, foldGutter: false }}`, `height="100%"`, and the markdown extension stay co-located in `MarkdownView`. No behavior or visual changes vs. the current `NoteEditor` — pure refactor.
- `NoteEditor` is refactored to render `<MarkdownView readOnly={false} value={body} onChange={handleBodyChange} placeholder="Start writing…" />` instead of `<ReactCodeMirror>` directly. Existing `NoteEditor` props, refs, debounce, flush, title input, and lifecycle effects are unchanged.

**Patterns to follow:**
- The existing `ReactCodeMirror` configuration in `src/features/explorer/components/NoteEditor.tsx:132-141` is the literal source.

**Test scenarios:**
- Happy path: rendering with `readOnly={false}` and a `value` shows the value, and typing fires `onChange`.
- Happy path: rendering with `readOnly={true}` shows the value, but typing via Testing Library does **not** call `onChange` (assert via spy that the handler is never invoked).
- Edge case: rendering with empty `value` shows the placeholder.
- Regression: existing `NoteEditor`-related tests (App.test.tsx flows that mount the editor through the layout) continue to pass.

**Verification:** `MarkdownView` renders correctly in both modes. `npx vitest run` passes including the new component test and all existing tests.

---

- [ ] **Unit 4: Store wiring — `activePreviewId` + `activateArtifact` markdown branch**

**Goal:** Add `activePreviewId` to `useExplorerStore` and route double-click on `.md`/`.mdx` files into it; export an `isMarkdownFile` helper so the same predicate is reused everywhere.

**Requirements:** R1, R2, R5

**Dependencies:** None (store does not import the IPC contract; Unit 2's type surface is unrelated to this unit)

**Files:**
- Modify: `src/features/explorer/store/useExplorerStore.ts`
- Modify: `src/features/explorer/store/useExplorerStore.test.ts`
- Modify: `src/features/explorer/utils/presentation.ts` (add `export function isMarkdownFile`)

**Approach:**
- Add `const [activePreviewId, setActivePreviewId] = useState<string | null>(null);` next to `activeNoteId`.
- Derive `activePreview = activePreviewId ? (nodeIndex.get(activePreviewId) ?? null) : null;` mirroring `activeNote`.
- Extend `activateArtifact`:
  - After `isDisplayFolder` and `node.kind === "note"` branches, add: `if (node.kind === "file" && isMarkdownFile(node)) { setActivePreviewId(node.id); return; }`.
- In `presentation.ts`, add `export function isMarkdownFile(node: ExplorerNode): boolean { return node.kind === "file" && MARKDOWN_EXTENSIONS.has(extensionOf(node.name)); }`. The `MARKDOWN_EXTENSIONS` and `extensionOf` constants stay module-private; only `isMarkdownFile` is added to the export surface.
- Return `activePreviewId`, `setActivePreviewId`, and `activePreview` from the hook.
- **The store does NOT enforce mutual exclusion between `activeNoteId` and `activePreviewId`.** Both can be set simultaneously during the close-then-open handoff orchestrated by `ExplorerLayout` (Unit 5). The store contract is intentionally permissive; the rendering invariant lives in the layout.

**Patterns to follow:**
- The existing `activeNoteId` + `activeNote` + `activateArtifact` "note" branch is the literal template.

**Test scenarios:**
- Happy path: `activateArtifact` on a `.md` file node sets `activePreviewId` to that node's ID.
- Happy path: `activateArtifact` on a `.mdx` file node sets `activePreviewId`.
- Happy path: `activateArtifact` on a folder still navigates (existing behavior).
- Happy path: `activateArtifact` on a note still sets `activeNoteId` (existing behavior, regression check).
- Edge case: `activateArtifact` on a non-markdown file (`.png`, `.txt`) does not set `activePreviewId` and does not throw.
- Edge case: `activateArtifact` on the same `.md` node twice in sequence is idempotent — `activePreviewId` ends with the same value, no extra side effects.
- Edge case: `setActivePreviewId(null)` clears the preview cleanly.

**Verification:** `useExplorerStore.test.ts` covers each branch. Existing tests still pass.

---

- [ ] **Unit 5: `MarkdownPreview` component + ExplorerLayout integration**

**Goal:** Add the read-only preview component, render it from `ExplorerLayout` when `activePreviewId` is set, route the back-button + tree-click + double-click flows through the same flush-or-block discipline used for notes today, and update every `noteIsOpen` usage site to the unified `editorIsOpen` predicate.

**Requirements:** R3, R5, R6, R8

**Dependencies:** Unit 1 (IPC reachable), Unit 2 (TypeScript surface), Unit 3 (`MarkdownView` exists), Unit 4 (store state exists)

**Files:**
- Create: `src/features/explorer/components/MarkdownPreview.tsx`
- Modify: `src/features/explorer/components/ExplorerLayout.tsx`
- Modify: `src/styles/app.css` (selectors for `.markdown-preview`, `.markdown-preview-header`, `.markdown-preview-error`, `.markdown-preview-hint`)
- Test: `src/features/explorer/components/MarkdownPreview.test.tsx`
- Modify: `src/app/App.test.tsx` (add a test for the markdown preview activation flow)

**Approach:**

`MarkdownPreview` (new component):
- Props: `client`, `nodeId`, `name` (the file name to show as a header), `onBack`. No ref handle (no flush capability).
- Internal state: `body: string`, `isLoading: boolean`, `loadError: string | null`.
- Body-load effect: `client.readFileContent(nodeId)` with the `cancelled` ignore-flag pattern from the recent notes fix. On error, set `loadError` to a user-facing message; never throw past the effect boundary.
- Render structure mirrors `NoteEditor`'s layout: header with back button + file name, then below the header the `"Read-only preview"` hint paragraph in the **same DOM position and with the same muted style class** as `NoteEditor`'s `note-editor-storage-hint` (use a parallel class `markdown-preview-hint` that inherits the same visual styling). Then either a loading state (CodeMirror simply not rendered until `!isLoading`, mirroring `NoteEditor.tsx:132-141`), an error block (replaces the body area, back button stays in the header), or `<MarkdownView readOnly={true} value={body} />`.
- Focus management on mount: focus moves to the back button (use `autoFocus` on the `<button>` or a `useEffect` calling `.focus()`).
- Capture `name` at first render (do not re-derive from the store on every render) so the header stays stable if the node disappears from the index mid-display (see Risks).

`ExplorerLayout` changes:
- Compute `previewIsOpen = !!store.activePreviewId && !!store.activePreview` next to `noteIsOpen`. Then derive `const editorIsOpen = noteIsOpen || previewIsOpen;`.
- Replace **all four** existing `noteIsOpen` usage sites with `editorIsOpen`:
  1. The workspace `className` ternary (line 198): `${editorIsOpen ? '' : (store.inspectorNode || store.selectionCount > 1 ? ' has-inspector' : '')}` (or equivalent — the `has-inspector` class must be suppressed during both note and preview).
  2. The `ExplorerContentGrid` render guard (line 218): `!store.isLoading && !editorIsOpen ? <ExplorerContentGrid .../> : null`.
  3. The inspector `<aside>` render guard (line 239): `!editorIsOpen ? <aside ...> ... </aside> : null`.
  4. Add a new render branch using `!store.isLoading && previewIsOpen` (note: `store.isLoading` — not bare `isLoading`, which does not exist in this scope): `!store.isLoading && previewIsOpen ? <MarkdownPreview .../> : null`. The note-editor branch keeps its existing `noteIsOpen` guard (not `editorIsOpen`) so that if both fields are inadvertently set, the dirty content of the note editor wins the render (defensive priority).
- Add `async function handleActivate(nodeId: string)`:
  ```
  if (noteIsOpen) {
    await flushAndCloseEditor();
    if (noteFlushError) return;   // flush failed; navigation blocked
  }
  store.activateArtifact(nodeId);
  ```
  Wire `onActivate={handleActivate}` instead of `onActivate={store.activateArtifact}` on `ExplorerContentGrid`.
- Add `setActivePreviewId(null)` guard in `handleDeleteById` symmetric to the existing note guard:
  ```
  if (store.activeNoteId === nodeId) store.setActiveNoteId(null);
  if (store.activePreviewId === nodeId) store.setActivePreviewId(null);
  ```
- Update the back-button handler used by `MarkdownPreview` to call `store.setActivePreviewId(null)` (no flush).
- The existing window close handler stays as-is — it gates on `noteEditorRef.current`, not on the preview. Verify by inspection that no refactor accidentally widens the predicate.

**Patterns to follow:**
- `src/features/explorer/components/NoteEditor.tsx` — header chrome, back button aria-label, error display style (`.note-editor-flush-error` is the visual class to mirror via `.markdown-preview-error`), loading-state pattern of conditional CodeMirror render.
- `src/features/explorer/components/ExplorerLayout.tsx:41-77, 128-143, 179-238` — flush-or-block sequencing, delete guard pattern, conditional render layout.
- `MarkdownView` from Unit 3.

**Test scenarios:**
- Happy path: opening a `.md` file fetches content via `readFileContent`, displays it with the file name as header, and the back button clears `activePreviewId`.
- Happy path: opening a `.mdx` file works the same way.
- Happy path: navigating from one preview to another `.md` file swaps the displayed content (re-fetches).
- Happy path: pressing Back returns to the explorer grid with `selectedArtifactIds` and `displayedFolderId` unchanged from before the preview opened.
- Edge case: rapid open-then-back during in-flight `readFileContent` does not cause a setState-after-unmount warning (cancelled flag).
- Edge case: empty markdown file renders without error.
- Edge case: double-clicking the same already-displayed `.md` file is idempotent — no spurious reload, no setState-after-unmount warning.
- Edge case: a background `applySnapshot` removes the previewed node from the index — `MarkdownPreview` continues rendering with the captured `name` until the user presses Back; layout does not snap back to the grid mid-display because the priority rule favors the open editor surface.
- Error path: `readFileContent` rejects with `"file unavailable"` — preview shows a generic error and a back button (no white screen).
- Error path: `readFileContent` rejects with `"file too large"` — preview shows a size-limit message.
- Error path: `readFileContent` rejects with `"not previewable"` — preview shows a generic error.
- Integration: opening a `.md` file via the (currently hidden, future-wired) tree double-click while a note has unsaved content triggers `handleActivate` → flush first; if flush succeeds, preview opens; if flush fails, the preview does **not** open and the note editor stays mounted with the flush error visible.
- Integration: window close with only a preview open (no note) does not throw, does not `preventDefault`, and does not call any flush.
- Integration: tree double-click on a non-markdown file (e.g., `.png`) does not open the preview; image thumbnail behavior is unchanged.
- Integration: deleting the previewed node via the tree context menu clears `activePreviewId` synchronously and the preview unmounts.
- Integration: the inspector aside and the `has-inspector` className are both absent during preview (regression check that `editorIsOpen` is wired everywhere).

**Verification:** `npx vitest run` passes including new tests. Manual smoke: mount a directory containing a `.md` file, double-click it, see content, press back, verify return to grid.

---

## System-Wide Impact

- **Interaction graph:** `activateArtifact` gains a new branch (markdown file). `ExplorerLayout` gains a new render branch and a new `handleActivate` wrapper that intercepts every grid double-click (and any future ExplorerTree double-click). `handleDeleteById` gains a symmetric guard. The window-close `onCloseRequested` handler is unchanged but must be verified against accidental predicate-widening.
- **Error propagation:** `read_file_content` returns `Result<String, String>` with one of three opaque error categories. `MarkdownPreview` converts each to a user-visible string in `loadError`. No silent failures; no thrown errors past the load effect.
- **State lifecycle risks:** None comparable to notes — no debounce, no auto-save, no on-disk writes. The only async surface is the load IPC, mitigated by the `cancelled` ignore flag. The `activePreview` derived state can become null mid-display if a background refresh removes the node; this is handled by capturing `name` at mount time and by the render-priority rule that keeps the surface open until the user explicitly backs out.
- **API surface parity:** Agents have full IPC parity for the new capability via `read_file_content`. Same trust level as the UI (no per-command capability scoping; see Risks).
- **Integration coverage:** The flush-or-block handoff via `handleActivate` must be exercised by an integration test, not just unit tests on each piece.
- **Unchanged invariants:**
  - All notes plan invariants R1–R16 continue to hold.
  - `get_note_content`'s contract (returns `Ok("")` for missing file) is not affected.
  - `get_node_thumbnail`'s safety logic is not modified — it is the pattern source.
  - `MARKDOWN_EXTENSIONS` set keeps its current contents (`md`, `mdx`); changes require coordinated update of the Rust allowlist (see Risks).
  - The window close handler still gates on `noteEditorRef.current` only.

## Risks & Dependencies

| Risk | Severity | Mitigation |
|------|----------|------------|
| `MarkdownView` extraction subtly changes note editor behavior (focus, selection, scroll) | Medium | Unit 3 is a strict refactor — no visual or behavior changes intended. Run all existing notes-related tests after extraction; manual smoke on note edit + auto-save before merging. |
| Reading large markdown files freezes the UI | Medium | `MAX_PREVIEW_BYTES = 1 MB` cap server-side. Files over the cap return a typed error before any read. UI shows "File too large" and a back button. |
| Symlink in mount escapes to user's home directory | Medium | Same canonicalize-then-`starts_with` guard as `get_node_thumbnail`. Add explicit symlink test with a tempdir-relative escape attempt. |
| TOCTOU between `symlink_metadata` / `canonicalize` / `read_to_string` | Low | Accepted limitation. The plan inherits `thumbnails.rs`'s sequence verbatim — there are narrow race windows where a benign file passes the size/symlink checks then is replaced before read. The threat model is single-user desktop where the user owns the mount; the windows are microseconds; mitigation (`openat2` with `O_NOFOLLOW`, fd-bound stat) is non-trivial in cross-platform Rust and is not adopted. Documented for future hardening if the threat model expands. |
| Mount root substitution: user replaces the originally canonical mount root with a symlink after mount creation | Low | Accepted limitation. The stored `mount.absolute_path` was canonical at creation time; if the user moves the underlying directory and replaces it with a symlink, re-canonicalization at read time silently shifts the trust anchor. Single-user desktop threat model; not mitigated. |
| Null CSP + IPC scope makes any in-webview script a path to filesystem read | Medium (inherited) | Inherited from existing app — `tauri.conf.json` has `csp: null` and `capabilities/default.json` grants all custom commands to the main window. This plan does not introduce per-command capability scoping. **Hard requirement: any future iteration that ships HTML rendering of markdown content must address CSP and IPC scoping before merging**, since rendered markdown could contain `<script>` tags that escalate read-only preview into arbitrary filesystem read. Documented as a Scope Boundary. |
| Frontend `MARKDOWN_EXTENSIONS` and Rust allowlist drift apart | Low | Two hardcoded lists in two languages; they must be updated together. Mitigation: a test scenario in Unit 1 iterates a hardcoded list of expected extensions and asserts each is accepted; if either list grows, the test (or the missing test entry) flags the divergence. Comment at the Rust allowlist explicitly cites the TypeScript location. |
| User double-clicks `.md` while a note has unsaved content; flush fails; preview opens anyway, losing the note | High → Mitigated | `handleActivate` wrapper sequences flush-then-set; if flush fails (`noteFlushError` non-null), `store.activateArtifact` is never called. Today's UI does not surface this path through the grid (note editor hides the grid), but the wrapper exists for forward-compat with `ExplorerTree`. |
| Window close handler accidentally tries to flush the preview | High → Mitigated | Window close gates on `noteEditorRef.current`, not the preview ref. Do not refactor to a generic "any active surface" check. Regression test: close the window with only a preview open and assert no exception. |
| Active preview's underlying node is deleted via tree context menu while preview is open | Medium → Mitigated | `handleDeleteById` clears `activePreviewId` symmetric to the note guard. Preview unmounts cleanly. |
| `activePreview` becomes null mid-display due to background refresh | Low | `MarkdownPreview` captures `name` at mount via prop (not re-derived from store). Render-priority rule favors the open editor surface so the layout does not snap back to the grid mid-render. |
| External edit to the previewed file goes unnoticed | Low | Documented limitation. User must close and reopen to see fresh content. File watcher is explicitly out of scope. |
| Non-UTF-8 file is opened (binary `.md` is rare but possible) | Low | `fs::read_to_string` fails with a UTF-8 error → mapped to `"file unavailable"`. UI shows the standard load-error message. |

## Documentation / Operational Notes

- No user-facing docs to update at this stage of the project.
- No new direct dependencies; `@codemirror/state` remains a transitive dep of `@uiw/react-codemirror`. Add it as a direct dep only if a future version-pin issue surfaces.
- No telemetry or monitoring hooks — local desktop app.

## Sources & References

- Origin: this conversation (no `docs/brainstorms/` document — direct planning bootstrap)
- Pattern source: [src-tauri/src/commands/thumbnails.rs](src-tauri/src/commands/thumbnails.rs)
- Recent context: [docs/plans/2026-04-14-001-feat-notes-node-type-plan.md](docs/plans/2026-04-14-001-feat-notes-node-type-plan.md)
- Recent review fixes carried into this plan: [.context/compound-engineering/ce-review/2026-04-15-notes-node-type/summary.md](.context/compound-engineering/ce-review/2026-04-15-notes-node-type/summary.md)
- Document review of this plan: 5 reviewers (coherence, feasibility, design-lens, security-lens, adversarial). Auto-fixes and structural corrections applied; deferred design-detail decisions (focus restoration to triggering grid cell, exact CodeMirror visual config, exact error message wording) explicitly noted.
