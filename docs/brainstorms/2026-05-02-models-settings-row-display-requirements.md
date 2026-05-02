---
title: Settings → Models — stable row order + visible model identity
type: requirements
status: completed
date: 2026-05-02
scope: lightweight
---

# Settings → Models — stable row order + visible model identity

## Problem

Two issues with the Settings → Models card today:

1. **Row order shifts between page opens.** Each time the Settings modal renders, the four model rows (Embedding / Reranker / OCR / Captioner) appear in a different order. Users see this as a bug and lose trust in the rest of the panel.
2. **No way to tell which actual model backs each role.** A row reads "Embedding · commit a1b2c3d4 · Ready" with no indication that Embedding is `onnx-community/gte-multilingual-base`. When a user wants to cross-reference HuggingFace docs, file a bug, or check upstream changelogs for a model bump, they have no anchor.

## Root cause (issue 1)

`src-tauri/src/services/search/client.rs:223` declares `pub roles: HashMap<String, ModelRoleStatusDto>`. Rust's `HashMap` deserializes with non-deterministic iteration order. Each round-trip through the Tauri layer re-serializes with a fresh order; the frontend at `src/features/settings/components/ModelManagerStatus.tsx:77` calls `Object.values(envelope.data.roles)` and renders in JSON-key order — which is now random per fetch.

## Goals

- Row order is stable and predictable across page opens, refreshes, and live progress updates.
- Each row shows enough identity for a user to find the underlying HuggingFace model without reading source code.
- Implementation reuses existing infrastructure: no new IPC routes, no new contract types — existing `RoleStatus` / `ModelRoleStatusDto` / `ModelRoleStatus` gain an additive `repo` field; the Tauri shell-open IPC is already wired.

## Non-goals

- Changing `manifest.py` content or pinning logic (separate concern; see "Adjacent" below).
- Adding model search / model swap UI.
- Surfacing per-file SHA-256 details in the row.
- Showing download progress in a different way.

## Decisions

### D1 — Row order rule: business-dependency order

Rows display in this fixed order regardless of map iteration:

```
Embedding → Reranker → OCR → Captioner
```

This matches the order in `sidecar/search_sidecar/models/manifest.py:DEFAULTS` and the order in the existing `ROLE_LABELS` constant in `ModelManagerStatus.tsx`. Embedding is the foundation of search, reranker refines it, OCR/captioner are auxiliary. Roles not in the canonical list (future additions) sort after the known four, alphabetically.

### D2 — Each row shows the HuggingFace repo identity

Add a muted secondary line under the role label:

```
Embedding                                              [Ready]
onnx-community/gte-multilingual-base · commit a1b2c3d4 ↗
```

- `repo` (e.g. `onnx-community/gte-multilingual-base`) is read from the sidecar manifest and surfaced through `RoleStatus`.
- `commit a1b2c3d4` (already present today) keeps the same 8-char-truncated form with full-hash tooltip.
- `↗` icon at the end of the line is a link to the HF tree for that commit. Opens in the user's system browser via Tauri's shell-open IPC (not the embedded webview).
- The `↗` element is a real button/link (not a div with onclick): keyboard-focusable, visible focus ring matching the existing settings focus style, and `aria-label="Open <repo> on HuggingFace"` for screen readers.

### D3 — Link target + fallback

