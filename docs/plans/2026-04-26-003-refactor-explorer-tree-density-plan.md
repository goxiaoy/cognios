---
title: refactor: Increase ExplorerTree information density
type: refactor
status: completed
date: 2026-04-26
deepened: 2026-04-26
---

# refactor: Increase ExplorerTree information density

## Overview

Tighten the Explorer tree so the left rail carries more hierarchy context in the same viewport area while staying adjustable for real-world file names. The current tree works functionally, but it spends too much space on padding, separators, and empty chrome while showing only the node name. This refactor keeps the current activation model and store contract intact, but makes the tree denser, easier to scan, better at disambiguating long or repetitive filenames, and less likely to interfere with content scrolling.

## Problem Frame

The current Explorer tree already supports the modern interaction model the app wants: persistent left tree, single-click activation, multi-select, inline rename, and a toolbar-backed create menu. The problem is presentation density.

`ExplorerRow.tsx` renders a roomy, card-like row with a wide expander column, generous vertical padding, full-width row dividers, and only one piece of information per node: its name. In real data, especially mounted directories with long timestamp-based names and many siblings, this creates three problems:

1. Too few rows fit in the visible tree viewport.
2. Truncated names are hard to distinguish without clicking into the inspector.
3. The tree visually competes with the detail surface instead of acting like a compact navigation rail.
4. Long filenames and repeated timestamp prefixes cannot be fully inspected from the tree without selecting the node or resizing the whole app window.
5. Scrolling pressure is not isolated enough at the shell level: the center content area should be able to scroll on its own without dragging the file tree or inspector along for the ride.

The request is not for another broad Explorer architecture change. It is a focused UI density pass on the existing tree-driven Explorer so the left rail feels closer to a professional editor/file navigator and less like a spacious list view.

## Requirements Trace

- R1. The default Explorer tree layout shows materially more rows per viewport than the current implementation by reducing row chrome and vertical spacing; implementation should target a before/after gain that is obvious in a like-for-like screenshot comparison and large enough to be counted, not merely felt.
- R2. Each row exposes enough secondary context to help distinguish truncated names without forcing an inspector click.
- R3. Dense presentation preserves current tree behavior: selection, multi-select modifiers, inline rename, context menu, create actions, note flush-before-switch, and file/url activation.
- R4. The tree sidebar remains usable at current app widths and should not steal disproportionate space from the detail surface.
- R5. Node kinds remain scannable after compaction; users should still be able to tell containers, notes, files, and URLs apart quickly.
- R6. The divider between the file tree and the center content supports horizontal drag-resize so users can temporarily allocate more width to long names without resizing the whole window.
- R7. Long or truncated tree labels expose their full name/path on hover after a short dwell, without requiring selection or breaking dense layout.
- R8. The tree rail, center content surface, and right inspector scroll independently; scrolling the center content must not drag the tree or inspector with it.

## Scope Boundaries

- No search, filter, sorting, or virtualized tree rendering.
- No filesystem-level hiding rules such as suppressing `.DS_Store`.
- No new backend fields or IPC endpoints; this plan must use existing snapshot data.
- No user-selectable density mode in this iteration.
- No persisted pane-width preference in this iteration unless the implementation turns out to be nearly free.
- No changes to note editor, markdown preview, image viewer, or inspector behavior beyond layout adjacency/regression checks.

## Context & Research

### Relevant Code and Patterns

