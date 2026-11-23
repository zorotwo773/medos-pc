"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink } from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import { useDarkMode } from "@/components/common/useDarkMode";
import { type ReferenceMode, useReferenceLayerMode } from "@/components/common/useReferenceLayerEnabled";
import MediaViewer from "@/components/common/MediaViewer";
import type { MediaDescriptor } from "@/lib/mediaInterop";

// Any Q-bank key (UWorld step1/2/3 or NBME/CMS form keys); forwarded verbatim to backend URLs.
type QBankDb = string;
type HoverSource = "amboss" | "qbank" | "utd" | "cliniccons" | "drug" | "firstaid" | "umls" | "uworld" | "books" | "diseases" | "sanford" | "utdddx";

interface TooltipMatch {
  id: number;
  title: string;
  href: string;
  source: string;
  kind?: string;
}

interface TooltipData {
  term: string;
  title?: string;
  source?: HoverSource;
  kind?: string;
  expansions?: string[];
  matches: TooltipMatch[];
  abstract?: string;
  cui?: string;
  icd10cm_codes?: Array<{ code: string; term?: string }>;
  media?: Array<{ title?: string; url: string }>;
  html?: string;
  drug_card?: {
    drug_class?: string;
    adult_dose?: string;
    common_uses?: string[];
    black_box?: string;
    has_black_box?: boolean;
  };
}

interface ScanMatch {
  start: number;
  end: number;
  term: string;
  source?: HoverSource;
  kind?: string;
  /** Present when the match came from the precomputed doc-terms list. */
  cui?: string;
  semanticGroup?: string;
}

/** One precomputed concept for a document, from GET /reference/doc-terms. */
interface DocTerm {
  term: string;
  cui?: string;
  semantic_group?: string;
  hit_count?: number;
}

interface TextNodeRange {
  node: Text;
  start: number;
  end: number;
}

const tooltipCache = new Map<string, TooltipData>();
const emptyTooltipCache = new Set<string>();
const tooltipInflight = new Map<string, Promise<TooltipData | null>>();
const relatedTooltipInflight = new Map<string, Promise<TooltipData>>();
const scanCache = new Map<string, ScanMatch[]>();
const scanInflight = new Map<string, Promise<ScanMatch[]>>();
const docTermsCache = new Map<string, DocTerm[]>();
const docTermsInflight = new Map<string, Promise<DocTerm[]>>();
const conceptCardCache = new Map<string, TooltipData | null>();
const conceptCardInflight = new Map<string, Promise<TooltipData | null>>();
const warmedTooltipKeys = new Set<string>();

// Doc-term matches resolve their hover card through the generic (source-agnostic)
// reference resolver, so they get the same rich cross-source card as today's
// AMBOSS matches. Underline colour is overridden per semantic group via a data
// attribute (see globals.css).
const DOC_TERM_SOURCE: HoverSource = "amboss";
const TOOLTIP_CACHE_VERSION = "smart-cards-v7";
const SCAN_CACHE_VERSION = "reference-scan-v2";
const MAX_SCAN_CACHE = 128;
const TOOLTIP_MARGIN = 12;
const TOOLTIP_DEFAULT_WIDTH = 360;
const TOOLTIP_MIN_WIDTH = 300;
const TOOLTIP_MAX_WIDTH = 660;
const TOOLTIP_DEFAULT_MAX_HEIGHT = 520;
const MAX_SECONDARY_ACTIONS = 6;

type TooltipPlacement = "above" | "below";
type TooltipLayout = "compact" | "article" | "media" | "exhibit";
type TooltipMetrics = { width: number; maxHeight: number; layout: TooltipLayout };
type TooltipState = TooltipMetrics & { data: TooltipData; x: number; y: number; placement: TooltipPlacement };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function plainHtmlLength(html?: string) {
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

function htmlTableStats(html?: string) {
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

function withThemeParam(value: string, theme: "light" | "dark") {
  if (!value || /^(?:data:|blob:)/i.test(value)) return value;
  const hashIndex = value.indexOf("#");
  const base = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}theme=${theme}${hash}`;
}

function themedFrameUrl(value: string, theme: "light" | "dark") {
  return /\/(?:qbank\/exhibit\/|cliniccons\/(?:algorithm|disease)\/|amboss\/article\/|utd\/topic\/)/i.test(value)
    ? withThemeParam(value, theme)
    : value;
}

function mediaSourceLabel(source?: string) {
  const labels: Record<string, string> = {
    amboss: "AMBOSS",
    qbank: "UWorld",
    utd: "UpToDate",
    uworld: "UWorld",
    sanford: "Sanford",
    cliniccons: "Clinic Consult",
    drug: "Drug Reference",
    firstaid: "First Aid",
  };
  return labels[source || ""] || "MedOS";
}

function tooltipMetrics(data: TooltipData): TooltipMetrics {
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const maxAvailableWidth = Math.max(TOOLTIP_MIN_WIDTH, viewportWidth - TOOLTIP_MARGIN * 2);
  const maxAvailableHeight = Math.max(360, viewportHeight - TOOLTIP_MARGIN * 2);
  const stats = htmlTableStats(data.html);
  const mediaCount = data.media?.length || 0;
  const matchCount = data.matches?.length || 0;
  let layout: TooltipLayout = "compact";
  let width = TOOLTIP_DEFAULT_WIDTH;
  let maxHeight = TOOLTIP_DEFAULT_MAX_HEIGHT;

  if (data.html) {
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

function tooltipPosition(anchorX: number, anchorY: number, metrics: TooltipMetrics) {
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
  const placement: TooltipPlacement = below + maxHeight <= window.innerHeight - TOOLTIP_MARGIN ? "below" : "above";
  const y = placement === "below" ? below : Math.max(TOOLTIP_MARGIN, anchorY - 8);
  return { x, y, placement };
}

function isTouchPointer(event: React.PointerEvent<HTMLElement>) {
  return event.pointerType === "touch";
}

function tooltipCacheKey(source: string, term: string) {
  return `${TOOLTIP_CACHE_VERSION}:${source}:${term.trim().toLowerCase()}`;
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function scanCacheKey(db: QBankDb, text: string) {
  return `${SCAN_CACHE_VERSION}:${db}:${text.length}:${hashText(text)}`;
}

function referenceDb(db: QBankDb): "step1" | "step2" | "step3" {
  const key = String(db || "").toLowerCase();
  const match = /(?:^|[^a-z])(?:step|amboss)([123])(?:$|[^0-9])/.exec(key) || /(?:^|[^0-9])([123])(?:$|[^0-9])/.exec(key);
  return match?.[1] === "1" ? "step1" : match?.[1] === "3" ? "step3" : "step2";
}

function rememberScan(key: string, matches: ScanMatch[]) {
  if (scanCache.size >= MAX_SCAN_CACHE) {
    const first = scanCache.keys().next().value;
    if (first) scanCache.delete(first);
  }
  scanCache.set(key, matches);
}

async function fetchJsonWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function loadScanMatches(db: QBankDb, text: string): Promise<ScanMatch[]> {
  const key = scanCacheKey(db, text);
  const cached = scanCache.get(key);
  if (cached) return cached;
  const pending = scanInflight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const base = getBackendUrl();
    const body = JSON.stringify({ text, limit: 250 });
    const scanData = await fetchJsonWithTimeout(
      `${base}/reference/scan?db=${referenceDb(db)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      8000
    ) as { matches?: ScanMatch[] };
    const matches = (scanData?.matches || []).sort((a, b) => (
      ((b.end - b.start) - (a.end - a.start)) ||
      scanPriority(a) - scanPriority(b) ||
      a.start - b.start
    ));
    // Don't cache an empty result: a cold backend (reference index still warming
    // right after launch) returns no matches, and caching that would leave the
    // first questions of a freshly-started block permanently un-underlined until a
    // full reload. Re-scan next time so it self-heals once the index is warm.
    if (matches.length) rememberScan(key, matches);
    return matches;
  })().finally(() => {
    scanInflight.delete(key);
  });
  scanInflight.set(key, request);
  return request;
}

