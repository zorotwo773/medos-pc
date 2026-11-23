"use client";
/**
 * Persistent highlighter for the Q-Bank question pane.
 *
 * The stem/explanation HTML is owned by `ReferenceLayer`/`AmbossHtml`, which
 * rewrites text nodes whenever hover references update. Injecting `<mark>`
 * elements there is destructive (they are wiped on the next render), so this
 * overlay paints translucent rectangles above the text instead, keeping the
 * underlying HTML untouched.
 *
 * Anchors are plain-text character offsets plus a quote/prefix/suffix fallback,
 * stored through `/api/custom/annotations` with source `qbank` and
 * refId `<db>:<qid>`. That means highlights survive reloads, question changes
 * and reference re-renders.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Highlighter, Loader2, Trash2, X } from "lucide-react";
import {
  createAnnotation,
  deleteAnnotation,
  fetchAnnotations,
  updateAnnotation,
  type CustomAnnotation,
} from "@/lib/customLibrary";

const SOURCE = "qbank";

const COLORS = [
  { key: "yellow", swatch: "#fde68a", label: "Yellow" },
  { key: "green", swatch: "#bbf7d0", label: "Green" },
  { key: "blue", swatch: "#bfdbfe", label: "Blue" },
  { key: "pink", swatch: "#fbcfe8", label: "Pink" },
  { key: "purple", swatch: "#ddd6fe", label: "Purple" },
] as const;

const FILL: Record<string, string> = {
  yellow: "rgba(250, 204, 21, 0.42)",
  green: "rgba(34, 197, 94, 0.30)",
  blue: "rgba(59, 130, 246, 0.26)",
  pink: "rgba(236, 72, 153, 0.26)",
  purple: "rgba(139, 92, 246, 0.30)",
};

type Box = { top: number; left: number; width: number; height: number };

type SelectionPayload = {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  rect: Box | null;
};

type Popup =
  | { mode: "new"; selection: SelectionPayload }
  | { mode: "edit"; annotation: CustomAnnotation; rect: Box | null }
  | null;

interface HighlightRect {
  id: string;
  color: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Props {
  db: string;
  qid: number | string | null | undefined;
  enabled?: boolean;
  as?: "div" | "main";
  className?: string;
  children: React.ReactNode;
}

/** Origin of the absolutely-positioned overlay's containing block (padding box). */
function contentOrigin(root: HTMLElement) {
  const rect = root.getBoundingClientRect();
  const style = window.getComputedStyle(root);
  return {
    left: rect.left + root.clientLeft + (parseFloat(style.paddingLeft) || 0),
    top: rect.top + root.clientTop + (parseFloat(style.paddingTop) || 0),
  };
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"]);

function textNodesWithin(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function offsetFromPoint(root: HTMLElement, nodes: Text[], node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    let total = 0;
    for (const textNode of nodes) {
      const length = textNode.nodeValue?.length || 0;
      if (textNode === node) return total + Math.max(0, Math.min(offset, length));
      total += length;
    }
  }
  // Element boundary (e.g. a selection that starts on a <p>): measure with a
  // range over the same root. Text inside script/style is excluded by the
  // walker, so this is only a fallback for unusual anchors.
  try {
    const probe = document.createRange();
    probe.selectNodeContents(root);
    probe.setEnd(node, offset);
    return probe.toString().length;
  } catch {
    return 0;
  }
}

function rangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const nodes = textNodesWithin(root);
  if (!nodes.length || end <= start) return null;
  const pointAt = (offset: number) => {
    let total = 0;
    for (const node of nodes) {
      const length = node.nodeValue?.length || 0;
      if (offset <= total + length) return { node, offset: Math.max(0, offset - total) };
      total += length;
    }
    const last = nodes[nodes.length - 1];
    return { node: last, offset: last.nodeValue?.length || 0 };
  };
  const startPoint = pointAt(start);
  const endPoint = pointAt(end);
  try {
    const range = document.createRange();
    range.setStart(startPoint.node, Math.min(startPoint.offset, startPoint.node.nodeValue?.length || 0));
    range.setEnd(endPoint.node, Math.min(endPoint.offset, endPoint.node.nodeValue?.length || 0));
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function resolveRange(root: HTMLElement, annotation: CustomAnnotation): Range | null {
  const quote = annotation.quote || "";
  if (!quote.trim()) return null;
  const nodes = textNodesWithin(root);
  const fullText = nodes.map(node => node.nodeValue || "").join("");

  const start = Number(annotation.start);
  const end = Number(annotation.end);
  if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= fullText.length) {
    if (normalized(fullText.slice(start, end)) === normalized(quote)) {
      const exact = rangeFromOffsets(root, start, end);
      if (exact) return exact;
    }
  }

  // Fallback for re-rendered content: find the quote again, preferring the
  // occurrence whose surrounding prefix/suffix matches the saved anchors.
  const hits: number[] = [];
  let cursor = 0;
  while (hits.length < 40) {
    const index = fullText.indexOf(quote, cursor);
    if (index < 0) break;
    hits.push(index);
    cursor = index + Math.max(1, quote.length);
  }
  if (!hits.length) return null;
  let chosen = hits[0];
  if (hits.length > 1) {
    const prefix = annotation.prefix || "";
    const suffix = annotation.suffix || "";
    const matched = hits.find(index => {
      const before = prefix ? fullText.slice(Math.max(0, index - prefix.length), index) : prefix;
      const after = suffix ? fullText.slice(index + quote.length, index + quote.length + suffix.length) : suffix;
      return (!prefix || before === prefix) && (!suffix || after === suffix);
    });
    if (matched != null) chosen = matched;
  }
  return rangeFromOffsets(root, chosen, chosen + quote.length);
}

function boxOf(range: Range): Box | null {
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0.5 || rect.height > 0.5);
  const first = rects[0] || range.getBoundingClientRect();
  if (!first || (!first.width && !first.height)) return null;
  return { top: first.top, left: first.left, width: first.width, height: first.height };
}

