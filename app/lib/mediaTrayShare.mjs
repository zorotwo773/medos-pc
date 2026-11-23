import { normalizeTrayResourceUrl } from "./mediaTrayModel.mjs";

export function buildTrayShareManifest(items) {
  const lines = ["MedOS media collection"];
  (items || []).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`Source: ${item.source}`);
    if (item.sourceUrl) lines.push(`Link: ${item.sourceUrl}`);
    if (item.resourceUrl) lines.push(`Media: ${item.resourceUrl}`);
    if (item.plainText) lines.push(`Snapshot: ${item.plainText}`);
    lines.push("");
  });
  return { title: "MedOS media collection", text: lines.join("\n").trim() };
}

function defaultFileName(item, index) {
  return item.fileName || `medos-media-${index + 1}.png`;
}

export async function shareTrayItems(items, { origin, navigatorApi = navigator, fetchImpl = fetch, FileCtor = File, copyFallback } = {}) {
  const manifest = buildTrayShareManifest(items);
  try {
    const files = [];
    for (const [index, item] of (items || []).entries()) {
      if (item.kind !== "image") continue;
      const resourceUrl = normalizeTrayResourceUrl(item.resourceUrl, { origin });
      if (!resourceUrl) continue;
      const response = await fetchImpl(resourceUrl);
      if (!response?.ok) continue;
      const blob = await response.blob();
      files.push(new FileCtor([blob], defaultFileName(item, index), { type: blob.type || "image/png" }));
    }
    if (files.length && navigatorApi?.canShare?.({ files })) {
      await navigatorApi.share({ title: manifest.title, text: manifest.text, files });
      return { outcome: "shared", manifest };
    }
  } catch {
    // Rejections, cancellation, and failed fetches intentionally fall through.
  }
  await copyFallback?.(manifest.text);
  return { outcome: "fallback", manifest };
}
