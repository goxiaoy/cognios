# CE Review: feat/markdown-preview — 2026-04-26

**Scope:** feat/markdown-preview → main (1d578eb)
**Plan:** docs/plans/2026-04-26-001-feat-markdown-file-preview-plan.md (R1–R8, Units 1–5)
**Mode:** autofix
**Verdict:** Ready with follow-up fixes

## Reviewers

correctness, testing, maintainability, project-standards, agent-native, learnings (always-on);
security (file-read IPC + path traversal); reliability (async load + flush sequencing);
api-contract (new Tauri command); adversarial (>200 changed lines + cross-component handoff);
kieran-typescript (new components, store wiring); julik-frontend-races (load-effect cancellation, focus, handleActivate)

## Applied Fixes (safe_auto)

1. **`src-tauri/src/commands/files.rs:20`** — Replaced `error.to_string()` with `"file unavailable"` opaque mapping for DB open failure. Mirrors `thumbnails.rs` pattern. Prevents the absolute SQLite path from leaking through IPC error strings (correctness COR-002 + security SEC-001, 2-reviewer agreement).
2. **`src-tauri/tests/file_preview_commands.rs`** — Added `#[cfg(unix)]` to the symlink-escape test. Without it the test crate fails to compile on Windows (project-standards F-001).
3. **`src/features/explorer/components/ExplorerLayout.tsx`** — `handleActivate` now clears `noteFlushError` at entry; `handleDeleteById` clears it when the active note is deleted. Prevents stale errors bleeding across note sessions (reliability R04 + julik F4 + kieran R03 + adversarial ADV-002, 4-reviewer agreement).

All 30 frontend tests + 31 Rust tests still pass after fixes.

## Residual Actionable Findings (gated_auto / manual)

### P2 — Should fix in a follow-up

**[P2-1] handleActivate has no in-flight guard** (correctness COR-001, reliability R03, julik F1, adversarial ADV-004 — 4 reviewers, confidence ~0.95)
File: `src/features/explorer/components/ExplorerLayout.tsx:153-167`
Two concurrent `handleActivate` calls (e.g. via a future `ExplorerTree` wiring) can race: both pass the `store.activeNoteId && noteEditorRef.current` check before the first's `setActiveNoteId(null)` commits, both await the same `flush()`, and the late-resolving call overwrites the user's most recent activation intent. Currently unreachable through the grid because the grid is hidden when a note is open; becomes reachable when the unwired `ExplorerTree` is hooked up.
Fix: add `const isActivating = useRef(false)` guard with `try`/`finally` clear, OR track latest requested nodeId and ignore stale continuations.
Route: `gated_auto → downstream-resolver`

**[P2-2] Missing integration tests for plan's Unit 5 scenarios** (testing F-01 through F-09)
The plan explicitly enumerated several integration scenarios that were not implemented:
- Flush failure blocks preview opening (App.test integration)
- Window close with only preview open (no flush, no preventDefault)
- Deleting the previewed node clears `activePreviewId`
- Permission-denied path-leak regression test for I/O error arm (current path-leak test rejects before any I/O)
- In-mount symlink (non-escaping) explicit test
- Store regression test for note/folder activation branches
- MarkdownPreview swap-to-different-md test
- Inspector aside absence assertion during preview
- MarkdownView writable-mode `onChange` positive assertion
Route: `manual → downstream-resolver`

