"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Highlighter, Loader2, Trash2, X } from "lucide-react";
import {
  createAnnotation,
  deleteAnnotation,
  fetchAnnotations,
  updateAnnotation,
  type CustomAnnotation,
} from "@/lib/customLibrary";

export const ANNOTATION_COLORS = [
  { key: "yellow", swatch: "#fde68a", label: "Yellow" },
  { key: "green", swatch: "#bbf7d0", label: "Green" },
  { key: "blue", swatch: "#bfdbfe", label: "Blue" },
  { key: "pink", swatch: "#fbcfe8", label: "Pink" },
  { key: "purple", swatch: "#ddd6fe", label: "Purple" },
] as const;

type SelectionPayload = {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  rect: { top: number; left: number; width: number; height: number };
};

type Popup =
  | { mode: "new"; selection: SelectionPayload }
  | { mode: "edit"; annotation: CustomAnnotation; rect: SelectionPayload["rect"] }
  | null;

/** Character offsets can legitimately be 0, so avoid the falsy `x || -1` trap. */
function toOffset(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : -1;
}

interface Props {
  source: string;
  refId: string | number | null;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  enabled?: boolean;
}

/**
 * Hosts the annotation UI for one vendor article iframe.
 *
 * The article document lives on the backend origin, so it reports text
 * selections and highlight clicks through postMessage. This component owns the
 * popover (rendered in the host, above the frame) and all persistence through
 * /api/custom/annotations; it then pushes the full highlight list back into the
 * iframe so the article never needs credentials.
 */