- When `commit` is a real SHA: `https://huggingface.co/{repo}/tree/{commit}` — anchors users to the exact pinned version they have.
- When `commit` is missing or equals the placeholder `<pinned>` (manifest hasn't been resolved yet): hide the commit fragment AND link to `https://huggingface.co/{repo}` (repo root) instead.
- The placeholder-commit case must not produce a broken link or a `commit <pinned>` string in the UI.

## User-visible behavior

| Scenario | What the user sees |
|---|---|
| All four models at default state | Four rows in fixed order. Each row shows `Role / repo · commit XXXXXXXX ↗ / state`. Clicking ↗ opens HF tree in system browser. |
| Models page opened twice in a row | Identical row order both times. |
| Live download in progress | Row stays in its fixed position; progress bar appears under the row as today. |
| Manifest commit unresolved (current state — `<pinned>`) | Row shows `Role / repo ↗ / state`. No "commit <pinned>" text. Link goes to repo root. |
| Future role added to manifest (e.g. "audio-transcript") | Embedding/Reranker/OCR/Captioner first in canonical order; new role appended after, alphabetically with other unknowns. |

## Success criteria

1. Opening Settings → Models 5 times in a row shows the same 4 rows in the same order: Embedding, Reranker, OCR, Captioner.
2. Each row visibly displays its repo (e.g. `onnx-community/gte-multilingual-base`) without hover.
3. Clicking the `↗` icon for the Embedding row opens `https://huggingface.co/onnx-community/gte-multilingual-base/tree/<commit>` in the user's default browser.
4. With the current placeholder-commit manifest, the rows render cleanly (no broken `<pinned>` strings, no broken links).
5. No regression in download progress display, license acceptance flow, or error messages.

## Deferred to planning

Open implementation-time questions surfaced during inline self-review. None block the brainstorm; planning should resolve each.

- **Where the placeholder-commit detection lives.** Frontend, Rust DTO, or sidecar — pick one layer to recognize unresolved commits (e.g. anything matching `<…>` literal). Recommendation: frontend, since D2 is a presentation concern and keeping the placeholder out of the wire would force a release-blocking sidecar change.
- **Repo overflow behavior.** Long repo strings (`unsloth/gemma-3n-E2B-it-GGUF` is 28 chars) plus `· commit XXXXXXXX ↗` may wrap on a narrow Settings card. Pick: truncate with tooltip, allow wrap, or constrain card min-width.
- **Hover / focus / active states for `↗`.** Match the existing settings link/button affordances. Define cursor, underline-on-hover, focus ring color.
- **Shell-open failure mode.** What renders if `shell.open(...)` rejects? Probably a small inline error or silent log; spec at planning time.
- **Live-download interaction.** Does the secondary line (repo · commit · ↗) stay visible above the progress bar, or hide while progress is rendering? Stay visible is probably right but worth confirming.
- **Tauri capability allowlist.** Confirm `shell.open` is permitted for `https://huggingface.co/*`. The plugin is already loaded; check `src-tauri/capabilities/default.json`.
- **Non-HF model future.** If a future role ships with a non-HF `repo` (custom URL, local-only model), `↗` link target should be derived from a small "where to link" rule rather than hardcoded to `huggingface.co`. Out of scope today but worth a comment in the link-target helper.

## Adjacent / out of scope

- **Model manifest pinning.** Earlier in the same session, the user hit `HTTP 404 ... Invalid rev id: <pinned>` because `manifest.py` ships with placeholder commit/SHA values. This UI change makes the placeholder state cleaner (D3) but does not resolve the underlying manifest. Pinning real HuggingFace SHAs is a separate workstream — manifest pinning likely belongs in a release-build CI step or a `scripts/pin-manifest.py` helper.
- **Per-file integrity panel.** Showing each `FileSpec` and its verification state inside an expandable row is a possible follow-up but adds meaningful scope; defer until users actually ask for that level of detail.

## References

- `src/features/settings/components/ModelManagerStatus.tsx` — the component being changed
- `src/lib/contracts/search.ts:107` — `ModelRoleStatus` interface (gains `repo`)
- `src-tauri/src/services/search/client.rs:228` — `ModelRoleStatusDto` (gains `repo`)
- `sidecar/search_sidecar/models/manager.py:73` — `RoleStatus` dataclass (gains `repo`)
- `sidecar/search_sidecar/models/manifest.py:58` — `DEFAULTS` (source of truth for repo per role)
- `src/lib/tauri/ipc.ts` — existing shell-open IPC pattern to reuse
