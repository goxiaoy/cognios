# CE Review: feat/notes-node-type — 2026-04-15

**Scope:** feat/notes-node-type → main (224525cd)  
**Intent:** Introduce `note` node kind — UUID-keyed .md files, titles in DB, full-page CodeMirror editor, 500ms auto-save, synchronous flush on navigation/window-close.  
**Mode:** autofix  
**Verdict:** Ready with fixes (residual gated/manual work documented below)

## Reviewers

correctness (always), testing (always), maintainability (always), project-standards (always),
agent-native (always), learnings-researcher (always), reliability (error handling, flush paths),
api-contract (new IPC commands), adversarial (>50 changed lines + data mutations),
kieran-typescript (TypeScript components/hooks/types), julik-frontend-races (debounce + async UI)

## Applied Fixes (safe_auto)

1. `get_note_content.rs` — TOCTOU: replaced `.exists()` + `read_to_string` with `match` on `io::ErrorKind::NotFound`
2. `NoteEditor.tsx` — Debounce timer not cleared on unmount; added cleanup `useEffect`
3. `NoteEditor.tsx` — Body load effect: added `cancelled` flag to ignore stale IPC responses
4. `NoteEditor.tsx` — `useImperativeHandle` missing deps; added `[client, nodeId]`
5. `ExplorerLayout.tsx` — Window close handler: capture `noteEditorRef.current` before `await` to freeze ref across async gap

## Residual Actionable Findings

### P1 — Critical

**[P1-1] Window close swallows flush errors — silent data loss**  
File: `src/features/explorer/components/ExplorerLayout.tsx:63-68`  
`.flush().catch(() => {})` silently discards IPC failure and closes the window unconditionally. Contradicts R12 (flush error blocks navigation) and the behavior of `flushAndCloseEditor`. Unsaved content is lost without user feedback.  
Fix: wrap in try/catch; only call `close()` on success; surface error state otherwise.  
Route: gated_auto → downstream-resolver | Confidence: 0.97 | Reviewers: correctness, reliability, adversarial

**[P1-2] Stale nodeId captured in debounce closure — writes to wrong note**  
File: `src/features/explorer/components/NoteEditor.tsx:81-87`  
`handleBodyChange` closes over `nodeId` by value. If `nodeId` ever changes while NoteEditor is mounted (or after remount without key), the 500ms timer fires `saveNoteContent` with the old note ID. Fix: add `const nodeIdRef = useRef(nodeId)` kept in sync via effect; use `nodeIdRef.current` inside the setTimeout callback.  
Route: gated_auto → downstream-resolver | Confidence: 0.94 | Reviewers: julik, typescript, adversarial

**[P1-3] Deleting the active note doesn't close the editor — ghost file risk**  
File: `src/features/explorer/components/ExplorerLayout.tsx:128-133`  
`handleDeleteById` applies the snapshot but never clears `activeNoteId`. After delete, `activeNote` becomes null so `noteIsOpen` turns false and the editor unmounts — but any pending debounce fires after unmount and re-creates `{id}.md` on disk with no DB record. Fix: in `handleDeleteById`, if `snapshot && store.activeNoteId === nodeId`, call `store.setActiveNoteId(null)` before applying the snapshot.  
Route: manual → downstream-resolver | Confidence: 0.85 | Reviewers: adversarial

### P2 — High

**[P2-1] `save_note_content` file-first ordering — DB/disk diverge on DB failure**  
File: `src-tauri/src/services/notes/save_note_content.rs:12-19`  
`fs::write` succeeds, then `conn.execute` fails → file has new content, `size_bytes`/`updated_at` permanently stale. Fix: update DB first in a transaction, then write file. Or accept the trade-off and document it.  
Route: manual → downstream-resolver | Confidence: 0.94 | Reviewers: correctness, reliability, adversarial, maintainability

**[P2-2] Compensating rollback result discarded — orphaned DB record on DELETE failure**  
File: `src-tauri/src/services/notes/create_note.rs:43-47`  
`let _ = conn.execute("DELETE ...")` silently drops the rollback result. If the DELETE fails, the node record survives while the file was never created. Fix: use a SQLite savepoint/transaction wrapping the INSERT — rollback is guaranteed by the engine, no manual compensating delete needed.  
Route: manual → downstream-resolver | Confidence: 0.92 | Reviewers: correctness, reliability, adversarial

