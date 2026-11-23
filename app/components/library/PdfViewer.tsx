"use client";
/**
 * Virtualized PDF viewer with collapsible Table-of-Contents sidebar.
 *
 * TOC is extracted from the PDF's embedded outline (bookmarks) via
 * pdfjs-dist's `doc.getOutline()`. Clicking a heading jumps to that page.
 */

import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import type * as PdfjsType from "pdfjs-dist";
import { ChevronRight, ChevronDown, BookOpen, PanelLeftClose, PanelLeft } from "lucide-react";
import { useTouchInteraction, type ContextCommand } from "@/components/touch/TouchInteractionProvider";
import {
  beginPdfJump,
  calculatePdfTargetScroll,
  createPdfJumpState,
  createPdfNavigationRequest,
  isUnseenPdfNavigationRequest,
  parsePdfPage,
  reconcileObservedPdfPage,
  settlePdfJump,
  type PdfJumpState,
  type PdfNavigationRequest,
} from "@/lib/pdfNavigation";
import { useDoubleTap, usePinchZoom, useTrackpadPinch } from "@/lib/useTouchGestures";

interface Props {
  url: string;
  initialPage?: number;
  navigationRequest?: PdfNavigationRequest | null;
}

// PDF.js outline item shape
interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineItem[];
  bold?: boolean;
  italic?: boolean;
}

const RENDER_AHEAD  = 2;
const PAGE_GAP      = 12;
const MIN_SCALE     = 0.5;
const DEFAULT_SCALE = 1.5;
const MAX_SCALE     = 4;
const ZOOM_STEP     = 0.25;
const TOC_WIDTH     = 260;
const GEOMETRY_READY_TIMEOUT_MS = 2000;
const LAYOUT_READY_TIMEOUT_MS = 500;

// Fallback page geometry (US-Letter at 72dpi) used for placeholders before a
// page's real dimensions are known, so unrendered pages still look like pages.
const FALLBACK_PAGE_W = 612;
const FALLBACK_PAGE_H = 792;

// Unscaled page dimensions, in CSS px at scale 1.
interface PageDims { w: number; h: number; }

type PdfStageElement = Pick<HTMLDivElement, "scrollTop" | "getBoundingClientRect">;
type PdfTargetElement = Pick<HTMLDivElement, "getBoundingClientRect">;

export function movePdfStageToTarget(
  container: PdfStageElement,
  target: PdfTargetElement,
  paddingTop = PAGE_GAP,
  stickyOffset = 0,
) {
  const scrollTop = calculatePdfTargetScroll({
    scrollTop: container.scrollTop,
    containerTop: container.getBoundingClientRect().top,
    targetTop: target.getBoundingClientRect().top,
    paddingTop,
    stickyOffset,
  });
  container.scrollTop = scrollTop;
  return scrollTop;
}

export async function resolvePdfOutlinePage(
  pdfDocument: Pick<PdfjsType.PDFDocumentProxy, "getDestination" | "getPageIndex">,
  destination: string | unknown[] | null,
  numPages: number,
) {
  if (destination === null) return null;
  try {
    const resolved = typeof destination === "string"
      ? await pdfDocument.getDestination(destination)
      : destination;
    if (!resolved?.length) return null;
    const first = resolved[0];
    const pageIndex = Number.isSafeInteger(first)
      ? Number(first)
      : await pdfDocument.getPageIndex(first as Parameters<typeof pdfDocument.getPageIndex>[0]);
    const page = pageIndex + 1;
    return Number.isSafeInteger(page) && page >= 1 && page <= numPages ? page : null;
  } catch {
    return null;
  }
}

export interface PdfPageRenderOperation {
  geometryReady: Promise<void>;
  rasterComplete: Promise<void>;
}

type PdfPageRenderHandle = Promise<void> | PdfPageRenderOperation;
type PdfNavigationFailure = "render-timeout" | "render-failed" | "layout-timeout" | "layout-failed" | "missing-target" | "unstable";

interface PdfStageNavigationOptions {
  container: PdfStageElement;
  targetPage: number;
  numPages: number;
  getPageElement: (page: number) => PdfTargetElement | null;
  renderPage: (page: number) => PdfPageRenderHandle;
  waitForLayout?: () => Promise<void>;
  onSettled?: (page: number) => void;
  onFailed?: (reason: PdfNavigationFailure) => void;
  isCancelled?: () => boolean;
  paddingTop?: number;
  stickyOffset?: number;
  renderAhead?: number;
  maxAttempts?: number;
  tolerance?: number;
  geometryTimeoutMs?: number;
  layoutTimeoutMs?: number;
}