async function fetchDocTerms(source: string, sourceId: string): Promise<DocTerm[]> {
  const key = `${source}::${sourceId}`;
  const cached = docTermsCache.get(key);
  if (cached) return cached;
  const pending = docTermsInflight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const base = getBackendUrl();
    const url = `${base}/reference/doc-terms?source=${encodeURIComponent(source)}&id=${encodeURIComponent(sourceId)}`;
    const data = (await fetchJsonWithTimeout(url, { method: "GET" }, 4000)) as { terms?: DocTerm[] };
    const terms = Array.isArray(data?.terms) ? data.terms : [];
    // Skip caching an empty list so a cold-start (index still warming) miss can be
    // retried, rather than leaving a freshly-opened doc permanently un-tagged.
    if (terms.length) docTermsCache.set(key, terms);
    return terms;
  })().finally(() => {
    docTermsInflight.delete(key);
  });
  docTermsInflight.set(key, request);
  return request;
}

/** Warm the doc-terms cache for an upcoming document (e.g. the NEXT q-bank
 *  question) while the user is still reading the current one, so its underlines —
 *  and therefore its hover boxes — apply the instant they navigate instead of
 *  after a network round-trip. Safe to call repeatedly: fetchDocTerms dedupes
 *  in-flight requests and caches non-empty results. */
export function prefetchDocTerms(source: string, sourceId: string): void {
  if (!source || !sourceId) return;
  void fetchDocTerms(source, sourceId).catch(() => {});
}

/** Centralized hover card for a resolved concept (by CUI). Reads the UMLS hub so
 *  EVERY database that mentions the concept is offered — not just whatever the old
 *  AMBOSS-biased entity graph stored. Match sources are preserved (never forced to
 *  amboss) so the card can badge UWorld library / books / diseases distinctly. */
async function fetchConceptCard(cui: string, db: QBankDb): Promise<TooltipData | null> {
  const key = `${TOOLTIP_CACHE_VERSION}:cui:${cui}:${db}`;
  if (conceptCardCache.has(key)) return conceptCardCache.get(key)!;
  const pending = conceptCardInflight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const base = getBackendUrl();
    const url = `${base}/reference/concept-card?cui=${encodeURIComponent(cui)}&db=${referenceDb(db)}&limit=8`;
    const raw = (await fetchJsonWithTimeout(url, { method: "GET" }, 1000)) as TooltipData | null;
    if (!raw) return null;
    const data: TooltipData | null = hasTooltipPayload(raw)
      ? { ...raw, matches: (raw.matches || []).map(m => ({ ...m, source: m.source || "umls" })) }
      : null;
    conceptCardCache.set(key, data);
    return data;
  })().finally(() => {
    conceptCardInflight.delete(key);
  });
  conceptCardInflight.set(key, request);
  return request;
}

function buildTermMatcher(term: string): RegExp | null {
  const tokens = term
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) return null;
  const body = tokens.join("[\\s\\-]+");
  // Unicode-aware word boundaries (handles hyphens / punctuation around terms).
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "giu");
  } catch {
    try {
      return new RegExp(`\\b(?:${body})\\b`, "gi");
    } catch {
      return null;
    }
  }
}

/** Find every occurrence of the document's ~dozen precomputed terms in `text`.
 *  Bounded and local — replaces the whole-article scan round-trip for the FIND
 *  step. Offsets are relative to collectTextNodes(root).text, like /reference/scan. */
