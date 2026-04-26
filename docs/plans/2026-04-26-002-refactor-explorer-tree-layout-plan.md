---
title: "refactor: VS Code-style tree-driven Explorer layout"
type: refactor
status: active
date: 2026-04-26
---

# refactor: VS Code-style tree-driven Explorer layout

## Overview

Replace the current Finder-style grid+inspector Explorer with a VS Code/Cursor-style three-column layout: persistent tree on the left, detail surface in the middle (note editor / markdown preview / image viewer / placeholder / welcome state), persistent inspector on the right. Tree single-click drives all selection and detail-surface activation. The grid view (`ExplorerContentGrid`, `ArtifactCard`, `Breadcrumbs`, `ViewModeToggle`) and the "current folder" navigation model (`displayedFolderId`) are removed entirely.

## Problem Frame

The current Explorer is built around the Finder model: `ExplorerLayout` shows `ExplorerContentGrid` in the middle with breadcrumbs at top, `ExplorerInspector` floats in/out on the right based on selection. Navigating into folders swaps `displayedFolderId`. Files have to be double-clicked to activate. The tree component (`ExplorerTree.tsx`) exists and is even tested but is **never rendered** — `ExplorerLayout` does not import it.

The user has decided this is the wrong shape for a notes-and-source-files workspace. The mental model they want is a code editor: persistent tree on the left for navigation, persistent metadata pane on the right, central area dedicated to viewing/editing one thing at a time. Single-click everywhere — no double-click distinction.

The challenge is mostly cohesive removal. Once `displayedFolderId` and the grid go away, several store fields (`breadcrumbs`, `viewMode`, `isHierarchyCollapsed`, `selectTreeNode`, `selectDisplayedFolder`) become dead, and every component or test that references them needs to be reworked. The `handleActivate` flush-before-navigate wrapper added during the markdown preview work continues to apply — now from the tree's `onSelect` instead of grid double-click.

## Requirements Trace

**Layout & rendering**
- R1. ExplorerTree is rendered in a persistent left sidebar of `ExplorerLayout`.
- R2. The right inspector panel renders unconditionally; when zero nodes are selected, it shows a placeholder ("No selection" or equivalent) instead of being unmounted.
- R3. The center area renders one of: NoteEditor (kind=note selected), MarkdownPreview (`.md`/`.mdx` file selected), ImageViewer (image file selected), generic "Cannot preview this file type" placeholder (other file kinds), or a welcome/empty state when no file is selected.
- R3a. Breadcrumbs render at the top of the center area whenever an active file is displayed (NoteEditor, MarkdownPreview, or ImageViewer), showing the path from root to the active node. They are hidden in the welcome state and the "Cannot preview" placeholder.

**Activation semantics**
- R4. Single-click on a container node (kind=folder, kind=mount, kind=directory) toggles its expansion in the tree and selects it. It does NOT change a "current folder" — that concept is removed.
- R5. Single-click on a file node (kind=file or kind=note) selects it and opens the appropriate detail surface in the center.
- R6. Right-click on any node opens the existing context menu (rename / delete / retry — same actions as today).
- R7. Multi-select via Shift-click (range) and Cmd/Ctrl-click (toggle add) is supported; the inspector reflects the aggregate.
- R8. There is no double-click flow.

**Create operations**
- R9. The CreateMenu ("New Folder", "Mount Directory", "Add URL", "New Note") moves to a toolbar at the top of the tree sidebar.
- R10. When exactly one container node is selected, new items are created as its children (parentId = that container). When zero or multiple nodes are selected (or the selection is not a single container), creation falls back to root (parentId = undefined).

**Lifecycle preserved**
- R11. The `handleActivate` flush-before-navigate wrapper extends to tree single-click — switching from a dirty note to any other node still flushes first; if flush fails, the navigation is blocked exactly as today.
- R12. Window-close, note auto-save, debounce, and markdown preview behavior are unchanged.

## Scope Boundaries

- **No drag-and-drop** in the tree (move/reparent is not added in this iteration).
- **No filesystem watcher** integration; tree refresh continues to come from the existing `useExplorerEvents` hook.
- **No search / filter** within the tree.
- **No sorting** beyond the default order returned by the snapshot.
- **No keyboard shortcuts** beyond what `ExplorerRow` and the `Cmd+Click` modifier already imply (no Ctrl+N for new note, no F2 for rename, no arrow-key navigation in the tree).
- **No collapsible sidebars** (toggle to hide tree or inspector). They are always visible at fixed widths.
- **No layout persistence** (column widths are not user-resizable; if added later, a separate plan).
- **Note editor / markdown preview internals are NOT touched** — only their rendering site shifts.

## Context & Research

### Relevant Code and Patterns

- `src/features/explorer/components/ExplorerTree.tsx` — exists, takes `expandedIds`, single `selectedId`, `onSelect`, `onToggle`, `onDelete`, `onRetry`, `onInlineRename`, `onStartRename`, `pendingInlineRenameId`. Has no toolbar slot. Selection state is `string | null`, so multi-select needs an API extension. Tree is currently never rendered anywhere.
- `src/features/explorer/components/ExplorerRow.tsx` — already supports right-click context menu (`onContextMenu` handler at line 103, `.tree-context-menu` rendering at line 144). Reuse as-is; no changes needed for context menu.
- `src/features/explorer/components/ExplorerLayout.tsx` — current 3-column-ish layout (without left sidebar). Renders `ExplorerContentGrid` in middle with breadcrumbs, `ExplorerInspector` on right as a conditional `<aside>` (line ~239). Window close, `flushAndCloseEditor`, `handleActivate`, `handleDeleteById` all stay.
- `src/features/explorer/store/useExplorerStore.ts` — large; many fields will be removed or deprecated. Live state to keep: `snapshot`, `expandedIds`, `toggleNode`, `selectedArtifactIds`, `selectArtifact`, `activateArtifact` (refactor), `refresh`, `applySnapshot`, `isLoading`, `error`, `activeAction`, `runAction`, `pendingInlineRenameId`, `setPendingInlineRenameId`, `activeNoteId`, `setActiveNoteId`, `activeNote`, `activePreviewId`, `setActivePreviewId`, `activePreview`, `setIsLoading`, `setError`. Live state to remove: `displayedFolderId`, `displayedFolder`, `visibleArtifacts`, `breadcrumbs`, `viewMode`, `setViewMode`, `isHierarchyCollapsed`, `toggleHierarchyCollapsed`, `mutationTarget`, `selectDisplayedFolder`, `selectTreeNode`. Some helpers (`isDisplayFolder`, `asDisplayFolder`) stay since they're used to classify container vs file kinds.
- `src/features/explorer/components/ExplorerInspector.tsx` — renders selected-node metadata + multi-select aggregate. Needs an empty-state branch when `selectionCount === 0`.
- `src/features/explorer/components/CreateMenu.tsx` — same component, just rendered in a different parent (the tree toolbar instead of the grid header). Its API doesn't change.
- `src/features/explorer/components/ArtifactCard.tsx` — grid cell renderer; deleted with grid. Currently the source of image thumbnail rendering for `kind=file` images. The display logic (`getNodeThumbnail` invocation) gets re-implemented in a small `ImageViewer` component for the center pane.
- `src/features/explorer/components/Breadcrumbs.tsx` (and `Breadcrumbs.test.tsx`) — currently rendered above the grid by `ExplorerLayout` driven by `displayedFolderId`. **Repurposed, not deleted:** the new layout renders Breadcrumbs at the top of the center detail surface, driven by the active node id (note / preview / image), showing the path from root to that active node. The existing component will likely need a small API tweak to accept an explicit `nodeId` instead of reading `displayedFolderId`-derived state.
- `src/lib/tauri/ipc.ts::getNodeThumbnail` — existing IPC that returns a base64 data URL. Already wired through `ExplorerClient.getNodeThumbnail`. Reused by the new `ImageViewer`.
- `src/styles/app.css` — many grid-related classes (`.explorer-workspace`, `.has-inspector`, `.artifact-collection-grid`, `.artifact-card`, `.breadcrumbs`, `.view-mode-toggle`, `.note-editor` is fine). The `.explorer-workspace` CSS-grid setup gets replaced with a three-column grid template.
- `src/features/explorer/components/ExplorerTree.test.tsx` — exists and tests the current single-select API. Will be extended for multi-select + toolbar prop.
- `src/app/App.test.tsx` — every integration test currently exercises the grid (mount card double-click to navigate, file card double-click to preview). All of these will be rewritten for tree-driven flow.

