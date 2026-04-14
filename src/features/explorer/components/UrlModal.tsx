import { FormEvent, useEffect, useState } from "react";

interface UrlPreview {
  title: string;
  description: string;
  favicon: string | null;
}

async function fetchUrlPreview(url: string): Promise<UrlPreview> {
  const res = await fetch(url);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const title =
    doc.querySelector("meta[property='og:title']")?.getAttribute("content") ??
    doc.querySelector("title")?.textContent ??
    url;

  const description =
    doc.querySelector("meta[property='og:description']")?.getAttribute("content") ??
    doc.querySelector("meta[name='description']")?.getAttribute("content") ??
    "";

  const faviconHref = doc.querySelector("link[rel~='icon']")?.getAttribute("href") ?? null;
  const favicon = faviconHref ? new URL(faviconHref, url).href : null;

  return { title: title.trim(), description: description.trim(), favicon };
}

export function UrlModal({
  activeAction,
  onClose,
  onSubmit
}: {
  activeAction: string | null;
  onClose(): void;
  onSubmit(url: string): void;
}) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<UrlPreview | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleUrlChange(value: string) {
    setUrl(value);
    setPreview(null);
    setFetchError(null);
  }

  async function handlePreview() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setFetching(true);
    setFetchError(null);
    setPreview(null);
    try {
      const p = await fetchUrlPreview(trimmed);
      setPreview(p);
    } catch {
      setFetchError("Preview unavailable — the URL will be indexed after creation.");
    } finally {
      setFetching(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Add URL"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">URL</p>
            <h2 className="modal-title">Save a web resource</h2>
          </div>
          <button
            aria-label="Close"
            className="modal-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>

        <form className="modal-body" onSubmit={handleSubmit}>
          <div className="field-stack">
            <label className="field-label" htmlFor="url-modal-input">URL</label>
            <div className="url-input-row">
              <input
                autoFocus
                id="url-modal-input"
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder="https://example.com"
                type="url"
                value={url}
              />
              <button
                className="ghost-button"
                disabled={!url.trim() || fetching || activeAction !== null}
                onClick={handlePreview}
                type="button"
              >
                {fetching ? "Fetching…" : "Preview"}
              </button>
            </div>
          </div>

          {fetchError ? (
            <p className="url-fetch-error">{fetchError}</p>
          ) : null}

          {preview ? (
            <div className="url-preview">
              {preview.favicon ? (
                <img alt="" className="url-preview-favicon" src={preview.favicon} />
              ) : (
                <span className="url-preview-favicon-placeholder" aria-hidden="true">↗</span>
              )}
              <div className="url-preview-body">
                <p className="url-preview-title">{preview.title}</p>
                {preview.description ? (
                  <p className="url-preview-description">{preview.description}</p>
                ) : null}
                <p className="url-preview-href">{url}</p>
              </div>
            </div>
          ) : null}

          <footer className="modal-footer">
            <button className="ghost-button" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              disabled={activeAction !== null || !url.trim()}
              type="submit"
            >
              {activeAction === "url" ? "Creating…" : "Fetch & Create"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
