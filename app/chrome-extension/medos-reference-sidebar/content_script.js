(function medosReferenceContentScript() {
  const DEFAULT_DB = "step2";
  const MAX_TEXT_CHARS = 90000;
  const MAX_MATCHES = 280;
  const RESCAN_DELAY_MS = 850;
  const NODE_SEPARATOR = "\nMEDOSNODESEPARATOR\n";
  const UNDERLINES_STORAGE_KEY = "medos:underlines";

  // Hover-card sizing/placement constants — mirrors AmbossHtml.tsx so the
  // extension card behaves identically to the in-app hover engine.
  const TOOLTIP_MARGIN = 12;
  const TOOLTIP_DEFAULT_WIDTH = 360;
  const TOOLTIP_MIN_WIDTH = 300;
  const TOOLTIP_MAX_WIDTH = 660;
  const TOOLTIP_DEFAULT_MAX_HEIGHT = 520;
  const MAX_SECONDARY_ACTIONS = 6;
  const HOVER_OPEN_DELAY_MS = 120;
  const HOVER_CLOSE_DELAY_MS = 220;

  function isMedosAppPage() {
    const host = location.hostname;
    const localHost = host === "localhost" || host === "127.0.0.1";
    return (
      document.documentElement.dataset.medosApp === "true" ||
      Boolean(document.querySelector(".shell-frame, .qbank-exam-shell, .qbank-tutor-layout")) ||
      (localHost && /^MedOS\b/i.test(document.title || "")) ||
      (localHost && location.pathname.startsWith("/qbank"))
    );
  }

  if (isMedosAppPage()) {
    return;
  }

  // Local cache of the setting — updated via storage listener
  let underlinesEnabled = true;
  chrome.storage.local.get([UNDERLINES_STORAGE_KEY], (result) => {
    underlinesEnabled = result[UNDERLINES_STORAGE_KEY] !== "off";
  });
  const SKIP_TAGS = new Set([
    "A",
    "BUTTON",
    "CANVAS",
    "CODE",
    "HEAD",
    "IFRAME",
    "IMG",
    "INPUT",
    "NOSCRIPT",
    "OPTION",
    "PRE",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "SVG",
    "TEXTAREA",
    "VIDEO",
  ]);

  let observer = null;
  let scanTimer = null;
  let scanToken = 0;
  let scanInFlight = false;
  let tooltipEl = null;
  let tooltipTarget = null;
  let tooltipData = null;
  let tooltipShowTimer = null;
  let tooltipHideTimer = null;
  let selectionTimer = null;
  let lastSelectionText = "";
  let lightboxEl = null;

  // Per-term tooltip cache (source::term → payload), mirrors AmbossHtml's tooltipCache.
  const tooltipCache = new Map();

  // ── Backend proxy (through the service worker) ────────────────────────────
  // Fetching 127.0.0.1 from the page's own context triggers Chrome's per-site
  // "access devices on your local network" prompt AND fails the backend's
  // localhost-only CORS check — the extension origin (service worker) does neither.
  async function apiJson(path, options) {
    const response = await chrome.runtime.sendMessage({ type: "MEDOS_API_JSON", path, options });
    if (!response || !response.ok) {
      throw new Error(`MedOS API failed: ${response ? response.status : "no response"}`);
    }
    return response.data;
  }

  async function apiImageDataUrl(path) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "MEDOS_API_DATAURL", path });
      return response && response.ok ? response.dataUrl : "";
    } catch (_error) {
      return "";
    }
  }

  // ── Text scanning / underline machinery ───────────────────────────────────
  function shouldSkipNode(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) {
      return true;
    }
    if (element.closest(".medos-ext-ref, .medos-ext-tooltip, .medos-ext-lightbox")) {
      return true;
    }
    for (let current = element; current; current = current.parentElement) {
      if (SKIP_TAGS.has(current.tagName)) {
        return true;
      }
      if (current.isContentEditable) {
        return true;
      }
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") {
        return true;
      }
    }
    return false;
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          return shouldSkipNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }
    return nodes;
  }

  function buildScanText(nodes) {
    let text = "";
    const ranges = [];
    for (const node of nodes) {
      if (text.length >= MAX_TEXT_CHARS) {
        break;
      }
      const value = node.nodeValue || "";
      if (!value) {
        continue;
      }
      if (text.length > 0) {
        text += NODE_SEPARATOR;
      }
      const remaining = MAX_TEXT_CHARS - text.length;
      const clipped = value.slice(0, Math.max(0, remaining));
      const start = text.length;
      text += clipped;
      ranges.push({ node, start, end: start + clipped.length });
    }
    return { text, ranges };
  }

  function removeExistingMarks() {
    hideTooltip(true);
    const marks = Array.from(document.querySelectorAll(".medos-ext-ref"));
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    }
  }

  function normalizeSource(source) {
    if (source === "uptodate") return "utd";
    if (source === "drugs") return "drug";
    if (source === "firstaid_full") return "firstaid";
    if ([
      "amboss", "qbank", "utd", "cliniccons", "drug",
      "firstaid", "umls", "uworld", "books", "diseases",
    ].includes(source)) {
      return source;
    }
    return "reference";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Long brand label shown at the top of the card (matches app tooltipBrand()).
  function tooltipBrand(data) {
    if (isDrugTooltipData(data)) return "DRUG REFERENCE";
    switch (normalizeSource(data.source || "amboss")) {
      case "qbank": return "UWORLD";
      case "utd": return "UPTODATE";
      case "cliniccons": return "CLINIC CONSULT";
      case "firstaid": return "FIRST AID";
      case "umls": return "UMLS";
      case "uworld": return "UWORLD LIBRARY";
      case "books": return "BOOKS";
      case "diseases": return "DISEASE";
      default: return "AMBOSS";
    }
  }

  // 2-letter colour-coded badge for a match action (matches app actionBadge()).
  function actionBadge(match) {
    const src = match.source;
    if (src === "drug" || match.kind === "drug" || (match.href || "").startsWith("/drugs")) return "Rx";
    if (src === "firstaid" || (match.href || "").startsWith("#firstaid-")) return "FA";
    if (src === "qbank" && match.kind === "question") return "Q";
    if (src === "qbank") return "UW";
    if (src === "uworld") return "UL";
    if (src === "utd") return "UT";
    if (src === "diseases") return "Dx";
    if (src === "books") return "Bk";
    if (src === "cliniccons") return "CC";
    if (src === "umls") return "UM";
    if (src === "amboss") return "AB";
    return "Lk";
  }

  function actionLabel(match) {
    const src = match.source;
    if (src === "drug" || match.kind === "drug" || (match.href || "").startsWith("/drugs")) return match.title || "Drug reference";
    if (src === "firstaid" || (match.href || "").startsWith("#firstaid-")) return match.title || "First Aid";
    if (src === "qbank") {
      if (match.kind === "question") return (match.title || "").replace(/^Open source question\s*/i, "") || "Question";
      if (match.kind === "image") return "Image";
      if (match.kind === "exhibit") return match.title || "Exhibit";
      return match.title || "UWorld";
    }
    if (src === "utd") {
      if (match.kind === "topic") return (match.title || "").replace(/^Open UpToDate topic$/i, "Topic");
      return (match.title || "").replace(/^Open UpToDate graphic$/i, "Graphic") || "UpToDate";
    }
    if (src === "umls") return match.title || "UMLS concept";
    return match.title || "Open source";
  }

  function actionSource(match) {
    if (match.source === "drug" || match.kind === "drug" || (match.href || "").startsWith("/drugs")) return "drug";
    if (match.source === "firstaid" || (match.href || "").startsWith("#firstaid-")) return "firstaid";
    return normalizeSource(match.source || "amboss");
  }

  function isQuestionMatch(match) {
    return match.source === "qbank" && match.kind === "question";
  }

  function isDrugTooltipData(data) {
    return Boolean(data && (data.source === "drug" || data.kind === "drug" || data.drug_card || /medos-drug-card/.test(data.html || "")));
  }

  // Hide the primary match (already represented by the card title/brand), like
  // the app's isPrimaryMatch() filter, so the actions list shows only extras.
  function isPrimaryMatch(match, data) {
    const primary = normalizeSource(data.source || "amboss");
    const src = normalizeSource(match.source || "amboss");
    if (isDrugTooltipData(data) && (match.source === "drug" || match.kind === "drug" || (match.href || "").startsWith("/drugs"))) return true;
    if (primary === "amboss" && src === "amboss") return true;
    if (primary === src && (data.kind || "") === (match.kind || "")) return true;
    if (primary === "firstaid" && src === "firstaid") return true;
    if (primary === "umls" && src === "umls") return true;
    return false;
  }

  function visibleActionMatches(data) {
    return (Array.isArray(data.matches) ? data.matches : []).filter((match) => !isPrimaryMatch(match, data));
  }

  // ── Card sizing + placement (ports tooltipMetrics / tooltipPosition) ──────
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function plainHtmlLength(html) {
    if (!html) return 0;
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .length;
  }

  function htmlTableStats(html) {
    if (!html) return { rows: 0, columns: 0, textLength: 0, hasTable: false };
    const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const columns = rows.reduce((max, row) => Math.max(max, (row.match(/<(td|th)\b/gi) || []).length), 0);
    return {
      rows: rows.length,
      columns,
      textLength: plainHtmlLength(html),
      hasTable: /<table\b|table-default-style|table-header-footer-style|table-footer-only-style/i.test(html),
    };
  }

  function tooltipMetrics(data) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxAvailableWidth = Math.max(TOOLTIP_MIN_WIDTH, viewportWidth - TOOLTIP_MARGIN * 2);
    const maxAvailableHeight = Math.max(360, viewportHeight - TOOLTIP_MARGIN * 2);
    const stats = htmlTableStats(data.html);
    const mediaCount = (data.media || []).length;
    const matchCount = (data.matches || []).length;
    let layout = "compact";
    let width = TOOLTIP_DEFAULT_WIDTH;
    let maxHeight = TOOLTIP_DEFAULT_MAX_HEIGHT;

    if (data.html && !isDrugTooltipData(data)) {
      layout = "exhibit";
      const tableWidth = stats.columns ? 190 + stats.columns * 112 : 430;
      const textWidth = stats.textLength > 900 ? 610 : stats.textLength > 520 ? 540 : 420;
      width = Math.max(340, tableWidth, textWidth);
      if (stats.hasTable && stats.columns <= 2 && stats.textLength < 700) width = Math.min(width, 460);
      if (stats.hasTable && stats.columns >= 4) width = Math.max(width, 600);
      maxHeight = 620;
    } else if (mediaCount) {
      layout = "media";
      width = mediaCount >= 2 ? 450 : 390;
      maxHeight = 560;
    } else if ((data.abstract?.length || 0) > 420 || matchCount > 3) {
      layout = "article";
      width = 390;
      maxHeight = 560;
    }

    if (matchCount > 3 && layout !== "exhibit") width += 24;
    return {
      width: Math.round(clamp(width, TOOLTIP_MIN_WIDTH, Math.min(TOOLTIP_MAX_WIDTH, maxAvailableWidth))),
      maxHeight: Math.round(clamp(maxHeight, 360, maxAvailableHeight)),
      layout,
    };
  }

  function tooltipPosition(anchorX, anchorY, metrics) {
    const width = Math.min(metrics.width, window.innerWidth - TOOLTIP_MARGIN * 2);
    const maxHeight = Math.min(metrics.maxHeight, window.innerHeight - TOOLTIP_MARGIN * 2);
    const preferRight = anchorX + 12;
    const preferLeft = anchorX - width - 12;
    const x = preferRight + width <= window.innerWidth - TOOLTIP_MARGIN
      ? preferRight
      : preferLeft >= TOOLTIP_MARGIN
        ? preferLeft
        : Math.max(TOOLTIP_MARGIN, Math.min(anchorX, window.innerWidth - width - TOOLTIP_MARGIN));
    const below = anchorY + 12;
    const placement = below + maxHeight <= window.innerHeight - TOOLTIP_MARGIN ? "below" : "above";
    const y = placement === "below" ? below : Math.max(TOOLTIP_MARGIN, anchorY - 8);
    return { x, y, placement };
  }

  // ── Underline application ─────────────────────────────────────────────────
  function rangeForMatch(match, nodeRange) {
    const start = Math.max(match.start, nodeRange.start);
    const end = Math.min(match.end, nodeRange.end);
    if (start >= end) {
      return null;
    }
    return {
      start: start - nodeRange.start,
      end: end - nodeRange.start,
      term: match.term || "",
      source: normalizeSource(match.source || ""),
      kind: match.kind || "",
    };
  }

  function wrapTextNode(node, ranges) {
    const text = node.nodeValue || "";
    const sorted = ranges
      .filter((range) => range.start < range.end && range.start >= 0 && range.end <= text.length)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    if (!sorted.length) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const range of sorted) {
      if (range.start < cursor) {
        continue;
      }
      if (range.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, range.start)));
      }
      const span = document.createElement("span");
      span.className = `medos-ext-ref medos-ext-ref-source-${range.source}`;
      span.dataset.medosTerm = range.term || text.slice(range.start, range.end);
      span.dataset.medosSource = range.source;
      span.dataset.medosKind = range.kind;
      span.textContent = text.slice(range.start, range.end);
      fragment.appendChild(span);
      cursor = range.end;
    }
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(fragment, node);
  }

  function wrapMatches(matches, ranges) {
    const byNode = new Map();
    for (const match of matches) {
      for (const nodeRange of ranges) {
        if (nodeRange.end <= match.start) {
          continue;
        }
        if (nodeRange.start >= match.end) {
          break;
        }
        const local = rangeForMatch(match, nodeRange);
        if (!local) {
          continue;
        }
        const list = byNode.get(nodeRange.node) || [];
        list.push(local);
        byNode.set(nodeRange.node, list);
      }
    }
    for (const [node, nodeRanges] of byNode.entries()) {
      if (node.isConnected && node.parentNode) {
        wrapTextNode(node, nodeRanges);
      }
    }
  }

  async function fetchMatches(text) {
    const data = await apiJson(`/reference/scan?db=${encodeURIComponent(DEFAULT_DB)}`, {
      method: "POST",
      body: { text, limit: MAX_MATCHES },
    });
    return Array.isArray(data.matches) ? data.matches : [];
  }

  async function scanPage() {
    if (isMedosAppPage()) {
      removeExistingMarks();
      if (observer) {
        observer.disconnect();
      }
      return;
    }

    removeExistingMarks();

    if (!underlinesEnabled) {
      return;
    }

    if (scanInFlight) {
      scheduleScan(RESCAN_DELAY_MS);
      return;
    }
    const token = ++scanToken;
    scanInFlight = true;
    if (observer) {
      observer.disconnect();
    }
    try {
      const nodes = collectTextNodes(document.body);
      const { text, ranges } = buildScanText(nodes);
      if (!text.trim()) {
        return;
      }
      const matches = await fetchMatches(text);
      if (token !== scanToken) {
        return;
      }
      wrapMatches(matches, ranges);
    } catch (error) {
      console.debug("[MedOS] reference scan skipped", error);
    } finally {
      scanInFlight = false;
      startObserver();
    }
  }

  function scheduleScan(delay = RESCAN_DELAY_MS) {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanPage, delay);
  }

  function startObserver() {
    if (!document.body) {
      return;
    }
    if (isMedosAppPage()) {
      return;
    }
    if (observer) {
      observer.disconnect();
    }
    observer = new MutationObserver((mutations) => {
      if (mutations.every(isExtensionMutation)) {
        return;
      }
      scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function isExtensionNode(node) {
    if (!node) {
      return false;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return Boolean(node.parentElement && node.parentElement.closest(".medos-ext-ref, .medos-ext-tooltip, .medos-ext-lightbox"));
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    return Boolean(node.matches(".medos-ext-ref, .medos-ext-tooltip, .medos-ext-lightbox") || node.closest(".medos-ext-ref, .medos-ext-tooltip, .medos-ext-lightbox"));
  }

  function isExtensionMutation(mutation) {
    if (isExtensionNode(mutation.target)) {
      return true;
    }
    const changed = [...mutation.addedNodes, ...mutation.removedNodes];
    return changed.length > 0 && changed.every(isExtensionNode);
  }

  // ── Side panel bridge ─────────────────────────────────────────────────────
  function openReferencePayload(payload) {
    chrome.runtime.sendMessage({ type: "MEDOS_OPEN_REFERENCE", payload }).catch(() => {});
  }

  function openReference(target) {
    openReferencePayload({
      term: target.dataset.medosTerm || target.textContent || "",
      source: target.dataset.medosSource || "reference",
      kind: target.dataset.medosKind || "",
      db: DEFAULT_DB,
      pageUrl: location.href,
      pageTitle: document.title,
    });
  }

  function openMatchInPanel(match) {
    openReferencePayload({
      term: match.title || (tooltipData && tooltipData.term) || "",
      source: match.source || "reference",
      kind: match.kind || "",
      href: match.href || "",
      db: DEFAULT_DB,
      pageUrl: location.href,
      pageTitle: document.title,
    });
  }

  function tooltipPayloadFromTarget(target) {
    return {
      term: target.dataset.medosTerm || target.textContent || "",
      source: target.dataset.medosSource || "reference",
      kind: target.dataset.medosKind || "",
      db: DEFAULT_DB,
      pageUrl: location.href,
      pageTitle: document.title,
    };
  }

  // ── Drug card + card body renderers (mirror AmbossHtml) ───────────────────
  function renderDrugCard(data) {
    const card = data && data.drug_card;
    if (!card) {
      return data && data.html ? `<div class="medos-ext-tooltip-html">${stripHtmlImages(data.html)}</div>` : "";
    }
    const uses = Array.isArray(card.common_uses) ? card.common_uses.filter(Boolean).slice(0, 5) : [];
    return `
      <div class="medos-ext-tooltip-html">
        <div class="medos-drug-card">
          ${card.drug_class ? `<section class="medos-drug-row medos-drug-class"><span class="medos-drug-label">Class:</span><strong>${escapeHtml(card.drug_class)}</strong></section>` : ""}
          ${card.adult_dose ? `<section class="medos-drug-row medos-drug-dose"><span class="medos-drug-label">Adult dose:</span><p>${escapeHtml(card.adult_dose)}</p></section>` : ""}
          ${uses.length ? `<section class="medos-drug-row medos-drug-uses"><span class="medos-drug-label">Common uses:</span><ul>${uses.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : ""}
          ${card.has_black_box || card.black_box ? `<section class="medos-drug-row medos-drug-warning"><span class="medos-drug-label">Black box:</span><p>${escapeHtml(card.black_box || "Black-box warning present in the local drug reference database.")}</p></section>` : ""}
        </div>
      </div>
    `;
  }

  // Backend HTML (exhibit tables) can carry <img src="/qbank/media/..."> which
  // would re-trigger the local-network prompt if loaded from the page. Strip
  // them; the media[] thumbnails (proxied as data URLs) carry the images instead.
  function stripHtmlImages(html) {
    return String(html || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<img\b[^>]*>/gi, "");
  }

  function renderCardHtml(data) {
    const isDrug = isDrugTooltipData(data);
    const source = isDrug ? "drug" : normalizeSource(data.source || "amboss");
    const actions = visibleActionMatches(data);
    const questionAction = actions.find(isQuestionMatch);
    const secondary = actions.filter((m) => !isQuestionMatch(m)).slice(0, MAX_SECONDARY_ACTIONS);
    const media = Array.isArray(data.media) ? data.media.slice(0, 3) : [];
    const icd = Array.isArray(data.icd10cm_codes) ? data.icd10cm_codes.slice(0, 5) : [];
    const expansions = Array.isArray(data.expansions) ? data.expansions.filter(Boolean) : [];

    return `
      ${questionAction ? `<button type="button" class="medos-ext-tooltip-q-corner" data-medos-action="q" title="${escapeHtml(questionAction.title || "Question")}">Q</button>` : ""}
      <div class="medos-ext-tooltip-body">
        <div class="medos-ext-tooltip-brand medos-ext-tooltip-brand-${escapeHtml(source)}">${escapeHtml(tooltipBrand(data))}</div>
        <strong class="medos-ext-tooltip-title${isDrug ? " medos-ext-tooltip-title-drug" : ""}">${escapeHtml(data.title || (data.matches && data.matches[0] && data.matches[0].title) || data.term || "")}</strong>
        ${icd.length ? `<div class="medos-ext-tooltip-icd">${icd.map((c) => `<span title="${escapeHtml(c.term || "ICD-10-CM")}">ICD ${escapeHtml(c.code)}</span>`).join("")}</div>` : ""}
        ${expansions.length ? `<em class="medos-ext-tooltip-exp">Abbreviation for: ${escapeHtml(expansions.join(", "))}</em>` : ""}
        ${data.abstract && !isDrug ? `<p class="medos-ext-tooltip-abstract">${escapeHtml(data.abstract)}</p>` : ""}
        ${isDrug ? renderDrugCard(data) : (data.html ? `<div class="medos-ext-tooltip-html">${stripHtmlImages(data.html)}</div>` : "")}
        ${media.length ? `<div class="medos-ext-tooltip-media" data-count="${Math.min(media.length, 3)}">${media.map((item, i) => `
          <button type="button" class="medos-ext-tooltip-thumb" data-medos-media-index="${i}" aria-label="${escapeHtml(item.title || data.title || data.term || "Image")}"><span class="medos-ext-thumb-ph"></span></button>
        `).join("")}</div>` : ""}
      </div>
      ${secondary.length ? `<div class="medos-ext-tooltip-actions">${secondary.map((match, i) => `
        <button type="button" class="medos-ext-tooltip-action medos-ext-tooltip-action-${escapeHtml(actionSource(match))}" data-medos-action-index="${i}" title="${escapeHtml(match.title || "")}">
          <span class="medos-ext-tooltip-badge medos-ext-tooltip-badge-${escapeHtml(actionSource(match))}">${escapeHtml(actionBadge(match))}</span>
          <span class="medos-ext-tooltip-action-title">${escapeHtml(actionLabel(match))}</span>
          <span class="medos-ext-tooltip-action-ext">↗</span>
        </button>
      `).join("")}</div>` : ""}
    `;
  }

  // ── Tooltip element lifecycle ─────────────────────────────────────────────
  function ensureTooltip() {
    if (tooltipEl && tooltipEl.isConnected) {
      return tooltipEl;
    }
    tooltipEl = document.createElement("div");
    tooltipEl.className = "medos-ext-tooltip";
    tooltipEl.addEventListener("mouseenter", () => clearTimeout(tooltipHideTimer));
    tooltipEl.addEventListener("mouseleave", () => hideTooltip());
    tooltipEl.addEventListener("wheel", (event) => {
      // Keep scroll inside the card; allow horizontal scroll of wide tables.
      event.stopPropagation();
      const box = event.target && event.target.closest && event.target.closest(".medos-ext-tooltip-html");
      if (box && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        box.scrollLeft += event.deltaX;
        event.preventDefault();
        return;
      }
      tooltipEl.scrollTop += event.deltaY;
      event.preventDefault();
    }, { passive: false });
    tooltipEl.addEventListener("click", onTooltipClick);
    document.documentElement.appendChild(tooltipEl);
    return tooltipEl;
  }

  function onTooltipClick(event) {
    const data = tooltipData;
    if (!data) return;
    event.preventDefault();
    event.stopPropagation();

    const qBtn = event.target.closest && event.target.closest("[data-medos-action='q']");
    if (qBtn) {
      const q = visibleActionMatches(data).find(isQuestionMatch);
      if (q) openMatchInPanel(q);
      hideTooltip(true);
      return;
    }
    const actionBtn = event.target.closest && event.target.closest("[data-medos-action-index]");
    if (actionBtn) {
      const secondary = visibleActionMatches(data).filter((m) => !isQuestionMatch(m));
      const match = secondary[Number(actionBtn.dataset.medosActionIndex)];
      if (match) openMatchInPanel(match);
      hideTooltip(true);
      return;
    }
    const thumb = event.target.closest && event.target.closest("[data-medos-media-index]");
    if (thumb) {
      const item = (data.media || [])[Number(thumb.dataset.medosMediaIndex)];
      if (item) openLightbox(item.url, item.title || data.title || data.term || "Image");
      return;
    }
    // Click anywhere else on the card → open the primary source in the side panel.
    const primary = (data.matches || []).find((m) => isPrimaryMatch(m, data)) || (data.matches || []).find((m) => !isQuestionMatch(m));
    if (primary) openMatchInPanel(primary);
    else if (tooltipTarget && tooltipTarget.isConnected) openReference(tooltipTarget);
    hideTooltip(true);
  }

  function positionTooltip(target, point) {
    if (!tooltipEl || !tooltipData) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const metrics = tooltipMetrics(tooltipData);
    tooltipEl.style.width = `${metrics.width}px`;
    tooltipEl.style.maxHeight = `${metrics.maxHeight}px`;
    const anchorX = point ? point.x : rect.left;
    const anchorY = point ? point.y : rect.bottom;
    const pos = tooltipPosition(anchorX, anchorY, metrics);
    tooltipEl.dataset.layout = metrics.layout;
    tooltipEl.classList.toggle("medos-ext-tooltip-above", pos.placement === "above");
    tooltipEl.classList.toggle("medos-ext-tooltip-below", pos.placement === "below");
    tooltipEl.style.left = `${pos.x}px`;
    tooltipEl.style.top = `${pos.y}px`;
  }

  async function loadTooltip(payload) {
    const key = `${payload.source || "amboss"}::${payload.term.trim().toLowerCase()}`;
    if (tooltipCache.has(key)) {
      return tooltipCache.get(key);
    }
    const params = new URLSearchParams({
      term: payload.term,
      db: DEFAULT_DB,
      source: payload.source || "amboss",
      limit: "12",
    });
    const data = await apiJson(`/reference/tooltip?${params.toString()}`);
    if (data) tooltipCache.set(key, data);
    return data;
  }

  function renderTooltipLoading(target, payload, point) {
    tooltipData = { term: payload.term, source: payload.source, matches: [] };
    const el = ensureTooltip();
    el.innerHTML = `
      <div class="medos-ext-tooltip-body">
        <div class="medos-ext-tooltip-brand medos-ext-tooltip-brand-${escapeHtml(normalizeSource(payload.source))}">${escapeHtml(tooltipBrand({ source: payload.source }))}</div>
        <strong class="medos-ext-tooltip-title">${escapeHtml(payload.term)}</strong>
        <p class="medos-ext-tooltip-abstract medos-ext-tooltip-loading">Loading MedOS reference…</p>
      </div>
    `;
    positionTooltip(target, point);
  }

  function renderTooltip(target, payload, data, point) {
    tooltipData = data;
    const el = ensureTooltip();
    el.innerHTML = renderCardHtml(data);
    positionTooltip(target, point);
    hydrateTooltipMedia(el, target, point);
  }

  // Media thumbnails cannot point straight at 127.0.0.1 (an <img> load from a
  // page is another local-network request → same Chrome prompt). The service
  // worker fetches the bytes and hands back a data: URL instead.
  function hydrateTooltipMedia(el, target, point) {
    const thumbs = el.querySelectorAll("[data-medos-media-index]");
    const media = (tooltipData && tooltipData.media) || [];
    thumbs.forEach((thumb) => {
      const item = media[Number(thumb.dataset.medosMediaIndex)];
      if (!item) return;
      apiImageDataUrl(item.url).then((dataUrl) => {
        if (!thumb.isConnected) return;
        if (!dataUrl) {
          thumb.remove();
          if (!el.querySelector(".medos-ext-tooltip-thumb")) {
            const strip = el.querySelector(".medos-ext-tooltip-media");
            if (strip) strip.remove();
          }
          return;
        }
        const img = document.createElement("img");
        img.alt = item.title || "";
        img.addEventListener("load", () => {
          if (tooltipTarget === target && target.isConnected) positionTooltip(target, point);
        }, { once: true });
        img.src = dataUrl;
        thumb.innerHTML = "";
        thumb.appendChild(img);
      });
    });
  }

  function showTooltip(target, point) {
    clearTimeout(tooltipHideTimer);
    clearTimeout(tooltipShowTimer);
    // Same term already shown — just reposition.
    if (tooltipTarget === target && tooltipData && tooltipEl && tooltipEl.isConnected) {
      positionTooltip(target, point);
      return;
    }
    tooltipTarget = target;
    tooltipShowTimer = window.setTimeout(async () => {
      if (!tooltipTarget || tooltipTarget !== target || !target.isConnected) {
        return;
      }
      const payload = tooltipPayloadFromTarget(target);
      renderTooltipLoading(target, payload, point);
      try {
        const data = await loadTooltip(payload);
        if (tooltipTarget !== target || !target.isConnected) return;
        if (data && (data.matches?.length || data.abstract || data.title || data.media?.length || data.html)) {
          renderTooltip(target, payload, data, point);
        } else {
          const el = ensureTooltip();
          el.innerHTML = `
            <div class="medos-ext-tooltip-body">
              <div class="medos-ext-tooltip-brand medos-ext-tooltip-brand-${escapeHtml(normalizeSource(payload.source))}">${escapeHtml(tooltipBrand({ source: payload.source }))}</div>
              <strong class="medos-ext-tooltip-title">${escapeHtml(payload.term)}</strong>
              <p class="medos-ext-tooltip-abstract">No MedOS reference found.</p>
            </div>
          `;
          positionTooltip(target, point);
        }
      } catch (_error) {
        if (tooltipTarget !== target) return;
        const el = ensureTooltip();
        el.innerHTML = `
          <div class="medos-ext-tooltip-body">
            <div class="medos-ext-tooltip-brand medos-ext-tooltip-brand-${escapeHtml(normalizeSource(payload.source))}">${escapeHtml(tooltipBrand({ source: payload.source }))}</div>
            <strong class="medos-ext-tooltip-title">${escapeHtml(payload.term)}</strong>
            <p class="medos-ext-tooltip-abstract">MedOS reference is not available.</p>
          </div>
        `;
        positionTooltip(target, point);
      }
    }, point && point.immediate ? 0 : HOVER_OPEN_DELAY_MS);
  }

  function hideTooltip(immediate = false) {
    clearTimeout(tooltipShowTimer);
    clearTimeout(tooltipHideTimer);
    const remove = () => {
      tooltipTarget = null;
      tooltipData = null;
      if (tooltipEl) {
        tooltipEl.remove();
      }
    };
    if (immediate) {
      remove();
      return;
    }
    tooltipHideTimer = window.setTimeout(remove, HOVER_CLOSE_DELAY_MS);
  }

  // ── In-page image lightbox (mirrors app image overlay) ────────────────────
  function openLightbox(url, title) {
    closeLightbox();
    lightboxEl = document.createElement("div");
    lightboxEl.className = "medos-ext-lightbox";
    lightboxEl.innerHTML = `
      <div class="medos-ext-lightbox-panel">
        <div class="medos-ext-lightbox-head">
          <strong>${escapeHtml(title || "Image")}</strong>
          <button type="button" class="medos-ext-lightbox-close" aria-label="Close">✕</button>
        </div>
        <div class="medos-ext-lightbox-stage"><span class="medos-ext-lightbox-loading">Loading…</span></div>
      </div>
    `;
    lightboxEl.addEventListener("click", (event) => {
      if (event.target === lightboxEl || event.target.closest(".medos-ext-lightbox-close")) {
        closeLightbox();
      }
    });
    document.documentElement.appendChild(lightboxEl);
    apiImageDataUrl(url).then((dataUrl) => {
      if (!lightboxEl) return;
      const stage = lightboxEl.querySelector(".medos-ext-lightbox-stage");
      if (!stage) return;
      if (!dataUrl) {
        stage.innerHTML = `<span class="medos-ext-lightbox-loading">Image unavailable</span>`;
        return;
      }
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = title || "";
      stage.innerHTML = "";
      stage.appendChild(img);
    });
  }

  function closeLightbox() {
    if (lightboxEl) {
      lightboxEl.remove();
      lightboxEl = null;
    }
  }

  // ── Text selection → side panel search box ────────────────────────────────
  function selectedText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return "";
    }
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > 140) {
      return "";
    }
    return text;
  }

  function sendSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => {
      const term = selectedText();
      if (!term || term === lastSelectionText) {
        return;
      }
      lastSelectionText = term;
      chrome.runtime.sendMessage({
        type: "MEDOS_SELECTION_CHANGED",
        payload: {
          term,
          source: "amboss",
          db: DEFAULT_DB,
          pageUrl: location.href,
          pageTitle: document.title,
        },
      }).catch(() => {});
    }, 180);
  }

  // ── Event wiring ──────────────────────────────────────────────────────────
  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest && event.target.closest(".medos-ext-ref");
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openReference(target);
  }, true);

  document.addEventListener("mouseover", (event) => {
    if (!underlinesEnabled) return;
    const target = event.target && event.target.closest && event.target.closest(".medos-ext-ref");
    if (target) {
      showTooltip(target, { x: event.clientX, y: event.clientY });
    }
  }, true);

  document.addEventListener("mouseout", (event) => {
    const target = event.target && event.target.closest && event.target.closest(".medos-ext-ref");
    if (!target) {
      return;
    }
    const next = event.relatedTarget;
    if (next && next.closest && next.closest(".medos-ext-tooltip")) {
      return;
    }
    hideTooltip();
  }, true);

  document.addEventListener("mouseup", sendSelection, true);
  document.addEventListener("keyup", sendSelection, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideTooltip(true);
      closeLightbox();
    }
  }, true);
  window.addEventListener("scroll", () => hideTooltip(true), true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "MEDOS_RESCAN_PAGE") {
      scheduleScan(50);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(UNDERLINES_STORAGE_KEY in changes)) return;
    underlinesEnabled = changes[UNDERLINES_STORAGE_KEY].newValue !== "off";
    clearTimeout(scanTimer);
    scanPage();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scheduleScan(150), { once: true });
  } else {
    scheduleScan(150);
  }
})();
