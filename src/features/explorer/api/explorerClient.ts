import {
  createFolder,
  createMount,
  createUrl,
  deleteNode,
  getExplorerSnapshot,
  renameNode,
  retryUrl
} from "../../../lib/tauri/ipc";
import type { ExplorerClient } from "../types/explorer";

export const explorerClient: ExplorerClient = {
  getExplorerSnapshot,
  createFolder,
  createMount,
  createUrl,
  renameNode,
  deleteNode,
  retryUrl
};
