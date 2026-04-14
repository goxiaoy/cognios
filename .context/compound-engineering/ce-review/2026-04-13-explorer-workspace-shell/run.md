# CE Review Run — Explorer Workspace Shell
**Date:** 2026-04-13  
**Branch:** `codex/explorer-workspace-shell`  
**Plan:** `docs/plans/2026-04-13-001-feat-explorer-workspace-shell-plan.md`  
**Mode:** autofix  
**Reviewers invoked:** 11 (correctness, testing, maintainability, project-standards, agent-native, learnings-researcher, security, performance, api-contract, reliability, adversarial, kieran-typescript)

---

## Applied Safe_Auto Fixes (12)

| # | File | Finding | Fix |
|---|------|---------|-----|
| 1 | `useExplorerStore.ts:63` | Stale closure in `applySnapshot` — `selectedArtifactIds` captured at callback creation | Replaced with functional updater `setSelectedArtifactIds((current) => ...)`, removed from deps array |
| 2 | `ExplorerLayout.tsx:55,75,95` | `parentId` guard checks `kind === "folder"` only — breaks node creation inside mount/directory | Changed to `store.displayedFolder ? store.displayedFolder.id : undefined` (3 locations) |
| 3 | `ArtifactCard.tsx:48` | `loadThumbnail(node.id)` called bare — synchronous throws escape `.catch()` | Wrapped with `Promise.resolve().then(() => loadThumbnail(node.id))` |
| 4 | `useExplorerEvents.ts:10` | `await onRefresh()` with no error handling — rejections become unhandled, `store.error` never set | Added `try/catch` around `onRefresh()` call |
| 5 | `presentation.ts:59` | `dayDifference === 1` fails on DST transition days (23h/25h boundary) | Changed to `dayDifference >= 1 && dayDifference < 2` |
| 6 | `ArtifactCard.tsx:56` | `thumbnailCache.set` inside cancelled guard — subsequent mounts after first cancellation never get cached value | Separated cache write from state update; cache written unconditionally when value present |
| 7 | `App.tsx:24` | Section label ternary duplicated in `<p>` and `<h2>` | Extracted to `sectionLabel` const before render |
| 8 | `useExplorerStore.ts:246` | `isDisplayFolder` private — `ExplorerLayout` and `ArtifactCard` encode duplicate/incomplete versions | Exported `isDisplayFolder` |
| 9 | `ArtifactCard.tsx:72` | `handleKeyDown` hardcodes 3rd independent copy of folder predicate | Replaced with `isDisplayFolder(node)` imported from `useExplorerStore` |
| 10 | `ExplorerContentGrid.tsx:27` | `sortedNodes` recomputed on every render via spread+sort | Wrapped in `useMemo([nodes])` |
| 11 | `ExplorerContentGrid.tsx:61,81` | `selectedIds.includes(node.id)` is O(n) inside map loop | Precomputed `selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])`, used `Set.has()` |
| 12 | `ExplorerContentGrid.tsx:69` | `groupByDate(sortedNodes)` called inline during render | Memoized as `groupedByDate = useMemo(() => groupByDate(sortedNodes), [sortedNodes])` |

---

## Residual Actionable Findings (Downstream-Resolver)

### P1 — High Priority

**FIND-R1** `useExplorerEvents.ts:18` — `[onRefresh]` dependency causes listener re-registration on every selection change because `onRefresh` depends on `applySnapshot` which depends on `displayedFolderId`. Architectural fix: memoize `onRefresh` with a stable `useRef` snapshot approach or refactor `applySnapshot` to not capture `displayedFolderId` in closure.  
`autofix_class: gated_auto` | `owner: downstream-resolver`

**FIND-R2** `src-tauri/src/commands/thumbnails.rs:24` — `open_database()` called per thumbnail request (no connection pool). Under concurrent thumbnail loads this creates N simultaneous SQLite connections.  
`autofix_class: manual` | `owner: downstream-resolver`

**FIND-R3** `src-tauri/src/commands/thumbnails.rs:35` — Symlink check is leaf-only; a symlink in an intermediate directory component of `relative_path` bypasses the protection. Use `Path::ancestors()` check or canonicalize the full path before the prefix check.  
`autofix_class: manual` | `owner: downstream-resolver`

### P2 — Moderate Priority

**FIND-R4** `src-tauri/src/services/mutations/rename_node.rs` — URL node branch omits `updated_at = CURRENT_TIMESTAMP`. Snapshot returns stale `modifiedAt` after a URL rename until the next full refresh.  
`autofix_class: gated_auto` | `owner: downstream-resolver`

**FIND-R5** `ExplorerLayout.tsx` — Initial load `useEffect` has `[]` deps but calls `store.refresh` which is captured via closure. Works correctly today because `store.refresh` never changes identity, but it's fragile. Consider using `useCallback` identity guarantee explicitly or document why this is safe.  
`autofix_class: manual` | `owner: downstream-resolver`

**FIND-R6** `ArtifactCard.tsx` — Module-level `thumbnailCache` is unbounded. Long sessions browsing image-heavy directories will accumulate without eviction. Add an LRU cap (e.g., 200 entries) or a max-bytes limit.  
`autofix_class: manual` | `owner: downstream-resolver`

**FIND-R7** `ExplorerInspector.tsx` — `selectionCount` prop is redundant; it equals `selectedArtifacts.length`. Derive at call site to simplify the interface.  
`autofix_class: manual` | `owner: downstream-resolver`

### P2 — Test Gaps

**FIND-R8** `useExplorerStore.test.ts` — Missing: `applySnapshot` fallback to root when `displayedFolderId` no longer valid, additive selection, `activateArtifact`, `runAction` error path, `selectedArtifactIds` purge on snapshot change, `toggleHierarchyCollapsed`.

**FIND-R9** `ExplorerContentGrid.test.tsx` — Date bucket test only asserts a label exists, not which bucket a given date falls into. Missing `metaKey` additive selection simulation.

**FIND-R10** `ExplorerInspector.test.tsx` — Missing no-selection state test (`node=null, selectionCount=0`).

**FIND-R11** `presentation.ts` — No unit tests at all. Priority: `dateBucketLabel` DST boundary, `formatNodeSize` boundary values, `isImageNode` known/unknown extensions.

---

## Advisory

**ADV-1** `src-tauri/src/commands/thumbnails.rs:92-118` — Hand-rolled base64 encoder. No correctness risk but consider the `base64` crate for auditability.

**ADV-2** Pre-existing: `url_repository.rs` — Lacks retry-count column; retry telemetry deferred by design per plan scope boundaries.

---

## Requirements Completeness

All 5 plan implementation units verified complete:
- [x] U1: Node metadata (`size_bytes`, `modified_at`)
- [x] U2: Image thumbnail IPC
- [x] U3: App shell + AppSidebar
- [x] U4: Explorer store refactor (split selection)
- [x] U5: ExplorerContentGrid + ArtifactCard + ExplorerInspector

Test suite: 13/13 passing. TypeScript: clean.
