import {
  acceptModelLicense,
  getIndexingStatus,
  getModelsStatus,
  getNodeContent,
  getNodeIndexingStatus,
  searchQuery,
  startModelDownload,
} from "../../../lib/tauri/ipc";
import type { SearchClient } from "../types/search";

export const searchClient: SearchClient = {
  search: searchQuery,
  indexStatus: getIndexingStatus,
  nodeIndexStatus: getNodeIndexingStatus,
  nodeContent: getNodeContent,
  modelsStatus: getModelsStatus,
  acceptModelLicense,
  startModelDownload,
};
