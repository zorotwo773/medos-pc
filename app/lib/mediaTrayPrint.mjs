import { escapeText, normalizeTrayResourceUrl, normalizeTraySourceUrl, sanitizeTrayHtml } from "./mediaTrayModel.mjs";

function renderItem(item, origin) {
  const sourceUrl = normalizeTraySourceUrl(item.sourceUrl, { origin });
  const metadata = `<p class="source">${escapeText(item.source)}${sourceUrl ? ` · <a href="${escapeText(sourceUrl)}">${escapeText(sourceUrl)}</a>` : ""}</p>`;
  if (item.kind === "image") {
    const imageUrl = normalizeTrayResourceUrl(item.resourceUrl, { origin });
    return `<article><h2>${escapeText(item.title)}</h2>${metadata}${imageUrl ? `<figure><object class="media-image" data="${escapeText(imageUrl)}" aria-label="${escapeText(item.title)}"><p class="missing">Media unavailable: ${escapeText(item.title)}</p></object><figcaption>${escapeText(item.source)}</figcaption></figure>` : `<p class="missing">Media unavailable: ${escapeText(item.title)}</p>`}</article>`;
  }
  const html = sanitizeTrayHtml(item.html, { origin });
  const body = /^<table[\s>]/i.test(html)
    ? html
    : item.kind === "document" && sourceUrl
      ? `<p><a href="${escapeText(sourceUrl)}">Open source document</a></p>`
      : `<p>${escapeText(item.plainText || "Media unavailable")}</p>`;
  return `<article><h2>${escapeText(item.title)}</h2>${metadata}${body}</article>`;
}

export function buildMediaTrayPrintDocument(items, { printedAt = new Date(), origin } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>MedOS media collection</title><style>@page{margin:16mm}body{font:12pt system-ui;color:#18212f}article{break-inside:avoid;margin:0 0 14mm}h1,h2{color:#123b5d}.source,figcaption{color:#52616b;font-size:10pt}.media-image{display:block;width:100%;max-width:100%;height:220mm;max-height:220mm}.missing{border:1px solid #8a6d3b;padding:10px}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #9ba7b0;padding:5px;text-align:left}</style></head><body><h1>MedOS media collection</h1><p>Printed ${escapeText(printedAt.toLocaleString())}</p>${(items || []).map((item) => renderItem(item, origin)).join("")}</body></html>`;
}