**[P2-3] Concurrent flush calls not serialized — two simultaneous IPC writes possible**  
File: `src/features/explorer/components/NoteEditor.tsx:51-61`  
If two callers invoke `flush()` concurrently (e.g. Back click + window close simultaneously), both pass the `pendingBodyRef !== null` guard before either nulls it, resulting in two concurrent `saveNoteContent` calls for the same content. Fix: track an in-flight flush promise ref; return the existing promise if one is already running.  
Route: gated_auto → downstream-resolver | Confidence: 0.85 | Reviewers: julik, adversarial

**[P2-4] `get_note_content` bare String param — implicit camelCase mapping**  
File: `src-tauri/src/commands/notes.rs:23-29`  
`get_note_content(state, note_id: String)` relies on Tauri v2 command macro's implicit camelCase rename for bare primitive params. All other commands use explicit `#[serde(rename_all = "camelCase")]` on input structs. Fix: wrap in `GetNoteContentInput { note_id: String }` with the serde annotation to make the contract explicit.  
Route: gated_auto → downstream-resolver | Confidence: 0.85 | Reviewers: api-contract, typescript

**[P2-5] Non-null assertion on `activeNote` not race-safe**  
File: `src/features/explorer/components/ExplorerLayout.tsx:198-199`  
A background `refresh()` can evict the active note from `nodeIndex` between renders, making `activeNote` null while `activeNoteId` is still set. The `store.activeNote!.name` assertion fires in that gap. Fix: derive `const note = store.activeNote; const noteId = store.activeNoteId;` and return null early if either is absent.  
Route: gated_auto → downstream-resolver | Confidence: 0.87 | Reviewers: typescript

### P3 — Moderate

**[P3-1] `save_note_content` doesn't emit `vfs://changed`**  
File: `src-tauri/src/services/notes/save_note_content.rs`  
All other mutations emit a `vfs://changed` event. `save_note_content` silently updates DB without notifying observers. Agent sessions or secondary windows won't see `size_bytes`/`updated_at` changes until the next unrelated refresh.  
Route: manual → downstream-resolver | Confidence: 0.75 | Reviewers: agent-native

**[P3-2] Service files placed in `services/notes/` — plan prescribed `services/mutations/` + `services/queries/`**  
Files: `src-tauri/src/services/notes/`  
The plan specified `create_note.rs` and `save_note_content.rs` in `services/mutations/` and `get_note_content.rs` in `services/queries/`. The implementation created a new `services/notes/` module. Not a runtime bug, but breaks the planned separation of reads vs. mutations.  
Route: advisory → human | Confidence: 0.85 | Reviewers: project-standards

## Requirements Completeness (plan_source: explicit)

| Requirement | Status |
|-------------|--------|
| R1 note kind in Rust + TS | met |
| R2 ~/.cogios/notes/{id}.md | met |
| R3 title in nodes.name only | met |
| R4 nestable under any node | met |
| R5 New Note creation action | met |
| R6 inline rename on create | met |
| R7 empty file on creation | met |
| R8 double-click opens editor | met |
| R9 title + storage hint + body | met |
| R10 title committed on blur | met |
| R11 body auto-saves (debounce) | met |
| R12 flush on navigation, error blocks | **partially met** — window close handler swallows errors (P1-1) |
| R13 distinct icon in tree | met |
| R14 inspector metadata | met |
| R15 rename/delete/move parity | **partially met** — delete while editor open leaves ghost file (P1-3) |
| R16 window close flush | **partially met** — flush errors swallowed (P1-1) |

## Testing Gaps

- `NoteEditor.tsx` has no test file — flush/debounce/title blur/back/error display all untested
- Compensating rollback (create_note file-write failure) has no test
- `flushAndCloseEditor` error path (navigation blocked on flush failure) has no test
- `handleNoteCreate` flow (New Note → snapshot → pendingInlineRenameId) has no test
- `activateArtifact` note branch in `useExplorerStore` has no test
- Window close handler sequence has no test
- Save + delete concurrency race has no test

## Coverage

- Suppressed: 3 findings below 0.60 confidence
- No untracked files excluded
- All 11 reviewers returned results; no failures
- No docs/solutions/ corpus — no known patterns to surface
