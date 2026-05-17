import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { ExistingMount, ExplorerClient, ExplorerNode, MountSetupContext } from "../types/explorer";
import { isPdfNode } from "../utils/presentation";
import type { CreateAction } from "./CreateMenu";
import type { SelectModifiers } from "./ExplorerRow";
import { useExplorerEvents } from "../hooks/useExplorerEvents";
import { useExplorerStoreContext } from "../store/ExplorerStoreContext";
import { isDisplayFolder } from "../store/useExplorerStore";
import { Breadcrumbs } from "./Breadcrumbs";
import { CreateMenu } from "./CreateMenu";
import { ExplorerInspector } from "./ExplorerInspector";
import { ExplorerTree } from "./ExplorerTree";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { MountModal } from "./MountModal";
import { NoteEditor, type NoteEditorHandle } from "./NoteEditor";
import { UrlModal } from "./UrlModal";
import { searchClient } from "../../search/api/searchClient";
import { voiceNoteClient } from "../../voice-notes/api/voiceNoteClient";
import {
  VoiceNoteRecordingPreview,
  VoiceNoteSourceAudioBar,
  type VoiceNotePlaybackState,
  type VoiceNotePreviewSession,
  type VoiceNoteRecordingPhase,
} from "../../voice-notes/components/VoiceNoteRecordingPreview";
import type { VoiceNote } from "../../../lib/contracts/voiceNote";
import { error as logError } from "../../../lib/logger";

const DEFAULT_TREE_WIDTH = 240;
const MIN_TREE_WIDTH = 208;
const MAX_TREE_WIDTH = 520;

