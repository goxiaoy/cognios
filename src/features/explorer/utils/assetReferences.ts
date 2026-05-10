import { convertFileSrc } from "@tauri-apps/api/core";

export function rewriteAssetReferences(
  text: string,
  assets: Record<string, string>
): string {
  let rendered = text;
  for (const [source, filePath] of Object.entries(assets)) {
    if (!source || !filePath) continue;
    rendered = rendered.split(source).join(toAssetUrl(filePath));
  }
  return rendered;
}

function toAssetUrl(filePath: string): string {
  try {
    return convertFileSrc(filePath);
  } catch {
    return filePath;
  }
}