- `src/features/explorer/components/ExplorerRow.tsx` owns the row shell, expander hit area, icon rendering, modifier-aware selection, inline rename, and context menu. It is the primary density bottleneck and should remain the single row-composition surface.
- `src/features/explorer/components/ExplorerTree.tsx` already supports array-based selection and a toolbar slot. No API redesign is needed for density work unless row metadata needs a small prop addition.
- `src/features/explorer/components/ExplorerLayout.tsx` fixes the Explorer shell at `240px / 1fr / 280px` and injects `CreateMenu` into the tree toolbar. Any tree-width rebalance, draggable divider, sidebar header compaction, and scroll-boundary ownership belongs here.
- `src/styles/app.css` contains the current density choices and shell overflow behavior: row padding, border treatment, expander width, toolbar padding, sidebar width, and the app panel scroll container. Most visual and scroll-isolation change will land here.
- `src/features/explorer/utils/presentation.ts` already centralizes explorer-specific display formatting (`formatNodeDate`, `formatNodeSize`, kind labels, markdown/image detection). Compact tree metadata should be derived here instead of hardcoded inside JSX.
- `src/app/App.test.tsx`, `src/features/explorer/components/ExplorerTree.test.tsx`, and `src/features/explorer/store/useExplorerStore.test.ts` already cover the interaction model that must not regress.

### Institutional Learnings

- No `docs/solutions/` directory or explorer-specific learning artifact exists in this repo, so there is no prior institutional guidance to carry forward for this density pass.

### External References

- None. The codebase already has sufficient local patterns for this change, and the task does not depend on unfamiliar framework behavior.

## Key Technical Decisions

- Increase density by making the existing tree presentation better, not by adding a new navigation mode.
  Rationale: the user’s complaint is about baseline information density. Adding a density toggle would introduce new state, branching, and test overhead without solving the default experience.

- Use a compact single-row composition with right-aligned secondary metadata instead of adding two-line rows.
  Rationale: the main goal is to fit more useful information into the same viewport height. A second text line would add information but reduce vertical density. A one-line structure with prioritized metadata uses the current empty horizontal space more effectively.

- Reuse existing node data for contextual suffixes.
  Rationale: `ExplorerNode` already exposes `kind`, `state`, `sizeBytes`, `modifiedAt`, and `children`. That is enough to surface lightweight hints such as type, size, state, and child count. No backend or IPC work is justified.

- Apply metadata priority by node kind and hide lower-priority tokens when width is constrained.
  Rationale: a dense tree only works if it degrades gracefully. Containers need different context than files, and the narrowest layouts cannot afford to render every token all the time.

- Keep the sidebar a navigation rail, not a mini inspector.
  Rationale: the inspector already owns full metadata display. The tree should expose only enough context to improve scanability and reduce unnecessary clicks.

- Add a draggable divider between tree and content instead of permanently widening the default tree column.
  Rationale: the default layout should still favor information density, but users need an escape hatch for unusually long names. Drag-resize solves the long-name problem without forcing the default shell to stay wide all the time.

- Reveal full names/paths through hover disclosure instead of rendering full paths inline.
  Rationale: inline paths would destroy density. Hover disclosure gives access to the full string only when needed while keeping the resting state compact.

- Make each Explorer pane own its own scroll container.
  Rationale: navigation, content reading/editing, and metadata inspection are separate tasks. Independent scroll containers keep content movement local and prevent the shell from feeling unstable.

## Open Questions

### Resolved During Planning

- Should this ship as an optional density mode or replace the current default tree styling?
  Resolution: replace the default styling. The problem is the default experience, and a mode toggle would add state and testing cost without clear product value.

- Should secondary tree context come from new backend data?
  Resolution: no. Existing snapshot fields are sufficient for a first density pass.

- Should row density increase by stacking more content vertically?
  Resolution: no. The plan uses a single-line row layout with prioritized trailing metadata so density improves in both height and scan efficiency.

### Deferred to Implementation

- The exact token priority for each node kind on very narrow widths.
  Why deferred: the rule can be planned now, but the final hide/show breakpoints and token ordering should be tuned in implementation against the real CSS and screenshots.

- Whether the tree sidebar should settle at a slightly narrower fixed width or a `minmax(...)` contract.
  Why deferred: the plan is clear that the sidebar should be tighter, but the exact width should be chosen once the dense row composition is visible in the app.

- Whether dragged tree width should reset on reload or be remembered for the session only.
  Why deferred: persistence is not required for the UX win, so implementation should decide based on complexity after the base drag behavior is working.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Row Information Priority

