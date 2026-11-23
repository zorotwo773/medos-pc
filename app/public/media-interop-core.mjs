const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizeFileStem(value) {
  let stem = String(value || "media").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "").slice(0, 120) || "media";
  if (RESERVED.test(stem)) stem = `medos-${stem}`;
  return stem;
}

export function mediaFileName({ source, title, extension }) {
  const left = sanitizeFileStem(source || "medos").toLowerCase();
  const right = sanitizeFileStem(title || "media").toLowerCase();
  const ext = String(extension || "bin").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  return `${left}-${right}.${ext}`;
}

export function expandTableGrid(rows) {
  const grid = [];
  rows.forEach((cells, rowIndex) => {
    if (!grid[rowIndex]) grid[rowIndex] = [];
    let column = 0;
    cells.forEach(cell => {
      while (grid[rowIndex][column] !== undefined) column += 1;
      const rowSpan = Math.max(1, Number(cell.rowSpan) || 1);
      const colSpan = Math.max(1, Number(cell.colSpan) || 1);
      for (let r = 0; r < rowSpan; r += 1) {
        if (!grid[rowIndex + r]) grid[rowIndex + r] = [];
        for (let c = 0; c < colSpan; c += 1) grid[rowIndex + r][column + c] = String(cell.text || "").trim();
      }
      column += colSpan;
    });
  });
  const width = Math.max(0, ...grid.map(row => row.length));
  return grid.map(row => Array.from({ length: width }, (_, index) => row[index] || ""));
}

export const rowsToTsv = rows => rows.map(row => row.join("\t")).join("\n");
const csvCell = value => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
export const rowsToCsv = rows => rows.map(row => row.map(value => csvCell(String(value))).join(",")).join("\r\n");
export const portableUrl = (raw, baseHref) => new URL(raw, baseHref).href;

const MEDOS_PORTS = new Set(["3000", "8002"]);
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif)(?:;[^,]*)?,/i;

function effectivePort(url) {
  if (url.port) return url.port;
  if (url.protocol === "http:") return "80";
  if (url.protocol === "https:") return "443";
  return "";
}

export function normalizeMediaSourceUrl(raw, baseHref) {
  const value = String(raw || "").trim();
  if (!value) return null;
  let base;
  let url;
  try {
    base = new URL(baseHref);
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(base.protocol) || !base.hostname) return null;

  if (url.protocol === "data:") {
    if (!SAFE_DATA_IMAGE.test(url.href)) return null;
    return { resourceUrl: url.href, portableUrl: "" };
  }

  if (url.protocol === "blob:") {
    let blobOrigin;
    try {
      blobOrigin = new URL(url.pathname);
    } catch {
      return null;
    }
    if (blobOrigin.username || blobOrigin.password) return null;
    if (url.origin !== base.origin) return null;
    return { resourceUrl: url.href, portableUrl: "" };
  }

  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (url.hostname !== base.hostname) return null;
  const allowedPorts = new Set([...MEDOS_PORTS, effectivePort(base)]);
  if (!allowedPorts.has(effectivePort(url))) return null;
  return { resourceUrl: url.href, portableUrl: url.href };
}

export function chooseActionFallback(requested, capabilities) {
  if (requested === "share" && capabilities.canShareFiles) return "share";
  if (requested === "save" && capabilities.canDownload) return "save";
  if (requested === "copy" && capabilities.canClipboard) return "copy";
  return "open";
}
