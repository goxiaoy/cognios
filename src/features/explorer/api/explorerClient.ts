import {
  createFolder,
  createMount,
  createNote,
  createUrl,
  deleteNode,
  getExplorerSnapshot,
  getNodeThumbnail,
  getNoteContent,
  readFileContent,
  renameNode,
  retryUrl,
  saveNoteContent,
} from "../../../lib/tauri/ipc";
import type { ExplorerClient } from "../types/explorer";

export const explorerClient: ExplorerClient = {
  getExplorerSnapshot,
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
};