| Node kind | Primary label | Preferred secondary context | Fallback when width is tight |
| --- | --- | --- | --- |
| `folder` / `directory` / `mount` | Name | child count, exceptional state | child count only |
| `note` | Name | `NOTE`, modified date or size | `NOTE` only |
| `file` | Name | compact type label plus size or modified date | compact type label only |
| `url` | Name | state (`pending`, `indexed`, `error`) | state only |

### Intended Shell Shape

```text
tree-sidebar
  tree-header
    compact create trigger
    lightweight summary (selection count or root/item count)
  tree-scroll
    dense rows
      expander | icon | name........ | trailing meta
resize-handle
detail-surface-scroll
inspector-scroll
```

## Success Metrics

- In a like-for-like default app window using the same representative snapshot, the tree shows visibly more fully readable rows than the current implementation.
- Long sibling filenames become easier to distinguish from the tree alone because at least one contextual suffix survives truncation.
- Long filenames can be fully inspected from the tree via drag-resize or hover disclosure without changing selection.
- Scrolling long center-pane content leaves tree scroll position and inspector scroll position unchanged.
- The denser shell does not regress create flows, selection behavior, or preview activation in existing Explorer tests.

## Implementation Units

- [x] **Unit 1: Define compact tree metadata formatters**

**Goal:** Introduce presentation helpers that compute short, type-aware row metadata and safe hover-disclosure strings so row JSX stays simple and consistent.

**Requirements:** R2, R5, R7

**Dependencies:** None

**Files:**
- Modify: `src/features/explorer/utils/presentation.ts`
- Create: `src/features/explorer/utils/presentation.test.ts`

**Approach:**
- Add compact formatting helpers for the tree rail rather than reusing inspector-level strings verbatim.
- Keep the logic pure and type-aware so row rendering only decides placement, not formatting rules.
- Prefer metadata that resolves name ambiguity quickly:
  - containers: child count and exceptional state
  - files/notes: short type token plus one compact distinguishing value such as size or modified date
  - URLs: state first
- Add a formatter for full hover disclosure content, preferring the repo-relative/root-relative node path over the bare filename when ancestry is available.
- Ensure compact labels are intentionally shorter than inspector labels so the tree stays a navigation surface.

**Patterns to follow:**
- Existing formatting helpers in `src/features/explorer/utils/presentation.ts`
- Existing type detection helpers such as `isImageNode` and `isMarkdownFile`

**Test scenarios:**
- Happy path: a markdown file returns a compact file-type token distinct from a generic document file.
- Happy path: a folder with children returns a child-count-oriented compact label.
- Happy path: a URL node returns its state-oriented compact metadata.
- Happy path: a nested node returns a full hover-disclosure path string in root-to-leaf order.
- Edge case: invalid or missing date input falls back cleanly instead of leaking `Invalid Date`.
- Edge case: a zero-byte file keeps a stable compact size label rather than rendering an empty suffix.
- Error path: nodes with unexpected kind/value combinations still return a safe fallback string.

**Verification:**
- Compact metadata helpers produce deterministic labels for representative node kinds in unit tests.

- [x] **Unit 2: Refactor tree rows for dense one-line scanning**

**Goal:** Recompose `ExplorerRow` so each row consumes less height, wastes less horizontal space, renders the new secondary metadata, and discloses full names/paths on hover without breaking interaction behavior.

**Requirements:** R1, R2, R3, R5, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `src/features/explorer/components/ExplorerRow.tsx`
- Modify: `src/features/explorer/components/ExplorerTree.tsx`
- Modify: `src/features/explorer/components/ExplorerTree.test.tsx`
- Modify: `src/styles/app.css`

