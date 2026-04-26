import {
  createFolder,
  createMount,
  createNote,
  createUrl,
  deleteNode,
  getExplorerSnapshot,
  getMountSetupContext,
  getNodeThumbnail,
  getNoteContent,
  readFileContent,
  renameNode,
  retryUrl,
  saveNoteContent,
  showNodeInFileManager,
} from "../../../lib/tauri/ipc";
import type { ExplorerClient } from "../types/explorer";

export const explorerClient: ExplorerClient = {
  getExplorerSnapshot,
  getMountSetupContext,
  createFolder,
  createMount,
  createNote,
  createUrl,
  renameNode,
  deleteNode,
  retryUrl,
  getNodeThumbnail,
  getNoteContent,
  saveNoteContent,
  readFileContent,
  showNodeInFileManager,
};
