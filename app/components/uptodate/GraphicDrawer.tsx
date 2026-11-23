"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type WheelEvent,
} from "react";
import {
  ImageOff,
  Loader2,
  Maximize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import { useDoubleTap, usePinchZoom } from "@/lib/useTouchGestures";
import MediaActions from "@/components/common/MediaActions";

interface Props {
  graphicId: number;
  onClose: () => void;
}

interface GraphicMeta {
  title?: string;
  caption?: string;
  legendText?: string;
  type?: string;
  imageHtml?: string;
}

const MIN_ZOOM = 0.65;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.15;

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function zoomText(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function graphicMediaDescriptor({
  base,
  graphicId,
  label,
  htmlTable,
  resourceUrl,
}: {
  base: string;
  graphicId: number;
  label: string;
  htmlTable: HTMLTableElement | null;
  resourceUrl?: string | null;
}) {
  const graphicUrl = `${base}/utd/graphic/${graphicId}`;
  if (htmlTable) {
    return Object.freeze({
      kind: "table" as const,
      title: label,
      source: "UpToDate",
      sourceUrl: `${graphicUrl}/html`,
      element: htmlTable,
    });
  }
  return Object.freeze({
    kind: "image" as const,
    title: label,
    source: "UpToDate",
    sourceUrl: graphicUrl,
    resourceUrl: resourceUrl && !resourceUrl.startsWith("blob:") ? resourceUrl : graphicUrl,
  });
}

export async function loadGraphicImage({
  imageUrl,
  thumbUrl,
  fetchImpl = fetch,
  allowThumbnail = true,
}: {
  imageUrl: string;
  thumbUrl: string;
  fetchImpl?: typeof fetch;
  allowThumbnail?: boolean;
}) {
  const primary = await fetchImpl(imageUrl).catch(() => null);
  if (primary?.ok) return { response: primary, resourceUrl: imageUrl };
  if (!allowThumbnail) return null;
  const thumbnail = await fetchImpl(thumbUrl).catch(() => null);
  return thumbnail?.ok ? { response: thumbnail, resourceUrl: thumbUrl } : null;
}

export default function GraphicDrawer({ graphicId, onClose }: Props) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imageResourceUrl, setImageResourceUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<GraphicMeta | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");
  const [htmlTable, setHtmlTable] = useState<HTMLTableElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const base = getBackendUrl();
  const imageUrl = `${base}/utd/graphic/${graphicId}`;
  const metaUrl = `${base}/utd/graphic/${graphicId}/meta`;
  const thumbUrl = `${base}/utd/thumb/${graphicId}`;

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isEditing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (isEditing) return;

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom(prev => clampZoom(prev + ZOOM_STEP));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom(prev => clampZoom(prev - ZOOM_STEP));
      } else if (e.key === "0") {
        e.preventDefault();
        resetView();
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    setImgSrc(null);
    setImageResourceUrl(null);
    setMeta(null);
    setLoadState("loading");
    setHtmlTable(null);
    setZoom(1);
    stageRef.current?.scrollTo({ top: 0, left: 0 });

    let cancelled = false;
    let objectUrl: string | null = null;

    async function load() {
      let metaData: GraphicMeta | null = null;
      try {
        const metaResp = await fetch(metaUrl);
        if (metaResp.ok) {
          metaData = await metaResp.json();
          if (!cancelled && metaData) setMeta(metaData);
        }
      } catch {
        /* metadata is optional */
      }

      const loadedImage = await loadGraphicImage({
        imageUrl,
        thumbUrl,
        allowThumbnail: !metaData?.imageHtml,
      });
      if (cancelled) return;

      if (loadedImage) {
        const blob = await loadedImage.response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImgSrc(objectUrl);
        setImageResourceUrl(loadedImage.resourceUrl);
        setLoadState("ok");
        return;
      }

      if (metaData?.imageHtml) {
        setLoadState("ok");
        return;
      }

      setLoadState("error");
    }

    void load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [graphicId, imageUrl, metaUrl, thumbUrl]);

  const label = meta?.title || meta?.caption || `Figure / Table #${graphicId}`;
  const caption = meta?.caption || meta?.legendText;
  const hasHtml = loadState === "ok" && !imgSrc && !!meta?.imageHtml;
  const descriptor = useMemo(() => graphicMediaDescriptor({
    base,
    graphicId,
    label,
    htmlTable: hasHtml ? htmlTable : null,
    resourceUrl: imageResourceUrl,
  }), [base, graphicId, hasHtml, htmlTable, imageResourceUrl, label]);

  function adjustZoom(delta: number) {
    setZoom(prev => clampZoom(prev + delta));
  }

  function resetView() {
    setZoom(1);
    requestAnimationFrame(() => {
      stageRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    });
  }

  function overviewView() {
    setZoom(MIN_ZOOM);
    requestAnimationFrame(() => {
      stageRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    });
  }

  const setGestureZoom = useCallback((next: number) => {
    setZoom(clampZoom(next));
  }, []);

  const toggleTouchZoom = useCallback(() => {
    setZoom(current => current < 1.8 ? clampZoom(1.8) : 1);
  }, []);

  const captureHtmlTable = useCallback((node: HTMLDivElement | null) => {
    const table = node?.querySelector("table") || null;
    setHtmlTable(current => current === table ? current : table);
  }, []);

  usePinchZoom(stageRef, {
    value: zoom,
    min: MIN_ZOOM,
    max: MAX_ZOOM,
    onChange: setGestureZoom,
    ignoreSelector: ".utd-graphic-controls",
  });

  useDoubleTap(stageRef, toggleTouchZoom, {
    ignoreSelector: ".utd-graphic-controls",
  });

  function handleStageWheel(e: WheelEvent<HTMLDivElement>) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  const zoomStyle = {
    "--utd-graphic-zoom": zoom,
    zoom,
  } as CSSProperties & { zoom: number };

  return (
    <>
      <div className="utd-graphic-backdrop" onClick={onClose} />

      <section
        className="utd-graphic-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={e => e.stopPropagation()}
      >
        <header className="utd-graphic-header">
          <div className="utd-graphic-title-block">
            <span className="utd-graphic-kicker">UpToDate visual</span>
            <h2>{label}</h2>
          </div>

          <div className="utd-graphic-controls" aria-label="Graphic controls">
            {loadState === "ok" && (!hasHtml || htmlTable) && (
              <MediaActions descriptor={descriptor} compact />
            )}
            <button
              type="button"
              onClick={() => adjustZoom(-ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut size={16} />
            </button>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.05}
              value={zoom}
              onChange={e => setZoom(clampZoom(Number(e.target.value)))}
              aria-label="Zoom"
            />
            <button
              type="button"
              onClick={() => adjustZoom(ZOOM_STEP)}
              disabled={zoom >= MAX_ZOOM}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn size={16} />
            </button>
            <span className="utd-graphic-zoom-readout">{zoomText(zoom)}</span>
            <button type="button" onClick={overviewView} title="Overview zoom" aria-label="Overview zoom">
              <Maximize2 size={16} />
            </button>
            <button type="button" onClick={resetView} title="Reset view" aria-label="Reset view">
              <RotateCcw size={16} />
            </button>
            <button type="button" className="utd-graphic-close" onClick={onClose} title="Close" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="utd-graphic-stage" ref={stageRef} onWheel={handleStageWheel}>
          {loadState === "loading" && (
            <div className="utd-graphic-state">
              <Loader2 size={30} style={{ animation: "utdGraphicSpin 1s linear infinite" }} />
              <span>Decrypting graphic...</span>
            </div>
          )}

          {loadState === "error" && (
            <div className="utd-graphic-state">
              <div className="utd-graphic-state-icon">
                <ImageOff size={30} />
              </div>
              <p>
                Graphic could not be loaded.
                <small>Try reopening it or restart MedOS if the local library is still starting.</small>
              </p>
            </div>
          )}

          {loadState === "ok" && imgSrc && (
            <div
              className="utd-graphic-zoom-content"
              style={zoomStyle}
              data-medos-media-pan-active={zoom > 1 ? "true" : undefined}
            >
              <figure className="utd-graphic-figure">
                <img
                  src={imgSrc}
                  alt={label}
                  className="utd-graphic-image"
                  draggable={zoom <= 1}
                  data-medos-media-title={label}
                  data-medos-media-source="UpToDate"
                  data-medos-media-source-url={imageUrl}
                />
                {caption && <figcaption>{caption}</figcaption>}
              </figure>
            </div>
          )}

          {hasHtml && (
            <div
              className="utd-graphic-zoom-content is-html"
              style={zoomStyle}
              data-medos-media-pan-active={zoom > 1 ? "true" : undefined}
            >
              <div
                ref={captureHtmlTable}
                className="utd-graphic-html"
                dangerouslySetInnerHTML={{ __html: meta?.imageHtml || "" }}
              />
            </div>
          )}
        </div>
      </section>

      <style>{`
        @keyframes utdGraphicSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .utd-graphic-backdrop {
          position: fixed;
          inset: 0;
          z-index: 1000 !important;
          background: rgba(6, 12, 24, 0.68);
          backdrop-filter: blur(2px);
        }

        .utd-graphic-drawer {
          position: fixed;
          inset: 18px;
          z-index: 1001 !important;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          width: auto;
          background: #f7f9fc;
          border: 1px solid rgba(216, 226, 240, 0.92);
          border-radius: 10px;
          box-shadow: 0 24px 80px rgba(2, 6, 23, 0.32);
        }

        .utd-graphic-header {
          min-height: 58px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 10px 12px 10px 16px;
          border-bottom: 1px solid rgba(216, 226, 240, 0.96);
          background: rgba(255, 255, 255, 0.96);
        }

        .utd-graphic-title-block {
          min-width: 0;
          display: grid;
          gap: 2px;
        }

        .utd-graphic-title-block h2 {
          margin: 0;
          overflow: hidden;
          color: var(--text-primary);
          font-size: 15px;
          font-weight: 700;
          line-height: 1.25;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .utd-graphic-kicker {
          color: #00857c;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }

        .utd-graphic-controls {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .utd-graphic-controls button {
          width: 32px;
          height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(148, 163, 184, 0.45);
          border-radius: 7px;
          background: #fff;
          color: #334155;
          cursor: pointer;
        }

        .utd-graphic-controls button:hover:not(:disabled) {
          border-color: rgba(0, 133, 124, 0.45);
          color: #00756e;
          background: rgba(0, 133, 124, 0.06);
        }

        .utd-graphic-controls button:disabled {
          cursor: default;
          color: #cbd5e1;
          background: #f8fafc;
        }

        .utd-graphic-controls input[type="range"] {
          width: 124px;
          accent-color: #00857c;
        }

        .utd-graphic-close {
          margin-left: 4px;
        }

        .utd-graphic-zoom-readout {
          min-width: 44px;
          color: #475569;
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          font-weight: 700;
          text-align: center;
        }

        .utd-graphic-stage {
          flex: 1;
          min-height: 0;
          overflow: auto;
          overscroll-behavior: contain;
          touch-action: pan-x pan-y;
          -webkit-overflow-scrolling: touch;
          padding: 18px;
          background:
            linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            #eef3f8;
          background-size: 22px 22px;
        }

        .utd-graphic-zoom-content {
          width: fit-content;
          min-width: min(100%, 980px);
          max-width: none;
          margin: 0 auto;
          transform-origin: top center;
        }

        .utd-graphic-zoom-content.is-html {
          min-width: min(100%, 1120px);
        }

        .utd-graphic-figure {
          width: fit-content;
          min-width: min(100%, 760px);
          max-width: 100%;
          margin: 0 auto;
          padding: 14px;
          border: 1px solid rgba(203, 213, 225, 0.9);
          border-radius: 8px;
          background: #fff;
          box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
        }

        .utd-graphic-image {
          display: block;
          max-width: min(100%, 1600px);
          max-height: none;
          object-fit: contain;
          user-select: none;
        }

        .utd-graphic-figure figcaption {
          max-width: 980px;
          margin: 12px 0 0;
          padding-top: 10px;
          border-top: 1px solid rgba(226, 232, 240, 0.94);
          color: #475569;
          font-size: 12px;
          line-height: 1.6;
        }

        .utd-graphic-html {
          min-width: min(1120px, calc(100vw - 84px));
          padding: 16px;
          border: 1px solid rgba(203, 213, 225, 0.9);
          border-radius: 8px;
          background: #fff;
          box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08);
          color: #0f172a;
          font-size: 13px;
          line-height: 1.5;
        }

        .utd-graphic-html img {
          max-width: 100%;
          height: auto;
        }

        .utd-graphic-html table,
        .utd-graphic-html .table-default-style,
        .utd-graphic-html .table-header-footer-style,
        .utd-graphic-html .table-footer-only-style {
          width: 100%;
          min-width: 880px;
          border-collapse: collapse;
          color: #0f172a;
          font-size: 12px;
          line-height: 1.45;
        }

        .utd-graphic-html th,
        .utd-graphic-html td {
          border: 1px solid #d8e2f0;
          padding: 8px 10px;
          vertical-align: top;
        }

        .utd-graphic-html th {
          background: #f8fafc;
          color: #1e293b;
          font-weight: 700;
        }

        .utd-graphic-html .ttl {
          margin: 0 0 14px;
          color: #0f172a;
          font-size: 15px;
          font-weight: 700;
          line-height: 1.35;
        }

        .utd-graphic-html .graphic_footnotes {
          margin-top: 14px;
          padding-top: 12px;
          border-top: 1px solid #d8e2f0;
          color: #475569;
          font-size: 11px;
          line-height: 1.6;
        }

        html[data-theme="dark"] .utd-graphic-drawer {
          background: var(--bg-card);
          border-color: var(--border);
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.54);
        }

        html[data-theme="dark"] .utd-graphic-header {
          background: rgba(15, 23, 42, 0.96);
          border-bottom-color: var(--border);
        }

        html[data-theme="dark"] .utd-graphic-controls button {
          background: var(--bg-subtle);
          border-color: var(--border);
          color: var(--text-primary);
        }

        html[data-theme="dark"] .utd-graphic-controls button:hover:not(:disabled) {
          background: rgba(45, 212, 191, 0.12);
          border-color: rgba(45, 212, 191, 0.4);
          color: #67e8f9;
        }

        html[data-theme="dark"] .utd-graphic-controls button:disabled {
          background: rgba(15, 23, 42, 0.72);
          color: var(--text-muted);
        }

        html[data-theme="dark"] .utd-graphic-zoom-readout,
        html[data-theme="dark"] .utd-graphic-state,
        html[data-theme="dark"] .utd-graphic-state p,
        html[data-theme="dark"] .utd-graphic-state small {
          color: var(--text-secondary);
        }

        html[data-theme="dark"] .utd-graphic-stage {
          background:
            linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            var(--bg-base);
          background-size: 22px 22px;
        }

        html[data-theme="dark"] .utd-graphic-figure,
        html[data-theme="dark"] .utd-graphic-html {
          background: var(--bg-card) !important;
          border-color: var(--border) !important;
          color: var(--text-primary) !important;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.32);
        }

        html[data-theme="dark"] .utd-graphic-figure figcaption {
          border-top-color: var(--border);
          color: var(--text-secondary);
        }

        html[data-theme="dark"] .utd-graphic-html table,
        html[data-theme="dark"] .utd-graphic-html thead,
        html[data-theme="dark"] .utd-graphic-html tbody,
        html[data-theme="dark"] .utd-graphic-html tfoot,
        html[data-theme="dark"] .utd-graphic-html tr,
        html[data-theme="dark"] .utd-graphic-html .table-default-style,
        html[data-theme="dark"] .utd-graphic-html .table-header-footer-style,
        html[data-theme="dark"] .utd-graphic-html .table-footer-only-style {
          background: var(--bg-card) !important;
          border-color: var(--border-strong) !important;
          color: var(--text-primary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html th,
        html[data-theme="dark"] .utd-graphic-html td {
          background: var(--bg-card) !important;
          border-color: var(--border-strong) !important;
          color: var(--text-primary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html th,
        html[data-theme="dark"] .utd-graphic-html thead td {
          background: var(--bg-subtle) !important;
          color: var(--text-primary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html th *,
        html[data-theme="dark"] .utd-graphic-html td * {
          background: transparent !important;
          color: inherit !important;
          border-color: inherit !important;
        }

        html[data-theme="dark"] .utd-graphic-html tr:nth-child(even) td {
          background: rgba(30, 41, 59, 0.72) !important;
        }

        html[data-theme="dark"] .utd-graphic-html p,
        html[data-theme="dark"] .utd-graphic-html div,
        html[data-theme="dark"] .utd-graphic-html span,
        html[data-theme="dark"] .utd-graphic-html em,
        html[data-theme="dark"] .utd-graphic-html strong,
        html[data-theme="dark"] .utd-graphic-html li,
        html[data-theme="dark"] .utd-graphic-html .ttl {
          color: var(--text-primary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html a {
          color: #7dd3fc !important;
        }

        html[data-theme="dark"] .utd-graphic-html .graphic_footnotes {
          border-top-color: var(--border);
          color: var(--text-secondary) !important;
        }

        html[data-theme="dark"] .utd-graphic-html .graphic_footnotes,
        html[data-theme="dark"] .utd-graphic-html .graphic_footnotes * {
          color: var(--text-secondary) !important;
        }

        .utd-graphic-state {
          min-height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: #64748b;
          text-align: center;
        }

        .utd-graphic-state-icon {
          width: 68px;
          height: 68px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(0, 133, 124, 0.18);
          border-radius: 16px;
          background: rgba(0, 133, 124, 0.08);
          color: #00857c;
        }

        .utd-graphic-state p {
          margin: 0;
          color: #475569;
          font-size: 13px;
          line-height: 1.55;
        }

        .utd-graphic-state small {
          display: block;
          margin-top: 4px;
          color: #64748b;
          font-size: 11px;
        }

        @media (max-width: 720px) {
          .utd-graphic-drawer {
            inset: 0;
            border: 0;
            border-radius: 0;
          }

          .utd-graphic-header {
            min-height: 96px;
            align-items: stretch;
            flex-direction: column;
            gap: 9px;
            padding: calc(8px + env(safe-area-inset-top, 0px)) 10px 8px;
          }

          .utd-graphic-title-block h2 {
            font-size: 13px;
            white-space: normal;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
          }

          .utd-graphic-controls {
            width: 100%;
            gap: 5px;
          }

          .utd-graphic-controls input[type="range"] {
            flex: 1;
            min-width: 72px;
          }

          .utd-graphic-controls button {
            width: 34px;
            height: 34px;
          }

          .utd-graphic-stage {
            padding: 10px;
          }

          .utd-graphic-html {
            min-width: 760px;
            padding: 12px;
          }

          .utd-graphic-html table,
          .utd-graphic-html .table-default-style,
          .utd-graphic-html .table-header-footer-style,
          .utd-graphic-html .table-footer-only-style {
            min-width: 720px;
          }
        }
      `}</style>
    </>
  );
}