**Approach:**
- Reduce row chrome: smaller vertical padding, narrower expander column, lighter separators, and tighter icon/name spacing.
- Replace the current card-like row feel with a rail-like row feel while preserving accessible click targets and focus treatment.
- Add a trailing metadata rail that truncates or hides gracefully before the primary node name becomes unreadable.
- Add hover disclosure for truncated rows, with a small dwell delay before showing the full name/path so the UI does not flicker while the pointer moves across the tree.
- Keep inline rename inside the same dense geometry so editing does not cause the tree to jump between two unrelated row heights.
- Preserve the current selection and context-menu DOM ownership in `ExplorerRow` so `ExplorerLayout` and store behavior remain unchanged.

**Patterns to follow:**
- Existing modifier-aware selection behavior in `src/features/explorer/components/ExplorerRow.tsx`
- Existing toolbar slot and recursive tree rendering in `src/features/explorer/components/ExplorerTree.tsx`

**Test scenarios:**
- Happy path: a plain click still fires `onSelect(nodeId, { shift: false, toggle: false })`.
- Happy path: Cmd/Ctrl-click and Shift-click still propagate the correct modifiers.
- Happy path: rows render the compact metadata container for node kinds that have secondary context.
- Happy path: hovering a truncated row long enough reveals the full name/path disclosure without selecting the node.
- Edge case: inline rename swaps the label for an input without removing the row from tree flow.
- Edge case: long names still expose the full title via `title`/tooltip semantics while truncating visually.
- Edge case: moving the pointer off the row before the dwell delay expires does not leave a stuck disclosure surface behind.
- Error path: URL rows in error state continue to render retry-capable context menu affordances.
- Integration: selected rows remain selectable in multi-select scenarios after the DOM/layout refactor.

**Verification:**
- `ExplorerTree` component tests still prove modifier behavior, selection highlighting, and toolbar rendering after the dense row refactor.
- In implementation review, a before/after comparison at the same viewport height shows a clearly higher count of fully visible rows and no loss of primary-name readability.

- [x] **Unit 3: Add adjustable tree width and isolate pane scrolling**

**Goal:** Make the surrounding sidebar structure support the denser rows, allow temporary width expansion for long names, and ensure each Explorer pane scrolls independently.

**Requirements:** R1, R3, R4, R6, R8

**Dependencies:** Unit 2

**Files:**
- Modify: `src/features/explorer/components/ExplorerLayout.tsx`
- Create: `src/features/explorer/components/ExplorerLayout.test.tsx`
- Modify: `src/styles/app.css`

**Approach:**
- Rebalance the Explorer shell so the tree column reads as a compact navigation rail rather than a padded panel.
- Replace the hardcoded tree/content boundary with a local-width state plus a drag handle constrained to sane minimum and maximum widths.
- Move overflow ownership down to the three panes so the tree rail, center detail surface, and inspector can scroll independently even when the surrounding app panel stays fixed.
- Keep the resize logic local to the Explorer shell; do not couple it to the store or backend.
- Verify that drag-resize and scroll isolation do not interfere with note editor, markdown preview, or image viewer behavior.

**Patterns to follow:**
- Current tree-toolbar injection in `src/features/explorer/components/ExplorerLayout.tsx`
- Existing shell layout structure in `src/styles/app.css`

**Test scenarios:**
- Happy path: dragging the divider updates the rendered tree width within configured bounds.
- Happy path: tree, detail surface, and inspector each own their own scrollable container.
- Edge case: dragging the divider to extremes clamps at minimum and maximum widths instead of collapsing a pane.
- Edge case: long tree names remain navigable without collapsing the detail surface below usable width.
- Integration: center-pane scrolling leaves the tree sidebar and inspector mounted in place with unchanged scroll offsets.

**Verification:**
- Layout-level tests prove divider drag behavior and independent scroll-container ownership.
- Manual verification at the app-shell level confirms the denser sidebar does not collapse the center detail surface below a usable width in the default desktop layout.

- [x] **Unit 4: Re-verify create flows and shell regressions in the full app**

**Goal:** Prove that the denser tree shell still works inside the real app wiring after row, hover, resize, and scroll-boundary changes land.

**Requirements:** R3, R6, R8

**Dependencies:** Unit 3