### Institutional Learnings

No `docs/solutions/` corpus. Recent reviews surfaced two patterns to carry forward:
- Single-arbiter pattern: store does not enforce mutual exclusion of `activeNoteId`/`activePreviewId`; `ExplorerLayout` arbitrates via a derived `editorIsOpen` predicate. This pattern continues to apply — extend the predicate to include the new image viewer state if added.
- `noteFlushError` reset discipline: the recent ce-review of feat/markdown-preview clarified that `setNoteFlushError(null)` must run at the top of `handleActivate` and inside `handleDeleteById` to avoid stale errors bleeding across sessions. The new tree-click activation path goes through the same `handleActivate`, so this stays correct.

### External References

None. This is a reorganization of existing components; no new dependencies, no framework patterns being introduced.

## Key Technical Decisions

- **Big-bang switch, single PR.** No feature flag, no parallel mode where both grid and tree render. Maintaining two layouts simultaneously costs more than the one-shot refactor saves. The grid disappears in the same commit set that introduces the tree-driven layout. This makes the implementation order matter: store and tree extensions land first, then the layout swap, then the dead-code cleanup.

- **Multi-select state stays in the store, not the tree component.** `selectedArtifactIds: string[]` already exists in the store and drives the inspector. The tree just becomes another writer/reader of that field. ExplorerTree gets a new `selectedIds: string[]` prop and an `onSelect(nodeId, modifiers)` callback shape that lets it signal the modifier intent (range vs toggle vs replace) up to a layout-level handler that translates into `selectedArtifactIds` mutations.

- **Tree expansion state stays in the store.** `expandedIds` and `toggleNode` already exist and other code (Folder creation auto-expand, etc.) writes to them. No reason to relocate.

- **Containers toggle expansion AND select.** Single-click on a folder/mount/directory both updates the selection (so the inspector shows its metadata) and toggles its expansion (so the user can see/hide its children). This matches VS Code/Cursor behavior. Files only select.

- **Center pane chooses its renderer based on the single most-recently-activated node, not the full selection.** Two store fields already encode this: `activeNoteId` and `activePreviewId`. A new `activeImagePreviewId` (or reuse `activePreviewId` with a kind-tagged variant — see deferred questions) carries image activation. Center decision tree:
  1. `activeNoteId` set → NoteEditor (highest priority, dirty content wins)
  2. `activePreviewId` set → MarkdownPreview
  3. (if image extension activated) → ImageViewer
  4. Otherwise → Welcome / "Select a file" placeholder
  Multi-select does not change the center surface — it only changes the inspector.

- **`activateArtifact` is the single store entry point for "user clicked a node".** Refactored to:
  - Container kind → call `toggleNode(id)` and update `selectedArtifactIds` to `[id]` (or modifier-aware variant)
  - File kind with markdown extension → set `activePreviewId`
  - File kind with image extension → set image-preview state
  - File kind otherwise → just selection (no center activation; inspector + "cannot preview" placeholder)
  - Note kind → set `activeNoteId`
  ExplorerLayout's `handleActivate` wrapper continues to flush any open note before delegating.

- **CreateMenu parentId derivation lives in `ExplorerLayout`, not the store.** A small derived helper computes `selectedContainer = selectionCount === 1 && isDisplayFolder(selectedArtifacts[0]) ? selectedArtifacts[0] : null` and passes its id (or undefined) to `client.createX({ parentId })`.

- **ImageViewer is a new minimal component.** Renders `<img src={dataUrl}>` from `client.getNodeThumbnail(nodeId)` with loading/error states mirroring `MarkdownPreview`. Same `cancelled`-flag ignore pattern. Gets its own test file. Keeping image preview narrowly scoped — no zoom, no rotate, no metadata overlay.

- **No hierarchy-collapse / sidebar-hide toggles in this iteration.** `isHierarchyCollapsed` is removed because it has no consumer once the tree is the primary surface. Adding sidebar-hide later is a follow-up; out of scope here.

- **Welcome/empty state in the center is a single static placeholder.** Renders when `activeNoteId`, `activePreviewId`, and image-preview state are all null. No interactivity beyond the message — the tree toolbar already exposes create actions.

- **Breadcrumbs stay, repositioned to the detail surface header.** Rendered above the active surface (NoteEditor / MarkdownPreview / ImageViewer) showing root → active-node path. This preserves the wayfinding value VS Code/Cursor have in their editor breadcrumb bar — important when the tree is partially collapsed and the active file's location isn't visible in the sidebar. Breadcrumbs read from the new `activeNoteId`/`activePreviewId`/image-preview state, not from `displayedFolderId` (which is removed). For the first cut breadcrumb segments are display-only; making them clickable to reveal-in-tree is a follow-up.

- **All existing tests that exercised grid double-click are rewritten, not deleted.** They're translated to tree single-click (mount card double-click → tree single-click on the mount node row, file card double-click → tree single-click on the file node row). This preserves test intent.

## Open Questions

### Resolved During Planning

- **Where does tree expansion state live?** In the store. Already there as `expandedIds`/`toggleNode`. Kept.

- **Multi-select state model?** Reuse `selectedArtifactIds: string[]` in the store. ExplorerTree extended to `selectedIds: string[]`.

