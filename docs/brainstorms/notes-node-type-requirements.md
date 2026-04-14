---
date: 2026-04-14
topic: notes-node-type
---

# Notes Node Type

## Problem Frame

Cognios currently organizes external content (filesystem mounts, URLs, folders). Users have no way to create first-party written content inside the app. A "note" node type closes this gap — letting users write and organize markdown notes within the same file tree they already use for other resources, without leaving the app.

## Requirements

**Node Type**

- R1. A new node kind `note` is added to the system, alongside the existing `folder`, `url`, `mount`, `directory`, and `file` kinds.
- R2. Note content is persisted as a markdown file at `<storage_dir>/notes/{id}.md`, where `<storage_dir>` is the path resolved by `storage_dir_from_home` in `src-tauri/src/lib.rs` (currently `~/.cogios`) and `{id}` matches the node's UUID in the node table.
- R3. The node table record for a note stores the title as the node `name` (same field used by folders/URLs).
- R4. Notes can be children of any node that supports children (folders and other notes). Notes support nested notes to arbitrary depth.

**Creation Flow**

- R5. "New Note" is available as a creation action in the explorer (alongside existing "New Folder", "Mount", "URL" options).
- R6. Creating a note immediately creates the node with name "Untitled" and activates inline rename so the user can set the title before doing anything else — matching the existing folder creation pattern. If the user presses Escape or dismisses without typing, the node is committed as "Untitled" and remains in the tree.
- R7. The corresponding `.md` file is created on disk at the time of node creation (empty body, title derived from node name).

**Editor**

- R8. Double-clicking a note node opens a full-page editor view, replacing the current explorer content area. Single-clicking selects the note and shows metadata in the inspector (R14); the body is not displayed. The editor includes a back button in the header. Clicking any other node in the left tree also exits the editor. Both paths trigger the R12 flush before transitioning.
- R9. The editor presents: a large title field at the top, a "Stored locally on your device" indicator below it, and a markdown body editor filling the remaining space.
- R10. The title field is editable inline. The title is committed on blur (when the user leaves the title field), at which point the node is renamed in the tree. Title and tree node name are always the same value.
- R11. The markdown body auto-saves to disk after a short debounce (no save button required). The user should never lose content due to forgetting to save.
- R12. Navigating away from the note (selecting another node, clicking the back button) triggers a synchronous flush of any pending auto-save — navigation waits until the disk write confirms before the new view renders. If the write fails, the editor shows an error and navigation is blocked until the user acknowledges.
- R16. App quit and window close also trigger a synchronous flush of any pending auto-save before the process exits, handled via the Tauri window close event.

**Tree Integration**

- R13. Notes appear in the explorer tree and content grid with a distinct icon that differentiates them from folders and files.
- R14. The inspector panel (right sidebar) shows metadata for a selected note: name, created date, modified date, and size (byte size of the `.md` file on disk, consistent with how size is reported for file nodes).
- R15. Renaming, deleting, and moving a note in the tree behaves consistently with other node types. Deleting a note also deletes its `.md` file from disk.

## Success Criteria

- A user can create a note, write content, and relaunch the app to find the note's title, body, tree position, and modification date intact.
- Notes nest naturally inside folders and other notes with no special handling required.
- The title seen in the tree always matches the title shown in the editor.
- No content is lost from an auto-save race: navigating away always flushes the buffer.

## Scope Boundaries

- No markdown preview/render mode in this iteration — editor only. (Deferred to keep scope focused; the editor library chosen in planning must support preview as a follow-on iteration.)
- No rich text (WYSIWYG) editor — plain markdown input.
- No search-inside-notes or full-text indexing of note content.
- No sync, cloud backup, or sharing of notes.
- No note templates or front-matter support.
- No tagging or metadata beyond what existing nodes already have.

## Key Decisions

- **Auto-save, no save button:** Eliminates lost-work risk with no extra user friction. Consistent with modern note apps.
- **Title = node name, stored in DB only:** Single source of truth; no divergence between tree and editor. The title is stored only in `nodes.name` — the `.md` file contains only the markdown body. Rename is a single DB write with no file rewrite needed. The trade-off is that `.md` files are titleless when read outside the app.
- **Markdown files on disk (not DB blobs):** User-owned and portable. Note: the filesystem layout is flat (all notes share one `notes/` directory keyed by UUID); tree hierarchy is in the DB only. Files are readable outside the app but do not reflect the tree structure.
- **Full-page editor (not panel or modal):** Maximizes writing space. Consistent with the screenshot the user provided.

## Dependencies / Assumptions

- The storage base directory is `~/.cogios/` as resolved by `storage_dir_from_home` in `src-tauri/src/lib.rs` (single 'n' — verified against codebase). R2 uses this path.
- A markdown editor library must be added as a dependency. Library selection is deferred to planning (see below).

## Outstanding Questions

### Deferred to Planning

- [Affects R8][Technical] How should the editor view integrate with the current `ExplorerLayout`? Options: a route/navigation push, a conditional render replacing the grid, or a new top-level view. Evaluate against existing navigation patterns in the explorer.
- [Affects R11][Technical] What debounce interval is appropriate for auto-save? Also confirm whether window blur/focus-loss should trigger an immediate flush (R12/R16 handle navigation and quit; blur handles tab switch).
- [Affects R8][Needs research] Which markdown editor library best fits the current stack (React 19, Tauri, no existing editor deps)? Candidates: CodeMirror 6, Monaco, `react-md-editor`, plain `<textarea>` with tab-handling. Evaluate bundle size, offline suitability (Tauri — no CDN), and ability to support markdown preview as a future iteration.
- [Affects R1][Technical] Confirm that adding the `note` kind requires no DB migration (the `nodes` table uses free-text `kind`). If a CHECK constraint or index is appropriate, cut a `0005_notes.sql` migration.
- [Affects R1][Technical] The following code extension points must all be updated atomically: Rust `NodeKind` enum + `from_db` dispatcher (`src-tauri/src/domain/vfs/node.rs`), TypeScript `NodeKind` type (`src/lib/contracts/vfs.ts`), `activateArtifact` in `useExplorerStore` (currently no-ops for non-folder nodes), `delete_node` service match arm, and `CreateMenu` `CreateAction` union.
- [Affects R3, R10][Technical] Verify whether the `nodes` table enforces name uniqueness within a parent scope. If so, title rename (R10) needs a conflict-resolution strategy (e.g., append a number suffix).
- [Affects R2][Technical] The `notes/` subdirectory inside `<storage_dir>` must be created on first use or at app startup — confirm where this creation is handled.

## Next Steps

-> `/ce:plan` for structured implementation planning
