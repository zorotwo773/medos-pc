"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { Copy, ExternalLink, Maximize2, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import MediaActions from "@/components/common/MediaActions";

interface FirstAidSnippetPayload {
  heading_id: number;
  title: string;
  hierarchy: string;
  page: number;
  page_end: number;
  edition: string;
  image_url: string;
  href: string;
  body_text?: string;
}

interface OpenFirstAidDetail {
  heading_id?: number | string;
  heading_ids?: Array<number | string>;
  query?: string;
}

export function openFirstAid(headingId: number | string, headingIds?: Array<number | string>, query?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("medos:open-firstaid", { detail: { heading_id: headingId, heading_ids: headingIds, query } }));
}

function compactCrumb(hierarchy: string, title: string) {
  const parts = (hierarchy || "").split(">").map(part => part.trim()).filter(Boolean);
  if (!parts.length) return title;
  return parts.slice(-3).join(" / ");
}

function cleanHighlightLabel(value: string) {
  return value.replace(/^first aid:\s*/i, "").trim();
}

const MIN_CLIENT_SCALE = 0.55;
const MAX_CLIENT_SCALE = 2.25;

export function firstAidMediaDescriptor(src: string, alt: string) {
  return Object.freeze({
    kind: "image" as const,
    title: alt,
    source: "First Aid",
    sourceUrl: src,
    resourceUrl: src,
  });
}