function offsetsOfSelection(
  root: HTMLElement,
  nodes: Text[],
  range: Range,
): { start: number; end: number } {
  return {
    start: offsetFromPoint(root, nodes, range.startContainer, range.startOffset),
    end: offsetFromPoint(root, nodes, range.endContainer, range.endOffset),
  };
}

function payloadFromRange(root: HTMLElement, range: Range): SelectionPayload | null {
  if (range.collapsed) return null;
  if (!root.contains(range.commonAncestorContainer)) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const nodes = textNodesWithin(root);
  const fullText = nodes.map(node => node.nodeValue || "").join("");
  const { start, end } = offsetsOfSelection(root, nodes, range);
  if (end <= start) return null;
  return {
    start,
    end,
    quote,
    prefix: fullText.slice(Math.max(0, start - 40), start),
    suffix: fullText.slice(end, end + 40),
    rect: boxOf(range),
  };
}

function computeRects(root: HTMLElement, annotations: CustomAnnotation[]): HighlightRect[] {
  const origin = contentOrigin(root);
  const output: HighlightRect[] = [];
  for (const annotation of annotations) {
    const range = resolveRange(root, annotation);
    if (!range) continue;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 1 || rect.height < 1) continue;
      output.push({
        id: annotation.id,
        color: annotation.color,
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  return output;
}

export default function QbankHighlightLayer({ db, qid, enabled = true, as = "div", className, children }: Props) {
  const rootRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const annotationsRef = useRef<CustomAnnotation[]>([]);
  const rectsRef = useRef<HighlightRect[]>([]);
  const lastRangeRef = useRef<Range | null>(null);
  const [annotations, setAnnotations] = useState<CustomAnnotation[]>([]);
  const [rects, setRects] = useState<HighlightRect[]>([]);
  const [popup, setPopup] = useState<Popup>(null);
  const [color, setColor] = useState<string>("yellow");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);

  annotationsRef.current = annotations;
  rectsRef.current = rects;
  const refId = qid == null || qid === "" ? null : `${db}:${qid}`;

  useEffect(() => setMounted(true), []);

  const recompute = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    setRects(computeRects(root, annotationsRef.current));
  }, []);

  const load = useCallback(async () => {
    if (!refId) {
      setAnnotations([]);
      return;
    }
    try {
      const items = await fetchAnnotations(SOURCE, refId);
      setAnnotations(items);
    } catch {
      setAnnotations([]);
    }
  }, [refId]);

  useEffect(() => {
    setPopup(null);
    lastRangeRef.current = null;
    setAnnotations([]);
    setRects([]);
    void load();
  }, [load]);

  // Paint after the initial render, after fonts/images settle, and whenever the
  // annotation set changes.
  useEffect(() => {
    recompute();
    if (!enabled) return;
    const timers = [60, 280, 800, 1800, 3200].map(ms => window.setTimeout(recompute, ms));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [annotations, enabled, recompute, refId]);

  // The question HTML is re-rendered by ReferenceLayer when hover terms change.
  // Observing the content (never the overlay) keeps rects in sync.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    let timer: number | null = null;
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        recompute();
      }, 90);
    };
    const observer = new MutationObserver(records => {
      const overlay = overlayRef.current;
      // Repainting the overlay must never re-trigger the observer.
      if (overlay && records.every(record => overlay.contains(record.target as Node))) return;
      schedule();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(root);
    }
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, recompute]);

  const requestHighlight = useCallback((colorKey: string) => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    const selection = window.getSelection();
    const live = selection && selection.rangeCount && !selection.isCollapsed
      ? selection.getRangeAt(0)
      : null;
    const payload = live
      ? payloadFromRange(root, live)
      : lastRangeRef.current
      ? payloadFromRange(root, lastRangeRef.current)
      : null;
    if (!payload) return;
    setPopup({ mode: "new", selection: payload });
    setColor(colorKey in FILL ? colorKey : "yellow");
    setNote("");
    setError("");
  }, [enabled]);

  // The tool-rail "Highlight" button drives this component so both entry points
  // write to the same persistent store.
  useEffect(() => {
    function onRequest(event: Event) {
      const detail = (event as CustomEvent<{ color?: string }>).detail;
      requestHighlight(detail?.color || "yellow");
    }
    window.addEventListener("medos:qbank-highlight", onRequest);
    return () => window.removeEventListener("medos:qbank-highlight", onRequest);
  }, [requestHighlight]);

  useEffect(() => {
    if (!enabled) return;
    function onSelectionEnd(event: Event) {
      // Interacting with the popover itself must never re-open it.
      const target = event.target as Element | null;
      if (target?.closest("[data-qbank-highlight-popover]")) return;
      window.setTimeout(() => {
        const root = rootRef.current;
        if (!root) return;
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        const payload = payloadFromRange(root, range);
        if (!payload) return;
        lastRangeRef.current = range.cloneRange();
        setPopup({ mode: "new", selection: payload });
        setColor("yellow");
        setNote("");
        setError("");
      }, 0);
    }
    document.addEventListener("mouseup", onSelectionEnd);
    document.addEventListener("keyup", onSelectionEnd);
    return () => {
      document.removeEventListener("mouseup", onSelectionEnd);
      document.removeEventListener("keyup", onSelectionEnd);
    };
  }, [enabled]);

  useEffect(() => {
    if (!popup) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-qbank-highlight-popover]")) return;
      if (rootRef.current && target && rootRef.current.contains(target)) return;
      setPopup(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopup(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [popup]);

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!enabled) return;
    const target = event.target as Element | null;
    if (target?.closest("button, a, input, textarea, select, label, [role='button'], [contenteditable='true']")) return;
    if (!window.getSelection()?.isCollapsed) return;
    const root = rootRef.current;
    if (!root) return;
    const origin = contentOrigin(root);
    const x = event.clientX - origin.left;
    const y = event.clientY - origin.top;
    const hit = [...rectsRef.current].reverse().find(rect =>
      x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height);
    if (!hit) return;
    const annotation = annotationsRef.current.find(item => item.id === hit.id);
    if (!annotation) return;
    setPopup({
      mode: "edit",
      annotation,
      rect: { top: event.clientY - 14, left: event.clientX, width: 0, height: 0 },
    });
    setColor(annotation.color || "yellow");
    setNote(annotation.note || "");
    setError("");
  };

  const saveNew = async () => {
    if (!popup || popup.mode !== "new" || !refId) return;
    setBusy(true);
    setError("");
    try {
      const created = await createAnnotation({
        source: SOURCE,
        refId,
        quote: popup.selection.quote,
        prefix: popup.selection.prefix,
        suffix: popup.selection.suffix,
        start: popup.selection.start,
        end: popup.selection.end,
        color,
        note: note.trim(),
      });
      setAnnotations(previous => [...previous, created]);
      setPopup(null);
      lastRangeRef.current = null;
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the highlight");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!popup || popup.mode !== "edit") return;
    setBusy(true);
    setError("");
    try {
      await updateAnnotation(popup.annotation.id, { color, note: note.trim() });
      setAnnotations(previous =>
        previous.map(item => item.id === popup.annotation.id ? { ...item, color, note: note.trim() } : item));
      setPopup(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the highlight");
    } finally {
      setBusy(false);
    }
  };

  const removeEdit = async () => {
    if (!popup || popup.mode !== "edit") return;
    setBusy(true);
    setError("");
    try {
      await deleteAnnotation(popup.annotation.id);
      setAnnotations(previous => previous.filter(item => item.id !== popup.annotation.id));
      setPopup(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the highlight");
    } finally {
      setBusy(false);
    }
  };

  const rect = popup
    ? popup.mode === "new" ? popup.selection.rect : popup.rect
    : null;
  const popupWidth = 320;
  const left = rect && typeof window !== "undefined"
    ? Math.min(Math.max(8, rect.left + rect.width / 2 - popupWidth / 2), Math.max(8, window.innerWidth - popupWidth - 8))
    : 8;
  const estimatedHeight = popup?.mode === "edit" ? 310 : 270;
  const below = rect ? rect.top + rect.height + 10 : 80;
  const above = rect ? rect.top - estimatedHeight - 10 : 80;
  const top = typeof window !== "undefined"
    ? Math.max(8, below + estimatedHeight > window.innerHeight ? above : below)
    : 80;

  const quote = popup
    ? popup.mode === "new" ? popup.selection.quote : popup.annotation.quote
    : "";

  return (
    <>
      {(() => {
        const Tag = as;
        return (
          <Tag
            ref={node => { rootRef.current = node; }}
            className={className ? `qbank-hl-root ${className}` : "qbank-hl-root"}
            onClick={handleClick}
          >
            {children}
            {/* Painted above the text but never receives pointer events; clicks
                are hit-tested from the wrapper so text selection keeps working. */}
            <div ref={overlayRef} className="qbank-hl-overlay" aria-hidden="true">
              {rects.map((item, index) => (
                <span
                  key={`${item.id}:${index}`}
                  className="qbank-hl-rect"
                  style={{
                    left: item.left,
                    top: item.top,
                    width: item.width,
                    height: item.height,
                    background: FILL[item.color] || FILL.yellow,
                  }}
                />
              ))}
            </div>
          </Tag>
        );
      })()}
      {mounted && popup && typeof document !== "undefined" && createPortal(
        <div
          className="qbank-hl-popover"
          data-qbank-highlight-popover
          style={{ top, left, width: popupWidth }}
          onMouseDown={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
        >
          <div className="qbank-hl-popover-head">
            <Highlighter size={14} color="#d97706" />
            <strong>{popup.mode === "new" ? "Highlight" : "Edit highlight"}</strong>
            <button type="button" onClick={() => setPopup(null)} title="Close" aria-label="Close">
              <X size={14} />
            </button>
          </div>

          <div className="qbank-hl-quote">
            {quote.length > 320 ? `${quote.slice(0, 320)}…` : quote}
          </div>

          <div className="qbank-hl-swatches">
            {COLORS.map(item => (
              <button
                key={item.key}
                type="button"
                title={item.label}
                aria-label={`${item.label} highlight`}
                aria-pressed={color === item.key}
                className={color === item.key ? "is-active" : ""}
                style={{ background: item.swatch }}
                onClick={() => setColor(item.key)}
              />
            ))}
          </div>

          <textarea
            value={note}
            onChange={event => setNote(event.target.value)}
            placeholder="Add a note (optional)"
            rows={3}
            className="qbank-hl-note"
          />

          {error && <div className="qbank-hl-error">{error}</div>}

          <div className="qbank-hl-actions">
            {popup.mode === "edit" && (
              <button type="button" className="qbank-hl-delete" onClick={removeEdit} disabled={busy} title="Delete highlight">
                <Trash2 size={13} /> Delete
              </button>
            )}
            <button type="button" className="qbank-hl-cancel" onClick={() => setPopup(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="qbank-hl-save" onClick={popup.mode === "new" ? saveNew : saveEdit} disabled={busy}>
              {busy && <Loader2 size={13} className="medos-spin" />}
              {popup.mode === "new" ? "Highlight" : "Save"}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