export interface PdfStageNavigationResult {
  page: number;
  scrollTop: number;
  attempts: number;
  stable: boolean;
}

function waitForPdfLayout() {
  return new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
}

type BoundedWaitResult = "ready" | "timeout" | "failed" | "cancelled";

async function waitForBoundedOperation(
  operation: Promise<void>,
  timeoutMs: number,
  isCancelled: () => boolean,
): Promise<BoundedWaitResult> {
  if (isCancelled()) return "cancelled";
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  try {
    const result = await Promise.race<BoundedWaitResult>([
      operation.then(() => "ready" as const, () => "failed" as const),
      new Promise<BoundedWaitResult>(resolve => {
        timeout = globalThis.setTimeout(() => resolve("timeout"), boundedTimeout);
      }),
    ]);
    return isCancelled() ? "cancelled" : result;
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}

function geometryPromiseFor(render: PdfPageRenderHandle) {
  return "geometryReady" in render ? render.geometryReady : render;
}

function rasterPromiseFor(render: PdfPageRenderHandle) {
  return "rasterComplete" in render ? render.rasterComplete : render;
}

export async function settlePdfStageNavigation({
  container,
  targetPage,
  numPages,
  getPageElement,
  renderPage,
  waitForLayout = waitForPdfLayout,
  onSettled,
  onFailed,
  isCancelled = () => false,
  paddingTop = PAGE_GAP,
  stickyOffset = 0,
  renderAhead = RENDER_AHEAD,
  maxAttempts = 4,
  tolerance = 0.5,
  geometryTimeoutMs = GEOMETRY_READY_TIMEOUT_MS,
  layoutTimeoutMs = LAYOUT_READY_TIMEOUT_MS,
}: PdfStageNavigationOptions): Promise<PdfStageNavigationResult> {
  const result = (attempts: number, stable = false): PdfStageNavigationResult => ({
    page: targetPage,
    scrollTop: container.scrollTop,
    attempts,
    stable,
  });
  const fail = (reason: PdfNavigationFailure, attempts: number) => {
    if (!isCancelled()) onFailed?.(reason);
    return result(attempts);
  };
  const firstPage = Math.max(1, targetPage - 1);
  const lastPage = Math.min(numPages, targetPage + renderAhead);
  const geometryRenderPromises: Promise<void>[] = [];
  for (let page = firstPage; page <= lastPage; page++) {
    const render = renderPage(page);
    void rasterPromiseFor(render).catch(() => {});
    if (page <= targetPage) geometryRenderPromises.push(geometryPromiseFor(render));
  }
  const renderWait = await waitForBoundedOperation(
    Promise.all(geometryRenderPromises).then(() => {}),
    geometryTimeoutMs,
    isCancelled,
  );
  if (renderWait === "cancelled") return result(0);
  if (renderWait === "timeout") return fail("render-timeout", 0);
  if (renderWait === "failed") return fail("render-failed", 0);

  const initialLayoutWait = await waitForBoundedOperation(waitForLayout(), layoutTimeoutMs, isCancelled);
  if (initialLayoutWait === "cancelled") return result(0);
  if (initialLayoutWait === "timeout") return fail("layout-timeout", 0);
  if (initialLayoutWait === "failed") return fail("layout-failed", 0);

  let target = getPageElement(targetPage);
  if (!target) return fail("missing-target", 0);
  movePdfStageToTarget(container, target, paddingTop, stickyOffset);

  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const layoutWait = await waitForBoundedOperation(waitForLayout(), layoutTimeoutMs, isCancelled);
    if (layoutWait === "cancelled") return result(attempts);
    if (layoutWait === "timeout") return fail("layout-timeout", attempts);
    if (layoutWait === "failed") return fail("layout-failed", attempts);
    target = getPageElement(targetPage);
    if (!target) return fail("missing-target", attempts);
    const verifiedScrollTop = calculatePdfTargetScroll({
      scrollTop: container.scrollTop,
      containerTop: container.getBoundingClientRect().top,
      targetTop: target.getBoundingClientRect().top,
      paddingTop,
      stickyOffset,
    });
    if (Math.abs(verifiedScrollTop - container.scrollTop) <= tolerance) {
      onSettled?.(targetPage);
      return result(attempts, true);
    }
    container.scrollTop = verifiedScrollTop;
  }

  return fail("unstable", maxAttempts);
}