- **Inspector empty state?** Plain placeholder text ("No selection"). Not interactive. The exact copy/visual is an implementation detail; the structural decision is "always rendered, with a known empty branch".

- **Welcome state when nothing selected?** Plain placeholder ("Select a file to preview"). Not interactive.

- **Right-click context menu plumbing?** ExplorerRow already has it. No work needed beyond the existing component.

- **CreateMenu placement?** Rendered as the tree-sidebar toolbar (header above the tree).

- **parentId derivation rule?** `selectedArtifacts.length === 1 && isDisplayFolder(selectedArtifacts[0])` → that node's id; else undefined.

### Deferred to Implementation

- **Single state field for preview vs separate?** Whether image preview reuses `activePreviewId` (with a kind-tagged variant in derivation) or gets its own `activeImagePreviewId` field. The shape will become obvious once the layout's render-priority decision tree is implemented; the simpler path is a separate field, but if the markdown preview's lifecycle is a clean fit, reuse is fine. Not a structural risk either way.
- **Exact column widths for tree and inspector sidebars.** Visual decision; defer to CSS layer at implementation time. Suggest tree ~240px, inspector ~280px as starting values.
- **Modifier mapping between OS** (Cmd on macOS, Ctrl on Windows/Linux for toggle-add). Standard React patterns suffice; resolve at implementation time.
- **Should the tree auto-scroll to a newly-created node?** Existing `pendingInlineRenameId` + ancestor expansion already partially handles this via the create flow. Nice-to-have but not required for v1.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
                  ┌─────────────────────────────────────────────────────────────┐
                  │  ExplorerLayout (CSS grid: tree / center / inspector)        │
                  │                                                              │
                  │  ┌───────────────┐ ┌──────────────────┐ ┌──────────────┐    │
                  │  │ Tree sidebar  │ │ Center surface   │ │ Inspector    │    │
                  │  │ ──────────────│ │ ─────────────────│ │ ─────────────│    │
                  │  │ [CreateMenu]  │ │ [Breadcrumbs]    │ │ Persistent.  │    │
                  │  │ ExplorerTree  │ │  (path of active │ │ Empty state  │    │
                  │  │  - rows       │ │   file; hidden   │ │ when 0 sel.  │    │
                  │  │  - expand     │ │   on welcome)    │ │ Single-node  │    │
                  │  │  - select     │ │ Priority order:  │ │ + multi-sel  │    │
                  │  │  - ctx-menu   │ │   noteIsOpen →   │ │ aggregate    │    │
                  │  │               │ │   NoteEditor     │ │ unchanged.   │    │
                  │  │               │ │   previewIsOpen→ │ │              │    │
                  │  │               │ │   MarkdownPrev   │ │              │    │
                  │  │               │ │   imageIsOpen →  │ │              │    │
                  │  │               │ │   ImageViewer    │ │              │    │
                  │  │               │ │   else → Welcome │ │              │    │
                  │  └───────────────┘ └──────────────────┘ └──────────────┘    │
                  └─────────────────────────────────────────────────────────────┘

handleActivate(nodeId, modifiers)              [layout-level wrapper, async]
  ├── if open note has unsaved content → await flush; if fails, set error and return
  ├── translate modifier to selection update (replace / range / toggle-add)
  ├── store.setSelectedArtifactIds(...)
  └── store.activateArtifact(nodeId)           [routes to right side-effect]
        ├── container        → toggleNode(id)        (no center change)
        ├── note             → setActiveNoteId(id)   (NoteEditor opens)
        ├── md/mdx file      → setActivePreviewId(id)(MarkdownPreview opens)
        ├── image file       → setActiveImagePreviewId   (ImageViewer opens)
        ├── url node         → tauri-plugin-shell open(url) (system browser; see R-URL)
        └── other file kind  → no center change      (inspector only; "Cannot preview" placeholder)

CreateMenu actions
  └── parentId = (selectionCount === 1 && isDisplayFolder(selected[0])) ? selected[0].id : undefined
