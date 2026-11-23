import {
  normalizeTrayResourceUrl,
  normalizeTraySourceUrl,
  sanitizeTrayHtml,
} from "./mediaTrayModel.mjs";

const MAX_LABEL_CHARS = 600;
const MAX_MEDIA_TEXT_CHARS = 250_000;

function boundedText(value, limit = MAX_LABEL_CHARS) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function readerMediaFromMessage(event, expectedFrameWindow, { origin } = {}) {
  if (!expectedFrameWindow || event?.source !== expectedFrameWindow) return null;
  const data = event?.data;
  const input = data?.type === "medos_media_open" ? data.descriptor : null;
  if (!input || (input.kind !== "image" && input.kind !== "table")) return null;

  const sourceUrl = normalizeTraySourceUrl(input.sourceUrl, { origin });
  if (input.sourceUrl && !sourceUrl) return null;
  const title = boundedText(input.title) || (input.kind === "table" ? "Table" : "Image");
  const source = boundedText(input.source) || "MedOS";
  const fileName = boundedText(input.fileName, 260) || undefined;

  if (input.kind === "image") {
    const resourceUrl = normalizeTrayResourceUrl(input.resourceUrl, { origin });
    if (!resourceUrl) return null;
    return Object.freeze({
      kind: "image",
      title,
      source,
      sourceUrl,
      resourceUrl,
      ...(fileName ? { fileName } : {}),
    });
  }

  const html = sanitizeTrayHtml(input.html, { origin });
  if (!/<table(?:\s|>)/i.test(html)) return null;
  return Object.freeze({
    kind: "table",
    title,
    source,
    sourceUrl,
    html,
    plainText: boundedText(input.plainText, MAX_MEDIA_TEXT_CHARS),
    ...(fileName ? { fileName } : {}),
  });
}