function clampScale(value: number) {
  return Math.max(MIN_CLIENT_SCALE, Math.min(MAX_CLIENT_SCALE, value));
}

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerMidpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function FirstAidImageViewer({
  src,
  alt,
  zoomed,
  onActivate,
  onToggleZoom,
}: {
  src: string;
  alt: string;
  zoomed: boolean;
  onActivate: () => void;
  onToggleZoom: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({
    dragging: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
    pinchDistance: 0,
    pinchScale: 1,
  });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [clientScale, setClientScale] = useState(1);
  const [dragging, setDragging] = useState(false);

  const resetView = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current.dragging = false;
    gestureRef.current.pinchDistance = 0;
    setDragging(false);
    setClientScale(1);
    window.requestAnimationFrame(() => {
      viewportRef.current?.scrollTo({ left: 0, top: 0 });
    });
  }, []);

  useEffect(() => {
    resetView();
  }, [resetView, src, zoomed]);

  const setScaleAround = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      setClientScale(clampScale(nextScale));
      return;
    }
    const previous = clientScale;
    const next = clampScale(nextScale);
    if (Math.abs(previous - next) < 0.01) return;

    const rect = viewport.getBoundingClientRect();
    const focusX = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const focusY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const contentX = (viewport.scrollLeft + focusX) / previous;
    const contentY = (viewport.scrollTop + focusY) / previous;

    setClientScale(next);
    window.requestAnimationFrame(() => {
      viewport.scrollLeft = contentX * next - focusX;
      viewport.scrollTop = contentY * next - focusY;
    });
  }, [clientScale]);

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (!zoomed) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.002);
      setScaleAround(clientScale * factor, event.clientX, event.clientY);
      return;
    }
    if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      viewport.scrollLeft += event.deltaY;
    }
  }, [clientScale, setScaleAround, zoomed]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    onActivate();
    if (!zoomed) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.setPointerCapture?.(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(pointersRef.current.values());
    if (points.length === 1) {
      gestureRef.current = {
        ...gestureRef.current,
        dragging: true,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        pinchDistance: 0,
        pinchScale: clientScale,
      };
      setDragging(true);
    } else if (points.length >= 2) {
      gestureRef.current.dragging = false;
      gestureRef.current.pinchDistance = pointerDistance(points[0], points[1]);
      gestureRef.current.pinchScale = clientScale;
      setDragging(false);
    }
  }, [clientScale, onActivate, zoomed]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!zoomed || !pointersRef.current.has(event.pointerId)) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2 && gestureRef.current.pinchDistance > 0) {
      event.preventDefault();
      const midpoint = pointerMidpoint(points[0], points[1]);
      const distance = pointerDistance(points[0], points[1]);
      setScaleAround(gestureRef.current.pinchScale * (distance / gestureRef.current.pinchDistance), midpoint.x, midpoint.y);
      return;
    }
    if (points.length === 1 && gestureRef.current.dragging) {
      event.preventDefault();
      viewport.scrollLeft = gestureRef.current.scrollLeft - (event.clientX - gestureRef.current.startX);
      viewport.scrollTop = gestureRef.current.scrollTop - (event.clientY - gestureRef.current.startY);
    }
  }, [setScaleAround, zoomed]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (viewport?.hasPointerCapture?.(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    pointersRef.current.delete(event.pointerId);
    const points = Array.from(pointersRef.current.values());
    if (!points.length) {
      gestureRef.current.dragging = false;
      gestureRef.current.pinchDistance = 0;
      setDragging(false);
      return;
    }
    gestureRef.current = {
      ...gestureRef.current,
      dragging: true,
      startX: points[0].x,
      startY: points[0].y,
      scrollLeft: viewport?.scrollLeft ?? 0,
      scrollTop: viewport?.scrollTop ?? 0,
      pinchDistance: 0,
      pinchScale: clientScale,
    };
    setDragging(true);
  }, [clientScale]);

  const imageStyle = zoomed && naturalSize.width
    ? { width: Math.max(320, Math.round(naturalSize.width * clientScale)), height: "auto", maxWidth: "none" }
    : undefined;
  const descriptor = useMemo(() => firstAidMediaDescriptor(src, alt), [alt, src]);

  return (
    <div
      ref={viewportRef}
      className={`firstaid-image-viewer ${zoomed ? "is-zoomed" : ""} ${dragging ? "is-dragging" : ""}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={event => {
        event.preventDefault();
        onActivate();
        if (zoomed) {
          setScaleAround(clientScale < 1.35 ? 1.6 : 1, event.clientX, event.clientY);
        } else {
          onToggleZoom();
        }
      }}
      onClick={() => {
        onActivate();
        if (!zoomed) onToggleZoom();
      }}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
          onToggleZoom();
          return;
        }
        if (!zoomed) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        const step = event.shiftKey ? 180 : 80;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          viewport.scrollBy({ left: -step });
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          viewport.scrollBy({ left: step });
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          viewport.scrollBy({ top: -step });
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          viewport.scrollBy({ top: step });
        } else if (event.key === "Home") {
          event.preventDefault();
          viewport.scrollTo({ left: 0, top: 0 });
        } else if (event.key === "End") {
          event.preventDefault();
          viewport.scrollTo({ left: viewport.scrollWidth, top: viewport.scrollHeight });
        }
      }}
      role="button"
      tabIndex={0}
      title={zoomed ? "Drag or scroll to pan" : "Open full page"}
      data-medos-media-pan-active={zoomed ? "true" : undefined}
    >
      <div className="firstaid-image-toolbar" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        {zoomed && (
          <>
          <button type="button" onClick={() => setScaleAround(clientScale / 1.2)} disabled={clientScale <= MIN_CLIENT_SCALE + 0.01} title="Zoom out" aria-label="Zoom out">
            <ZoomOut size={14} />
          </button>
          <button type="button" onClick={resetView} title="Reset view" aria-label="Reset view">
            <RotateCcw size={14} />
          </button>
          <button type="button" onClick={() => setScaleAround(clientScale * 1.2)} disabled={clientScale >= MAX_CLIENT_SCALE - 0.01} title="Zoom in" aria-label="Zoom in">
            <ZoomIn size={14} />
          </button>
          </>
        )}
        <MediaActions descriptor={descriptor} compact />
      </div>
      <img
        src={src}
        alt={alt}
        draggable={!zoomed}
        data-medos-media-title={alt}
        data-medos-media-source="First Aid"
        data-medos-media-source-url={src}
        style={imageStyle}
        onLoad={event => setNaturalSize({
          width: event.currentTarget.naturalWidth,
          height: event.currentTarget.naturalHeight,
        })}
      />
    </div>
  );
}

export default function FirstAidSnippet() {
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [snippet, setSnippet] = useState<FirstAidSnippetPayload | null>(null);
  const [snippets, setSnippets] = useState<FirstAidSnippetPayload[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [highlightLabel, setHighlightLabel] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const backend = getBackendUrl();

  const close = useCallback(() => {
    setOpen(false);
    setZoomed(false);
    setError("");
    setActiveIndex(0);
  }, []);

  const loadSnippets = useCallback(async (headingIds: number[]) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setOpen(true);
    setLoading(true);
    setError("");
    setZoomed(false);
    setActiveIndex(0);
    try {
      const uniqueIds = Array.from(new Set(headingIds.filter(id => Number.isFinite(id) && id > 0))).slice(0, 6);
      const data = await Promise.all(uniqueIds.map(async headingId => {
        const res = await fetch(`${backend}/firstaid/snippet?heading_id=${headingId}`);
        if (!res.ok) throw new Error(`First Aid snippet failed: ${res.status}`);
        return await res.json() as FirstAidSnippetPayload;
      }));
      if (requestId !== requestIdRef.current) return;
      setSnippets(data);
      setSnippet(data[0] || null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Could not load First Aid snippet");
      setSnippet(null);
      setSnippets([]);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenFirstAidDetail>).detail || {};
      const ids = Array.isArray(detail.heading_ids) && detail.heading_ids.length
        ? detail.heading_ids.map(id => Number(id))
        : [Number(detail.heading_id || "")];
      if (!ids.some(id => Number.isFinite(id) && id > 0)) return;
      setHighlightLabel(cleanHighlightLabel(detail.query || ""));
      void loadSnippets(ids);
    };
    window.addEventListener("medos:open-firstaid", handler);
    return () => window.removeEventListener("medos:open-firstaid", handler);
  }, [loadSnippets]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if ((event.key === "+" || event.key === "=") && !event.metaKey && !event.ctrlKey) setZoomed(true);
      if (event.key === "-" && !event.metaKey && !event.ctrlKey) setZoomed(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, open]);

  const copyText = useCallback(() => {
    const text = (snippets.length ? snippets : snippet ? [snippet] : [])
      .map(item => `${item.title} (p. ${item.page})\n${item.body_text || ""}`.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text) return;
    void navigator.clipboard?.writeText(text);
  }, [snippet, snippets]);

  if (!open) return null;

  const visibleSnippets = (snippets.length ? snippets : snippet ? [snippet] : []).filter((item, index, arr) => (
    arr.findIndex(other => other.page === item.page) === index
  ));
  const activeSnippet = visibleSnippets[Math.min(activeIndex, Math.max(visibleSnippets.length - 1, 0))] || snippet;
  const displayedSnippets = zoomed && activeSnippet ? [activeSnippet] : visibleSnippets;
  const fullHref = activeSnippet?.href || (activeSnippet ? `/library?path=USMLE%2FFirst%20Aid%20for%20the%20USMLE%20Step%201%202026.pdf&page=${activeSnippet.page}` : "/library");
  const highlightQuery = cleanHighlightLabel(highlightLabel || snippet?.title || "");
  const highlightParam = encodeURIComponent(highlightQuery);
  const pageLabel = activeSnippet
    ? `${visibleSnippets.length > 1 ? `${Math.min(activeIndex + 1, visibleSnippets.length)}/${visibleSnippets.length} · ` : ""}p. ${activeSnippet.page}${activeSnippet.page_end && activeSnippet.page_end !== activeSnippet.page ? `-${activeSnippet.page_end}` : ""}`
    : "";

  return (
    <div
      className="firstaid-snippet-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={event => {
        if (panelRef.current && !panelRef.current.contains(event.target as Node)) close();
      }}
    >
      <div ref={panelRef} className={`firstaid-snippet-panel ${zoomed ? "is-zoomed" : ""}`}>
        <header className="firstaid-snippet-header">
          <div>
            <span className="firstaid-snippet-crumb">
              {snippet ? compactCrumb(snippet.hierarchy, snippet.title) : "First Aid"}
            </span>
            <strong>{snippet?.title || "First Aid"}{pageLabel ? <em>{pageLabel}</em> : null}</strong>
          </div>
          <div className="firstaid-snippet-header-actions">
            <span className="firstaid-snippet-edition">FA {snippet?.edition || "2026"}</span>
            <button type="button" onClick={copyText} disabled={!snippet?.body_text} title="Copy text" aria-label="Copy text">
              <Copy size={16} />
            </button>
            <a href={fullHref} onClick={close} title="Open full page" aria-label="Open full page">
              <ExternalLink size={16} />
            </a>
            <button type="button" onClick={() => setZoomed(value => !value)} title={zoomed ? "Fit snippet" : "Zoom snippet"} aria-label={zoomed ? "Fit snippet" : "Zoom snippet"}>
              {zoomed ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" onClick={close} title="Close" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        <div ref={bodyRef} className="firstaid-snippet-body">
          {loading ? (
            <div className="firstaid-snippet-state">Loading First Aid...</div>
          ) : error ? (
            <div className="firstaid-snippet-state is-error">{error}</div>
          ) : snippet ? (
            <div className="firstaid-snippet-stack">
              {displayedSnippets.map(item => {
                const sourceIndex = Math.max(0, visibleSnippets.findIndex(other => other.heading_id === item.heading_id));
                const imageMode = zoomed || sourceIndex === 0 ? "page" : "region";
                const imageSrc = `${backend}/firstaid/snippet/image?heading_id=${item.heading_id}&zoom=${zoomed ? 3 : 2}&mode=${imageMode}${highlightParam ? `&highlight=${highlightParam}` : ""}`;
                return (
                  <section key={item.heading_id} className={`firstaid-snippet-card ${sourceIndex === 0 || zoomed ? "is-primary" : "is-secondary"}`}>
                    {visibleSnippets.length > 1 && !zoomed && (
                      <header>
                        <span>{sourceIndex + 1}</span>
                        <strong>{item.title}</strong>
                        <em>p. {item.page}</em>
                      </header>
                    )}
                    <FirstAidImageViewer
                      src={imageSrc}
                      alt={`${item.title} from First Aid page ${item.page}`}
                      zoomed={zoomed}
                      onActivate={() => {
                        setSnippet(item);
                        setActiveIndex(sourceIndex);
                        bodyRef.current?.scrollTo({ left: 0, top: 0 });
                      }}
                      onToggleZoom={() => setZoomed(value => !value)}
                    />
                  </section>
                );
              })}
            </div>
          ) : null}
        </div>

      </div>
    </div>
  );
}
