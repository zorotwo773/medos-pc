import {
  chooseActionFallback,
  expandTableGrid,
  mediaFileName,
  normalizeMediaSourceUrl,
  rowsToCsv,
  rowsToTsv,
} from "./media-interop-core.mjs";

const INITIALIZED = Symbol.for("medos.mediaInterop.initialized");

if (!globalThis[INITIALIZED]) {
  globalThis[INITIALIZED] = true;

  function runtimeBaseHref() {
    try {
      const current = new URL(location.href);
      if (/^https?:$/.test(current.protocol)) return current.href;
    } catch {
      // srcdoc documents use their injected backend base below.
    }
    try {
      const base = new URL(document.baseURI);
      const trustedPorts = new Set(["", "80", "443", "3000", "8002"]);
      let parentHostname = "";
      try {
        parentHostname = parent.location.hostname;
      } catch {
        return location.href;
      }
      if (
        /^https?:$/.test(base.protocol) &&
        base.hostname === parentHostname &&
        trustedPorts.has(base.port)
      ) {
        return base.href;
      }
    } catch {
      // Invalid or untrusted bases fail closed in sourceUrlPolicy.
    }
    return location.href;
  }

  const mediaBaseHref = runtimeBaseHref();

  const context = Object.freeze({
    source: "MedOS",
    title: document.title || "Media",
    sourceUrl: mediaBaseHref,
    printUrl: "",
    ...(globalThis.__MEDOS_MEDIA_CONTEXT__ || {}),
  });
  const ignoredSelector = "[data-medos-media-ignore]";
  const hiddenSelector = '[hidden],[aria-hidden="true"],[inert]';
  const excludedCellSelector =
    `.actions,.controls,[data-medos-media-ignore],${hiddenSelector}`;
  const excludedTableContentSelector =
    `script,style,button,input,textarea,select,[contenteditable=true],${excludedCellSelector}`;
  const interactiveSelector =
    "a,button,input,textarea,select,[contenteditable=true]";
  const cache = new Map();
  const trustedTableDescriptors = new WeakSet();
  const cacheLimit = 48;
  const cacheBytesLimit = 96 * 1024 * 1024;
  const prefetchConcurrency = 3;
  const prefetchRequestLimit = 24;
  const prefetchItemLimit = 12;
  const prefetchByteLimit = 24 * 1024 * 1024;
  const prefetchItemByteLimit = 16 * 1024 * 1024;
  const prefetchReservationBytes = 2 * 1024 * 1024;
  const requests = new Map();
  const requestQueue = [];
  let cacheBytes = 0;
  let activeRequests = 0;
  let prefetchRequests = 0;
  let admittedPrefetchItems = 0;
  let reservedPrefetchBytes = 0;
  let completedPrefetchBytes = 0;
  let readingPrefetchBytes = 0;

  const cleanText = (value) =>
    String(value || "").replace(/\s+/g, " ").trim();

  const firstText = (...values) => {
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return "";
  };

  const escapeHtml = (value) =>
    String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  function sourceUrlPolicy(raw) {
    return normalizeMediaSourceUrl(raw, mediaBaseHref);
  }

  function sealDescriptor(descriptor) {
    if (descriptor.file) Object.freeze(descriptor.file);
    return Object.freeze(descriptor);
  }

  function eligibleImage(image) {
    if (!(image instanceof HTMLImageElement)) return false;
    if (image.getAttribute("aria-hidden") === "true") return false;
    const roles = String(image.getAttribute("role") || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (roles.some((role) => role === "none" || role === "presentation")) {
      return false;
    }
    if (image.hasAttribute("data-medos-media-ignore")) return false;
    const width = image.naturalWidth || image.width || image.clientWidth || 0;
    const height = image.naturalHeight || image.height || image.clientHeight || 0;
    return Math.max(width, height) >= 80;
  }

  function eligibleTable(table) {
    if (
      !(table instanceof HTMLTableElement) ||
      table.rows.length === 0 ||
      table.closest(ignoredSelector)
    ) return false;
    let current = table;
    while (current) {
      if (hasHiddenState(current)) return false;
      current = current.parentElement;
    }
    return true;
  }

  function mediaElement(origin) {
    if (!(origin instanceof Element)) return null;
    const element = origin.closest("img,table") || Array.from(
      origin.closest("button,a,figure,[role=button]")?.querySelectorAll?.("img,table") || [],
    ).find((candidate) => (
      (candidate instanceof HTMLImageElement && eligibleImage(candidate)) ||
      (candidate instanceof HTMLTableElement && eligibleTable(candidate))
    ));
    if (element instanceof HTMLImageElement && eligibleImage(element)) return element;
    if (element instanceof HTMLTableElement && eligibleTable(element)) return element;
    return null;
  }

  function figcaptionFor(element) {
    const figure = element.closest("figure");
    return figure?.querySelector("figcaption")?.textContent || "";
  }

  function matchesBeforeTable(element, selector, table) {
    let current = element;
    while (current && current !== table) {
      if (current.matches(selector)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function renderedStyleFor(element) {
    let style = element.style || {};
    try {
      if (typeof getComputedStyle === "function") {
        style = getComputedStyle(element);
      }
    } catch {
      // Restricted nodes still expose their inline style below.
    }
    return style;
  }

  function hasNonRenderedStyle(element) {
    const style = renderedStyleFor(element);
    const display = String(
      style.display || element.style?.display || "",
    ).toLowerCase();
    const visibility = String(
      style.visibility || element.style?.visibility || "",
    ).toLowerCase();
    const contentVisibility = String(
      style.contentVisibility || element.style?.contentVisibility || "",
    ).toLowerCase();
    return (
      display === "none" ||
      visibility === "hidden" ||
      visibility === "collapse" ||
      contentVisibility === "hidden"
    );
  }

  function hasHiddenState(element) {
    return element.matches(hiddenSelector) || hasNonRenderedStyle(element);
  }

  function isHiddenWithinTable(element, table) {
    let current = element;
    while (current && current !== table) {
      if (hasHiddenState(current)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function tableRowGroups(table) {
    const groups = [];
    let current = null;
    for (const row of Array.from(table.rows)) {
      const parent = row.parentElement;
      const key = ["THEAD", "TBODY", "TFOOT"].includes(parent?.tagName)
        ? parent
        : table;
      if (!current || current.key !== key) {
        current = { key, rows: [] };
        groups.push(current);
      }
      current.rows.push(row);
    }
    return groups;
  }

  function visibleRowSpan(groupRows, rowIndex, rowSpan, table) {
    const span = Number(rowSpan);
    const end = span === 0
      ? groupRows.length
      : Math.min(groupRows.length, rowIndex + Math.max(1, span || 1));
    const count = groupRows
      .slice(rowIndex, end)
      .filter((row) => !isHiddenWithinTable(row, table))
      .length;
    return Math.max(1, count);
  }

  function visibleTableText(node, table, root) {
    if (node?.nodeType === 3) return node.nodeValue || "";
    if (node?.nodeType !== 1) return "";
    if (
      node !== root && (
        node.matches(excludedTableContentSelector) ||
        isHiddenWithinTable(node, table)
      )
    ) return "";
    return Array.from(node.childNodes || [])
      .map((child) => visibleTableText(child, table, root))
      .join("");
  }

  function tableCellGroups(table) {
    return tableRowGroups(table)
      .map(({ rows }) => rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) => !isHiddenWithinTable(row, table))
        .map(({ row, rowIndex }) => Array.from(row.cells)
          .filter((cell) => (
            !matchesBeforeTable(cell, excludedCellSelector, table) &&
            !isHiddenWithinTable(cell, table)
          ))
          .map((cell) => ({
            text: cleanText(visibleTableText(cell, table, cell)),
            rowSpan: visibleRowSpan(rows, rowIndex, cell.rowSpan, table),
            colSpan: cell.colSpan,
          }))))
      .filter((rows) => rows.length > 0);
  }

  function expandTableCellGroups(groups) {
    const grid = groups.flatMap((rows) => expandTableGrid(rows));
    const width = Math.max(0, ...grid.map((row) => row.length));
    return grid.map((row) =>
      Array.from({ length: width }, (_, index) => row[index] || ""),
    );
  }

  const safeRichTags = new Set([
    "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot",
    "tr", "th", "td", "p", "div", "span", "br", "strong", "b",
    "em", "i", "u", "s", "sub", "sup", "small", "mark", "abbr",
    "code", "kbd", "var", "samp", "pre", "ol", "ul", "li", "dl",
    "dt", "dd",
  ]);
  const droppedRichTags = new Set([
    "script", "style", "object", "embed", "iframe", "frame", "frameset",
    "form", "input", "button", "select", "textarea", "option", "svg",
    "math", "img", "video", "audio", "source", "track", "canvas",
    "template", "noscript", "meta", "link", "base",
  ]);
  const safeGlobalRichAttributes = new Set([
    "title", "lang", "dir", "aria-label", "aria-labelledby",
    "aria-describedby",
  ]);
  const safeRichAttributes = Object.freeze({
    col: new Set(["span"]),
    colgroup: new Set(["span"]),
    th: new Set(["id", "colspan", "rowspan", "scope", "headers", "abbr"]),
    td: new Set(["id", "colspan", "rowspan", "headers", "abbr"]),
    ol: new Set(["start", "reversed"]),
    li: new Set(["value"]),
  });

  function safeRichAttributesFor(node, tag, rowSpans) {
    const attributes = [];
    const adjustedRowSpan = rowSpans?.get(node);
    for (const attribute of Array.from(node.attributes || [])) {
      const name = attribute.name.toLowerCase();
      if (name === "rowspan" && adjustedRowSpan !== undefined) continue;
      if (
        !safeGlobalRichAttributes.has(name) &&
        !safeRichAttributes[tag]?.has(name)
      ) {
        continue;
      }
      attributes.push(` ${name}="${escapeHtml(attribute.value)}"`);
    }
    if (adjustedRowSpan > 1) {
      attributes.push(` rowspan="${adjustedRowSpan}"`);
    }
    if (tag === "table") {
      attributes.push(
        ' style="border-collapse:collapse;border:1px solid #64748b;color:#111827;background:#fff"',
      );
    } else if (tag === "th" || tag === "td") {
      attributes.push(
        ' style="border:1px solid #94a3b8;padding:4px 7px;vertical-align:top"',
      );
    }
    return attributes.join("");
  }

  function safeRichText(node, options) {
    if (node?.nodeType === 3) return node.nodeValue || "";
    if (node?.nodeType !== 1) return "";
    if (options?.shouldExclude(node)) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (droppedRichTags.has(tag)) return "";
    if (tag === "br") return " ";
    return Array.from(node.childNodes || [])
      .map((child) => safeRichText(child, options))
      .join(" ");
  }

  function serializeSafeRichNode(node, withinTable = false, options) {
    if (node?.nodeType === 3) return escapeHtml(node.nodeValue || "");
    if (node?.nodeType !== 1) return "";
    if (options?.shouldExclude(node)) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (droppedRichTags.has(tag)) return "";
    if (tag === "table" && withinTable) {
      return escapeHtml(cleanText(safeRichText(node, options)));
    }
    const children = Array.from(node.childNodes || [])
      .map((child) => serializeSafeRichNode(
        child,
        withinTable || tag === "table",
        options,
      ))
      .join("");
    if (!safeRichTags.has(tag)) return children;
    const attributes = safeRichAttributesFor(node, tag, options?.rowSpans);
    if (tag === "br" || tag === "col") return `<${tag}${attributes}>`;
    return `<${tag}${attributes}>${children}</${tag}>`;
  }

  function semanticTableHtml(table, title, source, sourceUrl) {
    const rowGroups = tableRowGroups(table);
    const rowSpans = new Map();
    rowGroups.forEach(({ rows }) => {
      rows.forEach((row, rowIndex) => {
        if (isHiddenWithinTable(row, table)) return;
        Array.from(row.cells).forEach((cell) => {
          if (
            matchesBeforeTable(cell, excludedCellSelector, table) ||
            isHiddenWithinTable(cell, table)
          ) return;
          rowSpans.set(
            cell,
            visibleRowSpan(rows, rowIndex, cell.rowSpan, table),
          );
        });
      });
    });
    const options = {
      rowSpans,
      shouldExclude: (node) => (
        node !== table && (
          node.matches(excludedTableContentSelector) ||
          isHiddenWithinTable(node, table)
        )
      ),
    };
    const attribution = sourceUrl
      ? `<p>${escapeHtml(title)} — ${escapeHtml(source)} · <a href="${escapeHtml(sourceUrl)}">Source</a></p>`
      : `<p>${escapeHtml(title)} — ${escapeHtml(source)}</p>`;
    return `${serializeSafeRichNode(table, false, options)}${attribution}`;
  }

  function cachedFile(url, title, source) {
    const entry = cache.get(url);
    if (!entry) return null;
    const extension = extensionFor(entry.blob.type, url);
    return new File(
      [entry.blob],
      mediaFileName({ source, title, extension }),
      { type: entry.blob.type || "application/octet-stream" },
    );
  }

  function extensionFor(mimeType, url = "") {
    const known = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
    };
    if (known[mimeType]) return known[mimeType];
    const match = String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    return match ? match[1].toLowerCase() : "bin";
  }

  function rememberBlob(url, blob) {
    if (!url || !blob || blob.size > cacheBytesLimit) return;
    const previous = cache.get(url);
    if (previous) cacheBytes -= previous.blob.size;
    cache.delete(url);
    cache.set(url, { blob });
    cacheBytes += blob.size;
    while (cache.size > cacheLimit || cacheBytes > cacheBytesLimit) {
      const oldest = cache.keys().next().value;
      const removed = cache.get(oldest);
      cache.delete(oldest);
      cacheBytes -= removed?.blob.size || 0;
    }
  }

  function releasePrefetchAdmission(task) {
    if (!task.admittedAsPrefetch) return;
    task.admittedAsPrefetch = false;
    admittedPrefetchItems = Math.max(0, admittedPrefetchItems - 1);
    reservedPrefetchBytes = Math.max(
      0,
      reservedPrefetchBytes - task.reservedBytes,
    );
    task.reservedBytes = 0;
  }

  function promoteRequest(task) {
    if (task.priority === "user") return;
    task.priority = "user";
    releasePrefetchAdmission(task);
    const index = requestQueue.indexOf(task);
    if (index >= 0) {
      requestQueue.splice(index, 1);
      requestQueue.unshift(task);
    }
  }

  function declaredResponseSize(response) {
    const raw = response?.headers?.get?.("content-length");
    if (raw === null || raw === undefined || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  async function cancelBody(body) {
    try {
      await body?.cancel?.();
    } catch {
      // Cancellation is best-effort and must never surface as an unhandled rejection.
    }
  }

  async function boundedResponseBlob(response, byteLimit) {
    const reader = response?.body?.getReader?.();
    if (!reader) {
      await cancelBody(response?.body);
      return null;
    }
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes + chunk.byteLength > byteLimit) {
        await cancelBody(reader);
        return null;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
    const mimeType = response?.headers?.get?.("content-type") ||
      "application/octet-stream";
    return new Blob(chunks, { type: mimeType });
  }

  async function executeRequest(task) {
    let bodyReservation = 0;
    try {
      const response = await fetch(task.url, { credentials: "same-origin" });
      if (!response.ok) return null;
      const declaredSize = declaredResponseSize(response);
      let blob;
      if (task.priority === "background") {
        const remaining =
          prefetchByteLimit - completedPrefetchBytes - readingPrefetchBytes;
        if (
          declaredSize !== null &&
          (declaredSize > prefetchItemByteLimit || declaredSize > remaining)
        ) {
          await cancelBody(response.body);
          return null;
        }
        bodyReservation = Math.min(
          prefetchItemByteLimit,
          remaining,
          Math.max(declaredSize || 0, task.reservedBytes || prefetchReservationBytes),
        );
        if (bodyReservation <= 0) {
          await cancelBody(response.body);
          return null;
        }
        readingPrefetchBytes += bodyReservation;
        blob = await boundedResponseBlob(response, bodyReservation);
      } else if (declaredSize !== null && declaredSize > cacheBytesLimit) {
        await cancelBody(response.body);
        return null;
      } else {
        blob = await response.blob();
      }
      readingPrefetchBytes = Math.max(0, readingPrefetchBytes - bodyReservation);
      bodyReservation = 0;
      if (!blob || blob.size > cacheBytesLimit) return null;
      if (task.priority === "background") {
        if (
          blob.size > prefetchItemByteLimit ||
          completedPrefetchBytes + blob.size > prefetchByteLimit
        ) {
          return null;
        }
        completedPrefetchBytes += blob.size;
      }
      rememberBlob(task.url, blob);
      return blob;
    } catch {
      return null;
    } finally {
      readingPrefetchBytes = Math.max(0, readingPrefetchBytes - bodyReservation);
    }
  }

  function drainRequestQueue() {
    while (activeRequests < prefetchConcurrency && requestQueue.length) {
      const task = requestQueue.shift();
      task.started = true;
      activeRequests += 1;
      void executeRequest(task).then((blob) => {
        activeRequests -= 1;
        releasePrefetchAdmission(task);
        requests.delete(task.url);
        task.resolve(blob);
        drainRequestQueue();
      });
    }
  }

  function requestBlob(url, priority = "user") {
    const policy = sourceUrlPolicy(url);
    if (!policy?.resourceUrl) return Promise.resolve(null);
    url = policy.resourceUrl;
    if (cache.has(url)) return Promise.resolve(cache.get(url).blob);
    const existing = requests.get(url);
    if (existing) {
      if (priority === "user") promoteRequest(existing);
      return existing.promise;
    }

    let admittedAsPrefetch = false;
    let reservedBytes = 0;
    if (priority === "background") {
      if (
        prefetchRequests >= prefetchRequestLimit ||
        admittedPrefetchItems >= prefetchItemLimit ||
        reservedPrefetchBytes + completedPrefetchBytes + prefetchReservationBytes >
          prefetchByteLimit
      ) {
        return Promise.resolve(null);
      }
      prefetchRequests += 1;
      admittedPrefetchItems += 1;
      reservedPrefetchBytes += prefetchReservationBytes;
      admittedAsPrefetch = true;
      reservedBytes = prefetchReservationBytes;
    }

    let resolveRequest;
    const promise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const task = {
      url,
      priority,
      promise,
      resolve: resolveRequest,
      admittedAsPrefetch,
      reservedBytes,
      started: false,
    };
    requests.set(url, task);
    if (priority === "user") requestQueue.unshift(task);
    else requestQueue.push(task);
    drainRequestQueue();
    return promise;
  }

  function prefetchImage(image) {
    if (!eligibleImage(image)) return;
    const descriptor = descriptorFor(image);
    if (descriptor?.resourceUrl) {
      void requestBlob(descriptor.resourceUrl, "background");
    }
  }

  function buildImageDescriptor({ title, source, sourceUrl, fileName, file: suppliedFile }) {
    const policy = sourceUrlPolicy(sourceUrl);
    const resourceUrl = policy?.resourceUrl || "";
    const portableSourceUrl = policy?.portableUrl || "";
    if (!resourceUrl && !suppliedFile) return null;
    const file = suppliedFile || cachedFile(resourceUrl, title, source);
    const mimeType = file?.type || "image/*";
    const imageHtml = resourceUrl
      ? `<img src="${escapeHtml(resourceUrl)}" alt="${escapeHtml(title)}">`
      : "";
    const html = `<figure>${imageHtml}<figcaption>${escapeHtml(title)} — ${escapeHtml(source)}</figcaption></figure>`;
    const plainText = portableSourceUrl
      ? `${title} — ${source}\n${portableSourceUrl}`
      : `${title} — ${source}`;
    return sealDescriptor({
      kind: "image",
      title,
      source,
      sourceUrl: portableSourceUrl,
      resourceUrl,
      fileName:
        fileName || file?.name ||
        mediaFileName({
          source,
          title,
          extension: extensionFor(file?.type, resourceUrl),
        }),
      mimeType,
      html,
      plainText,
      file,
    });
  }

  function buildDocumentDescriptor({ title, source, sourceUrl }) {
    const policy = sourceUrlPolicy(sourceUrl);
    const portableSourceUrl = policy?.portableUrl || "";
    if (!portableSourceUrl) return null;
    return sealDescriptor({
      kind: "document",
      title,
      source,
      sourceUrl: portableSourceUrl,
      html: `<p><a href="${escapeHtml(portableSourceUrl)}">${escapeHtml(title)}</a> — ${escapeHtml(source)}</p>`,
      plainText: `${title} — ${source}\n${portableSourceUrl}`,
    });
  }

  function imageDescriptor(image) {
    const dataTitle = image.getAttribute("data-medos-media-title");
    const title = firstText(
      image.getAttribute("alt"),
      image.getAttribute("title"),
      figcaptionFor(image),
      dataTitle,
      context.title,
      "Image",
    );
    const source = firstText(
      image.getAttribute("data-medos-media-source"),
      context.source,
      "MedOS",
    );
    const declaredSource = image.getAttribute("data-medos-media-source-url");
    const renderedSource = image.currentSrc || image.getAttribute("src") || "";
    const sourceUrl = declaredSource || renderedSource || context.sourceUrl;
    return buildImageDescriptor({ title, source, sourceUrl });
  }

  function buildTableDescriptor(table, overrides) {
    const caption = table.querySelector(":scope > caption")?.textContent || "";
    const title = firstText(
      overrides.title,
      table.getAttribute("alt"),
      table.getAttribute("title"),
      figcaptionFor(table),
      caption,
      table.getAttribute("data-medos-media-title"),
      context.title,
      "Table",
    );
    const source = firstText(
      overrides.source,
      table.getAttribute("data-medos-media-source"),
      context.source,
      "MedOS",
    );
    const policy = sourceUrlPolicy(
      overrides.sourceUrl ||
        table.getAttribute("data-medos-media-source-url") ||
        context.sourceUrl,
    );
    const sourceUrl = policy?.portableUrl || "";
    const rows = expandTableCellGroups(tableCellGroups(table));
    const tsv = rowsToTsv(rows);
    const csv = rowsToCsv(rows);
    const fileName = overrides.fileName ||
      mediaFileName({ source, title, extension: "csv" });
    const file = new File(["\ufeff", csv], fileName, {
      type: "text/csv;charset=utf-8",
    });
    const html = semanticTableHtml(table, title, source, sourceUrl);
    const plainText = tsv;
    const descriptor = sealDescriptor({
      kind: "table",
      title,
      source,
      sourceUrl,
      fileName,
      mimeType: "text/csv",
      html,
      plainText,
      tsv,
      csv,
      file,
    });
    trustedTableDescriptors.add(descriptor);
    return descriptor;
  }

  function tableDescriptor(table, overrides = {}) {
    if (!eligibleTable(table)) return null;
    return buildTableDescriptor(table, overrides);
  }

  function withOverrides(descriptor, overrides = {}) {
    const merged = { ...descriptor };
    for (const [key, value] of Object.entries(overrides || {})) {
      if (key !== "element" && value !== undefined) merged[key] = value;
    }
    return merged;
  }

  function descriptorFor(element, overrides = {}) {
    if (!(element instanceof Element) && element?.kind) {
      const seed = element;
      if (seed.element instanceof Element) {
        return descriptorFor(seed.element, seed);
      }
      if (seed.kind === "image") {
        return buildImageDescriptor({
          title: firstText(seed.title, context.title, "Image"),
          source: firstText(seed.source, context.source, "MedOS"),
          sourceUrl: seed.resourceUrl || seed.sourceUrl || context.sourceUrl,
          fileName: seed.fileName,
          file: seed.file,
        });
      }
      if (seed.kind === "document") {
        return buildDocumentDescriptor({
          title: firstText(seed.title, context.title, "Document"),
          source: firstText(seed.source, context.source, "MedOS"),
          sourceUrl: seed.sourceUrl || context.sourceUrl,
        });
      }
      if (
        seed.kind === "table" &&
        typeof seed.tsv === "string" &&
        typeof seed.html === "string" &&
        trustedTableDescriptors.has(seed)
      ) {
        const policy = sourceUrlPolicy(seed.sourceUrl || context.sourceUrl);
        if (seed.sourceUrl && !policy) return null;
        const normalized = sealDescriptor({
          ...seed,
          sourceUrl: policy?.portableUrl || "",
          plainText: seed.tsv,
        });
        trustedTableDescriptors.add(normalized);
        return normalized;
      }
      return null;
    }
    let media = null;
    if (element instanceof HTMLImageElement) {
      media = eligibleImage(element) ? element : null;
    } else if (element instanceof HTMLTableElement) {
      media = eligibleTable(element) ? element : null;
    } else {
      media = mediaElement(element);
    }
    if (!media) return null;
    if (media instanceof HTMLTableElement) {
      return tableDescriptor(media, overrides);
    }
    const descriptor = imageDescriptor(media);
    const imageOverrides = withOverrides(descriptor, overrides);
    return buildImageDescriptor(imageOverrides);
  }

  function viewerDescriptor(descriptor) {
    if (!descriptor || (descriptor.kind !== "image" && descriptor.kind !== "table")) {
      return null;
    }
    const transferable = {
      kind: descriptor.kind,
      title: descriptor.title,
      source: descriptor.source,
      sourceUrl: descriptor.sourceUrl,
      fileName: descriptor.fileName,
      html: descriptor.html,
      plainText: descriptor.plainText,
    };
    if (descriptor.kind === "image") {
      transferable.resourceUrl = descriptor.resourceUrl;
    }
    return transferable;
  }

  function statusRegion() {
    let region = document.getElementById("medos-media-status");
    if (!region && document.body) {
      region = document.createElement("div");
      region.id = "medos-media-status";
      region.setAttribute("role", "status");
      region.setAttribute("aria-live", "polite");
      region.setAttribute("aria-atomic", "true");
      region.style.cssText =
        "position:fixed;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
      document.body.appendChild(region);
    }
    return region;
  }

  function notify(message, tone = "ok") {
    const region = statusRegion();
    if (!region) return;
    region.dataset.tone = tone;
    region.textContent = "";
    requestAnimationFrame(() => {
      region.textContent = cleanText(message);
    });
  }

  function openStable(descriptor) {
    const policy = sourceUrlPolicy(descriptor?.sourceUrl);
    if (!policy?.portableUrl) {
      notify(descriptor?.plainText || "This item cannot be opened separately.", "error");
      return false;
    }
    if (!document.body) {
      window.prompt("Copy this local media URL:", policy.portableUrl);
      notify("The local media URL is ready to copy.", "error");
      return false;
    }
    const anchor = document.createElement("a");
    anchor.href = policy.portableUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    notify("Opened in a separate tab.");
    return true;
  }

  async function ensureFile(descriptor) {
    if (descriptor.file) return descriptor.file;
    if (descriptor.kind !== "image" || !descriptor.resourceUrl) return null;
    const blob = await requestBlob(descriptor.resourceUrl, "user");
    if (!blob) return null;
    const fileName = !descriptor.fileName || /\.bin$/i.test(descriptor.fileName)
      ? mediaFileName({
          source: descriptor.source,
          title: descriptor.title,
          extension: extensionFor(blob.type, descriptor.resourceUrl),
        })
      : descriptor.fileName;
    return new File([blob], fileName, {
      type: blob.type || "application/octet-stream",
    });
  }

  async function shareDescriptor(descriptor) {
    const file = await ensureFile(descriptor);
    if (!file || !navigator.share || !navigator.canShare?.({ files: [file] })) {
      return openStable(descriptor);
    }
    try {
      await navigator.share({ files: [file], title: descriptor.title });
      notify("Shared media.");
      return true;
    } catch {
      return openStable(descriptor);
    }
  }

  async function copyDescriptor(descriptor) {
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      const representations = {
        "text/html": new Blob([descriptor.html], { type: "text/html" }),
        "text/plain": new Blob([descriptor.plainText], { type: "text/plain" }),
      };
      const file = await ensureFile(descriptor);
      if (file) representations[file.type.split(";")[0]] = file;
      if (descriptor.kind === "table") {
        representations["text/tab-separated-values"] = new Blob([descriptor.tsv], {
          type: "text/tab-separated-values",
        });
      }
      try {
        await navigator.clipboard.write([new ClipboardItem(representations)]);
        notify("Copied media with source.");
        return true;
      } catch {
        // Text clipboard remains a useful fallback on restricted browsers.
      }
    }
    const fallbackText = descriptor.kind === "table"
      ? descriptor.tsv
      : descriptor.sourceUrl || descriptor.plainText;
    if (fallbackText && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(fallbackText);
        notify(descriptor.kind === "table" ? "Copied table." : "Copied media URL.");
        return true;
      } catch {
        // A selectable/open fallback remains available below.
      }
    }
    return openStable(descriptor);
  }

  async function saveDescriptor(descriptor) {
    const file = await ensureFile(descriptor);
    if (!file) return openStable(descriptor);
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    notify("Saved media.");
    return true;
  }

  function printableDocument(descriptor) {
    const title = escapeHtml(descriptor.title || "MedOS media");
    const source = escapeHtml(descriptor.source || "MedOS");
    const sourceUrl = sourceUrlPolicy(descriptor.sourceUrl)?.portableUrl || "";
    const attribution = sourceUrl
      ? `${source} · <a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a>`
      : source;
    let body = "";
    if (descriptor.kind === "image") {
      const resourceUrl = sourceUrlPolicy(descriptor.resourceUrl)?.resourceUrl || "";
      body = resourceUrl
        ? `<figure><img src="${escapeHtml(resourceUrl)}" alt="${title}"><figcaption>${attribution}</figcaption></figure>`
        : `<p>Media unavailable: ${title}</p>`;
    } else if (descriptor.kind === "table") {
      body = `${descriptor.html}<p class="source">${attribution}</p>`;
    } else {
      body = sourceUrl
        ? `<p><a href="${escapeHtml(sourceUrl)}">Open source document</a></p>`
        : `<p>${escapeHtml(descriptor.plainText || "Media unavailable")}</p>`;
    }
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>@page{margin:16mm}body{font:12pt system-ui;color:#18212f}h1{color:#123b5d}.source,figcaption{color:#52616b;font-size:10pt}figure{margin:0}img{display:block;max-width:100%;max-height:245mm;object-fit:contain}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #9ba7b0;padding:5px;text-align:left}</style></head><body><h1>${title}</h1>${body}</body></html>`;
  }

  function printDescriptor(descriptor) {
    const popup = window.open("", "_blank");
    if (!popup?.document) {
      notify("Allow pop-ups to print or save this media as PDF.", "error");
      return false;
    }
    try {
      popup.opener = null;
      popup.name = "medos-media-print-preview";
      popup.document.open();
      popup.document.write(printableDocument(descriptor));
      popup.document.close();
      popup.focus();
      popup.print();
      return true;
    } catch {
      try { popup.close?.(); } catch { /* best-effort cleanup */ }
      notify("The printable media view could not be created.", "error");
      return false;
    }
  }

  async function run(action, descriptor) {
    const normalized = descriptorFor(descriptor);
    if (!normalized) {
      notify("No transferable media was found.", "error");
      return false;
    }
    if (action === "open") return openStable(normalized);
    if (action === "share") return shareDescriptor(normalized);
    if (action === "copy") return copyDescriptor(normalized);
    if (action === "print") return printDescriptor(normalized);
    const selected = chooseActionFallback(action, {
      canShareFiles: false,
      canDownload: action === "save",
      canClipboard: false,
    });
    if (selected === "save") return saveDescriptor(normalized);
    return openStable(normalized);
  }

  function addTransferData(transfer, type, value) {
    if (!value) return;
    try {
      transfer.setData(type, value);
    } catch {
      // Browsers may reject nonstandard drag MIME types; standard types continue.
    }
  }

  function onDragStart(event) {
    const candidate = event.target instanceof Element
      ? event.target.closest("img,table")
      : null;
    const element = mediaElement(event.target);
    if (!element || !event.dataTransfer) {
      if (candidate instanceof HTMLImageElement) event.preventDefault();
      return;
    }
    if (element.closest('[data-medos-media-pan-active="true"]')) {
      event.preventDefault();
      return;
    }
    if (element instanceof HTMLTableElement) {
      if (event.target.closest(interactiveSelector)) {
        event.preventDefault();
        return;
      }
      const selection = document.getSelection?.();
      if (selection && !selection.isCollapsed) {
        event.preventDefault();
        return;
      }
    }
    const descriptor = descriptorFor(element);
    if (!descriptor) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    addTransferData(event.dataTransfer, "text/uri-list", descriptor.sourceUrl);
    addTransferData(event.dataTransfer, "text/plain", descriptor.plainText);
    addTransferData(event.dataTransfer, "text/html", descriptor.html);
    if (descriptor.kind === "table") {
      addTransferData(
        event.dataTransfer,
        "text/tab-separated-values",
        descriptor.tsv,
      );
    }
    if (descriptor.file && event.dataTransfer.items?.add) {
      try {
        event.dataTransfer.items.add(descriptor.file);
      } catch {
        // The URL and textual representations remain portable.
      }
    }
  }

  function onMediaClick(event) {
    if (window.parent === window || event.defaultPrevented || event.button > 0) return;
    const element = mediaElement(event.target);
    if (!element) return;
    if (element instanceof HTMLTableElement) {
      if (event.target.closest?.(interactiveSelector)) return;
      const selection = document.getSelection?.();
      if (selection && !selection.isCollapsed) return;
    }
    const descriptor = viewerDescriptor(descriptorFor(element));
    if (!descriptor) return;
    event.preventDefault();
    event.stopPropagation();
    window.parent.postMessage({ type: "medos_media_open", descriptor }, "*");
  }

  function prepareElement(element) {
    if (element instanceof HTMLImageElement) {
      element.draggable = Boolean(eligibleImage(element) && descriptorFor(element));
      if (element.complete) prefetchImage(element);
      else {
        element.addEventListener(
          "load",
          () => {
            element.draggable = Boolean(
              eligibleImage(element) && descriptorFor(element),
            );
            prefetchImage(element);
          },
          { once: true },
        );
      }
      return;
    }
    if (element instanceof HTMLTableElement && eligibleTable(element)) {
      element.draggable = true;
    }
  }

  function prepareTree(root) {
    if (!(root instanceof Element || root instanceof Document)) return;
    if (root instanceof Element && root.matches("img,table")) prepareElement(root);
    root.querySelectorAll?.("img,table").forEach(prepareElement);
  }

  function initializeDocument() {
    statusRegion();
    prepareTree(document);
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("click", onMediaClick, true);
    const observer = new MutationObserver((records) => {
      records.forEach((record) =>
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) prepareTree(node);
        }),
      );
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener("keydown", (event) => {
    if (
      window.parent !== window &&
      context.printUrl &&
      (event.ctrlKey || event.metaKey) &&
      String(event.key).toLowerCase() === "p"
    ) {
      event.preventDefault();
      window.parent.postMessage(
        { type: "medos_print_article", printUrl: context.printUrl },
        "*",
      );
    }
  });

  globalThis.MedOSMedia = Object.freeze({ descriptorFor, notify, run });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeDocument, { once: true });
  } else {
    initializeDocument();
  }
}