**[P2-3] Window-close listener async registration race** (reliability R02 + adversarial ADV-006)
File: `src/features/explorer/components/ExplorerLayout.tsx:60-86`
`getCurrentWindow().onCloseRequested(...).then(fn => unlistenFn = fn)` has no `.catch()` and races the cleanup function. In React StrictMode, the first registration's listener can leak. **Pre-existing from notes work** — same pattern lives on main. Not introduced by this PR; documented for future hardening.
Route: `manual → downstream-resolver` (separate PR, not this branch's responsibility)

### P3 — Nice-to-have

**[P3-1] `is_previewable_extension` has dead `None` arm** (correctness COR-003)
File: `src-tauri/src/services/files/read_file_content.rs:75-83`
`str::rsplit().next()` always returns `Some` — the `None` arm is unreachable. Functionally correct (the `!contains('.')` guard does the work), but misleading for readers. Replace with `rsplit_once('.').map(|(_, ext)| ...)` to make the no-dot rejection the actual gate.
Route: `manual → downstream-resolver`

**[P3-2] Frontend/backend extension allowlist drift risk** (maintainability M-01, agent-native F-01, residual)
The plan explicitly documented this risk and accepts the dual-list approach. Stronger mitigations would be either (a) a `get_previewable_extensions` IPC for runtime discovery, or (b) a parity test asserting both lists match. Not blocking.
Route: `advisory → human`

**[P3-3] Stale body flash on swap-preview** (julik F3, kieran F02)
When swapping `nodeId` while MarkdownPreview is mounted, there's one render cycle where the old `body` shows under the new header. Currently unreachable through the UI (preview can't swap without going back to the grid first), but worth `setBody("")` at top of load effect or `key={nodeId}` for resilience. Speculative until the UX exposes the swap path.
Route: `advisory → human`

**[P3-4] `messageForError` falls through to default for `"file unavailable"`** (reliability R06)
The default branch happens to return the correct message ("This file is not available."). Adding an explicit `case` would protect against future error-string drift. Cosmetic.
Route: `advisory → human`

**[P3-5] `editorIsOpen` naming** (maintainability M-04)
Variable covers note editor + read-only preview; `contentPanelIsOpen` would be more accurate. Naming nit.
Route: `advisory → human`

**[P3-6] `extensionOf("md")` returns "md" for dotless filename** (adversarial ADV-009)
TS `isMarkdownFile({name: "md"})` returns true; Rust correctly rejects with "not previewable". UI shows the preview as activatable, then errors. Edge case, not a security or data risk.
Route: `advisory → human`

**[P3-7] `noteId` vs `nodeId` IPC argument naming inconsistency** (api-contract AC-002)
`getNoteContent` uses `noteId`, new `readFileContent` uses `nodeId`. Both technically correct (the parameter IS a node ID in both cases) but inconsistent. Future renamers should consider unifying.
Route: `advisory → human`

## Pre-existing Issues (not introduced by this PR, documented for future work)

- `NoteEditor` debounce timer cleanup uses `[]` deps not `[nodeId]` (kieran F03/F04) — landed in notes work.
- `NoteEditor.flush()` zeroes `pendingBodyRef` before await; on save failure the content is lost (reliability R05).
- Window-close handler `.then()` has no `.catch()` (reliability R02 + adversarial ADV-006).
- TOCTOU window between `symlink_metadata` and `read_to_string` (security RR-001 + adversarial ADV-008) — documented as accepted limitation in plan.

## Requirements Completeness (plan_source: explicit)

| Req | Status |
|-----|--------|
| R1 (.md/.mdx activation) | Met |
| R2 (other kinds unchanged) | Met |
| R3 (header + read-only hint + syntax-highlighted body) | Met |
| R4 (notes still editable) | Met |
| R5 (mutually exclusive surfaces) | Met (via `editorIsOpen` predicate) |
| R6 (back button + window-close gating) | Met |
| R7 (no FE absolute paths) | Met |
| R8 (1 MB cap, typed error, no UI freeze) | Met |

## Coverage

- All 12 reviewers returned results
- 4 cross-reviewer agreements raised confidence on top issues
- Suppressed: 0 findings (none below 0.60 confidence)
- No untracked files excluded

## Verdict: **Ready with follow-up fixes**

The 3 safe fixes already landed close the top correctness/security gap. The remaining P2 items are non-blocking but should be tracked:
1. **handleActivate concurrent-call guard** — required before any `ExplorerTree` wiring
2. **Plan Unit 5 integration test gaps** — missing scenarios that were enumerated in the plan

Both can ship in a follow-up PR.