**Files:**
- Modify: `src/features/explorer/components/CreateMenu.tsx`
- Modify: `src/app/App.test.tsx`

**Approach:**
- Compress toolbar/header affordances only after the resizable shell contract is established.
- Keep create behavior unchanged: toolbar actions still route through the existing `CreateMenu` and `selectedContainerId` logic.
- Re-run app-level assertions around empty state, create actions, preview activation, and shell stability so the denser presentation does not hide a functional regression.

**Patterns to follow:**
- Existing create action wiring in `src/features/explorer/components/CreateMenu.tsx`
- Existing app-level explorer flows in `src/app/App.test.tsx`

**Test scenarios:**
- Happy path: the Explorer still renders the welcome state and empty inspector when the snapshot is empty.
- Happy path: create actions remain reachable from the compact toolbar and still create into the expected parent.
- Edge case: opening create actions while tree selection changes does not alter the already-snapshotted parent target.
- Integration: toolbar compaction does not break the existing “new folder”, “mount directory”, and “add URL” flows covered in `App.test.tsx`.
- Integration: preview activation and URL-open flows still work after the shell owns resize and pane scrolling.

**Verification:**
- App-level tests still prove the tree toolbar create flows and basic Explorer shell rendering after sidebar compaction.

## System-Wide Impact

- **Interaction graph:** `ExplorerRow` remains the event owner for click, modifier, rename, hover disclosure, and context-menu actions; `ExplorerLayout` continues to translate row clicks into selection and activation while also owning divider drag state and pane scroll boundaries; `useExplorerStore` remains the single state authority.
- **Error propagation:** This refactor should not introduce new async failure paths because metadata is derived from existing snapshot fields. The only failure-sensitive paths remain create, rename, delete, retry, note flush, and URL open.
- **State lifecycle risks:** Snapshot updates after rename/delete/create must continue to refresh row metadata correctly. Dense rendering must not cache stale suffixes outside the existing React render flow. Divider drag and hover timers must clean up correctly on unmount to avoid stuck UI state.
- **API surface parity:** No backend or IPC contract changes are expected. `ExplorerNode` stays unchanged.
- **Integration coverage:** App-level and layout-level tests need to keep proving create flows, selection-driven rendering, preview activation, divider drag behavior, and independent scroll containment because the visible shell around those behaviors is changing.
- **Unchanged invariants:** Multi-select semantics, note flush-before-switch, URL open behavior, preview routing, inline rename, and context menu actions should remain behaviorally identical.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Over-compressing rows harms readability or clickability | Keep accessible focus states and minimum hit targets, and verify against real screenshots before merge |
| Secondary metadata becomes noisy instead of useful | Use kind-specific priority rules and allow lower-priority tokens to hide first on narrow widths |
| Dense row markup breaks rename/context menu flows | Preserve the existing ownership boundaries in `ExplorerRow` and cover regressions in component tests |
| Resize handling causes janky drag behavior or text selection side effects | Use explicit drag state, clamp widths, and verify pointer cleanup paths in layout tests |
| Scroll ownership stays on the outer panel, so center scrolling still moves the whole shell | Move overflow responsibility to pane-level containers and verify with app-shell/manual checks |
| Sidebar compaction steals too much space from detail content on small windows | Tune width bounds as part of implementation and verify at app-shell level before finalizing |

## Documentation / Operational Notes

- No product or backend documentation changes are required.
- The implementation should capture before/after screenshots for review because the value of this work is primarily visual and interactional.

## Sources & References

- Related prior plan: `docs/plans/2026-04-26-002-refactor-explorer-tree-layout-plan.md`
- Related requirements background: `docs/brainstorms/explorer-ui-milestone-2-requirements.md`
- Related code:
  - `src/features/explorer/components/ExplorerRow.tsx`
  - `src/features/explorer/components/ExplorerTree.tsx`
  - `src/features/explorer/components/ExplorerLayout.tsx`
  - `src/features/explorer/utils/presentation.ts`
  - `src/styles/app.css`
