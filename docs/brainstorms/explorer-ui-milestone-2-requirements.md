---
date: 2026-04-13
topic: explorer-ui-milestone-2
---

# Explorer UI — Navigation Shell, Content Grid & Inspector

## Problem Frame

Milestone 1 delivered a functional VFS backend and a working-but-plain tree explorer. The current UI is one flat view: a hero header, a tree panel, and a sparse inspector. It does not reflect the product's identity as a personal knowledge OS.

This milestone replaces the placeholder shell with a real app structure — a persistent left navigation sidebar, a three-pane Explorer (hierarchy tree / content grid / inspector), a richer node metadata surface (dates, size), and type-aware artifact cards with image thumbnail support. Home, Chat, and Memory Timeline sections are stubbed so the navigation contract is established without pre-building unrelated features.

The target is a UI that a user would recognize as a real product, not a scaffold.

## Layout Overview

```
┌──────────┬────────────────────────────────────────────────────────┐
│          │  HIERARCHY        │  CONTENT GRID        │  INSPECTOR  │
│  LEFT    │                   │                       │             │
│   NAV    │  ▼ Project Alpha  │  architecture         │ [name]      │
│          │    ▶ assets       │  12 ARTIFACTS  ● GRID │ DIRECTORY   │
│  Home    │    ▼ docs         │                       │             │
│  Chat    │      architecture │  [card][card][card]   │ CREATED     │
│ ●Explorer│      specs        │  [card][card][card]   │ MODIFIED    │
│  Memory  │      research     │                       │ TOTAL SIZE  │
│          │    ▶ src          │                       │             │
└──────────┴────────────────────────────────────────────────────────┘
```

## Requirements

**Navigation Shell**
- R1. The app renders a persistent left sidebar containing four navigation items in order: Home, Chat, Explorer, Memory Timeline, with a CogniOS wordmark/logo at the top and a system status line at the bottom.
- R2. Home, Chat, and Memory Timeline render stub placeholder pages — empty state with section name — so routes are established without functional implementation.
- R3. Explorer is the active section; it occupies the remainder of the viewport to the right of the sidebar and is divided into three panels: Hierarchy (left), Content Grid (center), Inspector (right).
- R4. The active navigation item is visually distinguished. Navigation persists across Explorer interactions (selecting a node does not collapse the sidebar or change the active nav item).

**Hierarchy Panel**
- R5. The Hierarchy panel shows the full collapsible VFS node tree — the existing `ExplorerTree` behavior — within the left portion of the Explorer section. The panel can be toggled open/closed (collapsed to icon-only).
- R6. Selecting a folder in the Hierarchy sets the `displayed folder` for the Explorer. The Content Grid shows that folder's immediate children, the selected folder is highlighted in the tree, and any prior grid-artifact selection is cleared.
- R7. The breadcrumb trail reflects the `displayed folder` that is currently driving the Content Grid, not the currently selected artifact inside the grid.

**Content Grid**
- R8. The Content Grid header shows: the current folder name, a count of artifacts (`N ARTIFACTS`), and view mode toggles (Grid, List, Date).
- R9. The Content Grid displays the immediate children of the selected folder as artifact cards.
- R10. Artifact cards show: a type-representative thumbnail/icon area, node name (truncated if necessary), modified date, and a type badge (e.g., FOLDER, DOCUMENT, IMAGE, CODE, MARKDOWN, WEB LINK, MOUNT).
- R11. For image-type file nodes, the card thumbnail area renders an actual image preview. All other node types display a type-appropriate icon in the thumbnail area.
- R12. **Grid mode:** Cards are arranged in a fixed-column grid with square thumbnail areas.
- R13. **List mode:** Cards render as compact rows (small icon, name, type badge, modified date) sorted by name.
- R14. **Date mode:** Cards are grouped by modified date (Today, Yesterday, This Week, Earlier), with the same card layout as Grid mode within each group.
- R15. Users can select multiple artifacts in the Content Grid. The selection count is shown in the header (e.g., `4 SELECTED`). Single-select updates the Inspector for that artifact without changing the `displayed folder`; multi-select updates the Inspector to show aggregate metadata for the selected artifacts.
- R16. If no folder is selected in the Hierarchy, the Content Grid shows the top-level VFS roots.
- R17. Activating a folder card from the Content Grid changes the `displayed folder` by selecting that folder in the Hierarchy, then repopulates the grid with that folder's immediate children. Plain selection of a folder card still behaves like artifact selection for Inspector purposes.

**Inspector Panel**
- R18. When a single node is selected, the Inspector shows: node name, kind label (e.g., `DIRECTORY · PROJECT ALPHA`), created date, modified date, and size.
  - For files: size is the file's size in bytes, displayed in human-readable form (KB, MB, GB).
  - For folders and mounts: size is the aggregate of all descendant file sizes.
