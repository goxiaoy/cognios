import {
  deleteProviderSecret,
  getIndexingStatus,
  getModelsStatus,
  getNodeContent,
  getNodeIndexingStatus,
  getProviderSecretPresent,
  getSearchSettings,
  readSearchSettingsFallback,
  restartSidecar,
  searchQuery,
  setProviderSecret,
  startModelDownload,
  testChatProvider,
  updateSearchSettings,
} from "../../../lib/tauri/ipc";
import type { SearchClient } from "../types/search";

export const searchClient: SearchClient = {
  search: searchQuery,
  indexStatus: getIndexingStatus,
  nodeIndexStatus: getNodeIndexingStatus,
  nodeContent: getNodeContent,
  modelsStatus: getModelsStatus,
  startModelDownload,
  settings: getSearchSettings,
  updateSettings: updateSearchSettings,
  restartSidecar,
  readSettingsFallback: readSearchSettingsFallback,
  setProviderSecret,
  hasProviderSecret: getProviderSecretPresent,
  deleteProviderSecret,
  testChatProvider,
};