export default function AnnotationLayer({ source, refId, iframeRef, enabled = true }: Props) {
  const [annotations, setAnnotations] = useState<CustomAnnotation[]>([]);
  const [popup, setPopup] = useState<Popup>(null);
  const [color, setColor] = useState<string>("yellow");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const annotationsRef = useRef<CustomAnnotation[]>([]);
  annotationsRef.current = annotations;

  const pushMarks = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || refId == null) return;
    win.postMessage(
      {
        type: "medos_apply_annotations",
        source,
        refId: String(refId),
        items: annotationsRef.current,
      },
      "*",
    );
  }, [iframeRef, refId, source]);

  const load = useCallback(async () => {
    if (refId == null) {
      setAnnotations([]);
      return;
    }
    try {
      const items = await fetchAnnotations(source, refId);
      setAnnotations(items);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load highlights");
    }
  }, [refId, source]);

  useEffect(() => {
    setPopup(null);
    void load();
  }, [load]);

  useEffect(() => {
    pushMarks();
  }, [annotations, pushMarks]);

  // A cached article can finish loading before this host attaches its message
  // listener, so the frame's single `ready` ping is missed. Re-send the list a
  // few times after mount/article change so saved highlights always paint.
  useEffect(() => {
    if (!enabled || refId == null) return;
    const timers = [90, 350, 900, 1800].map(ms => window.setTimeout(pushMarks, ms));
    return () => timers.forEach(id => window.clearTimeout(id));
  }, [annotations, enabled, pushMarks, refId]);

  useEffect(() => {
    if (!enabled || refId == null) return;
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.source !== source) return;
      if (data.refId != null && String(data.refId) !== String(refId)) return;

      if (data.type === "medos_annotation_ready") {
        pushMarks();
        return;
      }

      if (data.type === "medos_annotation_selection" && data.rect) {
        setPopup({
          mode: "new",
          selection: {
            start: toOffset(data.start),
            end: toOffset(data.end),
            quote: String(data.quote || ""),
            prefix: String(data.prefix || ""),
            suffix: String(data.suffix || ""),
            rect: data.rect,
          },
        });
        setColor("yellow");
        setNote("");
        setError("");
        return;
      }

      if (data.type === "medos_annotation_click" && data.rect) {
        const annotation = annotationsRef.current.find(item => item.id === String(data.id || ""));
        if (!annotation) return;
        setPopup({ mode: "edit", annotation, rect: data.rect });
        setColor(annotation.color || "yellow");
        setNote(annotation.note || "");
        setError("");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabled, pushMarks, refId, source]);

  const frameRect = iframeRef.current?.getBoundingClientRect();
  const rect = popup ? (popup.mode === "new" ? popup.selection.rect : popup.rect) : null;
  const left = frameRect && rect
    ? Math.min(
        Math.max(8, frameRect.left + rect.left + rect.width / 2 - 160),
        Math.max(8, window.innerWidth - 328),
      )
    : 0;
  const estimatedHeight = popup?.mode === "edit" ? 300 : 260;
  const below = frameRect && rect ? frameRect.top + rect.top + rect.height + 10 : 0;
  const above = frameRect && rect ? frameRect.top + rect.top - estimatedHeight - 10 : 0;
  const top = popup
    ? Math.max(8, below + estimatedHeight > window.innerHeight ? above : below)
    : 0;

  async function saveNew() {
    if (!popup || popup.mode !== "new" || refId == null) return;
    setBusy(true);
    setError("");
    try {
      await createAnnotation({
        source,
        refId,
        quote: popup.selection.quote,
        prefix: popup.selection.prefix,
        suffix: popup.selection.suffix,
        start: popup.selection.start,
        end: popup.selection.end,
        color,
        note: note.trim(),
      });
      await load();
      setPopup(null);
      iframeRef.current?.contentWindow?.postMessage({ type: "medos_clear_selection" }, "*");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the highlight");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!popup || popup.mode !== "edit") return;
    setBusy(true);
    setError("");
    try {
      await updateAnnotation(popup.annotation.id, { color, note: note.trim() });
      await load();
      setPopup(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the highlight");
    } finally {
      setBusy(false);
    }
  }

  async function removeEdit() {
    if (!popup || popup.mode !== "edit") return;
    setBusy(true);
    setError("");
    try {
      await deleteAnnotation(popup.annotation.id);
      await load();
      setPopup(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the highlight");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled || refId == null || !popup) return null;

  const quote = popup.mode === "new" ? popup.selection.quote : popup.annotation.quote;

  return (
    <div
      data-medos-annotation-popover
      style={{
        position: "fixed",
        top,
        left,
        width: 320,
        zIndex: 4000,
        background: "var(--bg-card)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-strong, var(--border))",
        borderRadius: 12,
        boxShadow: "0 18px 44px rgba(15,23,42,0.28)",
        padding: 12,
      }}
      onMouseDown={event => event.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Highlighter size={14} color="#d97706" />
        <strong style={{ fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          {popup.mode === "new" ? "Highlight" : "Edit highlight"}
        </strong>
        <button
          type="button"
          onClick={() => setPopup(null)}
          title="Close"
          style={{
            marginLeft: "auto", background: "none", border: "none", cursor: "pointer",
            color: "var(--text-muted)", display: "flex", padding: 2,
          }}
        >
          <X size={14} />
        </button>
      </div>

      <div
        style={{
          fontSize: 12, lineHeight: 1.45, color: "var(--text-secondary)",
          background: "var(--bg-subtle, rgba(148,163,184,0.12))",
          borderRadius: 7, padding: "7px 9px", marginBottom: 9,
          maxHeight: 74, overflow: "auto",
        }}
      >
        {quote.length > 320 ? `${quote.slice(0, 320)}…` : quote}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
        {ANNOTATION_COLORS.map(item => (
          <button
            key={item.key}
            type="button"
            title={item.label}
            aria-label={`${item.label} highlight`}
            onClick={() => setColor(item.key)}
            style={{
              width: 24, height: 24, borderRadius: 999, cursor: "pointer",
              background: item.swatch,
              border: color === item.key ? "2px solid var(--text-primary)" : "1px solid rgba(15,23,42,0.18)",
              boxShadow: color === item.key ? "0 0 0 2px var(--bg-card)" : "none",
            }}
          />
        ))}
      </div>

      <textarea
        value={note}
        onChange={event => setNote(event.target.value)}
        placeholder="Add a note (optional)"
        rows={3}
        style={{
          width: "100%", resize: "vertical", fontSize: 12.5, lineHeight: 1.45,
          padding: "7px 9px", borderRadius: 7, border: "1px solid var(--border)",
          background: "var(--bg-base)", color: "var(--text-primary)", outline: "none",
          minHeight: 58, maxHeight: 160,
        }}
      />

      {error && (
        <div style={{ marginTop: 7, fontSize: 11.5, color: "var(--red, #ef4444)", fontWeight: 600 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10 }}>
        {popup.mode === "edit" && (
          <button
            type="button"
            onClick={removeEdit}
            disabled={busy}
            title="Delete highlight"
            style={{
              display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer",
              padding: "5px 9px", borderRadius: 7, fontSize: 11.5, fontWeight: 700,
              border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.1)",
              color: "#dc2626",
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
        )}
        <button
          type="button"
          onClick={() => setPopup(null)}
          disabled={busy}
          style={{
            marginLeft: "auto", padding: "5px 11px", borderRadius: 7, cursor: "pointer",
            fontSize: 11.5, fontWeight: 700, border: "1px solid var(--border)",
            background: "transparent", color: "var(--text-secondary)",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={popup.mode === "new" ? saveNew : saveEdit}
          disabled={busy}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5, cursor: busy ? "default" : "pointer",
            padding: "5px 12px", borderRadius: 7, fontSize: 11.5, fontWeight: 800,
            border: "1px solid rgba(217,119,6,0.4)", background: "#d97706", color: "#fff",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy && <Loader2 size={13} className="medos-spin" />}
          {popup.mode === "new" ? "Highlight" : "Save"}
        </button>
      </div>
    </div>
  );
}