export function PdfNavigationFeedback({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="status" aria-live="polite" style={{
      padding: "5px 16px", background: "#352f25", color: "#f3d7a0",
      fontFamily: "var(--font-mono)", fontSize: 10, flexShrink: 0,
    }}>
      {message}
    </div>
  );
}

export function buildPdfHaloCommands({
  hasContents,
  toggleContents,
  previousPage,
  nextPage,
  canGoPrevious,
  canGoNext,
}: {
  hasContents: boolean;
  toggleContents: () => void;
  previousPage: () => void;
  nextPage: () => void;
  canGoPrevious: boolean;
  canGoNext: boolean;
}): ContextCommand[] {
  return [
    ...(hasContents ? [{
      id: "pdf-contents", label: "Contents", mode: "read" as const,
      glyph: "menu_book", description: "Show or hide the PDF outline", run: toggleContents,
    }] : []),
    {
      id: "pdf-previous-page", label: "Previous page", mode: "read" as const,
      glyph: "chevron_left", description: canGoPrevious ? "Go back one page" : "Already at the first page",
      run: previousPage,
    },
    {
      id: "pdf-next-page", label: "Next page", mode: "read" as const,
      glyph: "chevron_right", description: canGoNext ? "Go forward one page" : "Already at the last page",
      run: nextPage,
    },
  ];
}

// ── TOC tree node ───────────────────────────────────────────────────────────