export function ExplorerLayout({
  active,
  client,
  focusNodeRequest,
  onFocusNodeRequestHandled,
  voiceNoteSession,
}: {
  active: boolean;
  client: ExplorerClient;
  focusNodeRequest?: { nodeId: string; serial: number } | null;
  onFocusNodeRequestHandled?(): void;
  voiceNoteSession?: VoiceNotePreviewSession | null;
}) {
  // The store is hoisted to a context provider at the App root so
  // SearchPalette + this layout share one instance. ``client`` stays
  // on the props for the existing test harness (App.test.tsx mounts
  // ExplorerLayout directly with an injected client) — when used
  // there the test wraps it in <ExplorerStoreProvider client={client}>.
  void client;
  const store = useExplorerStoreContext();
  const [openModal, setOpenModal] = useState<CreateAction | null>(null);
  // parentId snapshot at modal-open time so the user can change selection
  // mid-modal without shifting the new node's parent.
  const [modalParentId, setModalParentId] = useState<string | null>(null);
  const [noteFlushError, setNoteFlushError] = useState<string | null>(null);
  const [mountSetupContext, setMountSetupContext] = useState<MountSetupContext | null>(null);
  const [mountSetupError, setMountSetupError] = useState<string | null>(null);
  const [mountSubmitting, setMountSubmitting] = useState(false);
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const [openedVoiceNote, setOpenedVoiceNote] = useState<VoiceNote | null>(null);
  const [openedVoiceNoteId, setOpenedVoiceNoteId] = useState<string | null>(null);
  const [liveVoiceNoteTranscript, setLiveVoiceNoteTranscript] = useState("");
  const [voiceNoteTranscript, setVoiceNoteTranscript] = useState("");
  const [voiceNotePlayback, setVoiceNotePlayback] = useState<VoiceNotePlaybackState>({
    currentMs: 0,
    durationMs: 0,
    isPlaying: false,
  });
  const noteEditorRef = useRef<NoteEditorHandle>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Anchor for shift-click range selection. Tracks the most recent
  // single-clicked node id; reset by plain or toggle clicks.
  const selectionAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await store.refresh();
      } catch (cause) {
        store.setError(cause instanceof Error ? cause.message : "Unexpected backend error");
      } finally {
        store.setIsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (openModal !== "mount") return;
    let cancelled = false;
    setMountSetupError(null);
    setMountSetupContext(null);

    void client
      .getMountSetupContext()
      .then((context) => {
        if (!cancelled) setMountSetupContext(context);
      })
      .catch((cause) => {
        if (!cancelled) {
          setMountSetupError(
            cause instanceof Error ? cause.message : "Failed to load suggested folders."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, openModal]);

  useExplorerEvents(store.refresh);

  useEffect(() => {
    const activeNoteId = store.activeNoteId;
    if (!activeNoteId) {
      setOpenedVoiceNote(null);
      setOpenedVoiceNoteId(null);
      return;
    }
    if (voiceNoteSession?.note.noteId === activeNoteId) {
      setOpenedVoiceNote(null);
      setOpenedVoiceNoteId(null);
      return;
    }

    let cancelled = false;
    setOpenedVoiceNote(null);
    setOpenedVoiceNoteId(activeNoteId);
    void voiceNoteClient
      .get(activeNoteId)
      .then((voiceNote) => {
        if (cancelled) return;
        setOpenedVoiceNote(voiceNote);
        setOpenedVoiceNoteId(activeNoteId);
      })
      .catch((cause) => {
        if (cancelled) return;
        setOpenedVoiceNote(null);
        setOpenedVoiceNoteId(activeNoteId);
        void logError(
          `[ExplorerLayout] failed to load voice note metadata: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        );
      });

    return () => {
      cancelled = true;
    };
  }, [store.activeNoteId, voiceNoteSession?.note.noteId]);

  useEffect(() => {
    if (!active || !focusNodeRequest) return;
    if (!findNodeById(store.snapshot.roots, focusNodeRequest.nodeId)) return;
    selectionAnchorRef.current = focusNodeRequest.nodeId;
    store.selectArtifact(focusNodeRequest.nodeId, false);
    store.activateArtifact(focusNodeRequest.nodeId);
    onFocusNodeRequestHandled?.();
  }, [
    active,
    focusNodeRequest?.nodeId,
    focusNodeRequest?.serial,
    onFocusNodeRequestHandled,
    store,
    store.snapshot,
  ]);

  // Window close: only the note editor has pending writes to flush. Previews
  // are read-only and cannot block close.
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let unmounted = false;

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const editor = noteEditorRef.current;
        if (editor) {
          event.preventDefault();
          try {
            await editor.flush();
            getCurrentWindow().close();
          } catch (cause) {
            setNoteFlushError(
              cause instanceof Error ? cause.message : "Failed to save note"
            );
          }
        }
      })
      .then((fn) => {
        if (unmounted) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch(() => {
        // onCloseRequested registration failed; nothing we can do client-side.
      });

    return () => {
      unmounted = true;
      unlistenFn?.();
    };
  }, []);

  // Selected single container, used as parentId for create operations.
  const selectedContainer = useMemo(() => {
    if (store.selectedArtifacts.length !== 1) return null;
    const node = store.selectedArtifacts[0];
    return isDisplayFolder(node) ? node : null;
  }, [store.selectedArtifacts]);
  const selectedContainerId = selectedContainer?.id;

  // The "active file" surface — the most-recent file activation drives the
  // center pane and breadcrumbs. Mutual-exclusion enforcement: note editor
  // takes render priority if multiple fields are inadvertently set.
  //
  // Cannot-preview files (binary, unsupported documents, ...) don't populate any active*
  // slot, but the user still selected a single file — surface that in
  // the breadcrumbs so the header doesn't disappear when you click a
  // non-previewable item.
  const cannotPreviewNode: ExplorerNode | null =
    store.selectionCount === 1 &&
    store.selectedArtifacts[0].kind === "file" &&
    !store.activeNote &&
    !store.activePreview &&
    !store.activeImagePreview
      ? store.selectedArtifacts[0]
      : null;
  const activeFileNode: ExplorerNode | null =
    store.activeNote ??
    store.activePreview ??
    store.activeImagePreview ??
    cannotPreviewNode ??
    null;

  // Compute breadcrumb path to the active file's parent from the snapshot.
  // The preview title already renders the active file name.
  const breadcrumbNodes = useMemo(() => {
    if (!activeFileNode) return [];
    const path: ExplorerNode[] = [];
    const index = new Map<string, ExplorerNode>();
    const visit = (node: ExplorerNode) => {
      index.set(node.id, node);
      node.children.forEach(visit);
    };
    store.snapshot.roots.forEach(visit);
    let cursor: ExplorerNode | null = activeFileNode;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parentId ? index.get(cursor.parentId) ?? null : null;
    }
    return path.slice(0, -1);
  }, [activeFileNode, store.snapshot]);

  // Visible flat tree order (respects expansion). Used for shift-click range.
  const visibleOrder = useMemo(() => {
    const ordered: string[] = [];
    const expandedSet = new Set(store.expandedIds);
    function visit(node: ExplorerNode) {
      ordered.push(node.id);
      if (expandedSet.has(node.id)) {
        for (const child of node.children) visit(child);
      }
    }
    store.snapshot.roots.forEach(visit);
    return ordered;
  }, [store.snapshot, store.expandedIds]);

  // Layout-level wrapper that flushes any open note before delegating to the
  // store. Required because store.activateArtifact is synchronous and has no
  // ref to call flush().
  async function handleActivate(nodeId: string, modifiers: SelectModifiers) {
    setNoteFlushError(null);

    // Update selection based on modifier first (so the inspector reflects
    // the click target even if flush fails).
    if (modifiers.shift) {
      const anchor = selectionAnchorRef.current;
      const anchorIdx = anchor ? visibleOrder.indexOf(anchor) : -1;
      const targetIdx = visibleOrder.indexOf(nodeId);
      if (anchorIdx === -1 || targetIdx === -1) {
        // Anchor invisible (collapsed) or missing — fall back to plain click.
        selectionAnchorRef.current = nodeId;
        store.selectArtifact(nodeId, false);
      } else {
        const [start, end] =
          anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
        const range = visibleOrder.slice(start, end + 1);
        store.replaceSelection(range);
      }
    } else if (modifiers.toggle) {
      selectionAnchorRef.current = nodeId;
      store.selectArtifact(nodeId, true);
    } else {
      selectionAnchorRef.current = nodeId;
      store.selectArtifact(nodeId, false);
    }

    // Then the activation side effect (note flush, surface change, URL open).
    if (store.activeNoteId && noteEditorRef.current) {
      try {
        await noteEditorRef.current.flush();
        store.setActiveNoteId(null);
      } catch (cause) {
        setNoteFlushError(
          cause instanceof Error ? cause.message : "Failed to save note"
        );
        return;
      }
    }

    // URL nodes don't auto-open on click — they're opened via the right-click
    // "Open link" context menu item (handleOpenUrl). All other kinds delegate
    // to the store for surface activation.
    store.activateArtifact(nodeId);
  }

  async function handleOpenUrl(nodeId: string) {
    const indexed = (function findInTree(roots: ExplorerNode[]): ExplorerNode | null {
      for (const root of roots) {
        if (root.id === nodeId) return root;
        const found = findInTree(root.children);
        if (found) return found;
      }
      return null;
    })(store.snapshot.roots);
    if (indexed?.kind !== "url") return;
    try {
      await openExternal(indexed.name);
    } catch (cause) {
      void logError(
        `[ExplorerLayout] failed to open URL: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  }

  function handleCreateSelect(action: CreateAction) {
    const parentId = selectedContainerId ?? null;
    if (action === "folder") {
      void handleFolderCreate(parentId);
    } else if (action === "note") {
      void handleNoteCreate(parentId);
    } else {
      // Modal-based create: snapshot parentId at open time so changing the
      // tree selection mid-modal doesn't shift the new node's parent.
      setModalParentId(parentId);
      setOpenModal(action);
    }
  }

  async function handleFolderCreate(parentId: string | null) {
    const snapshot = await store.runAction("folder", () =>
      client.createFolder({ name: "Untitled", parentId: parentId ?? undefined })
    );
    if (snapshot) {
      const prevIds = collectIds(store.snapshot.roots);
      store.applySnapshot(snapshot);
      // Auto-expand the parent so the new child is visible — without
      // this the user clicks "New folder" on a collapsed mount and
      // sees nothing happen.
      if (parentId) store.expandNode(parentId);
      for (const root of snapshot.roots) {
        const newId = findNewId(root, prevIds);
        if (newId) {
          store.setPendingInlineRenameId(newId);
          break;
        }
      }
    }
  }

  async function handleNoteCreate(parentId: string | null) {
    const snapshot = await store.runAction("note", () =>
      client.createNote({ parentId: parentId ?? undefined })
    );
    if (snapshot) {
      const prevIds = collectIds(store.snapshot.roots);
      store.applySnapshot(snapshot);
      if (parentId) store.expandNode(parentId);
      for (const root of snapshot.roots) {
        const newId = findNewId(root, prevIds);
        if (newId) {
          store.setPendingInlineRenameId(newId);
          break;
        }
      }
    }
  }

  async function handleDeleteById(nodeId: string, cascade: boolean) {
    const deletedIds = new Set(
      collectNodeIds(findNodeById(store.snapshot.roots, nodeId)).concat(nodeId)
    );
    clearDeletedPreviewState(deletedIds);
    const snapshot = await store.runAction("delete", () =>
      client.deleteNode({ nodeId, cascade })
    );
    if (snapshot) store.applySnapshot(snapshot);
  }

  async function handleDeleteMany(nodeIds: string[]) {
    const nodesToDelete = topLevelSelectedNodes(store.snapshot.roots, nodeIds);
    if (nodesToDelete.length === 0) return;

    const deletedIds = new Set(nodesToDelete.flatMap((node) => collectNodeIds(node)));
    clearDeletedPreviewState(deletedIds);

    const snapshot = await store.runAction("delete", async () => {
      let latest = store.snapshot;
      for (const node of nodesToDelete) {
        latest = await client.deleteNode({
          nodeId: node.id,
          cascade: node.children.length > 0,
        });
      }
      return latest;
    });
    if (snapshot) store.applySnapshot(snapshot);
  }

  function clearDeletedPreviewState(deletedIds: Set<string>) {
    if (store.activeNoteId && deletedIds.has(store.activeNoteId)) {
      store.setActiveNoteId(null);
      setNoteFlushError(null);
    }
    if (store.activePreviewId && deletedIds.has(store.activePreviewId)) {
      store.setActivePreviewId(null);
    }
    if (store.activeImagePreviewId && deletedIds.has(store.activeImagePreviewId)) {
      store.setActiveImagePreviewId(null);
    }
  }

  async function handleInlineRename(nodeId: string, newName: string) {
    store.setPendingInlineRenameId(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    const snapshot = await store.runAction("rename", () =>
      client.renameNode({ nodeId, newName: trimmed })
    );
    if (snapshot) store.applySnapshot(snapshot);
  }

  async function handleRetry(nodeId: string) {
    await store.runAction("retry", async () => {
      await client.retryUrl({ nodeId });
      await store.refresh();
    });
  }

  async function handleRevealInFileManager(nodeId: string) {
    try {
      await client.showNodeInFileManager(nodeId);
      store.setError(null);
    } catch (cause) {
      store.setError(cause instanceof Error ? cause.message : "Failed to open file manager");
    }
  }

  async function handleMountSubmit(args: { path: string; name: string; ignoreConfig: string }) {
    setMountSubmitting(true);
    store.setError(null);
    try {
      const snapshot = await client.createMount({
        path: args.path,
        parentId: modalParentId ?? undefined,
        ignoreConfig: args.ignoreConfig || undefined
      });
      store.applySnapshot(snapshot);
      if (modalParentId) store.expandNode(modalParentId);
      setOpenModal(null);
      setModalParentId(null);
      setMountSetupContext(null);
      return;
    } catch (cause) {
      throw cause;
    } finally {
      setMountSubmitting(false);
    }
  }

  async function handleUrlSubmit(url: string) {
    const snapshot = await store.runAction("url", () =>
      client.createUrl({ url, parentId: modalParentId ?? undefined })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
      if (modalParentId) store.expandNode(modalParentId);
      setOpenModal(null);
      setModalParentId(null);
    }
  }

  function handleModalClose() {
    setOpenModal(null);
    setModalParentId(null);
    setMountSetupContext(null);
    setMountSetupError(null);
  }

  async function handleRevealExistingMount(nodeId: string) {
    setNoteFlushError(null);
    if (store.activeNoteId && noteEditorRef.current) {
      try {
        await noteEditorRef.current.flush();
        store.setActiveNoteId(null);
      } catch (cause) {
        setNoteFlushError(cause instanceof Error ? cause.message : "Failed to save note");
        return;
      }
    }

    selectionAnchorRef.current = nodeId;
    store.selectArtifact(nodeId, false);
    if (!store.expandedIds.includes(nodeId)) {
      store.toggleNode(nodeId);
    }
    handleModalClose();
  }

  // Center surface decision. Note takes render priority if both fields are set.
  const showNote = !!store.activeNoteId && !!store.activeNote;
  const openedVoiceNoteSession = useMemo<VoiceNotePreviewSession | null>(() => {
    if (!openedVoiceNote || openedVoiceNote.noteId !== openedVoiceNoteId) {
      return null;
    }
    return {
      note: openedVoiceNote,
      elapsedMs: 0,
      phase: phaseForOpenedVoiceNote(openedVoiceNote),
      error:
        openedVoiceNote.status === "failed" ||
        openedVoiceNote.transcriptionStatus === "failed"
          ? "Voice note transcription failed."
          : null,
      onTogglePause: noop,
      onStop: noop,
    };
  }, [openedVoiceNote, openedVoiceNoteId]);
  const displayedVoiceNoteSession =
    voiceNoteSession?.note.noteId === store.activeNoteId
      ? voiceNoteSession
      : openedVoiceNoteSession;
  const liveVoiceNoteSession = displayedVoiceNoteSession
    ? {
        ...displayedVoiceNoteSession,
        transcript: liveVoiceNoteTranscript,
      }
    : null;
  const activeVoiceNoteSession =
    voiceNoteSession?.note.noteId === store.activeNoteId ? voiceNoteSession : null;
  const showRecordingSurface =
    !!activeVoiceNoteSession && isRecordingSurfacePhase(activeVoiceNoteSession.phase);
  const savedVoiceNote =
    showNote && !showRecordingSurface
      ? activeVoiceNoteSession?.note ?? openedVoiceNote
      : null;
  const showVoiceNoteRecording =
    showNote &&
    showRecordingSurface &&
    !!liveVoiceNoteSession &&
    liveVoiceNoteSession.note.noteId === store.activeNoteId;
  const voiceNoteEditorKey = savedVoiceNote
    ? `${store.activeNoteId}:${savedVoiceNote.updatedAt}:${savedVoiceNote.transcriptionStatus}`
    : store.activeNoteId ?? "note";
  const transcriptCues = useMemo(
    () => parseTimestampedTranscript(voiceNoteTranscript),
    [voiceNoteTranscript]
  );
  const showMarkdown = !showNote && !!store.activePreviewId && !!store.activePreview;
  const showImage =
    !showNote &&
    !showMarkdown &&
    !!store.activeImagePreviewId &&
    !!store.activeImagePreview;
  // Cannot-preview placeholder: a single non-previewable file node is selected.
  const showCannotPreview =
    !showNote &&
    !showMarkdown &&
    !showImage &&
    store.selectionCount === 1 &&
    store.selectedArtifacts[0].kind === "file";
  const showWelcome = !showNote && !showMarkdown && !showImage && !showCannotPreview;
  const clampedTreeWidth = clampTreeWidth(treeWidth, workspaceRef.current);

  useEffect(() => {
    if (!showVoiceNoteRecording || !store.activeNoteId) {
      setLiveVoiceNoteTranscript("");
      return;
    }

    let cancelled = false;
    async function refreshTranscript() {
      if (!store.activeNoteId) return;
      try {
        const transcript = await voiceNoteClient.getTranscript(store.activeNoteId);
        if (!cancelled) {
          setLiveVoiceNoteTranscript(transcript.trim());
        }
      } catch {
        if (!cancelled) setLiveVoiceNoteTranscript("");
      }
    }

    void refreshTranscript();
    const timer = window.setInterval(() => {
      void refreshTranscript();
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, showVoiceNoteRecording, store.activeNoteId]);

  useEffect(() => {
    setVoiceNotePlayback({
      currentMs: 0,
      durationMs: 0,
      isPlaying: false,
    });
    if (!savedVoiceNote || !store.activeNoteId) {
      setVoiceNoteTranscript("");
      return;
    }

    let cancelled = false;
    void voiceNoteClient
      .getTranscript(store.activeNoteId)
      .then((transcript) => {
        if (!cancelled) setVoiceNoteTranscript(transcript);
      })
      .catch(() => {
        if (!cancelled) setVoiceNoteTranscript("");
      });

    return () => {
      cancelled = true;
    };
  }, [savedVoiceNote?.noteId, savedVoiceNote?.transcriptUpdatedAt, store.activeNoteId]);

  const handleVoiceNotePlaybackChange = useCallback((state: VoiceNotePlaybackState) => {
    setVoiceNotePlayback(state);
  }, []);

  function handleResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = clampedTreeWidth;

    function handleMouseMove(moveEvent: MouseEvent) {
      const delta = moveEvent.clientX - startX;
      setTreeWidth(clampTreeWidth(startWidth + delta, workspaceRef.current));
    }

    function handleMouseUp() {
      cleanupResizeListeners();
    }

    function cleanupResizeListeners() {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("is-resizing-pane");
      resizeCleanupRef.current = null;
    }

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanupResizeListeners;
    document.body.classList.add("is-resizing-pane");
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp, { once: true });
  }

  return (
    <section
      aria-hidden={!active}
      className={`explorer-layout${active ? " is-active" : " is-hidden"}`}
    >
      {store.error ? <p className="error-banner">{store.error}</p> : null}

      <div
        className="explorer-workspace"
        data-testid="explorer-workspace"
        ref={workspaceRef}
        style={{
          gridTemplateColumns: `${clampedTreeWidth}px 10px minmax(0, 1fr) 280px`,
        }}
      >
        <aside className="tree-sidebar">
          <ExplorerTree
            expandedIds={store.expandedIds}
            nodes={store.snapshot.roots}
            onDelete={handleDeleteById}
            onDeleteMany={handleDeleteMany}
            onInlineRename={handleInlineRename}
            onOpenUrl={(nodeId) => {
              void handleOpenUrl(nodeId);
            }}
            onRevealInFileManager={(nodeId) => {
              void handleRevealInFileManager(nodeId);
            }}
            onRetry={handleRetry}
            onSelect={(id, modifiers) => void handleActivate(id, modifiers)}
            onStartRename={store.setPendingInlineRenameId}
            onToggle={store.toggleNode}
            pendingInlineRenameId={store.pendingInlineRenameId}
            selectedIds={store.selectedArtifactIds}
            toolbar={<CreateMenu onSelect={handleCreateSelect} />}
          />
        </aside>

        <div
          aria-label="Resize file tree"
          aria-orientation="vertical"
          aria-valuemax={MAX_TREE_WIDTH}
          aria-valuemin={MIN_TREE_WIDTH}
          aria-valuenow={Math.round(clampedTreeWidth)}
          className="tree-resize-handle"
          onMouseDown={handleResizeStart}
          role="separator"
        />

        <main className="detail-surface">
          <div className="detail-surface-scroll">
            {store.isLoading ? (
              <p className="empty-state">Loading explorer...</p>
            ) : (
              <>
                {activeFileNode ? <Breadcrumbs nodes={breadcrumbNodes} /> : null}
                {showVoiceNoteRecording ? (
                  <VoiceNoteRecordingPreview session={liveVoiceNoteSession!} />
                ) : showNote ? (
                  savedVoiceNote ? (
                    <NoteEditor
                      key={voiceNoteEditorKey}
                      ref={noteEditorRef}
                      client={client}
                      flushError={noteFlushError}
                      initialTitle={store.activeNote!.name}
                      nodeId={store.activeNoteId!}
                      onTitleChange={() => {
                        void store.refresh().catch(() => {});
                      }}
                      afterHeader={
                        <div className="voice-note-note-surface">
                          <VoiceNoteSourceAudioBar
                            note={savedVoiceNote}
                            onPlaybackChange={handleVoiceNotePlaybackChange}
                          />
                          <VoiceNoteTranscriptPlayback
                            cues={transcriptCues}
                            playback={voiceNotePlayback}
                            transcript={voiceNoteTranscript}
                          />
                        </div>
                      }
                    />
                  ) : (
                    <NoteEditor
                      ref={noteEditorRef}
                      client={client}
                      flushError={noteFlushError}
                      initialTitle={store.activeNote!.name}
                      nodeId={store.activeNoteId!}
                      onTitleChange={() => {
                        void store.refresh().catch(() => {});
                      }}
                    />
                  )
                ) : null}
                {showMarkdown ? (
                  <MarkdownPreview
                    client={client}
                    name={store.activePreview!.name}
                    nodeId={store.activePreviewId!}
                  />
                ) : null}
                {showImage ? (
                  <ImagePreview
                    contentKind={
                      isPdfNode(store.activeImagePreview!) ? "pdf" : "image"
                    }
                    searchClient={searchClient}
                    name={store.activeImagePreview!.name}
                    nodeId={store.activeImagePreviewId!}
                  />
                ) : null}
                {showCannotPreview ? (
                  <div className="markdown-preview">
                    <header className="markdown-preview-header">
                      <h2 className="markdown-preview-title">
                        {store.selectedArtifacts[0].name}
                      </h2>
                    </header>
                    <div className="detail-placeholder">
                      <p>This file type cannot be previewed</p>
                    </div>
                  </div>
                ) : null}
                {showWelcome ? (
                  <div className="detail-placeholder">
                    <p>Select an item to preview</p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </main>

        <aside className="inspector-panel">
          <div className="inspector-panel-scroll">
            <ExplorerInspector
              client={client}
              node={store.inspectorNode}
              selectedArtifacts={store.selectedArtifacts}
              selectionCount={store.selectionCount}
            />
          </div>
        </aside>
      </div>

      {openModal === "mount" ? (
        <MountModal
          isSubmitting={mountSubmitting}
          onClose={handleModalClose}
          onRevealMount={(nodeId) => {
            void handleRevealExistingMount(nodeId);
          }}
          onSubmit={handleMountSubmit}
          setupContext={mountSetupContext}
          setupError={mountSetupError}
        />
      ) : null}

      {openModal === "url" ? (
        <UrlModal
          activeAction={store.activeAction}
          onClose={handleModalClose}
          onSubmit={handleUrlSubmit}
        />
      ) : null}
    </section>
  );
}

function collectIds(nodes: ExplorerNode[]): Set<string> {
  const ids = new Set<string>();
  function visit(node: ExplorerNode) {
    ids.add(node.id);
    node.children.forEach(visit);
  }
  nodes.forEach(visit);
  return ids;
}

function collectNodeIds(node: ExplorerNode | null): string[] {
  if (!node) return [];
  return [node.id, ...node.children.flatMap((child) => collectNodeIds(child))];
}

function topLevelSelectedNodes(nodes: ExplorerNode[], selectedIds: string[]): ExplorerNode[] {
  const selected = new Set(selectedIds);
  const result: ExplorerNode[] = [];

  function visit(node: ExplorerNode, hasSelectedAncestor: boolean) {
    const isSelected = selected.has(node.id);
    if (isSelected && !hasSelectedAncestor) {
      result.push(node);
    }
    for (const child of node.children) {
      visit(child, hasSelectedAncestor || isSelected);
    }
  }

  nodes.forEach((node) => visit(node, false));
  return result;
}

function findNewId(node: ExplorerNode, prevIds: Set<string>): string | null {
  if (!prevIds.has(node.id)) return node.id;
  for (const child of node.children) {
    const found = findNewId(child, prevIds);
    if (found) return found;
  }
  return null;
}

function findNodeById(nodes: ExplorerNode[], nodeId: string): ExplorerNode | null {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const found = findNodeById(node.children, nodeId);
    if (found) return found;
  }
  return null;
}

function clampTreeWidth(nextWidth: number, workspace: HTMLDivElement | null) {
  const workspaceWidth = workspace?.getBoundingClientRect().width ?? 0;
  const maxWidthFromViewport =
    workspaceWidth > 0 ? Math.max(MIN_TREE_WIDTH, workspaceWidth - 280 - 320 - 10) : MAX_TREE_WIDTH;
  const maxWidth = Math.min(MAX_TREE_WIDTH, maxWidthFromViewport);

  return Math.max(MIN_TREE_WIDTH, Math.min(nextWidth, maxWidth));
}

interface TranscriptCue {
  id: string;
  startMs: number;
  text: string;
}

function VoiceNoteTranscriptPlayback({
  cues,
  playback,
  transcript,
}: {
  cues: TranscriptCue[];
  playback: VoiceNotePlaybackState;
  transcript: string;
}) {
  const lineRefs = useRef(new Map<string, HTMLDivElement>());
  const activeIndex = activeTranscriptCueIndex(cues, playback.currentMs);
  const activeCue = activeIndex >= 0 ? cues[activeIndex] : null;
  const plainTranscriptLines = useMemo(
    () =>
      transcript
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [transcript]
  );

  useEffect(() => {
    if (!playback.isPlaying || !activeCue) return;
    lineRefs.current.get(activeCue.id)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [activeCue?.id, playback.isPlaying]);

  if (cues.length === 0 && plainTranscriptLines.length === 0) {
    return null;
  }

  return (
    <section className="voice-note-transcript-sync" aria-label="Transcript playback">
      <div className="voice-note-transcript-sync-list">
        {cues.length > 0
          ? cues.map((cue, index) => (
              <div
                aria-current={index === activeIndex ? "true" : undefined}
                className={`voice-note-transcript-sync-line${index === activeIndex ? " is-active" : ""}`}
                key={cue.id}
                ref={(element) => {
                  if (element) {
                    lineRefs.current.set(cue.id, element);
                  } else {
                    lineRefs.current.delete(cue.id);
                  }
                }}
              >
                <time>{formatTranscriptCueTime(cue.startMs)}</time>
                <p>{cue.text}</p>
              </div>
            ))
          : plainTranscriptLines.map((line, index) => (
              <div className="voice-note-transcript-sync-line is-plain" key={`${index}:${line}`}>
                <p>{line}</p>
              </div>
            ))}
      </div>
    </section>
  );
}

function phaseForOpenedVoiceNote(note: VoiceNote): VoiceNoteRecordingPhase {
  if (note.status === "failed" || note.transcriptionStatus === "failed") {
    return "failed";
  }
  if (
    note.status === "transcribing" ||
    note.status === "speaker_processing" ||
    note.status === "indexing" ||
    note.transcriptionStatus === "transcribing" ||
    note.summaryStatus === "pending"
  ) {
    return "transcribing";
  }
  return "complete";
}

function isRecordingSurfacePhase(phase: VoiceNoteRecordingPhase): boolean {
  return (
    phase === "preparing" ||
    phase === "recording" ||
    phase === "paused" ||
    phase === "stopping"
  );
}

function parseTimestampedTranscript(transcript: string): TranscriptCue[] {
  return transcript
    .split(/\r?\n/)
    .map((line, index) => parseTranscriptCue(line, index))
    .filter((cue): cue is TranscriptCue => cue !== null);
}

function parseTranscriptCue(line: string, index: number): TranscriptCue | null {
  const trimmed = line.trim();
  const match = /^\[(\d{1,3}:\d{2}(?:\.\d{1,3})?)\]\s*(.+)$/.exec(trimmed);
  if (!match) return null;
  const startMs = parseTranscriptTimestampMs(match[1]);
  if (startMs === null) return null;
  return {
    id: `${index}:${startMs}`,
    startMs,
    text: match[2],
  };
}

function parseTranscriptTimestampMs(timestamp: string): number | null {
  const [minutesText, secondsText] = timestamp.split(":");
  const minutes = Number(minutesText);
  if (!Number.isFinite(minutes)) return null;
  const [secondsWhole, millisText = "0"] = secondsText.split(".");
  const seconds = Number(secondsWhole);
  if (!Number.isFinite(seconds) || seconds >= 60) return null;
  const millis = Number(millisText.padEnd(3, "0").slice(0, 3));
  if (!Number.isFinite(millis)) return null;
  return minutes * 60_000 + seconds * 1_000 + millis;
}

function activeTranscriptCueIndex(cues: TranscriptCue[], currentMs: number): number {
  if (cues.length === 0) return -1;
  let activeIndex = -1;
  for (let index = 0; index < cues.length; index += 1) {
    if (cues[index].startMs <= currentMs + 250) {
      activeIndex = index;
    } else {
      break;
    }
  }
  return activeIndex;
}

function formatTranscriptCueTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function noop() {}
