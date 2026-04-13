import { FormEvent } from "react";
import { MountIgnoreDialog } from "./MountIgnoreDialog";

export function CreateNodeDialog({
  activeAction,
  folderName,
  mountIgnoreConfig,
  mountPath,
  onFolderChange,
  onFolderSubmit,
  onMountChange,
  onMountIgnoreChange,
  onMountSubmit,
  onUrlChange,
  onUrlSubmit,
  urlValue
}: {
  activeAction: "folder" | "mount" | "url" | "rename" | "delete" | "retry" | null;
  folderName: string;
  mountIgnoreConfig: string;
  mountPath: string;
  onFolderChange(value: string): void;
  onFolderSubmit(event: FormEvent<HTMLFormElement>): void;
  onMountChange(value: string): void;
  onMountIgnoreChange(value: string): void;
  onMountSubmit(event: FormEvent<HTMLFormElement>): void;
  onUrlChange(value: string): void;
  onUrlSubmit(event: FormEvent<HTMLFormElement>): void;
  urlValue: string;
}) {
  return (
    <section className="inspector-block">
      <header className="inspector-block-header">
        <p className="eyebrow">Create</p>
        <h3>New VFS nodes</h3>
      </header>
      <div className="action-stack">
        <form className="inline-form" onSubmit={onFolderSubmit}>
          <label className="sr-only" htmlFor="folder-name">
            Folder name
          </label>
          <input
            id="folder-name"
            name="folderName"
            onChange={(event) => onFolderChange(event.target.value)}
            placeholder="New folder"
            value={folderName}
          />
          <button disabled={activeAction !== null || !folderName.trim()} type="submit">
            {activeAction === "folder" ? "Adding..." : "Add Folder"}
          </button>
        </form>

        <form className="mount-form" onSubmit={onMountSubmit}>
          <label className="field-stack" htmlFor="mount-path">
            <span className="field-label">Mount path</span>
            <input
              id="mount-path"
              name="mountPath"
              onChange={(event) => onMountChange(event.target.value)}
              placeholder="~/projects/example"
              value={mountPath}
            />
          </label>
          <MountIgnoreDialog
            ignoreConfig={mountIgnoreConfig}
            onChange={onMountIgnoreChange}
          />
          <button disabled={activeAction !== null || !mountPath.trim()} type="submit">
            {activeAction === "mount" ? "Mounting..." : "Add Mount"}
          </button>
        </form>

        <form className="inline-form" onSubmit={onUrlSubmit}>
          <label className="sr-only" htmlFor="url-value">
            URL
          </label>
          <input
            id="url-value"
            name="urlValue"
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder="https://example.com"
            value={urlValue}
          />
          <button disabled={activeAction !== null || !urlValue.trim()} type="submit">
            {activeAction === "url" ? "Adding..." : "Add URL"}
          </button>
        </form>
      </div>
    </section>
  );
}