```

## Implementation Units

---

- [ ] **Unit 1: Store refactor — remove grid-only state, normalize tree-driven model**

**Goal:** Strip `useExplorerStore` of grid/breadcrumb/view-mode state, leave only the tree-driven model. Refactor `activateArtifact` to handle container expansion as a side effect.

**Requirements:** R4, R5, R7, R10 (foundation)

**Dependencies:** None — first to land.

**Files:**
- Modify: `src/features/explorer/store/useExplorerStore.ts`
- Modify: `src/features/explorer/store/useExplorerStore.test.ts`

**Approach:**
- Remove state and helpers no longer used: `displayedFolderId`, `setDisplayedFolderId`, `displayedFolder`, `visibleArtifacts`, `breadcrumbs`, `viewMode`, `setViewMode`, `isHierarchyCollapsed`, `toggleHierarchyCollapsed`, `mutationTarget`, `selectDisplayedFolder`, `selectTreeNode`.
- Refactor `activateArtifact` to: (a) for containers, call `toggleNode(node.id)`; for note kind, set `activeNoteId`; for file kind, dispatch by extension to `activePreviewId` (markdown), an image-preview state field, or no-op (other kinds). Folder/mount/directory selection still updates `selectedArtifactIds` so the inspector reflects the click target.
- Add an image-preview field (`activeImagePreviewId: string | null`) and its setter, derived `activeImagePreview` lookup. Mirror the existing `activeNoteId` / `activePreviewId` shape exactly.
- Keep `expandedIds`, `toggleNode`, `selectedArtifactIds`, `selectArtifact`, `applySnapshot`, `refresh`, `setPendingInlineRenameId`, the note + preview state, the action runner.
- Update or remove store tests that exercised removed state. Add tests for the new container-toggle-on-activate behavior and the image-preview branch.
- `applySnapshot`'s pruning of `selectedArtifactIds` against the new index continues to apply; remove the `displayedFolderId`-relative parent check (was: keep selection only if its parent matches the displayed folder). Replace with: keep selection if the node still exists in the new index.

**Patterns to follow:**
- Existing `activeNoteId`/`activePreviewId` pattern in the store (state + setter + derived lookup).
- Existing test style in `useExplorerStore.test.ts` (snapshot fixture + `activateArtifact` assertions).

**Test scenarios:**
- Happy path: `activateArtifact` on a folder calls `toggleNode` (verify by checking `expandedIds` flip) and sets `selectedArtifactIds` to `[folderId]`.
- Happy path: `activateArtifact` on a `.png` file sets `activeImagePreviewId` and clears `activePreviewId`/`activeNoteId`.
- Regression: `activateArtifact` on a `.md` file still sets `activePreviewId` (existing behavior).
- Regression: `activateArtifact` on a kind=note still sets `activeNoteId` (existing behavior).
- Edge case: `activateArtifact` on a kind=file with unsupported extension does NOT set any active surface field but DOES update `selectedArtifactIds`.
- Edge case: `applySnapshot` removes the active note/preview/image node from the index → corresponding active id remains set in store, but derived `activeNote`/`activePreview`/`activeImagePreview` resolve to null (consistent with current pattern).
- Edge case: calling `setExpanded`/`toggleNode` on a non-existent id is a no-op.
- Negative: removed fields (`displayedFolderId`, `viewMode`, `breadcrumbs`) are not present on the returned hook value.

**Verification:**
- `npx tsc --noEmit` passes after the field removals (callers of removed fields will surface here — documented as "expected to fail; fixed in later units").
- `useExplorerStore.test.ts` passes including new branches.

---

- [ ] **Unit 2: Extend ExplorerTree — multi-select, toolbar slot**

**Goal:** Extend `ExplorerTree`'s API to support array-based selection with modifier-aware callbacks and accept a toolbar render slot.

**Requirements:** R1, R7, R9 (toolbar slot)

**Dependencies:** None (parallel-able with Unit 1; layout swap depends on both).

**Files:**
- Modify: `src/features/explorer/components/ExplorerTree.tsx`
- Modify: `src/features/explorer/components/ExplorerRow.tsx`
- Modify: `src/features/explorer/components/ExplorerTree.test.tsx`
- Test: extend existing test file

**Approach:**
- Replace `selectedId: string | null` with `selectedIds: string[]`. Each `ExplorerRow` reads `isSelected = selectedIds.includes(node.id)`.
- Replace `onSelect(nodeId)` with `onSelect(nodeId, modifiers)` where modifiers carries `{ shift: boolean; toggle: boolean }`. ExplorerRow gathers modifier state from the click event.
- Add an optional `toolbar?: ReactNode` prop rendered as a header above the tree when provided. Wrap the existing tree DOM in a flex container with the toolbar on top.
- Keep all other props as-is (`expandedIds`, `pendingInlineRenameId`, `onDelete`, `onRetry`, `onToggle`, `onInlineRename`, `onStartRename`).
- ExplorerRow's right-click context menu (`onContextMenu` handler at line 103) is unchanged — already correct.
- Update the existing tree tests for the new selection prop shape; add new tests for modifier propagation and toolbar slot rendering.

**Patterns to follow:**
- The `ExplorerRow` modifier pattern can mirror `ArtifactCard.handleSelect` style if multi-select event handling exists there (read it first; otherwise derive from MouseEvent).
- The toolbar slot pattern is a standard React `children` or named-prop slot — no new abstraction needed.

**Test scenarios:**
- Happy path: clicking a row with no modifier fires `onSelect(id, { shift: false, toggle: false })`.
- Happy path: clicking a row with Cmd/Ctrl held fires `onSelect(id, { toggle: true })`.
- Happy path: clicking a row with Shift held fires `onSelect(id, { shift: true })`.
- Happy path: passing `selectedIds=["a","b"]` highlights both rows.
- Happy path: passing `toolbar={<button>Create</button>}` renders that button above the first tree row.
- Edge case: `selectedIds=[]` highlights nothing.
- Regression: existing tree behaviors (expansion via onToggle, inline rename, delete via context menu, retry) still pass.

**Verification:**
- `ExplorerTree.test.tsx` passes including new modifier and toolbar tests.
- Visual smoke: tree renders with toolbar at top in storybook or via temporary mount.

---

- [ ] **Unit 3: ExplorerInspector — persistent + empty state**

**Goal:** Make the inspector handle the `selectionCount === 0` case with a placeholder so it can render unconditionally.

**Requirements:** R2

**Dependencies:** None.

**Files:**
- Modify: `src/features/explorer/components/ExplorerInspector.tsx`
- Modify: `src/features/explorer/components/ExplorerInspector.test.tsx`

**Approach:**
- Add a top-level branch: if `node === null && selectionCount === 0`, render an empty-state block (e.g., a small centered "No selection" hint with the existing inspector container styling). Otherwise render the existing single-node or multi-select aggregate views.
- Do not change any of the existing per-kind metadata rendering or the multi-select aggregate logic.
- Update test file: existing per-kind / multi-select tests stay; add one test asserting the empty-state placeholder appears when the inspector receives `node={null}, selectedArtifacts=[], selectionCount={0}`.

**Patterns to follow:**
- Existing branch structure in `ExplorerInspector.tsx`. Use the same wrapper class so the inspector retains its CSS grid placement.

**Test scenarios:**
- Happy path: `node=null, selectionCount=0` renders the empty-state placeholder (assert visible text, e.g., "No selection").
- Regression: `node=<note>, selectionCount=1` still renders the per-node metadata exactly as before.
- Regression: `selectedArtifacts=[a, b], selectionCount=2` still renders the aggregate view.

**Verification:**
- `ExplorerInspector.test.tsx` passes including the empty branch.

---

- [ ] **Unit 4: ImageViewer (new component)**

**Goal:** Add a small read-only image viewer for the center pane when an image file is activated.

**Requirements:** R3 (image branch)

**Dependencies:** None (parallel-able).

**Files:**
- Create: `src/features/explorer/components/ImageViewer.tsx`
- Create: `src/features/explorer/components/ImageViewer.test.tsx`
- Modify: `src/styles/app.css` (add `.image-viewer*` classes)

**Approach:**
- Component props: `client`, `nodeId`, `name`, `onBack`. Same shape as `MarkdownPreview`.
- Internal state: `dataUrl: string | null`, `isLoading: boolean`, `loadError: string | null`. Body-load effect calls `client.getNodeThumbnail(nodeId)` with the cancelled-flag ignore pattern from `MarkdownPreview`.
- Render: header with back button + filename, body with either a loading placeholder, an error message, or an `<img>` with `max-width: 100%; max-height: 100%; object-fit: contain` styling.
- Focus the back button on mount (same pattern as `MarkdownPreview`).
- No zoom, pan, rotate, metadata overlay — keep narrowly scoped.

**Patterns to follow:**
- `src/features/explorer/components/MarkdownPreview.tsx` — exact lifecycle, error mapping, focus management, header structure. The only difference is `<img>` instead of `<MarkdownView>` / `<ReactMarkdown>`.

**Test scenarios:**
- Happy path: mounts with a valid `nodeId`, calls `getNodeThumbnail`, renders an `<img>` with the returned data URL.
- Happy path: clicking the back button calls `onBack`.
- Edge case: empty `nodeId` is not a real case (won't happen via UI), but a missing-data error from the IPC produces a load-error message instead of a blank image.
- Error path: `getNodeThumbnail` rejects → renders the error message; back button still works.
- Edge case: rapid unmount during load does not produce a setState-after-unmount warning (cancelled flag).
- Edge case: `nodeId` changes mid-load → previous fetch's response is ignored.

**Verification:**
- `ImageViewer.test.tsx` passes. Visual smoke: an image file in a mount renders.

---

- [ ] **Unit 5: ExplorerLayout — three-column rebuild**

**Goal:** Replace the current grid-based layout with the new tree + center + inspector layout. Wire all the pieces together: tree onSelect → handleActivate → store; CreateMenu in tree toolbar; center renders one of NoteEditor/MarkdownPreview/ImageViewer/Welcome by priority; inspector persistent.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12

**Dependencies:** Units 1–4 (store, tree extension, inspector empty state, image viewer).

**Files:**
- Modify: `src/features/explorer/components/ExplorerLayout.tsx` (large rewrite)
- Modify: `src/features/explorer/components/Breadcrumbs.tsx` (small API tweak: accept an explicit `nodeId` prop instead of reading the removed `displayedFolderId`)
- Modify: `src/features/explorer/components/Breadcrumbs.test.tsx` (update for the new prop shape)
- Modify: `src/styles/app.css` (replace `.explorer-workspace` grid setup with three-column template; add tree-toolbar styles; reposition breadcrumb styles for the new header context)
- Modify: `src/app/App.test.tsx` (rewrite integration tests for tree-driven flow — all App.test.tsx changes land in this unit; Unit 6 does not touch App.test.tsx)
- Possibly modify: `src/features/explorer/components/CreateMenu.tsx` if any prop adjustments are needed for the tree-toolbar context (likely none; verify)

**Approach:**
- New CSS grid template with three named columns: tree (~240px), center (1fr), inspector (~280px), single row spanning the workspace height. Remove the conditional `has-inspector` modifier — inspector is always rendered.
- Render order:
  - Left: `<div className="tree-sidebar">` containing `<ExplorerTree>` with `CreateMenu` passed via the `toolbar` prop introduced in Unit 2. Do not render `CreateMenu` as a sibling outside `ExplorerTree`; the toolbar prop is the single contract.
  - Center: a column with `<Breadcrumbs nodeId={activeFileId} />` at the top (rendered only when a file surface is active — i.e. one of `activeNoteId`/`activePreviewId`/`activeImagePreviewId` is set), then the surface itself. Surface priority: NoteEditor → MarkdownPreview → ImageViewer → Welcome placeholder.
  - Right: `<aside className="inspector-panel"><ExplorerInspector ... /></aside>`.
- `handleActivate(nodeId, modifiers)` keeps the flush-before-navigate guard from the previous markdown-preview work. New: also translates modifiers into selection-replacement-vs-toggle-vs-range. Modifier translation:
  - No modifier: `selectArtifact(nodeId, false)` (replace).
  - Cmd/Ctrl: `selectArtifact(nodeId, true)` (toggle add — already supported by `selectArtifact`).
  - Shift: range-select between the previous "anchor" and `nodeId`. Anchor tracking is local to the layout (a `useRef` to the last single-clicked id). Compute the range by walking the visible flat-tree order and selecting all node ids between anchor and target inclusive. If anchor is null, behave as no-modifier.
  - In all cases, after selection update, call `store.activateArtifact(nodeId)` (no-op for unsupported file kinds).
- `handleDeleteById` continues to clear active note/preview state when the deleted node is the active one — extend to also clear `activeImagePreviewId`.
- CreateMenu actions derive parentId from a small inline helper:
  ```
  const parentId =
    selectedArtifacts.length === 1 && isDisplayFolder(selectedArtifacts[0])
      ? selectedArtifacts[0].id
      : undefined;
  ```
- Remove all references to `displayedFolder`, `breadcrumbs`, `viewMode`, `isHierarchyCollapsed`, the `<ExplorerContentGrid>` render branch, the `onActivate={handleActivate}` wiring on the grid (now wired on the tree), and the `<Breadcrumbs>` render.
- Window-close handler unchanged.
- `flushAndCloseEditor` continues to power the note editor's back button.
- Welcome state: a simple `<div className="explorer-welcome">` with a centered hint string.

**Test scenarios:**
- Happy path: render with empty snapshot → tree shows 0 rows, toolbar shows CreateMenu, center shows welcome, inspector shows empty state.
- Happy path: render with a snapshot containing one folder → single tree row; click it → folder expands (no children) and is selected; center still welcome; inspector shows the folder's metadata.
- Happy path: snapshot with a folder containing a note → click folder to expand, click the note row → NoteEditor renders in center; inspector shows the note's metadata.
- Happy path: snapshot with a mount containing `README.md` → click mount to expand, click the `.md` row → MarkdownPreview renders in center; back button returns to welcome.
- Happy path: snapshot with an image file → click it → ImageViewer renders.
- Happy path: file with unsupported extension → click it → center stays at welcome (or shows "Cannot preview" placeholder); inspector shows the file's metadata.
- Happy path: Cmd-click two files in the tree → both highlighted; inspector shows aggregate (2 items, total size).
- Happy path: Shift-click a range → all rows between anchor and target selected.
- Happy path: open a note, type, click another row in the tree → flush triggered before navigation; if flush fails, navigation blocked and noteFlushError surfaced (regression of existing handleActivate behavior).
- Happy path: with one folder selected, click "New Note" in the tree toolbar → `createNote` called with `parentId=folderId`.
- Happy path: with no selection, click "New Note" → `createNote` called with `parentId=undefined`.
- Happy path: with two folders selected (multi), click "New Note" → falls back to `parentId=undefined` (rule: only single-container selection drives parent).
- Happy path: right-click a tree row → context menu opens (existing ExplorerRow behavior).
- Edge case: deleting the actively-displayed note clears `activeNoteId`, center returns to welcome.
- Edge case: deleting the actively-displayed image clears `activeImagePreviewId`.
- Integration: window close with only an image preview open does NOT preventDefault and does NOT call flush (existing window-close-handler behavior must remain unchanged).
- Regression: `noteFlushError` is cleared at the top of `handleActivate` (carried-forward fix from the markdown preview review).

**Verification:**
- `App.test.tsx` passes including all rewritten integration tests.
- `npx tsc --noEmit` clean.
- Manual smoke: app loads, tree shows mounts, clicking files opens correct surfaces, create menu in tree toolbar works.

---

- [ ] **Unit 6: Delete grid + breadcrumbs + view-mode toggle + dead tests**

**Goal:** Remove the now-unused grid components and their styles. Verify nothing else still imports them.

**Requirements:** Cleanup of removed scope.

**Dependencies:** Unit 5 (the layout no longer renders these).

**Files:**
- Delete: `src/features/explorer/components/ExplorerContentGrid.tsx`
- Delete: `src/features/explorer/components/ExplorerContentGrid.test.tsx`
- Delete: `src/features/explorer/components/ArtifactCard.tsx`
- Delete: `src/features/explorer/components/ViewModeToggle.tsx`
- Modify: `src/styles/app.css` (remove grid-related class blocks: `.artifact-collection-grid`, `.artifact-card*`, `.view-mode-toggle*`, the old `.explorer-workspace` rules superseded by Unit 5; **keep** `.breadcrumbs*` rules — Breadcrumbs is repositioned, not removed)
- Note: `Breadcrumbs.tsx` and `Breadcrumbs.test.tsx` are NOT deleted — they are repurposed in Unit 5 to render in the detail surface header.

**Approach:**
- After Unit 5 lands, grep the codebase for each filename and class to confirm no remaining references. If any test imports `ArtifactCard` or `ExplorerContentGrid`, those tests come out too (they'd be testing dead code).
- Also remove any image-related logic in ArtifactCard that was only powering the grid's image thumbnails — the new `ImageViewer` is the only consumer of `getNodeThumbnail` going forward (verify by grepping for `getNodeThumbnail` callers).
- Run the full test suite and `tsc --noEmit` to confirm no broken imports remain.

**Test scenarios:**
- Test expectation: none — pure deletion / mechanical cleanup.

**Verification:**
- `npx tsc --noEmit` passes.
- `npx vitest run` passes (every remaining test still runs and the suite shrinks by exactly the deleted tests).
- `grep -r "ExplorerContentGrid\|ArtifactCard\|ViewModeToggle\|displayedFolderId" src/` returns only matches inside string literals, comments, or false positives — no live imports of deleted code.
- `grep -r "Breadcrumbs" src/` still returns matches in `ExplorerLayout.tsx` (the new render site) and `Breadcrumbs.tsx`/`.test.tsx` (the repurposed component) — these are expected.

---

## System-Wide Impact

- **Interaction graph:** `activateArtifact` is the central dispatch. Tree `onSelect` → layout `handleActivate` (flush + selection update + activateArtifact). Container kinds also get `toggleNode` as a side effect from inside `activateArtifact`. The window close handler continues to gate on `noteEditorRef.current` and is not widened. Right-click context menu paths (rename, delete, retry) are unchanged in behavior, only re-mounted under the new tree.
- **Error propagation:** `handleActivate` flush failure path unchanged (noteFlushError surfaced, navigation blocked). MarkdownPreview / ImageViewer load errors stay component-local with the same opaque error vocabulary.
- **State lifecycle risks:** `selectedArtifactIds` becomes the single source of truth for "what is selected"; the previous dual-purpose use (grid selection vs tree selection) collapses. `activeNoteId` / `activePreviewId` / new `activeImagePreviewId` are set via `activateArtifact` and cleared via the back buttons or `handleDeleteById`. `applySnapshot` continues to defensively prune `selectedArtifactIds` against the new node index.
- **API surface parity:** Agents using IPC commands directly are unaffected — no IPC contract changes. The UI rebuild does not touch the Tauri command surface.
- **Integration coverage:** The new `handleActivate` modifier flow (Cmd/Shift) is exercised only in integration tests; pure unit tests of the store cannot verify the range-select math because anchor tracking lives in the layout. Add at least one integration test for each modifier path.
- **Unchanged invariants:**
  - All existing IPC commands and their request/response shapes.
  - Note auto-save + flush + window-close discipline (R12).
  - MarkdownPreview behavior (toggle, error categories, render priority of note over preview).
  - Inspector's per-kind metadata rendering and multi-select aggregate.
  - The `editorIsOpen`-style render-priority discipline at the layout level (now extends to image preview as a third surface).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing `displayedFolderId` breaks ancestor-expansion logic that auto-expanded folders during create flows | Audit all writes to `setExpandedIds` / `toggleNode` and ancestor-expansion utilities before removing helpers; preserve the "expand parents on create" behavior using only `expandedIds`. Tests for create-then-render flows must continue to pass. |
| Big-bang refactor produces a working tree but a regression in subtle existing behaviors (e.g., create-then-rename, multi-delete confirmation) | Keep the existing IPC commands and store action runner unchanged; rewrite tests to exercise the same flows through the tree path. The change is presentational, not domain. |
| Multi-select range computation requires a flat ordered traversal of visible (non-collapsed) tree rows | Compute the visible-row order at click time from the snapshot + `expandedIds`; do not cache. Worst case is O(N) per Shift-click which is fine for the expected node counts (single-user desktop, hundreds at most). |
| `ArtifactCard` deletion silently removes a feature (e.g., image thumbnails in the grid) that some other consumer depended on | The grid is the only consumer; verify by grep before deletion. If image thumbnails are still needed in the inspector, the inspector already renders them inline (verify in inspector code) or the new ImageViewer covers the use case. |
| Window-close handler currently gates on `noteEditorRef.current` only; if the layout rewrite accidentally widens this to "any active surface" the read-only previews would block window close incorrectly | Explicit code comment + regression test that closes the window with only a preview open and asserts no preventDefault. |
| Dropping `viewMode` (grid/list/date) loses persisted user preference if it was being saved anywhere | Check for any localStorage / settings persistence of `viewMode`; if present, remove the persisted key in the same change to avoid stale values. |
| Three-column CSS grid layout reflows poorly at narrow viewport widths (Tauri windows can be small) | The existing app sets a minimum window size; verify and document. If the smallest practical width still leaves <100px for the tree, defer responsive collapse to a follow-up plan. |
| Tree expansion-on-activate collides with tree expansion-via-chevron-click already implemented in ExplorerRow | Verify that `ExplorerRow`'s row click and chevron click do not double-fire `onToggle`. If they share a path, this is fine; if separate, only one should be wired up to avoid the toggle bouncing back. Read both handlers before implementing Unit 5. |

## Documentation / Operational Notes

- No user-facing docs to update.
- No new dependencies; no native-side changes; no data migrations.
- This change is presentational only; revert is straightforward (git revert the merge commit) but the change is visible enough that a quick screenshot before/after is worth attaching to the PR description.

## Sources & References

- Origin: this conversation (no `docs/brainstorms/` document — direct planning bootstrap).
- Pattern source: `src/features/explorer/components/MarkdownPreview.tsx` (loading + error pattern reused by `ImageViewer`).
- Pattern source: `src/features/explorer/components/ExplorerTree.tsx` and `ExplorerRow.tsx` (existing tree + context menu).
- Recent context: `docs/plans/2026-04-26-001-feat-markdown-file-preview-plan.md` (the `handleActivate` flush wrapper introduced there extends to the new tree-click path).
- Recent context: `docs/plans/2026-04-14-001-feat-notes-node-type-plan.md` (note lifecycle invariants preserved).

---

## Review Findings Integration (2026-04-26)

The plan was reviewed by 5 reviewer personas (coherence, feasibility, design-lens, product-lens, adversarial). The following resolutions are integrated into the plan; sections above have been updated to be consistent with these decisions. Treat this section as the authoritative tiebreaker if any earlier section is ambiguous.

### Strategic decisions (product-lens)

- **Identity shift to VS Code model is accepted.** The tradeoff acknowledged: visual at-a-glance browsing for image-heavy mounts is degraded (no thumbnail wall). Accepted because notes + URL + structured-content workflows are the primary use case; deep image-gallery browsing is not. Tree-row icons (`FileImage` lucide glyph) are sufficient identification for the supported scope.
- **URL node activation is a real gap and must be specified.** New requirement **R-URL**: single-click on `kind="url"` node selects it (inspector updates) AND opens the URL in the system default browser via `tauri-plugin-shell` (or equivalent). If shell-open fails or the node is in `pending`/`error` state, fall back to selection-only and rely on the inspector's existing retry control. Add `tauri-plugin-shell` to the dependency check during Unit 5 implementation; if the plugin isn't already wired, add it. (Frontend uses `import { open } from "@tauri-apps/plugin-shell"`.)
- **No double-click activation flow** (R8) means *for navigation/preview*. The existing `onDoubleClick={() => onStartRename(node.id)}` on the tree row label (ExplorerRow.tsx:133) **stays** — double-click-to-rename is a useful muscle-memory affordance and does not conflict with the navigation model. R8 wording clarified accordingly.
- **Opportunity cost** is accepted; this refactor is sequenced before the next IPC-bearing feature.

### Required code-level corrections (feasibility)

- **F1 / F9 — `applySnapshot` and `activateArtifact` dep-array updates (Unit 1).**
  - `applySnapshot` was a `useCallback([displayedFolderId])`. With `displayedFolderId` removed, drop it from the dep array and rewrite the body: keep root auto-expansion, remove the `nextDisplayedFolderId` ancestor expansion block, replace the selection filter with `current.filter(id => nextIndex.has(id))`.
  - `activateArtifact` was a `useCallback([nodeIndex, selectDisplayedFolder])`. Update to `[nodeIndex, toggleNode]` after the container branch is rewritten.
- **F2 — ExplorerInspector empty state (Unit 3).** The current `if (!node) return null` at ExplorerInspector.tsx line 45 is exactly the codepath we want to repurpose. Replace `return null` with a placeholder render (`<div className="inspector-pane"><p>No selection</p></div>`). No new branch needed.
- **F3 — `TreeBranch` internal component (Unit 2).** ExplorerTree.tsx defines an internal recursive `TreeBranch` (~lines 50-114). The selection prop change (`selectedId: string | null` → `selectedIds: string[]`) and onSelect signature change (`onSelect(nodeId)` → `onSelect(nodeId, modifiers)`) must be propagated through `TreeBranch` as well — TypeScript surfaces this but Unit 2's file list now explicitly includes `TreeBranch`'s prop interface.
- **F4 — App.test.tsx test-string anchors (Unit 5).** The current tests anchor on `findByText(/no visible artifacts/i)` (from ExplorerContentGrid) and `fireEvent.dblClick(...)`. Both vanish in this refactor. Specified anchor strings:
  - Welcome state in center: `"Select an item to preview"` (used in the test as `findByText(/select an item to preview/i)`).
  - Inspector empty state: `"No selection"`.
  - Tree empty state (no roots): no special placeholder; the tree just renders zero rows. Tests assert `screen.queryByRole("tree")` exists with zero `treeitem` children.
  - Tree-driven activation: replace `dblClick` with `fireEvent.click(<the tree row matching node name>)`.
- **F5 — ImageViewer 5MB cap mapping (Unit 4).** `getNodeThumbnail` rejects with `"thumbnail unavailable"` for files >5MB and for permission errors — these collapse into one opaque error. ImageViewer's error mapping must show **"This image is too large or unavailable to preview."** for the catch-all path. Raising the cap is **deferred to a follow-up plan**: needs a backend change in `thumbnails.rs` and a security re-review of the size-cap rationale.
- **F6 — R8 vs `onDoubleClick`-rename.** Resolved: R8 is about navigation flows only; rename-on-double-click stays.
- **F7 — `ExplorerViewMode` and `ExplorerTreeNode` type cleanup (Unit 6).** Add `src/features/explorer/types/explorer.ts` to Unit 6's modify list; remove `ExplorerViewMode` and `ExplorerTreeNode` after grep confirms zero remaining importers.
- **F8 — `replaceSelection(ids: string[])` action (Unit 1).** Range-select needs an atomic batch setter. Add `replaceSelection` to the store's returned API; the layout's Shift-click handler computes the visible-flat-tree slice and calls `store.replaceSelection(rangeIds)` in one dispatch. Test: range Shift-click sets `selectedArtifactIds` exactly once with the full range.
- **F10 — All four create handlers, parentId snapshot semantics (Unit 5).** `handleFolderCreate`, `handleNoteCreate`, `handleMountSubmit`, `handleUrlSubmit` all use the new `selectedContainer` derived helper. **Snapshot-at-modal-open**: when a modal-bearing handler (mount, URL) is invoked, capture `parentId` at modal-open time into modal state, NOT at submit time — otherwise the user can change the tree selection mid-modal and the parentId shifts unexpectedly. Direct-action handlers (folder, note) capture at click time, which is the same instant.

### Coherence cleanups (auto-fixable)

- **COH-001 — Toolbar slot resolved.** `CreateMenu` is passed via `ExplorerTree`'s `toolbar?: ReactNode` prop (introduced in Unit 2). Do not render `CreateMenu` as a sibling outside the tree. Unit 5's parenthetical "OR sibling" is removed.
- **COH-002 — `activateArtifact` annotation.** Unit 5's `(no-op for unsupported file kinds)` comment is replaced with: `(dispatches by kind: containers toggle expansion, notes/markdown/images open their surface, URLs open in system browser, other file kinds leave center unchanged)`.
- **COH-003 — App.test.tsx ownership.** All App.test.tsx changes land in Unit 5. Unit 6 does not touch App.test.tsx. Cross-reference removed.
- **COH-004 — R7 vs Scope Boundaries.** Mouse-modifier multi-select (Cmd/Ctrl-click toggle, Shift-click range) **is in scope** per R7. Scope-Boundaries clarified: keyboard-only shortcuts (Ctrl+N, F2, arrow-key navigation) are out; mouse-modifier selection is in.
- **COH-005 — `selectArtifact` signature.** The current store already exposes `selectArtifact(nodeId, additive?: boolean)`. Unit 1 keeps that signature; the new `replaceSelection(ids: string[])` is added alongside (does not replace `selectArtifact`).
- **COH-006 — Image-preview field naming.** Single canonical name: **`activeImagePreviewId: string | null`** with setter `setActiveImagePreviewId` and derived `activeImagePreview`. The "or reuse `activePreviewId`" alternative is dropped. The diagram and all units use this name uniformly.
- **COH-007 — `applySnapshot` System-Wide Impact wording updated** to reflect the new pruning rule (node must still exist; `displayedFolderId`-relative parent check removed).
- **COH-009 — `ImageViewer.onBack` wiring (Unit 5).** `onBack` calls `store.setActiveImagePreviewId(null)`, returning the center to the welcome state. Mirrors the (unchanged) `MarkdownPreview.onBack` → `store.setActivePreviewId(null)` wiring.

### Design refinements (design-lens)

- **DL-1 — "Cannot preview" placeholder vs Welcome state are distinct.** Both render in the center area:
  - **Welcome state**: shown when `activeNoteId`, `activePreviewId`, `activeImagePreviewId` are all null AND `selectedArtifactIds.length === 0`. Copy: `"Select an item to preview"`. No breadcrumbs.
  - **Cannot-preview placeholder**: shown when a non-previewable node is the *only* selected node (e.g., a `.zip` file is single-clicked) and no surface state is set. Copy: `"This file type cannot be previewed"`. No breadcrumbs. Inspector still shows the file's metadata.
  - **Loading state**: when `isLoading` is true (initial snapshot fetch), the center renders nothing (no welcome, no placeholder). The tree-sidebar shows the existing "Loading explorer..." placeholder. Welcome and Cannot-preview are guarded by `!isLoading`.
- **DL-2 — ImageViewer height context.** Center pane is a flex column with `min-height: 0` so children with `flex: 1` don't overflow. ImageViewer's body uses `display: flex; align-items: center; justify-content: center; overflow: hidden` and the `<img>` uses `max-width: 100%; max-height: 100%; object-fit: contain`. Document this in the CSS specifically (Unit 4).
- **DL-3 — Modifier key cross-platform mapping.** Use `event.metaKey || event.ctrlKey` for the toggle-add modifier. This is the standard pattern: macOS users press Cmd, Windows/Linux users press Ctrl. Documented in Unit 2.
- **DL-4 — Anchor reset rules (Unit 5).**
  - Plain click (no modifier): set anchor to clicked id, replace selection with `[id]`.
  - Cmd/Ctrl click: set anchor to clicked id, toggle selection of that id.
  - Shift click: anchor stays as last-set; selection becomes the range from anchor to target (computed from current visible flat-tree order).
  - If anchor id is not present in the current visible flat-tree order (collapsed ancestor or deleted), behave as plain click (treat target as the new anchor).
  - Anchor stored in `useRef<string | null>`. Reset to `null` only when `selectedArtifactIds` is explicitly cleared from outside (e.g., after a delete that empties selection).
- **DL-5 — Container click idempotency.** Single-click on an already-selected, already-expanded folder: still toggles (collapses) and remains selected. The chevron toggle and row-body toggle do not double-fire because they live in separate buttons (no propagation between sibling buttons). Click on chevron alone toggles only; click on row body selects + toggles. Both paths converge on `toggleNode(id)`. Clicking the row body of a collapsed folder expands and selects it; clicking again collapses it (and re-selects, which is idempotent).
- **DL-6 — Focus management.** Each surface decides its own initial focus: NoteEditor (existing behavior) does not steal focus; MarkdownPreview and ImageViewer focus the back button on mount (existing pattern). Welcome and Cannot-preview placeholders do NOT steal focus — focus stays in the tree. Tab from a tree row leads naturally to the center pane (browser default tab order).
- **DL-7 — Minimum window width.** Verify Tauri config at implementation time. Target: tree 240px + center min 480px + inspector 280px = 1000px minimum app width. If current Tauri config allows narrower, raise the floor. Documented in Unit 5.
- **DL-8 — Tree empty state.** When the snapshot has zero roots, the tree renders zero rows; the tree toolbar (CreateMenu) is the only call-to-action. No special "Empty workspace" copy needed because the create menu is already prominent. Tested by asserting CreateMenu is reachable when the tree has no items.

### Adversarial concerns (resolved or accepted)

- **Adv-F1 (applySnapshot pruning)**: covered by F1 above.
- **Adv-F2 (chevron + row double-fire)**: covered by DL-5 above. They live in separate buttons; no propagation. Test scenario added to Unit 2: clicking the row body triggers exactly one `onToggle` call.
- **Adv-F3 (anchor invalidation)**: covered by DL-4 above.
- **Adv-F4 (rename + activate race)**: when the user clicks another tree row while inline-rename is active, the blur fires `commit()` on the rename input first (synchronously initiating `handleInlineRename`), then the click on the new row fires `handleActivate`. Both go through `runAction` which serializes via `setActiveAction`. **Required guard**: `handleActivate` checks `store.activeAction !== null` at the top; if true, await one tick (`await new Promise(r => setTimeout(r, 0))`) and re-check before proceeding with flush. This prevents the rename action from being clobbered. Documented in Unit 5.
- **Adv-F5 (ImageViewer 5MB cap)**: covered by F5 above. Error message specified.
- **Adv-F6 (big-bang rollback story)**: accepted. The git-revert path is rough; mitigation is to ensure all units land in one PR with the full test suite passing. If a regression is found post-merge, the revert IS the rollback; downstream work would need to rebase. This is an explicit risk we accept for cleanliness.
- **Adv-F7 (multi-select delete semantics)**: clarified. Right-click on a tree row opens its existing context menu, which only operates on that row. Multi-select **does not** trigger batch delete from the context menu; batch delete via context menu is a separate feature out of scope for this plan. The existing `handleDeleteById` (single-node) flow is unchanged. Documented in Scope Boundaries.
- **Adv-F8 (welcome vs loading flash)**: covered by DL-1 above. Welcome is gated by `!isLoading`.

### Updates to specific units

- **Unit 1**: now also adds `replaceSelection(ids)` action; updates `applySnapshot` and `activateArtifact` dep arrays per F1/F9.
- **Unit 2**: file list explicitly includes `TreeBranch` interface inside ExplorerTree.tsx; modifier-key check uses `metaKey || ctrlKey`; toolbar slot is the only CreateMenu placement.
- **Unit 3**: replace `return null` with empty-state render; do NOT add a new branch.
- **Unit 4** (ImageViewer): error mapping for `"thumbnail unavailable"` → `"This image is too large or unavailable to preview."`; CSS height-context per DL-2.
- **Unit 5**: now includes the URL activation path (shell.open), the in-flight rename guard (Adv-F4), the snapshot-at-modal-open semantics for create handlers (F10), specified welcome/cannot-preview/empty copy strings, anchor reset logic (DL-4), minimum window width verification (DL-7).
- **Unit 6**: adds `src/features/explorer/types/explorer.ts` (remove `ExplorerViewMode`, `ExplorerTreeNode`).

### New scope boundaries

- Multi-select batch delete is **not** added in this plan. Right-click delete operates on the right-clicked node only.
- Raising the image-preview size cap above 5MB is **not** done here; deferred to a follow-up backend plan.
- `tauri-plugin-shell` integration for URL activation is in scope IF the plugin is not already wired; otherwise the plan inherits the existing wiring.
- Image thumbnail preview at-a-glance (e.g., a gallery mode in the center pane) is not added; the loss is accepted per the strategic decision above.

