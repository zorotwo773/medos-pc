"use client";
/**
 * MediaViewer — the ONE standardized box for viewing any image, table, exhibit,
 * video, or embedded page anywhere in MedOS. Use this instead of bespoke
 * per-surface modals so the look + controls stay identical app-wide.
 *
 * Style: borderless content on a dim backdrop, easy to close (X / click-away /
 * Esc). Controls: zoom (images), fullscreen, minimize-to-pill, and a source
 * label. The windowed box is resizable (drag its corner).
 *
 * Provide exactly one of: imageUrl | frameUrl | html | children. A video/audio
 * URL passed as imageUrl is auto-detected.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, ZoomIn, ZoomOut, RotateCcw, Maximize2, Minimize2, Minus } from "lucide-react";
import MediaActions from "./MediaActions";
import type { MediaDescriptor } from "@/lib/mediaInterop";

export interface MediaViewerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  source?: string;
  caption?: string;
  imageUrl?: string;
  sourceUrl?: string;
  fileName?: string;
  frameUrl?: string;
  html?: string;
  children?: React.ReactNode;
  mediaDescriptor?: Readonly<MediaDescriptor>;
}

const isVideo = (u = "") => /\.(mp4|webm|mov)(\?|$)/i.test(u);
const isAudio = (u = "") => /\.(mp3|wav|m4a|ogg)(\?|$)/i.test(u);

export function mediaViewerImageDescriptor({ title, source, sourceUrl, imageUrl, fileName }: Pick<MediaViewerProps, "title" | "source" | "sourceUrl" | "imageUrl" | "fileName">) {
  return Object.freeze({
    kind: "image" as const,
    title: title || "MedOS image",
    source: source || "MedOS",
    sourceUrl: sourceUrl || imageUrl || "",
    resourceUrl: imageUrl || "",
    fileName,
  });
}

export default function MediaViewer({
  open, onClose, title, source, caption, imageUrl, sourceUrl, fileName, frameUrl, html, children, mediaDescriptor,
}: MediaViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const pan = useRef({ x: 0, y: 0 });
  const [, force] = useState(0);
  const dragging = useRef<{ x: number; y: number } | null>(null);
  const htmlRootRef = useRef<HTMLDivElement>(null);
  const [renderedTableDescriptor, setRenderedTableDescriptor] = useState<Readonly<MediaDescriptor> | null>(null);

  // Reset transient view state whenever a new item opens.
  useEffect(() => {
    if (open) { setZoom(1); setFullscreen(false); setMinimized(false); pan.current = { x: 0, y: 0 }; }
  }, [open, imageUrl, frameUrl, html]);

  // Esc closes; never trap the key from inputs elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      else if (e.key === "f" && imageUrl) setFullscreen(v => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, imageUrl]);

  const zoomBy = useCallback((d: number) => setZoom(z => Math.min(4, Math.max(0.5, +(z + d).toFixed(2)))), []);
  const resetView = useCallback(() => { setZoom(1); pan.current = { x: 0, y: 0 }; force(n => n + 1); }, []);
  const isImg = !!imageUrl && !isVideo(imageUrl) && !isAudio(imageUrl);
  const inferredDescriptor = useMemo(() => {
    if (isImg) {
      return mediaViewerImageDescriptor({ title, source, sourceUrl, imageUrl, fileName });
    }
    const documentUrl = sourceUrl || frameUrl || "";
    if ((frameUrl || html) && documentUrl) {
      return Object.freeze({
        kind: "document" as const,
        title: title || "MedOS document",
        source: source || "MedOS",
        sourceUrl: documentUrl,
      });
    }
    return null;
  }, [fileName, frameUrl, html, imageUrl, isImg, source, sourceUrl, title]);

  useEffect(() => {
    if (!open || !html || mediaDescriptor?.kind !== "table") {
      setRenderedTableDescriptor(null);
      return;
    }
    const table = htmlRootRef.current?.querySelector("table");
    if (!table) {
      setRenderedTableDescriptor(null);
      return;
    }
    const normalized = window.MedOSMedia?.descriptorFor({
      ...mediaDescriptor,
      element: table,
    });
    setRenderedTableDescriptor(normalized || mediaDescriptor);
  }, [html, mediaDescriptor, open]);

  const descriptor = mediaDescriptor?.kind === "table"
    ? renderedTableDescriptor
    : (mediaDescriptor || inferredDescriptor);

  if (!open) return null;

  // Minimized → a small restore pill, bottom-right, no backdrop.
  if (minimized) {
    return (
      <div style={{ position: "fixed", right: 18, bottom: 18, zIndex: 200, display: "flex", alignItems: "center", gap: 8,
        background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px",
        boxShadow: "0 10px 30px rgba(15,23,42,0.22)", maxWidth: 280 }}>
        <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title || source || "Preview"}
        </span>
        <button onClick={() => setMinimized(false)} title="Restore" style={pillBtn}><Maximize2 size={14} /></button>
        <button onClick={onClose} title="Close" style={pillBtn}><X size={14} /></button>
      </div>
    );
  }

  const body = (() => {
    if (imageUrl && isVideo(imageUrl)) {
      return <video controls autoPlay src={imageUrl} onClick={e => e.stopPropagation()}
        style={{ maxWidth: "100%", maxHeight: "100%", background: "#000", borderRadius: 6 }} />;
    }
    if (imageUrl && isAudio(imageUrl)) {
      return <audio controls autoPlay src={imageUrl} onClick={e => e.stopPropagation()} style={{ width: "min(560px, 90vw)" }} />;
    }
    if (isImg) {
      return (
        <img src={imageUrl} alt={title || ""} draggable={zoom <= 1}
          data-medos-media-title={title || "MedOS image"}
          data-medos-media-source={source || "MedOS"}
          data-medos-media-source-url={sourceUrl || imageUrl}
          data-medos-media-pan-active={zoom > 1 ? "true" : undefined}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => { if (zoom > 1) { dragging.current = { x: e.clientX - pan.current.x, y: e.clientY - pan.current.y }; } }}
          onMouseMove={e => { if (dragging.current) { pan.current = { x: e.clientX - dragging.current.x, y: e.clientY - dragging.current.y }; force(n => n + 1); } }}
          onMouseUp={() => { dragging.current = null; }}
          onMouseLeave={() => { dragging.current = null; }}
          onWheel={e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 0.2 : -0.2); } }}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "#fff", borderRadius: 6,
            transform: `translate(${pan.current.x}px, ${pan.current.y}px) scale(${zoom})`, transformOrigin: "center",
            cursor: zoom > 1 ? (dragging.current ? "grabbing" : "grab") : "default", transition: dragging.current ? "none" : "transform .12s ease" }} />
      );
    }
    if (frameUrl) {
      return <iframe key={frameUrl} src={frameUrl} title={title || "Preview"} onClick={e => e.stopPropagation()}
        style={{ width: "100%", height: "100%", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-card)" }} />;
    }
    if (html) {
      return <div ref={htmlRootRef} className="medos-mediaviewer-html" onClick={e => e.stopPropagation()}
        dangerouslySetInnerHTML={{ __html: html }}
        style={{ width: "100%", height: "100%", overflow: "auto", background: "var(--bg-card)", color: "var(--text-primary)",
          border: "1px solid var(--border)", borderRadius: 6, padding: 14 }} />;
    }
    return <div onClick={e => e.stopPropagation()} style={{ width: "100%", height: "100%", overflow: "auto" }}>{children}</div>;
  })();

  const windowed = !fullscreen && !isImg; // tables/html get a resizable window; images fill the dim area.

  return (
    <div onMouseDown={() => onClose()} style={{ position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(15,23,42,0.72)", backdropFilter: "blur(3px)", display: "flex",
      alignItems: "center", justifyContent: "center", padding: fullscreen ? 0 : 24 }}>

      {/* Controls — fixed top-right, above content */}
      <div onMouseDown={e => e.stopPropagation()} style={{ position: "fixed", top: 16, right: 16, zIndex: 2, display: "flex", flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "calc(100vw - 32px)", gap: 8, alignItems: "center" }}>
        {source && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase",
            color: "var(--text-secondary)", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 999, padding: "5px 9px" }}>
            {source}
          </span>
        )}
        {descriptor && <MediaActions descriptor={descriptor} compact />}
        {isImg && <button style={ctrlBtn} title="Zoom out" onClick={() => zoomBy(-0.2)}><ZoomOut size={15} /></button>}
        {isImg && <button style={ctrlBtn} title="Reset" onClick={resetView}><RotateCcw size={15} /></button>}
        {isImg && <button style={ctrlBtn} title="Zoom in" onClick={() => zoomBy(0.2)}><ZoomIn size={15} /></button>}
        <button style={ctrlBtn} title={fullscreen ? "Exit full screen" : "Full screen"} onClick={() => setFullscreen(v => !v)}>
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button style={ctrlBtn} title="Minimize" onClick={() => setMinimized(true)}><Minus size={15} /></button>
        <button style={ctrlBtn} title="Close (Esc)" onClick={onClose}><X size={15} /></button>
      </div>

      {/* Title / caption — top-left, unobtrusive */}
      {(title || caption) && (
        <div onMouseDown={e => e.stopPropagation()} style={{ position: "fixed", top: 18, left: 20, zIndex: 2, maxWidth: "55vw" }}>
          {title && <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>}
          {caption && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.82)", textShadow: "0 1px 4px rgba(0,0,0,0.5)", marginTop: 2 }}>{caption}</div>}
        </div>
      )}

      <div onMouseDown={e => e.stopPropagation()} style={
        fullscreen
          ? { width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }
          : windowed
            ? { width: "min(980px, 94vw)", height: "min(80vh, 760px)", resize: "both", overflow: "hidden",
                minWidth: 360, minHeight: 260, display: "flex", flexDirection: "column" }
            : { maxWidth: "96vw", maxHeight: "92vh", display: "flex", alignItems: "center", justifyContent: "center" }
      }>
        {body}
      </div>
    </div>
  );
}

const ctrlBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
  width: 32, height: 32, borderRadius: 7, cursor: "pointer",
  background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-primary)",
};
const pillBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 26, height: 26, borderRadius: 6, cursor: "pointer",
  background: "var(--bg-subtle)", border: "1px solid var(--border)", color: "var(--text-secondary)",
};
