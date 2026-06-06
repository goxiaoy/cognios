export const VFS_EVENT_NAME = "vfs://changed";
export const NODE_STATUS_EVENT_NAME = "node-status://changed";

export interface VfsChangeEvent {
  mountId: string;
  reason: string;
}