- R19. When a folder is selected in the Hierarchy and no artifact is selected in the grid, the Inspector shows the displayed folder's metadata (same fields as R18).
- R20. For URL nodes, the Inspector also shows the indexing state (Pending, Indexing, Indexed, Error).
- R21. Rename and Delete actions remain accessible from the Inspector for the current single-node selection, including the displayed folder when no grid artifact is selected. During multi-select, Rename is disabled and Delete is not offered; bulk mutations are out of scope for this milestone.
- R22. When multiple artifacts are selected (R15), the Inspector shows: selection count, combined size, and common type if all selected items share a type.

**VFS Metadata Extension**
- R23. Each VFS node exposes `created_at` and `modified_at` timestamps.
  - Mounted file/directory nodes: timestamps come from the underlying filesystem.
  - Folder nodes (virtual): `created_at` is when the folder was created in the VFS; `modified_at` updates when children are added or removed.
  - URL nodes: `created_at` is the bookmark creation time; `modified_at` is the last successful index time (or creation time if never indexed).
  - Mount nodes: `created_at` is the mount creation time; `modified_at` updates on last filesystem sync.
- R24. Each VFS node exposes `size_bytes`.
  - File nodes: actual file size from the filesystem.
  - Folder and Mount nodes: aggregate of all descendant file sizes; `0` if no file descendants.
  - URL nodes: total bytes of locally cached artifacts generated for that URL (for Milestone 2, cached raw HTML), or `0` before indexing produces a persisted cache artifact.

## Success Criteria

- Opening the app shows the four-item sidebar and lands on the Explorer with the Hierarchy tree populated.
- Clicking a folder in the Hierarchy populates the Content Grid with its children within 200ms.
- Switching between Grid, List, and Date view modes is immediate (no network/IPC call).
- An image file in the grid shows an actual thumbnail; a markdown file shows a document icon.
- The Inspector shows accurate created and modified dates and a human-readable size for any selected node.
- Home, Chat, and Memory Timeline are reachable from the sidebar and render placeholder content without errors.
- The Hierarchy panel can be collapsed and re-expanded without loss of selection state.
- Existing Milestone 1 real-time Explorer updates, breadcrumbs, and rename/delete flows continue to work after the new shell lands.

## Scope Boundaries

- No AI features: no extracted entities, no related topics, no "Ask AI" CTA.
- No file content rendering within the grid (nodes are cards, not opened/previewed inline).
- No drag-and-drop between folders.
- No search or filter within the Content Grid.
- No deep-link routing (URL-bar navigation, browser history) — navigation state is in-memory only.
- Home, Chat, and Memory Timeline are stubs; no functional implementation of those sections.
- Node creation (folder, mount, URL) interaction point is not defined here — carry forward M1 behavior or defer to a separate UX brainstorm.

## Key Decisions

- **Three-pane Explorer layout:** Hierarchy / Content Grid / Inspector mirrors the pattern used by Finder, Notion, and Linear — familiar enough to be intuitive, distinct enough to own the CogniOS identity.
- **Folder-drives-grid:** Selecting a folder in the Hierarchy is the single trigger that populates the grid. No independent grid navigation cursor. Keeps the mental model simple — the tree is always the source of truth for "where you are."
- **Image thumbnails only:** Rendering arbitrary file content previews in M2 is high complexity for uncertain value. Images are the one type where a thumbnail is unambiguously better than an icon. Other rich previews (PDF first page, code syntax highlight) are deferred.
- **Dates and size are the metadata scope for M2:** AI-derived fields (entities, related topics) are deferred. Dates and size are computable from existing data without AI infrastructure.
- **Nav stubs establish routes early:** Wiring up stub pages now prevents later refactors to the shell when Chat or Memory Timeline are implemented.

## Dependencies / Assumptions

- The Rust backend must be extended to return `created_at`, `modified_at`, and `size_bytes` on each `ExplorerNode`. This is a backend contract change that affects the IPC layer and the `ExplorerNode` type in `src/lib/contracts/vfs.ts`.
- Image thumbnail generation for mounted image files requires a mechanism to read file content or generate a preview URL — unverified whether Tauri's asset serving or a custom IPC command is the right approach.

## Outstanding Questions

### Resolve Before Planning

*(None — all product decisions resolved.)*

### Deferred to Planning

- **[Affects R11] [Needs research]** How to serve image thumbnails in Tauri: custom IPC command that reads the file and returns base64, Tauri's `asset://` protocol, or a streaming approach. Must work on all target platforms.
- **[Affects R22, R23] [Technical]** Backend schema changes needed to store `created_at`, `modified_at`, and `size_bytes` on VFS nodes. Folder/Mount aggregate sizes need a rollup strategy (eager on insert/delete vs. computed on read).
- **[Affects R5] [Technical]** Collapse/expand state for the Hierarchy panel — default to `useExplorerStore` (tightly coupled to Explorer section state; a separate layout store is only warranted when a second consumer appears).
- **[Affects R1] [Technical]** Routing approach for the four navigation sections (simple state machine in App.tsx vs. React Router). Given stub-only scope for non-Explorer sections, a lightweight state machine may suffice over a full router.
- **[Affects R15] [Technical]** Multi-select UX: click-to-select-one, modifier+click for multi-select, or checkbox overlay on cards. Interaction design for the confirmation prompt.

## Next Steps

-> `/ce:plan` for structured implementation planning.
