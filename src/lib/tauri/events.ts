export const VFS_EVENT_NAME = "vfs://changed";

export interface VfsChangeEvent {
  mountId: string;
  reason: string;
}
