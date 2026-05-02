import {
  acceptModelLicense,
  getIndexingStatus,
  getModelsStatus,
  getNodeIndexingStatus,
  searchQuery,
  startModelDownload,
} from "../../../lib/tauri/ipc";
import type { SearchClient } from "../types/search";

export const searchClient: SearchClient = {
  search: searchQuery,
  indexStatus: getIndexingStatus,
  nodeIndexStatus: getNodeIndexingStatus,
  modelsStatus: getModelsStatus,
  acceptModelLicense,
  startModelDownload,
};