function matchDocTermsInText(text: string, terms: DocTerm[]): ScanMatch[] {
  if (!text || !terms.length) return [];
  const out: ScanMatch[] = [];
  for (const entry of terms) {
    const term = (entry.term || "").trim();
    if (term.length < 3) continue;
    const re = buildTermMatcher(term);
    if (!re) continue;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 250) {
      const start = m.index;
      const end = start + m[0].length;
      if (end > start) {
        out.push({
          start,
          end,
          term,
          source: DOC_TERM_SOURCE,
          kind: entry.semantic_group || "concept",
          cui: entry.cui || undefined,
          semanticGroup: (entry.semantic_group || "").toLowerCase() || undefined,
        });
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

function scanPriority(match: ScanMatch) {
  if (match.source === "drug") return 0;
  if (match.source === "qbank" && match.kind === "exhibit") return 1;
  if (match.source === "amboss") return 2;
  if (match.source === "firstaid") return 3;
  if (match.source === "qbank" && match.kind === "image") return 4;
  if (match.source === "qbank") return 4;
  if (match.source === "cliniccons") return 5;
  if (match.source === "utd") return 6;
  if (match.source === "umls") return 7;
  return 9;
}

function matchPriority(match: TooltipMatch, primary?: TooltipData) {
  if (match.source === "sanford" || match.href?.startsWith("/sanford")) return -1;
  if (match.source === "drug" || match.kind === "drug" || match.href?.startsWith("/drugs")) return 0;
  if (primary?.source === "qbank" && primary.kind === "exhibit") {
    if (match.source === "drug") return 0;
    if (match.source === "qbank" && match.kind === "exhibit") return 1;
    if (match.source === "qbank" && match.kind === "question") return 1;
    if (match.source === "amboss") return 2;
    if (match.source === "firstaid") return 3;
    if (match.source === "qbank" && match.kind === "image") return 4;
    if (match.source === "cliniccons") return 5;
    if (match.source === "utdddx") return 6;
    if (match.source === "utd" && match.kind === "topic") return 6;
    if (match.source === "utd") return 7;
    if (match.source === "umls") return 8;
    return 9;
  }
  if (primary?.source === "qbank" && primary.kind === "image") {
    if (match.source === "drug") return 0;
    if (match.source === "qbank" && match.kind === "question") return 1;
    if (match.source === "qbank" && match.kind === "image") return 1;
    if (match.source === "amboss") return 2;
    if (match.source === "firstaid") return 3;
    if (match.source === "cliniccons") return 4;
    if (match.source === "utdddx") return 5;
    if (match.source === "utd" && match.kind === "topic") return 5;
    if (match.source === "utd") return 6;
    if (match.source === "umls") return 7;
    return 9;
  }
  if (match.source === "sanford" || match.href?.startsWith("/sanford")) return -1;
  if (match.source === "drug") return 0;
  if (match.source === "qbank" && match.kind === "exhibit") return 1;
  if (match.source === "amboss") return 2;
  if (match.source === "firstaid") return 3;
  if (match.source === "qbank" && match.kind === "question") return 4;
  if (match.source === "qbank" && match.kind === "image") return 5;
  if (match.source === "cliniccons") return 6;
  if (match.source === "utdddx") return 7;
  if (match.source === "utd" && match.kind === "topic") return 7;
  if (match.source === "utd") return 8;
  if (match.source === "umls") return 9;
  return 9;
}

// Compact 2-letter, colour-coded source badges — the hover box is small, so the
// source is shown as a coloured chip (see .medos-tooltip-action-* in globals.css)
// rather than a long word. The article title carries the meaning.
function actionBadge(match: TooltipMatch) {
  if (match.source === "sanford" || match.href?.startsWith("/sanford")) return "SG";
  if (match.source === "utdddx" || match.href?.startsWith("/utdddx")) return "DX";
  if (match.source === "drug" || match.kind === "drug" || match.href?.startsWith("/drugs")) return "Rx";
  if (match.source === "firstaid" || match.href?.startsWith("#firstaid-")) return "FA";
  if (match.source === "qbank" && match.kind === "question") return "Q";
  if (match.source === "qbank") return "UW";        // UWorld Q-bank (exhibit / image)
  if (match.source === "uworld") return "UL";       // UWorld Library
  if (match.source === "utd") return "UT";
  if (match.source === "diseases") return "Dx";
  if (match.source === "books") return "Bk";
  if (match.source === "cliniccons") return "CC";
  if (match.source === "umls") return "UM";
  if (match.source === "amboss") return "AB";
  return "Lk";
}

function actionLabel(match: TooltipMatch, primary?: TooltipData) {
  if (match.source === "sanford" || match.href?.startsWith("/sanford")) return match.title || "Sanford Guide";
  if (match.source === "utdddx" || match.href?.startsWith("/utdddx")) return match.title || "UpToDate DDx";
  if (match.source === "drug" || match.kind === "drug" || match.href?.startsWith("/drugs")) return match.title || "Drug reference";
  if (match.source === "firstaid" || match.href?.startsWith("#firstaid-")) return match.title || "First Aid";
  if (match.source === "qbank") {
    if (match.kind === "question") return match.title.replace(/^Open source question\s*/i, "");
    if (match.kind === "image") return "Image";
    return primary?.kind === "exhibit" ? "Exhibit" : match.title;
  }
  if (match.source === "amboss") return match.title;
  if (match.source === "utd") {
    if (match.kind === "topic") return match.title.replace(/^Open UpToDate topic$/i, "Topic");
    return match.title.replace(/^Open UpToDate graphic$/i, "Graphic");
  }
  if (match.source === "cliniccons") {
    if (match.kind === "image") return "Algorithm image";
    if (match.kind === "disease") return match.title;
    return match.title;
  }
  if (match.source === "umls") return match.title || "UMLS concept";
  if (match.source === "drug") return match.title || "Drug reference";
  return match.title;
}

function isQuestionMatch(match: TooltipMatch) {
  return match.source === "qbank" && match.kind === "question";
}

function isPrimaryMatch(match: TooltipMatch, primary: TooltipData) {
  if (primary.source === "qbank" && primary.kind === match.kind && match.source === "qbank") return true;
  if (primary.source === "amboss" && match.source === "amboss") return true;
  if (primary.source === "utd" && primary.kind === match.kind && match.source === "utd") return true;
  if (primary.source === "cliniccons" && primary.kind === match.kind && match.source === "cliniccons") return true;
  if (primary.source === "firstaid" && match.source === "firstaid") return true;
  if (primary.source === "umls" && match.source === "umls") return true;
  if (isDrugTooltipData(primary) && (match.source === "drug" || match.kind === "drug" || match.href?.startsWith("/drugs"))) return true;
  return false;
}

function actionSource(match: TooltipMatch) {
  if (match.source === "drug" || match.kind === "drug" || match.href?.startsWith("/drugs")) return "drug";
  if (match.source === "firstaid" || match.href?.startsWith("#firstaid-")) return "firstaid";
  if (match.source === "umls") return "umls";
  if (match.source === "extension") return "amboss";
  return match.source || "amboss";
}

function openRoute(match: TooltipMatch) {
  const href = match.href || "";
  if (!href) return;
  if (href.startsWith("/")) {
    window.dispatchEvent(new CustomEvent("TabBar:open", {
      detail: {
        href,
        title: match.title,
      },
    }));
    return;
  }
  try {
    const url = new URL(href);
    if (url.origin === window.location.origin) {
      window.dispatchEvent(new CustomEvent("TabBar:open", {
        detail: {
          href: `${url.pathname}${url.search}${url.hash}`,
          title: match.title,
        },
      }));
      return;
    }
  } catch {
    /* fall through to the browser for non-route values */
  }
  const url = href;
  window.open(url, "_blank", "noopener,noreferrer");
}

function dispatchFirstAid(match: TooltipMatch, query?: string) {
  const raw = `${match.href || ""} ${match.id || ""}`;
  const headingId = Number(raw.match(/firstaid-(\d+)/)?.[1] || raw.match(/heading_id=(\d+)/)?.[1] || match.id);
  if (!Number.isFinite(headingId) || headingId <= 0) return false;
  window.dispatchEvent(new CustomEvent("medos:open-firstaid", { detail: { heading_id: headingId, query: query || match.title } }));
  return true;
}

function DrugTooltipCard({ data }: { data: TooltipData }) {
  const card = data.drug_card;
  if (!card) {
    return data.html ? (
      <div className="medos-drug-tooltip-card" dangerouslySetInnerHTML={{ __html: data.html }} />
    ) : null;
  }
  const uses = (card.common_uses || []).filter(Boolean).slice(0, 5);
  return (
    <div className="medos-drug-tooltip-card">
      <div className="medos-drug-card">
        {card.drug_class ? (
          <section className="medos-drug-row medos-drug-class">
            <span className="medos-drug-label">Class:</span>
            <strong>{card.drug_class}</strong>
          </section>
        ) : null}
        {card.adult_dose ? (
          <section className="medos-drug-row medos-drug-dose">
            <span className="medos-drug-label">Adult dose:</span>
            <p>{card.adult_dose}</p>
          </section>
        ) : null}
        {uses.length ? (
          <section className="medos-drug-row medos-drug-uses">
            <span className="medos-drug-label">Common uses:</span>
            <ul>
              {uses.map(use => <li key={use}>{use}</li>)}
            </ul>
          </section>
        ) : null}
        {card.has_black_box || card.black_box ? (
          <section className="medos-drug-row medos-drug-warning">
            <span className="medos-drug-label">Black box:</span>
            <p>{card.black_box || "Black-box warning present in the local drug reference database."}</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function visibleActionMatches(data: TooltipData) {
  return (data.matches || []).filter(match => {
    if (isPrimaryMatch(match, data)) return false;
    return true;
  });
}

function tooltipUrl(source: HoverSource, term: string, db: QBankDb) {
  const base = getBackendUrl();
  return source === "qbank"
    ? `${base}/qbank/visual-tooltip?term=${encodeURIComponent(term)}&db=${db}`
    : source === "sanford"
      ? `${base}/sanford/tooltip?term=${encodeURIComponent(term)}&limit=6`
    : source === "utdddx"
      ? `${base}/utdddx/tooltip?term=${encodeURIComponent(term)}&limit=6`
    : source === "utd"
      ? `${base}/utd/tooltip?term=${encodeURIComponent(term)}`
      : source === "cliniccons"
        ? `${base}/cliniccons/tooltip?term=${encodeURIComponent(term)}&limit=8`
        : source === "drug"
          ? `${base}/reference/tooltip?term=${encodeURIComponent(term)}&db=${referenceDb(db)}&source=drug&limit=12`
          : source === "firstaid"
            ? `${base}/reference/tooltip?term=${encodeURIComponent(term)}&db=${referenceDb(db)}&source=firstaid&limit=12`
            : source === "umls"
              ? `${base}/reference/tooltip?term=${encodeURIComponent(term)}&db=${referenceDb(db)}&source=umls&limit=12`
        : `${base}/amboss/tooltip?term=${encodeURIComponent(term)}&limit=6`;
}

function referenceTooltipUrl(term: string, source: HoverSource, db: QBankDb) {
  const base = getBackendUrl();
  return `${base}/reference/tooltip?term=${encodeURIComponent(term)}&db=${referenceDb(db)}&source=${source}&limit=12`;
}

function hasTooltipPayload(data: TooltipData | null) {
  return !!data && (!!data.matches?.length || !!data.abstract || !!data.title || !!data.media?.length || !!data.html);
}

function isDrugTooltipData(data: TooltipData) {
  return data.source === "drug" || data.kind === "drug" || !!data.drug_card || /medos-drug-card/.test(data.html || "");
}

function tooltipBrand(data: TooltipData) {
  if (isDrugTooltipData(data)) return "DRUG REFERENCE";
  if (data.source === "qbank") return "UWORLD";
  if (data.source === "utd") return "UPTODATE";
  if (data.source === "cliniccons") return "CLINIC CONSULT";
  if (data.source === "firstaid") return "FIRST AID";
  if (data.source === "umls") return "UMLS";
  return "AMBOSS";
}

function normalizeTooltipData(data: TooltipData, source: HoverSource, preserveMatchSources = false): TooltipData {
  const normalizedSource = data.source || source;
  return {
    ...data,
    source: normalizedSource as HoverSource,
    matches: (data.matches || []).map(match => ({
      ...match,
      source: preserveMatchSources ? (match.source || normalizedSource) : source === "amboss" ? "amboss" : (match.source || normalizedSource),
    })),
  };
}

interface TooltipLoadResult { data: TooltipData | null; failed: boolean }

async function loadTooltipSource(term: string, source: HoverSource, db: QBankDb, timeoutMs = 900): Promise<TooltipLoadResult> {
  const raw = await fetchJsonWithTimeout(tooltipUrl(source, term, db), { method: "GET" }, timeoutMs) as TooltipData | null;
  if (!raw) return { data: null, failed: true };
  const data = normalizeTooltipData(raw, source);
  return { data: hasTooltipPayload(data) ? data : null, failed: false };
}

async function loadReferenceTooltip(term: string, source: HoverSource, db: QBankDb, timeoutMs = 900): Promise<TooltipLoadResult> {
  const raw = await fetchJsonWithTimeout(referenceTooltipUrl(term, source, db), { method: "GET" }, timeoutMs) as TooltipData | null;
  if (!raw) return { data: null, failed: true };
  const data = normalizeTooltipData(raw, source, true);
  return { data: hasTooltipPayload(data) ? data : null, failed: false };
}

function mergeTooltipData(primary: TooltipData, related: Array<TooltipData | null>): TooltipData {
  const dominantDrug = [primary, ...related].find(item => item && isDrugTooltipData(item));
  const base = dominantDrug || primary;
  const seen = new Set<string>();
  const matches = [base, primary, ...related]
    .flatMap(item => item?.matches || [])
    .filter(match => {
      const source = actionSource(match);
      const dedupeKey = `${source}:${match.kind || ""}:${match.href}:${match.title}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .sort((a, b) => matchPriority(a, base) - matchPriority(b, base));
  const mediaSeen = new Set<string>();
  const media = [primary, ...related]
    .flatMap(item => item?.media || [])
    .filter(item => {
      if (!item.url || mediaSeen.has(item.url)) return false;
      mediaSeen.add(item.url);
      return true;
    });
  const richer = related.find(item => item?.html || item?.abstract || item?.media?.length);
  const coded = [base, primary, ...related].find(item => item?.icd10cm_codes?.length);
  return {
    ...base,
    source: isDrugTooltipData(base) ? "drug" : base.source,
    kind: isDrugTooltipData(base) ? "drug" : base.kind,
    html: base.html || primary.html || richer?.html,
    drug_card: base.drug_card || primary.drug_card || richer?.drug_card,
    abstract: isDrugTooltipData(base) ? "" : (base.abstract || primary.abstract || richer?.abstract),
    cui: base.cui || primary.cui || richer?.cui,
    icd10cm_codes: coded?.icd10cm_codes || [],
    media,
    matches,
  };
}

async function fetchTooltip(term: string, source: HoverSource = "amboss", db: QBankDb = "step2"): Promise<TooltipData | null> {
  const key = tooltipCacheKey(source, term);
  if (!key) return null;
  if (tooltipCache.has(key)) return tooltipCache.get(key)!;
  if (emptyTooltipCache.has(key)) return null;
  const pending = tooltipInflight.get(key);
  if (pending) return pending;
  try {
    const request = (async () => {
      const reference = await loadReferenceTooltip(term, source, db, 700);
      const fallback = reference.data ? { data: null, failed: false } : await loadTooltipSource(term, source, db, 850);
      const data = reference.data || fallback.data;
      if (!data) {
        // Cache only a definitive HTTP-success empty result. A timeout, aborted
        // request, or temporarily unavailable backend must remain retryable.
        if (!reference.failed && !fallback.failed) emptyTooltipCache.add(key);
        return null;
      }
      tooltipCache.set(key, data);
      return data;
    })().finally(() => {
      tooltipInflight.delete(key);
    });
    tooltipInflight.set(key, request);
    return request;
  } catch {
    return null;
  }
}

async function fetchTooltipRelated(term: string, source: HoverSource, db: QBankDb, primary: TooltipData): Promise<TooltipData> {
  const combinedKey = tooltipCacheKey(`combined:${source}`, term);
  if (tooltipCache.has(combinedKey)) return tooltipCache.get(combinedKey)!;
  const pending = relatedTooltipInflight.get(combinedKey);
  if (pending) return pending;
  const request = (async () => {
    const relatedResults = await Promise.all([
      loadTooltipSource(term, source, db, 900),
      loadReferenceTooltip(term, source, db, 900),
    ]);
    const related = relatedResults.map(result => result.data);
    const merged = mergeTooltipData(primary, related);
    tooltipCache.set(combinedKey, merged);
    return merged;
  })().finally(() => {
    relatedTooltipInflight.delete(combinedKey);
  });
  relatedTooltipInflight.set(combinedKey, request);
  return request;
}

function collectTextNodes(root: HTMLElement): { text: string; ranges: TextNodeRange[] } {
  const ranges: TextNodeRange[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".medos-hover-link, .medos-amboss-link, a, script, style, textarea, input, select")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const value = node.textContent || "";
    if (text) text += " ";
    const start = text.length;
    text += value;
    ranges.push({ node, start, end: start + value.length });
  }
  return { text, ranges };
}

function applyMatches(root: HTMLElement, matches: ScanMatch[]) {
  root.querySelectorAll(".medos-hover-link, .medos-amboss-link").forEach(el => {
    el.replaceWith(document.createTextNode(el.textContent || ""));
  });

  const { ranges } = collectTextNodes(root);
  const wrapped: Array<{ range: TextNodeRange; match: ScanMatch; localStart: number; localEnd: number }> = [];

  let rangeIndex = 0;
  const orderedMatches = [...matches].sort((a, b) => a.start - b.start || b.end - a.end);
  for (const match of orderedMatches) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= match.start) rangeIndex++;
    for (let i = rangeIndex; i < ranges.length && ranges[i].start < match.end; i++) {
      const range = ranges[i];
      const start = Math.max(match.start, range.start);
      const end = Math.min(match.end, range.end);
      if (start < end) {
        wrapped.push({
          range,
          match,
          localStart: start - range.start,
          localEnd: end - range.start,
        });
      }
    }
  }

  const byNode = new Map<Text, Array<{ range: TextNodeRange; match: ScanMatch; localStart: number; localEnd: number }>>();
  wrapped.forEach(item => {
    const items = byNode.get(item.range.node) || [];
    items.push(item);
    byNode.set(item.range.node, items);
  });

  [...byNode.values()]
    .sort((a, b) => b[0].range.start - a[0].range.start)
    .forEach(items => {
      const range = items[0].range;
      if (!range.node.parentNode) return;
      const value = range.node.textContent || "";
      const segments = items
        .filter(item => item.localStart >= 0 && item.localEnd <= value.length && item.localStart < item.localEnd)
        .sort((a, b) => a.localStart - b.localStart);
      if (!segments.length) return;

      const frag = document.createDocumentFragment();
      let cursor = 0;
      segments.forEach(({ match, localStart, localEnd }) => {
        if (localStart > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, localStart)));
        const middle = value.slice(localStart, localEnd);
        const span = document.createElement("span");
        const source = match.source || "amboss";
        span.className = `medos-hover-link medos-hover-${source}`;
        span.dataset.term = match.term;
        span.dataset.source = source;
        if (match.kind) span.dataset.kind = match.kind;
        if (match.cui) span.dataset.cui = match.cui;
        if (match.semanticGroup) span.dataset.semanticGroup = match.semanticGroup;
        span.textContent = middle;
        frag.appendChild(span);
        cursor = localEnd;
      });
      if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
      range.node.parentNode.replaceChild(frag, range.node);
    });
}

function findReferenceTarget(eventTarget: EventTarget | null) {
  // NOTE: q-bank exhibit/media anchors are deliberately NOT reference targets.
  // They are handled by handleClick's figure branch (open in a viewer, never
  // navigate) on every pointer type — treating them as hover terms used to
  // mis-route the click and open the raw backend page over the exam.
  return eventTarget instanceof Element
    ? eventTarget.closest(".medos-hover-link, .medos-amboss-link") as HTMLElement | null
    : null;
}

export function AmbossHtml({
  html,
  className,
  as = "div",
  onOpenArticle,
  onOpenMatch,
  onMouseMove,
  onMouseLeave,
  onClick,
  db = "step2",
  source,
  sourceId,
  modeOverride,
  hoverEnabled = true,
}: {
  html: string;
  className?: string;
  as?: "div" | "span";
  onOpenArticle?: (match: TooltipMatch) => void;
  onOpenMatch?: (match: TooltipMatch) => boolean | void;
  onMouseMove?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
  onClick?: React.MouseEventHandler<HTMLElement>;
  db?: QBankDb;
  source?: string;
  sourceId?: string;
  modeOverride?: ReferenceMode;
  hoverEnabled?: boolean;
}) {
  const [darkModeOn] = useDarkMode();
  const globalMode = useReferenceLayerMode();
  const mode = modeOverride ?? globalMode;
  const ref = useRef<HTMLElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const activeTermRef = useRef("");
  const requestIdRef = useRef(0);
  const tooltipElRef = useRef<HTMLDivElement | null>(null);
  const touchPinnedRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [imageOverlay, setImageOverlay] = useState<{ src: string; title: string } | null>(null);
  const [frameOverlay, setFrameOverlay] = useState<{ src: string; title: string } | null>(null);
  const [tableOverlay, setTableOverlay] = useState<Readonly<MediaDescriptor> | null>(null);
  const [mounted, setMounted] = useState(false);
  const isDrugTooltip = tooltip ? isDrugTooltipData(tooltip.data) : false;
  const tooltipActions = tooltip ? visibleActionMatches(tooltip.data) : [];
  const questionAction = tooltipActions.find(isQuestionMatch);
  const secondaryActions = tooltipActions.filter(match => !isQuestionMatch(match));
  const frameTheme = darkModeOn ? "dark" : "light";

  useEffect(() => {
    setMounted(true);
  }, []);

  const closeTooltip = useCallback(() => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    touchPinnedRef.current = false;
    activeTermRef.current = "";
    requestIdRef.current += 1;
    setTooltip(null);
  }, []);

  useEffect(() => {
    if (!tooltip) return;
    const close = (event?: Event) => {
      const tooltipEl = tooltipElRef.current;
      if (tooltipEl && event?.target instanceof Node && tooltipEl.contains(event.target)) return;
      closeTooltip();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeTooltip, tooltip]);

  useEffect(() => {
    if (!hoverEnabled) closeTooltip();
  }, [closeTooltip, hoverEnabled]);

  useEffect(() => {
    if (!tooltip || !touchPinnedRef.current) return;

    const closeFromOutsideTouch = (event: PointerEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const tooltipEl = tooltipElRef.current;
      if (tooltipEl?.contains(target)) return;
      const root = ref.current;
      if (target instanceof Element && root?.contains(target) && findReferenceTarget(target)) return;
      closeTooltip();
    };

    document.addEventListener("pointerdown", closeFromOutsideTouch);
    document.addEventListener("touchstart", closeFromOutsideTouch, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", closeFromOutsideTouch);
      document.removeEventListener("touchstart", closeFromOutsideTouch);
    };
  }, [closeTooltip, tooltip]);

  useEffect(() => {
    if (!tooltip) return;
    const tooltipEl = tooltipElRef.current;
    if (!tooltipEl) return;
    const onWheel = (event: WheelEvent) => {
      event.stopPropagation();
      const target = event.target instanceof Element ? event.target : null;
      const tableBox = target?.closest(".medos-hover-tooltip-html") as HTMLElement | null;
      if (tableBox && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        tableBox.scrollLeft += event.deltaX;
        event.preventDefault();
        return;
      }
      tooltipEl.scrollTop += event.deltaY;
      event.preventDefault();
    };
    tooltipEl.addEventListener("wheel", onWheel, { passive: false });
    return () => tooltipEl.removeEventListener("wheel", onWheel);
  }, [tooltip]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let cancelled = false;
    root.innerHTML = html;
    // Make inline figures and tables visibly interactive. Click handling below
    // opens the shared MediaViewer while preserving links and reference terms.
    root.querySelectorAll("img").forEach(im => {
      if (im.closest("a, button, .medos-hover-link, .medos-amboss-link")) return;
      (im as HTMLImageElement).style.cursor = "zoom-in";
      im.classList.add("medos-zoomable-img");
    });
    root.querySelectorAll("table").forEach(table => {
      (table as HTMLTableElement).style.cursor = "zoom-in";
      table.classList.add("medos-zoomable-table");
    });
    let rafId: number | null = null;

    // Collapse overlapping matches: longest wins, then richer source, then position.
    const dedupe = (matches: ScanMatch[]): ScanMatch[] => {
      const occupied: Array<[number, number]> = [];
      return [...matches]
        .sort((a, b) =>
          ((b.end - b.start) - (a.end - a.start)) ||
          scanPriority(a) - scanPriority(b) ||
          a.start - b.start
        )
        .filter(match => {
          if (occupied.some(([s, e]) => match.start < e && match.end > s)) return false;
          occupied.push([match.start, match.end]);
          return true;
        })
        .sort((a, b) => a.start - b.start || ((b.end - b.start) - (a.end - a.start)));
    };

    // Pre-warm the heavier per-source (UWorld/drug) tooltips during idle time.
    const warmFrom = (matches: ScanMatch[]) => {
      const keys = [...new Set(
        matches
          .filter(match => match.source === "qbank" || match.source === "drug")
          .sort((a, b) => scanPriority(a) - scanPriority(b))
          .map(match => `${match.source || "amboss"}::${match.term}`)
      )].filter(key => !warmedTooltipKeys.has(`${db}:${key}`)).slice(0, 4);
      if (!keys.length) return;
      const warm = () => keys.forEach((key, index) => {
        const [warmSource, term] = key.split("::", 2) as [HoverSource, string];
        warmedTooltipKeys.add(`${db}:${key}`);
        window.setTimeout(() => void fetchTooltip(term, warmSource, db), index * 80);
      });
      if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 1200 });
      else globalThis.setTimeout(warm, 250);
    };

    // Returns true when the pass is "settled" (applied underlines, or this
    // fragment legitimately has no concepts). Returns false to request a retry —
    // used only for the cold-reference-index case below.
    const run = async (): Promise<boolean> => {
      const { text } = collectTextNodes(root);
      if (!text.trim()) return true;

      const docTermsP = sourceId
        ? fetchDocTerms(source || "", sourceId)
        : Promise.resolve([] as DocTerm[]);

      // Lite: precomputed concepts only — no whole-article scan round-trip, so
      // underlines appear instantly even on slow machines. This applies whenever
      // the document is TAGGED (has a precomputed list), even if this particular
      // fragment (e.g. a short answer choice) matches none of those terms — we
      // must NOT fall back to a live scan per-fragment, or every choice without a
      // hub concept would re-trigger the slow path we are trying to avoid.
      if (mode !== "full") {
        const terms = await docTermsP;
        if (cancelled) return true;
        if (terms.length > 0) {
          const docMatches = matchDocTermsInText(text, terms);
          if (docMatches.length) {
            const deduped = dedupe(docMatches);
            applyMatches(root, deduped);
            warmFrom(deduped);
          }
          return true;
        }
        // Untagged document (e.g. an Anki card has no hub row) — fall through to a
        // live scan so it is not left blank.
      }

      // Full mode, or Lite with an untagged document: live scan, merged with the
      // precomputed terms. Doc-term matches go first so that on an exact overlap
      // the CUI-bearing version wins the tie (keeping the centralized concept
      // card); a longer live-scan span still wins on length, which sorts first.
      const [terms, scanMatches] = await Promise.all([docTermsP, loadScanMatches(db, text)]);
      if (cancelled) return true;
      const docMatches = matchDocTermsInText(text, terms);
      const merged = dedupe([...docMatches, ...scanMatches]);
      // Keep the resolved CUI on the surviving span even when a higher-priority
      // live match (e.g. a UWorld exhibit, scan priority 1) won an EXACT overlap —
      // the hover card keys off data-cui to show the centralized cross-database
      // suggestions (UpToDate, UWorld library, AMBOSS, books…) instead of the old
      // AMBOSS-biased term card. Exact-extent only, so we never mis-tag a span.
      for (const m of merged) {
        if (m.cui) continue;
        const dt = docMatches.find(d => d.cui && d.start === m.start && d.end === m.end);
        if (dt) {
          m.cui = dt.cui;
          if (!m.semanticGroup) m.semanticGroup = dt.semanticGroup;
        }
      }
      if (merged.length) {
        applyMatches(root, merged);
        warmFrom(merged);
        return true;
      }
      // Zero matches. A TAGGED document (sourceId present — e.g. a q-bank question,
      // which the precompute guarantees has ≥1 concept) coming back empty almost
      // always means the reference index is still warming right after launch
      // (MEDOS_SKIP_REFERENCE_WARMUP defers it). Signal a retry so the first
      // questions of a freshly-started block — and explanations revealed by a fast
      // answer — self-heal in ~1s instead of staying blank until you navigate away
      // and back. Untagged fragments (no sourceId) legitimately have no concepts,
      // so they settle immediately and never retry.
      return !sourceId;
    };

    // Bounded, cancel-aware retry with backoff for the cold-index case only.
    let retries = 0;
    const RETRY_DELAYS = [500, 1200, 2500];
    let retryTimer: number | null = null;
    const attempt = () => {
      void run()
        .then(settled => {
          if (cancelled || settled || retries >= RETRY_DELAYS.length) return;
          retryTimer = window.setTimeout(attempt, RETRY_DELAYS[retries]);
          retries += 1;
        })
        .catch(() => {});
    };

    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      attempt();
    });

    return () => {
      cancelled = true;
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [html, db, source, sourceId, mode]);

  const scheduleClose = useCallback(() => {
    if (touchPinnedRef.current) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(closeTooltip, 220);
  }, [closeTooltip]);

  const openMatch = useCallback((match: TooltipMatch) => {
    if (!match?.href) return;
    closeTooltip();
    if (match.href.startsWith("/qbank/media/")) {
      setImageOverlay({ src: `${getBackendUrl()}${match.href}`, title: match.title || "UWorld image" });
    } else if (match.href.startsWith("/qbank/exhibit/")) {
      setFrameOverlay({ src: `${getBackendUrl()}${match.href}`, title: match.title || "UWorld exhibit" });
    } else if (match.href.startsWith("/utd/graphic/") || match.href.startsWith("/utd/thumb/")) {
      setImageOverlay({ src: `${getBackendUrl()}${match.href}`, title: match.title || "UpToDate graphic" });
    } else if (match.href.startsWith("/cliniccons/image/")) {
      setImageOverlay({ src: `${getBackendUrl()}${match.href}`, title: match.title || "Clinic Consult algorithm image" });
    } else if (match.href.startsWith("/cliniccons/algorithm/") || match.href.startsWith("/cliniccons/disease/")) {
      setFrameOverlay({ src: `${getBackendUrl()}${match.href}`, title: match.title || "Clinic Consult reference" });
    } else if (match.source === "firstaid" || match.href.startsWith("#firstaid-") || match.href.startsWith("/firstaid/")) {
      dispatchFirstAid(match);
    } else if (match.source === "drug" || match.href.startsWith("/drugs")) {
      const handled = onOpenMatch?.(match);
      if (!handled) openRoute(match);
    } else if (isQuestionMatch(match)) {
      openRoute(match);
    } else if (match.source === "qbank" || match.source === "utd" || match.source === "uworld") {
      // qbank/utd/uworld-library open inside the host reader's side panel when it
      // provides onOpenMatch (e.g. the q-bank tutor), else in a MedOS tab.
      const handled = onOpenMatch?.(match);
      if (!handled) openRoute(match);
    } else if (match.source === "sanford" || match.source === "utdddx" || match.href.startsWith("/sanford") || match.href.startsWith("/utdddx")) {
      // Sanford Guide / UpToDate DDx open their reader page (panel if the host
      // offers one, else a MedOS tab) — never through onOpenArticle (amboss/uworld).
      const handled = onOpenMatch?.(match);
      if (!handled) openRoute(match);
    } else if (onOpenArticle) {
      onOpenArticle(match);
    } else if (onOpenMatch?.(match)) {
      return;
    } else {
      openRoute(match);
    }
  }, [closeTooltip, onOpenArticle, onOpenMatch]);

  const openPrimaryTooltip = useCallback(() => {
    if (!tooltip) return;
    const primary = tooltip.data.matches.find(match => isPrimaryMatch(match, tooltip.data))
      || tooltip.data.matches.find(match => !isQuestionMatch(match));
    if (primary) openMatch(primary);
  }, [openMatch, tooltip]);

  const showTooltipForTarget = useCallback((
    target: HTMLElement,
    point?: { x: number; y: number },
    options?: { immediate?: boolean; pinByTouch?: boolean }
  ) => {
    if (!target) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    const term = target.dataset.term || target.textContent || "";
    // Reference targets are only underline spans now (exhibit/media anchors are
    // intercepted by handleClick's figure branch), so the source is whatever the
    // underline pass tagged, defaulting to amboss.
    const source = (target.dataset.source || "amboss") as HoverSource;
    // The underline FIND step already resolved this term to a concept; prefer the
    // centralized CUI card so every database that mentions it is offered.
    const cui = target.dataset.cui || "";
    if (!term.trim()) return;
    touchPinnedRef.current = !!options?.pinByTouch;
    activeTermRef.current = `${source}::${term}`;
    if (tooltip?.data.term.toLowerCase() === term.toLowerCase() && (tooltip.data.source || "amboss") === source) {
      if (point) setTooltip({ ...tooltip, ...tooltipPosition(point.x, point.y, tooltip) });
      return;
    }
    hoverTimer.current = window.setTimeout(async () => {
      hoverTimer.current = null;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const combinedKey = tooltipCacheKey(`combined:${source}`, term);
      const cachedCombined = tooltipCache.get(combinedKey);
      // CUI path first (centralized, cross-DB, already complete). Fall back to the
      // term-based entity-graph card for untagged spans (e.g. Anki) or empty CUIs.
      const conceptData = cui ? await fetchConceptCard(cui, db) : null;
      const data = conceptData || cachedCombined || await fetchTooltip(term, source, db);
      if (requestId !== requestIdRef.current || activeTermRef.current !== `${source}::${term}`) return;
      if (!data) {
        if (options?.pinByTouch) touchPinnedRef.current = false;
        return;
      }
      const rect = target.getBoundingClientRect();
      const metrics = tooltipMetrics(data);
      setTooltip({
        data,
        ...metrics,
        ...tooltipPosition(point?.x ?? rect.left, point?.y ?? rect.bottom, metrics),
      });
      // The concept card is already the full cross-source view; only the
      // term-based path needs the secondary related-source merge.
      if (!conceptData && !cachedCombined) void fetchTooltipRelated(term, source, db, data).catch(() => {});
    }, options?.immediate ? 0 : (cui || tooltipCache.has(tooltipCacheKey(source, term))) ? 20 : 70);
  }, [db, tooltip]);

  const handlePointerOver = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!hoverEnabled) return;
    if (isTouchPointer(event)) return;
    const target = findReferenceTarget(event.target);
    if (target) showTooltipForTarget(target, { x: event.clientX, y: event.clientY });
  }, [hoverEnabled, showTooltipForTarget]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!hoverEnabled) {
      onMouseMove?.(event as unknown as React.MouseEvent<HTMLElement>);
      return;
    }
    if (isTouchPointer(event)) return;
    const target = findReferenceTarget(event.target);
    if (target) {
      if (tooltip) showTooltipForTarget(target, { x: event.clientX, y: event.clientY });
      else if (!hoverTimer.current) showTooltipForTarget(target, { x: event.clientX, y: event.clientY });
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    }
    // Always forward move events: the host uses them for inline-figure hover
    // previews (e.g. the q-bank media thumbnail), which must fire over IMAGES —
    // i.e. exactly where there is no reference term. The old early-return here
    // swallowed them, so hovering an embedded image did nothing.
    onMouseMove?.(event as unknown as React.MouseEvent<HTMLElement>);
  }, [hoverEnabled, onMouseMove, showTooltipForTarget, tooltip]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!hoverEnabled) return;
    if (!isTouchPointer(event)) return;
    const target = findReferenceTarget(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickUntilRef.current = Date.now() + 900;
    const rect = target.getBoundingClientRect();
    showTooltipForTarget(target, {
      x: Number.isFinite(event.clientX) ? event.clientX : rect.left,
      y: Number.isFinite(event.clientY) ? event.clientY : rect.bottom,
    }, { immediate: true, pinByTouch: true });
  }, [hoverEnabled, showTooltipForTarget]);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLElement>) => {
    if (!hoverEnabled) return;
    if (typeof globalThis.PointerEvent !== "undefined") return;
    const target = findReferenceTarget(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickUntilRef.current = Date.now() + 900;
    const rect = target.getBoundingClientRect();
    const touch = event.touches[0];
    showTooltipForTarget(target, {
      x: touch?.clientX ?? rect.left,
      y: touch?.clientY ?? rect.bottom,
    }, { immediate: true, pinByTouch: true });
  }, [hoverEnabled, showTooltipForTarget]);

  const handleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    // ── Exhibit / media anchors: the ONE rule, every surface, every mode ──
    // A q-bank exhibit or media link must ALWAYS open in a viewer and NEVER
    // navigate the page (which would tear down a running exam block). The host
    // gets first claim — its richer MediaViewer calls preventDefault — and the
    // built-in overlay is the universal fallback for any surface that doesn't
    // wire up onClick. This is intentionally BEFORE the hover/tooltip routing so
    // exhibit links can't be mis-handled as hover terms (the old bug that left
    // exhibits opening as a full-page backend URL).
    const figureAnchor = event.target instanceof Element
      ? (event.target.closest("a[href*='/qbank/exhibit/'], a[href*='/qbank/media/']") as HTMLAnchorElement | null)
      : null;
    if (figureAnchor && ref.current?.contains(figureAnchor)) {
      onClick?.(event);
      if (event.defaultPrevented) { event.stopPropagation(); return; }
      event.preventDefault();
      event.stopPropagation();
      const rawHref = figureAnchor.getAttribute("href") || figureAnchor.href || "";
      const src = /^https?:/i.test(rawHref) ? rawHref : `${getBackendUrl()}${rawHref}`;
      if (/\/qbank\/exhibit\//.test(src)) setFrameOverlay({ src, title: "Exhibit" });
      else setImageOverlay({ src, title: figureAnchor.textContent?.trim() || "Image" });
      return;
    }
    const target = hoverEnabled ? findReferenceTarget(event.target) : null;
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressClickUntilRef.current) return;
      const term = target.dataset.term || target.textContent || "";
      const source = (target.dataset.source || "amboss") as HoverSource;
      const cui = target.dataset.cui || "";
      void (cui ? fetchConceptCard(cui, db) : Promise.resolve(null))
        .then(card => card || fetchTooltip(term, source, db))
        .then(data => {
          if (data?.matches?.[0]) openMatch(data.matches[0]);
        });
      return;
    }
    // Let the host handle the click first (e.g. the q-bank media viewer opens its
    // own rich zoomable modal for /qbank/media/ images and calls preventDefault).
    onClick?.(event);
    if (event.defaultPrevented) return;
    const clickedElement = event.target instanceof Element ? event.target : null;
    const table = clickedElement?.closest("table.medos-zoomable-table") as HTMLTableElement | null;
    if (table && ref.current?.contains(table) && !clickedElement?.closest("a,button,input,textarea,select,[contenteditable=true]")) {
      const descriptor = window.MedOSMedia?.descriptorFor({
        kind: "table",
        title: "",
        source: mediaSourceLabel(source),
        sourceUrl: window.location.href,
        element: table,
      });
      if (descriptor?.kind === "table" && descriptor.html) {
        event.preventDefault();
        event.stopPropagation();
        setTableOverlay(descriptor);
        return;
      }
    }
    // Fallback for any other inline figure (drug/anki/article images the host does
    // not claim): open it full-size in the built-in overlay.
    const img = (event.target instanceof Element ? event.target.closest(".medos-zoomable-img") : null) as HTMLImageElement | null;
    if (img && ref.current?.contains(img)) {
      const src = img.currentSrc || img.src;
      if (src) {
        event.preventDefault();
        event.stopPropagation();
        setImageOverlay({ src, title: img.getAttribute("alt") || "Figure" });
      }
    }
  }, [db, hoverEnabled, onClick, openMatch, source]);

  const sharedProps = {
    className,
    "data-reference-state": hoverEnabled ? "active" : "pending",
    onPointerDown: handlePointerDown,
    onPointerOver: handlePointerOver,
    onPointerMove: handlePointerMove,
    onPointerOut: (event: React.PointerEvent<HTMLElement>) => {
      if (isTouchPointer(event) || touchPinnedRef.current) return;
      const next = event.relatedTarget as Element | null;
      if (next?.closest?.(".medos-hover-link, .medos-amboss-link")) return;
      if (next?.closest?.(".medos-amboss-tooltip")) return;
      scheduleClose();
    },
    onTouchStart: handleTouchStart,
    onMouseLeave,
    onClick: handleClick,
  };

  return (
    <>
      {as === "span" ? (
        <span ref={ref as React.RefObject<HTMLSpanElement | null>} {...sharedProps} />
      ) : (
        <div ref={ref as React.RefObject<HTMLDivElement | null>} {...sharedProps} />
      )}
      {mounted && tooltip && createPortal(
        <div
          ref={tooltipElRef}
          className={`medos-amboss-tooltip medos-amboss-tooltip-${tooltip.placement}`}
          data-layout={tooltip.layout}
          style={{ left: tooltip.x, top: tooltip.y, width: tooltip.width, maxHeight: tooltip.maxHeight }}
          role="button"
          tabIndex={0}
          title="Open primary source"
          onPointerEnter={() => {
            if (closeTimer.current) window.clearTimeout(closeTimer.current);
          }}
          onPointerLeave={scheduleClose}
          onClick={event => {
            if ((event.target as Element).closest("button, a")) return;
            openPrimaryTooltip();
          }}
          onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openPrimaryTooltip();
            }
          }}
        >
          {questionAction ? (
            <button
              type="button"
              className="medos-tooltip-q-corner"
              title={questionAction.title}
              onClick={event => {
                event.stopPropagation();
                openMatch(questionAction);
              }}
            >
              Q
              <ExternalLink size={10} />
            </button>
          ) : null}
          <div className="medos-tooltip-body">
            <div className={`medos-hover-tooltip-brand medos-hover-tooltip-brand-${isDrugTooltip ? "drug" : (tooltip.data.source || "amboss")}`}>
              {tooltipBrand(tooltip.data)}
            </div>
            <strong className={isDrugTooltip ? "medos-drug-tooltip-title" : undefined}>
              {tooltip.data.title || tooltip.data.matches[0]?.title || tooltip.data.term}
            </strong>
            {tooltip.data.icd10cm_codes?.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                {tooltip.data.icd10cm_codes.slice(0, 5).map(code => (
                  <span key={code.code} title={code.term || "ICD-10-CM"} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 9, letterSpacing: "0.06em", color: "#0f766e", background: "rgba(20,184,166,0.12)", border: "1px solid rgba(20,184,166,0.28)", borderRadius: 4, padding: "1px 5px" }}>
                    ICD {code.code}
                  </span>
                ))}
              </div>
            ) : null}
            {tooltip.data.expansions?.length ? <em>Abbreviation for: {tooltip.data.expansions.join(", ")}</em> : null}
            {tooltip.data.abstract && !isDrugTooltip ? <p>{tooltip.data.abstract}</p> : null}
            {isDrugTooltip ? <DrugTooltipCard data={tooltip.data} /> : null}
            {!isDrugTooltip && tooltip.data.html ? (
              <div className="medos-hover-tooltip-html" dangerouslySetInnerHTML={{ __html: tooltip.data.html }} />
            ) : null}
            {tooltip.data.media?.length ? (
              <div
                className="medos-amboss-tooltip-media"
                data-count={Math.min(tooltip.data.media.length, 3)}
              >
                  {tooltip.data.media.slice(0, 3).map(item => (
                    <button
                      key={item.url}
                      type="button"
                      className="medos-amboss-tooltip-thumb"
                      aria-label={item.title || tooltip.data.title || tooltip.data.term}
                      onClick={() => {
                        if (tooltip.data.source === "firstaid" || item.url.startsWith("/firstaid/")) {
                          const headingId = Number(item.url.match(/heading_id=(\d+)/)?.[1] || tooltip.data.matches?.[0]?.id || "");
                          if (Number.isFinite(headingId) && headingId > 0) {
                            closeTooltip();
                            window.dispatchEvent(new CustomEvent("medos:open-firstaid", {
                              detail: { heading_id: headingId, query: tooltip.data.term || tooltip.data.title || item.title },
                            }));
                          }
                          return;
                        }
                        const src = `${getBackendUrl()}${item.url}`;
                        setImageOverlay({ src, title: item.title || tooltip.data.title || "Image" });
                      }}
                  >
                    <img
                      src={`${getBackendUrl()}${item.url}`}
                      alt={item.title || tooltip.data.title || tooltip.data.term}
                    />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {secondaryActions.length ? (
            <div className="medos-tooltip-actions">
              {secondaryActions.slice(0, MAX_SECONDARY_ACTIONS).map(match => (
                <button
                  key={`${match.source}-${match.kind || "article"}-${match.id}-${match.href}`}
                  type="button"
                  className={`medos-tooltip-action medos-tooltip-action-${actionSource(match)} ${isQuestionMatch(match) ? "medos-tooltip-action-question" : ""}`}
                  title={match.title}
                  onClick={event => {
                    event.stopPropagation();
                    openMatch(match);
                  }}
                >
                  <span className={`medos-tooltip-action-badge medos-tooltip-action-badge-${actionSource(match)}`}>
                    {actionBadge(match)}
                  </span>
                  <span className="medos-tooltip-action-title">{actionLabel(match, tooltip.data)}</span>
                  <ExternalLink size={12} />
                </button>
              ))}
            </div>
          ) : null}
        </div>,
        document.body
      )}
      {mounted && imageOverlay && createPortal(
        <MediaViewer
          open
          onClose={() => setImageOverlay(null)}
          title={imageOverlay.title}
          source={mediaSourceLabel(source)}
          sourceUrl={imageOverlay.src}
          imageUrl={imageOverlay.src}
        />,
        document.body
      )}
      {mounted && frameOverlay && createPortal(
        <MediaViewer
          open
          onClose={() => setFrameOverlay(null)}
          title={frameOverlay.title}
          source={mediaSourceLabel(source)}
          sourceUrl={frameOverlay.src}
          frameUrl={themedFrameUrl(frameOverlay.src, frameTheme)}
        />,
        document.body
      )}
      {mounted && tableOverlay && createPortal(
        <MediaViewer
          open
          onClose={() => setTableOverlay(null)}
          title={tableOverlay.title}
          source={tableOverlay.source}
          sourceUrl={tableOverlay.sourceUrl}
          html={tableOverlay.html}
          mediaDescriptor={tableOverlay}
        />,
        document.body
      )}
    </>
  );
}
