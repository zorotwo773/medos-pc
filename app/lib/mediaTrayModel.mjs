export const MAX_TRAY_ITEMS = 12;
export const MAX_TRAY_BYTES = 2_000_000;
export const MAX_TRAY_TEXT_CHARS = 250_000;

const EMPTY_STATE = Object.freeze({ items: Object.freeze([]), selectedTrayItemId: null });

function text(value) {
  return typeof value === "string" ? value : "";
}

function clampText(value) {
  return text(value).slice(0, MAX_TRAY_TEXT_CHARS);
}

function escapeText(value) {
  return text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function browserOrigin() {
  return typeof location !== "undefined" ? location.origin : "";
}

function policyBase(origin) {
  try {
    const base = new URL(origin || browserOrigin());
    return /^https?:$/.test(base.protocol) && base.hostname ? base : null;
  } catch {
    return null;
  }
}

function allowedPort(url, base) {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const basePort = base.port || (base.protocol === "https:" ? "443" : "80");
  return port === basePort || port === "3000" || port === "8002";
}

export function normalizeTraySourceUrl(value, { origin } = {}) {
  const raw = text(value).trim();
  const base = policyBase(origin);
  if (!raw || !base) return "";
  try {
    const url = new URL(raw, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hostname !== base.hostname || !allowedPort(url, base)) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function normalizeTrayResourceUrl(value, { origin } = {}) {
  const raw = text(value).trim();
  const base = policyBase(origin);
  if (!raw || !base) return "";
  if (/^data:image\/(?:png|jpeg|gif|webp|avif)(?:;[^,]*)?,/i.test(raw)) return raw;
  try {
    const url = new URL(raw, base);
    if (url.protocol === "blob:") return url.origin === base.origin ? url.href : "";
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hostname !== base.hostname || !allowedPort(url, base)) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function normalizeTrayDescriptor(descriptor, { origin } = {}) {
  const displayedImageUrl = descriptor?.resourceUrl || descriptor?.imageUrl || descriptor?.displayedImageUrl || descriptor?.element?.currentSrc || descriptor?.element?.src || "";
  return {
    ...descriptor,
    sourceUrl: normalizeTraySourceUrl(descriptor?.sourceUrl, { origin }),
    resourceUrl: normalizeTrayResourceUrl(displayedImageUrl, { origin }),
  };
}

const SEMANTIC_TAGS = new Set(["a", "b", "blockquote", "br", "caption", "code", "em", "figcaption", "figure", "i", "img", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);
const VOID_TAGS = new Set(["br", "img"]);

function safeSemanticAttributes(tag, rawAttributes, origin) {
  const attributes = [];
  const attributePattern = /\s([a-zA-Z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of rawAttributes.matchAll(attributePattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (tag === "a" && name === "href") {
      const href = normalizeTraySourceUrl(value, { origin });
      if (href) attributes.push(` href="${escapeText(href)}"`);
    } else if (tag === "img" && name === "src") {
      const src = normalizeTrayResourceUrl(value, { origin });
      if (src) attributes.push(` src="${escapeText(src)}"`);
    } else if (tag === "img" && (name === "alt" || name === "title")) {
      attributes.push(` ${name}="${escapeText(value)}"`);
    } else if ((tag === "td" || tag === "th") && (name === "colspan" || name === "rowspan")) {
      const span = Math.max(1, Math.min(100, Number.parseInt(value, 10) || 1));
      attributes.push(` ${name}="${span}"`);
    } else if (tag === "th" && name === "scope" && /^(?:col|colgroup|row|rowgroup)$/i.test(value)) {
      attributes.push(` scope="${value.toLowerCase()}"`);
    }
  }
  return attributes.join("");
}

export function sanitizeTrayHtml(value, { origin } = {}) {
  return text(value)
    .replace(/<(script|style|iframe|object|embed|form|button|select|textarea|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<input\b[^>]*\/?\s*>/gi, "")
    .replace(/<(\/?)\s*([a-zA-Z][\w:-]*)([^>]*)>/g, (match, closing, rawTag, rawAttributes) => {
      const tag = rawTag.toLowerCase();
      if (!SEMANTIC_TAGS.has(tag)) return "";
      if (closing) return VOID_TAGS.has(tag) ? "" : `</${tag}>`;
      return `<${tag}${safeSemanticAttributes(tag, rawAttributes, origin)}>`;
    })
    .trim()
    .slice(0, MAX_TRAY_TEXT_CHARS);
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function trayContentKey(descriptor) {
  const kind = descriptor?.kind === "table" || descriptor?.kind === "excerpt" || descriptor?.kind === "document" ? descriptor.kind : "image";
  const identity = kind === "image" ? text(descriptor?.resourceUrl) : `${sanitizeTrayHtml(descriptor?.html)}\n${clampText(descriptor?.plainText)}`;
  return `${kind}:${text(descriptor?.sourceUrl)}:${stableHash(identity)}`;
}

export function snapshotTrayDescriptor(descriptor, options = {}) {
  const { now = Date.now() } = options;
  const normalized = normalizeTrayDescriptor(descriptor, options);
  const kind = normalized?.kind === "table" || normalized?.kind === "excerpt" || normalized?.kind === "document" ? normalized.kind : "image";
  const html = kind === "image" ? "" : sanitizeTrayHtml(normalized?.html, options);
  const plainText = kind === "image" ? "" : clampText(normalized?.plainText || html.replace(/<[^>]+>/g, " "));
  const sourceUrl = text(normalized?.sourceUrl);
  const key = trayContentKey({ ...normalized, kind, html, plainText });
  const estimatedBytes = new TextEncoder().encode([text(normalized?.title), text(normalized?.source), sourceUrl, text(normalized?.resourceUrl), text(normalized?.fileName), html, plainText].join("\n")).byteLength;
  return Object.freeze({
    trayItemId: `tray-${key.replace(/[^a-z0-9-]/gi, "-")}`,
    contentKey: key,
    kind,
    title: text(normalized?.title) || "Untitled media",
    source: text(normalized?.source) || "MedOS",
    sourceUrl,
    resourceUrl: text(normalized?.resourceUrl) || undefined,
    fileName: text(normalized?.fileName) || undefined,
    html: html || undefined,
    plainText: plainText || undefined,
    estimatedBytes,
    addedAt: now,
  });
}

export function createTrayState() {
  return EMPTY_STATE;
}

export function addTrayItem(state, descriptor, options) {
  const current = state || EMPTY_STATE;
  const item = snapshotTrayDescriptor(descriptor, options);
  const duplicate = current.items.find((candidate) => candidate.contentKey === item.contentKey);
  if (duplicate) return { outcome: "duplicate", state: { ...current, selectedTrayItemId: duplicate.trayItemId }, item: duplicate };
  const totalBytes = current.items.reduce((total, candidate) => total + candidate.estimatedBytes, 0) + item.estimatedBytes;
  if (current.items.length >= MAX_TRAY_ITEMS || totalBytes > MAX_TRAY_BYTES) return { outcome: "limit", state: current, item: null };
  return { outcome: "added", state: { items: Object.freeze([...current.items, item]), selectedTrayItemId: item.trayItemId }, item };
}

export function selectTrayItem(state, trayItemId) {
  const current = state || EMPTY_STATE;
  return current.items.some((item) => item.trayItemId === trayItemId) ? { ...current, selectedTrayItemId: trayItemId } : current;
}

export function reorderTrayItem(state, trayItemId, direction) {
  const current = state || EMPTY_STATE;
  const from = current.items.findIndex((item) => item.trayItemId === trayItemId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= current.items.length) return current;
  const items = [...current.items];
  [items[from], items[to]] = [items[to], items[from]];
  return { ...current, items: Object.freeze(items) };
}

export function removeTrayItem(state, trayItemId) {
  const current = state || EMPTY_STATE;
  const items = current.items.filter((item) => item.trayItemId !== trayItemId);
  if (items.length === current.items.length) return current;
  return { items: Object.freeze(items), selectedTrayItemId: current.selectedTrayItemId === trayItemId ? (items[0]?.trayItemId ?? null) : current.selectedTrayItemId };
}

export function clearTray() {
  return EMPTY_STATE;
}

export function releaseOwnedObjectUrls(items, revoke = (url) => URL.revokeObjectURL(url)) {
  for (const item of items || []) if (item?.ownedObjectUrl && item.resourceUrl?.startsWith("blob:")) revoke(item.resourceUrl);
}

export { escapeText };