function TocEntry({
  item,
  depth,
  onNavigate,
}: {
  item: OutlineItem;
  depth: number;
  onNavigate: (dest: string | unknown[] | null) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = item.items && item.items.length > 0;
  const activate = () => {
    if (hasChildren) setOpen(o => !o);
    onNavigate(item.dest);
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate();
          }
        }}
        style={{
          display: "flex", alignItems: "flex-start", gap: 4,
          padding: `4px 8px 4px ${8 + depth * 14}px`,
          cursor: "pointer", borderRadius: 4,
          color: "#c8c8c8", fontSize: 11,
          lineHeight: 1.45,
          transition: "background 0.1s",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
      >
        <span style={{ flexShrink: 0, marginTop: 1, color: "#666", width: 12 }}>
          {hasChildren
            ? (open ? <ChevronDown size={10} /> : <ChevronRight size={10} />)
            : null}
        </span>
        <span style={{
          flex: 1,
          fontWeight: item.bold ? 700 : (depth === 0 ? 600 : 400),
          fontStyle: item.italic ? "italic" : "normal",
          opacity: depth === 0 ? 1 : 0.85,
          wordBreak: "break-word",
        }}>
          {item.title}
        </span>
      </div>
      {open && hasChildren && (
        <div>
          {item.items.map((child, i) => (
            <TocEntry key={i} item={child} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function PdfViewer({ url, initialPage = 1, navigationRequest = null }: Props) {
  const touch = useTouchInteraction();
  const [pdfLib, setPdfLib]       = useState<typeof PdfjsType | null>(null);
  const [doc, setDoc]             = useState<PdfjsType.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages]   = useState(0);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [settledPage, setSettledPage] = useState<number | null>(null);
  const [scale, setScale]         = useState(DEFAULT_SCALE);
  const [inputPage, setInputPage] = useState(String(initialPage));
  const [error, setError]         = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);
  const [outline, setOutline]     = useState<OutlineItem[]>([]);
  const [tocOpen, setTocOpen]     = useState(true);
  const [navigationMessage, setNavigationMessage] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PdfNavigationRequest | null>(() => (
    navigationRequest ?? createPdfNavigationRequest(initialPage, "route")
  ));
  // Bumped whenever a page's real dimensions are first learned, so placeholders
  // re-render at the correct page shape.
  const [dimsTick, setDimsTick]   = useState(0);

  const containerRef  = useRef<HTMLDivElement>(null);
  const pageRefs      = useRef<(HTMLDivElement | null)[]>([]);
  const renderingRef  = useRef<Map<number, PdfPageRenderOperation>>(new Map());
  const lastProcessedRequestRef = useRef(0);
  const jumpStateRef = useRef<PdfJumpState>(createPdfJumpState());
  const prevScaleRef  = useRef(scale);
  const pageDimsRef   = useRef<Map<number, PageDims>>(new Map());
  const baseDimsRef   = useRef<PageDims | null>(null);
  const visibleRef    = useRef<Set<number>>(new Set());
  // Last known anchor: which page sits at the top of the viewport and its offset
  // from the container top. Used to keep the viewport fixed when page geometry
  // is learned and placeholders resize.
  const scrollAnchorRef = useRef<{ page: number; top: number } | null>(null);
  const scrollRafRef    = useRef<number | null>(null);
  const mountedRef      = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (navigationRequest) setPendingRequest(navigationRequest);
  }, [navigationRequest]);

  // Best-known unscaled dimensions for a page: its own if rendered, else the
  // first page seen (most books are uniform), else a US-Letter fallback.
  const dimsForPage = useCallback((pageNum: number): PageDims => {
    return pageDimsRef.current.get(pageNum)
      ?? baseDimsRef.current
      ?? { w: FALLBACK_PAGE_W, h: FALLBACK_PAGE_H };
  }, []);

  const setClampedScale = useCallback((next: number) => {
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
  }, []);

  const zoomBy = useCallback((delta: number) => {
    setScale(s => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((s + delta) * 100) / 100)));
  }, []);

  const toggleTouchZoom = useCallback(() => {
    setScale(current => current < 2.1 ? 2.2 : DEFAULT_SCALE);
  }, []);

  usePinchZoom(containerRef, {
    value: scale,
    min: MIN_SCALE,
    max: MAX_SCALE,
    onChange: setClampedScale,
    ignoreSelector: ".pdf-toolbar",
  });

  useTrackpadPinch(containerRef, {
    value: scale,
    min: MIN_SCALE,
    max: MAX_SCALE,
    step: 0.01,
    multiplicative: true,
    onChange: setClampedScale,
    ignoreSelector: ".pdf-toolbar",
  });

  useDoubleTap(containerRef, toggleTouchZoom, {
    ignoreSelector: ".pdf-toolbar",
  });

  // ── 1. Load pdfjs-dist ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    import("pdfjs-dist").then(lib => {
      if (cancelled) return;
      lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      setPdfLib(lib);
    });
    return () => { cancelled = true; };
  }, []);

  // ── 2. Load document ─────────────────────────────────────────────────────
  const loadTask = useMemo(() => {
    if (!pdfLib || !url) return null;
    return pdfLib.getDocument({ url, rangeChunkSize: 65536 });
  }, [pdfLib, url]);

  useEffect(() => {
    if (!loadTask) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    setOutline([]);
    setSettledPage(null);
    pageRefs.current = [];
    renderingRef.current.clear();
    pageDimsRef.current.clear();
    baseDimsRef.current = null;
    visibleRef.current.clear();
    scrollAnchorRef.current = null;
    lastProcessedRequestRef.current = 0;
    jumpStateRef.current = createPdfJumpState();

    loadTask.promise
      .then(async d => {
        if (cancelled) { d.destroy(); return; }

        // Probe one page's real geometry up front so placeholders start at the
        // correct page shape (most books are uniform), avoiding a layout jump
        // when the first page renders.
        try {
          const probe = await d.getPage(1);
          const vp = probe.getViewport({ scale: 1 });
          baseDimsRef.current = { w: vp.width, h: vp.height };
          probe.cleanup();
        } catch {
          // fall back to default placeholder geometry
        }
        if (cancelled) { d.destroy(); return; }

        setDoc(d);
        setNumPages(d.numPages);
        setLoading(false);

        // Extract outline (table of contents)
        try {
          const raw = await d.getOutline();
          if (raw && raw.length > 0) setOutline(raw as OutlineItem[]);
        } catch {
          // No outline — that's fine, TOC panel will just be empty
        }
      })
      .catch(err => {
        if (cancelled) return;
        setError(err?.message ?? "Failed to load PDF");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      loadTask.destroy?.();
    };
  }, [loadTask]);

  // ── 3. Render a page ─────────────────────────────────────────────────────
  const renderPage = useCallback((pageNum: number): PdfPageRenderOperation => {
    if (!doc) {
      const ready = Promise.resolve();
      return { geometryReady: ready, rasterComplete: ready };
    }
    const inFlight = renderingRef.current.get(pageNum);
    if (inFlight) return inFlight;
    const container = pageRefs.current[pageNum - 1];
    if (!container) {
      const ready = Promise.resolve();
      return { geometryReady: ready, rasterComplete: ready };
    }

    let resolveGeometry!: () => void;
    let rejectGeometry!: (reason?: unknown) => void;
    let geometryKnown = false;
    const geometryReady = new Promise<void>((resolve, reject) => {
      resolveGeometry = resolve;
      rejectGeometry = reject;
    });
    // Observer-driven render-ahead does not await geometry; attach a rejection
    // handler here while preserving the original promise for navigation.
    void geometryReady.catch(() => {});
    const work = async () => {
      let page: PdfjsType.PDFPageProxy | null = null;
      try {
        page           = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const dpr      = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const cacheKey = `${scale}@${dpr}`;

        // Record real (unscaled) geometry before resolving the render promise,
        // allowing navigation to await the React placeholder resize.
        const dims: PageDims = { w: viewport.width / scale, h: viewport.height / scale };
        if (!baseDimsRef.current) baseDimsRef.current = dims;
        const known = pageDimsRef.current.get(pageNum);
        if (!known || Math.abs(known.w - dims.w) > 0.5 || Math.abs(known.h - dims.h) > 0.5) {
          pageDimsRef.current.set(pageNum, dims);
          setDimsTick(t => t + 1);
        }
        geometryKnown = true;
        resolveGeometry();

        let canvas = container.querySelector("canvas") as HTMLCanvasElement | null;
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.style.display = "block";
          container.appendChild(canvas);
        }

        // Size the canvas backing store at the device pixel ratio for crisp text,
        // while keeping its CSS box at the logical (scaled) page size.
        canvas.style.width  = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        if (canvas.dataset.scale === cacheKey && canvas.width > 0) {
          return;
        }

        canvas.width  = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.dataset.scale = cacheKey;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
        await page.render({ canvasContext: ctx, viewport, canvas, transform }).promise;
      } catch (error) {
        if (!geometryKnown) rejectGeometry(error);
        // Raster failures remain non-fatal after geometry has been learned.
      } finally {
        if (!geometryKnown) rejectGeometry(new Error("PDF page geometry unavailable"));
        try { page?.cleanup(); } catch { /* best-effort PDF.js cleanup */ }
      }
    };
    const operation: PdfPageRenderOperation = {
      geometryReady,
      rasterComplete: Promise.resolve(),
    };
    operation.rasterComplete = Promise.resolve().then(work).finally(() => {
      if (renderingRef.current.get(pageNum) === operation) renderingRef.current.delete(pageNum);
    });
    renderingRef.current.set(pageNum, operation);
    return operation;
  }, [doc, scale]);

  // The "current" page is the one covering the most of the viewport, not just
  // any page that happens to intersect the (margin-expanded) root.
  const syncCurrentPage = useCallback(() => {
    const container = containerRef.current;
    if (!container || visibleRef.current.size === 0) return;
    const cRect = container.getBoundingClientRect();
    let best = -1;
    let bestOverlap = -1;
    visibleRef.current.forEach(pageNum => {
      const el = pageRefs.current[pageNum - 1];
      if (!el) return;
      const r = el.getBoundingClientRect();
      const overlap = Math.min(r.bottom, cRect.bottom) - Math.max(r.top, cRect.top);
      if (overlap > bestOverlap) { bestOverlap = overlap; best = pageNum; }
    });
    if (best > 0) {
      const reconciledPage = reconcileObservedPdfPage(jumpStateRef.current, best);
      if (reconciledPage !== best) return;
      setCurrentPage(reconciledPage);
      setInputPage(String(reconciledPage));
      setSettledPage(reconciledPage);
    }
  }, []);

  // Record the page at the top of the viewport and its offset, so geometry
  // changes (a page learning its true height) can be compensated without the
  // viewport drifting.
  const recordAnchor = useCallback(() => {
    const container = containerRef.current;
    if (jumpStateRef.current.settling) return;
    if (!container || visibleRef.current.size === 0) return;
    const cTop = container.getBoundingClientRect().top;
    let straddle = -1, straddleTop = 0;
    let highest = -1, highestTop = Infinity;
    visibleRef.current.forEach(pageNum => {
      const el = pageRefs.current[pageNum - 1];
      if (!el) return;
      const r = el.getBoundingClientRect();
      const top = r.top - cTop;
      if (top <= 1 && r.bottom - cTop > 0) { straddle = pageNum; straddleTop = top; }
      if (top < highestTop) { highest = pageNum; highestTop = top; }
    });
    // Prefer the page crossing the top edge; otherwise the highest visible page.
    if (straddle > 0) scrollAnchorRef.current = { page: straddle, top: straddleTop };
    else if (highest > 0) scrollAnchorRef.current = { page: highest, top: highestTop };
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      recordAnchor();
    });
  }, [recordAnchor]);

  useEffect(() => () => {
    if (scrollRafRef.current != null) window.cancelAnimationFrame(scrollRafRef.current);
  }, []);

  // ── 4. IntersectionObserver ──────────────────────────────────────────────
  useEffect(() => {
    if (!doc || numPages === 0) return;
    visibleRef.current.clear();
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          const idx = pageRefs.current.indexOf(entry.target as HTMLDivElement);
          if (idx < 0) return;
          const pageNum = idx + 1;
          if (entry.isIntersecting) {
            visibleRef.current.add(pageNum);
            for (let p = Math.max(1, pageNum - 1); p <= Math.min(numPages, pageNum + RENDER_AHEAD); p++) {
              renderPage(p);
            }
          } else {
            visibleRef.current.delete(pageNum);
          }
        });
        syncCurrentPage();
      },
      { root: containerRef.current, rootMargin: "200px 0px", threshold: [0, 0.1, 0.5, 0.9, 1] }
    );
    pageRefs.current.forEach(el => { if (el) observer.observe(el); });
    return () => observer.disconnect();
  }, [doc, numPages, renderPage, syncCurrentPage]);

  // Keep the viewport anchored on the same content across a zoom change, and
  // pre-stretch already-rendered canvases so rendered pages and placeholders
  // reflow by the same factor. Without this, changing the zoom silently scrolls
  // you onto a different page. Runs before paint to avoid a visible jump.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const prev = prevScaleRef.current;
    prevScaleRef.current = scale;
    if (jumpStateRef.current.settling) return;
    if (!container || prev === scale || prev <= 0) return;
    const ratio = scale / prev;

    // Capture the old scroll position before mutating any layout.
    const cx = container.clientWidth / 2;
    const cy = container.clientHeight / 2;
    const targetTop  = (container.scrollTop + cy) * ratio - cy;
    const targetLeft = (container.scrollLeft + cx) * ratio - cx;

    pageRefs.current.forEach(el => {
      const canvas = el?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) return;
      const w = parseFloat(canvas.style.width);
      const h = parseFloat(canvas.style.height);
      if (w > 0) canvas.style.width  = `${w * ratio}px`;
      if (h > 0) canvas.style.height = `${h * ratio}px`;
      canvas.dataset.scale = "";   // force a crisp re-render at the new scale
    });

    container.scrollTop  = Math.max(0, targetTop);
    container.scrollLeft = Math.max(0, targetLeft);
    recordAnchor();
  }, [scale, recordAnchor]);

  // When a page learns its true geometry and placeholders resize, nudge the
  // scroll position so the page at the top of the viewport stays put.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = scrollAnchorRef.current;
    if (jumpStateRef.current.settling) return;
    if (!container || !anchor) return;
    const el = pageRefs.current[anchor.page - 1];
    if (!el) return;
    const nowTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const delta = nowTop - anchor.top;
    if (Math.abs(delta) > 0.5) container.scrollTop += delta;
  }, [dimsTick]);

  // Crisp re-render of on-screen pages after a zoom change (post-paint).
  useEffect(() => {
    if (!doc) return;
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    pageRefs.current.forEach((el, idx) => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top < cRect.bottom + 400 && rect.bottom > cRect.top - 400) renderPage(idx + 1);
    });
  }, [scale, doc, renderPage]);

  // ── 5. Page navigation ───────────────────────────────────────────────────
  const requestPage = useCallback((n: number, source: PdfNavigationRequest["source"], optionalDestination?: unknown) => {
    const request = createPdfNavigationRequest(n, source, optionalDestination, numPages);
    if (request) setPendingRequest(request);
  }, [numPages]);

  const goToPage = useCallback((n: number) => requestPage(n, "toolbar"), [requestPage]);

  // Keyboard shortcuts when the page area is focused: zoom (+/-/0, also Ctrl/Cmd
  // variants so the browser doesn't zoom the whole app) and paged navigation.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    switch (e.key) {
      case "+": case "=":
        e.preventDefault(); zoomBy(ZOOM_STEP); break;
      case "-": case "_":
        e.preventDefault(); zoomBy(-ZOOM_STEP); break;
      case "0":
        if (e.ctrlKey || e.metaKey || !e.shiftKey) { e.preventDefault(); setScale(DEFAULT_SCALE); }
        break;
      case "PageDown":
        e.preventDefault(); goToPage(currentPage + 1); break;
      case "PageUp":
        e.preventDefault(); goToPage(currentPage - 1); break;
      case "Home":
        e.preventDefault(); goToPage(1); break;
      case "End":
        e.preventDefault(); goToPage(numPages); break;
      default: break;
    }
  }, [zoomBy, goToPage, currentPage, numPages]);

  useEffect(() => {
    if (!doc || numPages === 0 || !pendingRequest) return;
    if (!isUnseenPdfNavigationRequest(lastProcessedRequestRef.current, pendingRequest)) return;
    const target = parsePdfPage(pendingRequest.page, numPages);
    if (target === null) return;

    const request = { ...pendingRequest, page: target };
    lastProcessedRequestRef.current = request.requestId;
    jumpStateRef.current = beginPdfJump(jumpStateRef.current, request);
    scrollAnchorRef.current = null;
    setNavigationMessage(null);
    setCurrentPage(target);
    setInputPage(String(target));

    const container = containerRef.current;
    if (!container) {
      setNavigationMessage("Could not open that PDF page.");
      jumpStateRef.current = settlePdfJump(jumpStateRef.current, request.requestId);
      return;
    }

    const failNavigation = () => {
      if (!mountedRef.current || jumpStateRef.current.requestId !== request.requestId) return;
      jumpStateRef.current = settlePdfJump(jumpStateRef.current, request.requestId);
      setNavigationMessage("Could not stabilize that PDF page position.");
    };
    void settlePdfStageNavigation({
      container,
      targetPage: target,
      numPages,
      getPageElement: page => pageRefs.current[page - 1],
      renderPage,
      paddingTop: PAGE_GAP,
      isCancelled: () => !mountedRef.current || jumpStateRef.current.requestId !== request.requestId,
      onFailed: failNavigation,
      onSettled: page => {
        if (!mountedRef.current || jumpStateRef.current.requestId !== request.requestId) return;
        jumpStateRef.current = settlePdfJump(jumpStateRef.current, request.requestId);
        setCurrentPage(page);
        setInputPage(String(page));
        setSettledPage(page);
        recordAnchor();
      },
    }).catch(failNavigation);
  }, [doc, numPages, pendingRequest, recordAnchor, renderPage]);

  useEffect(() => {
    if (typeof window === "undefined" || settledPage === null) return;
    window.postMessage({ type: "medos-pdf-page", page: settledPage }, "*");
  }, [settledPage]);

  // ── 6. Navigate to a TOC destination ────────────────────────────────────
  const navigateToDest = useCallback(async (dest: string | unknown[] | null) => {
    if (!doc) return;
    const page = await resolvePdfOutlinePage(doc, dest, numPages);
    if (page === null) {
      setNavigationMessage("Could not open that PDF destination.");
      return;
    }
    requestPage(page, "outline", { destination: dest });
  }, [doc, numPages, requestPage]);

  const haloCommands = useMemo(() => buildPdfHaloCommands({
    hasContents: outline.length > 0,
    toggleContents: () => setTocOpen(value => !value),
    previousPage: () => goToPage(currentPage - 1),
    nextPage: () => goToPage(currentPage + 1),
    canGoPrevious: currentPage > 1,
    canGoNext: currentPage < numPages,
  }), [currentPage, goToPage, numPages, outline.length]);

  useEffect(() => {
    const unregister = haloCommands.map(command => touch.registerContextCommand(command));
    return () => unregister.forEach(dispose => dispose());
  }, [haloCommands, touch]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (error) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      flexDirection: "column", gap: 12, color: "var(--text-muted)",
      fontFamily: "var(--font-mono)", fontSize: 11 }}>
      <span style={{ color: "var(--red)" }}>PDF load error</span>
      <span style={{ maxWidth: 400, textAlign: "center", opacity: 0.7 }}>{error}</span>
    </div>
  );

  const showToc = tocOpen && outline.length > 0;

  return (
    <div className="pdf-viewer-shell" style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%",
      overflow: "hidden", background: "#3a3a3a" }}>

      {/* ── Toolbar ── */}
      <div className="pdf-toolbar" style={{
        display: "flex", alignItems: "center", gap: 10, padding: "6px 16px",
        background: "#2d2d2d", borderBottom: "1px solid rgba(255,255,255,0.08)",
        flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "#c8c8c8",
      }}>
        {/* TOC toggle — only shown when outline exists */}
        {outline.length > 0 && (
          <button
            onClick={() => setTocOpen(v => !v)}
            title={tocOpen ? "Hide contents" : "Show contents"}
            style={{ ...toolBtn, display: "flex", alignItems: "center", gap: 5 }}
          >
            {tocOpen ? <PanelLeftClose size={13} /> : <PanelLeft size={13} />}
          </button>
        )}

        {/* Page navigation */}
        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} style={toolBtn}>‹</button>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <input
            value={inputPage}
            onChange={e => setInputPage(e.target.value)}
            onKeyDown={e => {
              if (e.key !== "Enter") return;
              const page = parsePdfPage(inputPage, numPages);
              if (page === null) {
                setNavigationMessage("Enter a valid PDF page number.");
                return;
              }
              goToPage(page);
            }}
            style={{
              width: 40, textAlign: "center",
              background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 3, color: "#e0e0e0", fontFamily: "inherit", fontSize: 11,
              padding: "2px 4px", outline: "none",
            }}
          />
          <span style={{ opacity: 0.5 }}>/ {numPages || "…"}</span>
        </span>
        <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} style={toolBtn}>›</button>

        <span style={{ flex: 1 }} />

        {/* Zoom */}
        <button onClick={() => zoomBy(-ZOOM_STEP)} disabled={scale <= MIN_SCALE} title="Zoom out (−)" style={toolBtn}>−</button>
        <span style={{ minWidth: 40, textAlign: "center" }}>{Math.round(scale * 100)}%</span>
        <button onClick={() => zoomBy(ZOOM_STEP)} disabled={scale >= MAX_SCALE} title="Zoom in (+)" style={toolBtn}>+</button>
        <button onClick={() => setScale(DEFAULT_SCALE)} title="Reset zoom (0)"
          style={{ ...toolBtn, fontSize: 9, letterSpacing: "0.1em" }}>RESET</button>

        {loading && <span style={{ opacity: 0.5, marginLeft: 8 }}>loading…</span>}
      </div>

      <PdfNavigationFeedback message={navigationMessage} />

      {/* ── Body: TOC sidebar + page area ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* TOC sidebar */}
        <div style={{
          width: showToc ? TOC_WIDTH : 0,
          minWidth: showToc ? TOC_WIDTH : 0,
          transition: "width 0.2s, min-width 0.2s",
          overflow: "hidden",
          background: "#252525",
          borderRight: showToc ? "1px solid rgba(255,255,255,0.08)" : "none",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
        }}>
          {showToc && (
            <>
              {/* TOC header */}
              <div style={{
                padding: "10px 12px 8px",
                borderBottom: "1px solid rgba(255,255,255,0.07)",
                display: "flex", alignItems: "center", gap: 7, flexShrink: 0,
              }}>
                <BookOpen size={12} color="#888" />
                <span style={{
                  fontSize: 10, fontWeight: 700, color: "#777",
                  textTransform: "uppercase", letterSpacing: "0.08em",
                  fontFamily: "var(--font-mono)",
                }}>
                  Contents
                </span>
              </div>

              {/* TOC scroll area */}
              <div style={{ flex: 1, overflowY: "auto", padding: "6px 4px 16px" }}>
                {outline.map((item, i) => (
                  <TocEntry key={i} item={item} depth={0} onNavigate={navigateToDest} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Page scroll area */}
        <div
          ref={containerRef}
          className="pdf-touch-stage"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          style={{
            flex: 1, overflowY: "auto", overflowX: "auto",
            padding: `${PAGE_GAP}px`,
            display: "flex", flexDirection: "column",
            alignItems: "center", gap: `${PAGE_GAP}px`,
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
            overflowAnchor: "none",
            touchAction: "pan-x pan-y",
            outline: "none",
          }}
        >
          {numPages > 0
            ? Array.from({ length: numPages }, (_, i) => {
                const dims = dimsForPage(i + 1);
                return (
                  <div
                    key={i}
                    ref={el => { pageRefs.current[i] = el; }}
                    data-page={i + 1}
                    style={{
                      background: "#fff",
                      boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
                      flexShrink: 0,
                      width: Math.round(dims.w * scale),
                      height: Math.round(dims.h * scale),
                    }}
                  />
                );
              })
            : loading
              ? <div style={{ color: "#888", fontFamily: "var(--font-mono)", fontSize: 11, marginTop: 40 }}>
                  Loading PDF…
                </div>
              : null
          }
        </div>
      </div>
    </div>
  );
}

const toolBtn: React.CSSProperties = {
  background: "rgba(255,255,255,0.07)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  color: "#d0d0d0",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 14,
  lineHeight: 1,
  padding: "3px 8px",
};
