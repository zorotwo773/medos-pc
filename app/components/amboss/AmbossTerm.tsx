"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBackendUrl } from "@/lib/api";

interface TooltipMatch {
  id: number;
  title: string;
  href: string;
  source: "article" | "chapter" | "abbreviation" | string;
}

interface TooltipData {
  term: string;
  expansions: string[];
  matches: TooltipMatch[];
  abstract: string;
}

const cache = new Map<string, TooltipData>();

async function fetchTooltip(term: string): Promise<TooltipData | null> {
  const key = term.trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const r = await fetch(`${getBackendUrl()}/amboss/tooltip?term=${encodeURIComponent(term)}&limit=6`);
    if (!r.ok) return null;
    const d: TooltipData = await r.json();
    cache.set(key, d);
    return d;
  } catch {
    return null;
  }
}

interface AmbossTermProps {
  term: string;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Inline span that underlines its content and shows an AMBOSS-style popup on
 * hover, with multiple suggestion options and a short abstract. Clicking a
 * suggestion navigates to the AMBOSS article.
 */
export function AmbossTerm({ term, children, className }: AmbossTermProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<TooltipData | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const touchPinnedRef = useRef(false);
  const suppressClickUntilRef = useRef(0);

  const closeTooltip = useCallback(() => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    touchPinnedRef.current = false;
    setOpen(false);
  }, []);

  const showAt = useCallback(async (pinByTouch = false) => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    touchPinnedRef.current = pinByTouch;
    setPos({ top: rect.bottom + window.scrollY + 6, left: rect.left + window.scrollX });
    setOpen(true);
    if (!data) {
      const d = await fetchTooltip(term);
      if (d && d.matches.length > 0) setData(d);
      else closeTooltip();
    }
  }, [closeTooltip, data, term]);

  useEffect(() => {
    if (!open || !touchPinnedRef.current) return;
    const closeFromOutsideTouch = (event: PointerEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || tooltipRef.current?.contains(target)) return;
      closeTooltip();
    };
    document.addEventListener("pointerdown", closeFromOutsideTouch);
    document.addEventListener("touchstart", closeFromOutsideTouch, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", closeFromOutsideTouch);
      document.removeEventListener("touchstart", closeFromOutsideTouch);
    };
  }, [closeTooltip, open]);

  const handleEnter = useCallback(() => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    touchPinnedRef.current = false;
    hoverTimer.current = window.setTimeout(showAt, 200);
  }, [showAt]);

  const handleLeave = useCallback(() => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (touchPinnedRef.current) return;
    hoverTimer.current = window.setTimeout(() => setOpen(false), 220);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLSpanElement>) => {
    if (e.pointerType !== "touch") return;
    e.preventDefault();
    e.stopPropagation();
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    suppressClickUntilRef.current = Date.now() + 900;
    void showAt(true);
  }, [showAt]);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLSpanElement>) => {
    if (typeof globalThis.PointerEvent !== "undefined") return;
    e.preventDefault();
    e.stopPropagation();
    if (hoverTimer.current) globalThis.clearTimeout(hoverTimer.current);
    suppressClickUntilRef.current = Date.now() + 900;
    void showAt(true);
  }, [showAt]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (Date.now() < suppressClickUntilRef.current) return;
    if (!data) {
      fetchTooltip(term).then(d => {
        if (d && d.matches[0]) router.push(d.matches[0].href);
      });
    } else if (data.matches[0]) {
      router.push(data.matches[0].href);
    }
  }, [data, term, router]);

  return (
    <>
      <span
        ref={anchorRef}
        onPointerDown={handlePointerDown}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onTouchStart={handleTouchStart}
        onClick={handleClick}
        className={className}
        style={{
          borderBottom: "1px dotted #0ea5e9",
          cursor: "pointer",
          color: "inherit",
        }}
        data-amboss-term={term}
      >
        {children ?? term}
      </span>
      {open && pos && data && (
        <div
          ref={tooltipRef}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          style={{
            position: "absolute",
            top: pos.top,
            left: pos.left,
            zIndex: 9999,
            width: 360,
            maxWidth: "90vw",
            background: "var(--bg-card)",
            border: "1px solid rgba(14,165,233,0.25)",
            borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
            padding: 12,
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            color: "var(--text-primary)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: "0.14em",
              color: "#0ea5e9", textTransform: "uppercase",
            }}>AMBOSS</span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{data.matches[0]?.title || data.term}</span>
          </div>
          {data.expansions.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
              Abbreviation for: <em>{data.expansions.join(", ")}</em>
            </div>
          )}
          {data.abstract && (
            <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-secondary)", marginBottom: 8 }}>
              {data.abstract}
            </div>
          )}
          {data.matches.length > 1 && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Other matches
              </div>
              {data.matches.slice(1, 6).map(m => (
                <button
                  key={m.id}
                  onClick={() => router.push(m.href)}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    border: "none", background: "transparent", padding: "4px 0",
                    fontSize: 12, cursor: "pointer", color: "#0369a1",
                  }}
                >
                  {m.title} <span style={{ color: "var(--text-muted)", fontSize: 10 }}>· {m.source}</span>
                </button>
              ))}
            </div>
          )}
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Click to open article</span>
            <button
              onClick={() => data.matches[0] && router.push(data.matches[0].href)}
              style={{
                border: "none", background: "#0ea5e9", color: "#fff",
                padding: "4px 10px", borderRadius: 6, fontSize: 11,
                cursor: "pointer", fontWeight: 600,
              }}
            >
              Open →
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Wrap an arbitrary string so that every known AMBOSS term / medical
 * abbreviation becomes a live `<AmbossTerm>`. Runs entirely on the client, on
 * demand, after indexing terms from the backend.
 */
// Module-level cache: fetched once per page load, shared across all AmbossAutoText instances.
let _termsCache: string[] | null = null;
let _termsFetch: Promise<string[]> | null = null;

function getAmbossTerms(): Promise<string[]> {
  if (_termsCache) return Promise.resolve(_termsCache);
  if (_termsFetch) return _termsFetch;
  _termsFetch = fetch(`${getBackendUrl()}/amboss/terms`)
    .then(r => r.ok ? r.json() : { terms: [] })
    .then(d => { _termsCache = d.terms || []; return _termsCache!; })
    .catch(() => { _termsFetch = null; return []; });
  return _termsFetch;
}

export function AmbossAutoText({ text, className }: { text: string; className?: string }) {
  const [terms, setTerms] = useState<string[] | null>(_termsCache);

  useEffect(() => {
    if (_termsCache) { setTerms(_termsCache); return; }
    let cancel = false;
    getAmbossTerms().then(t => { if (!cancel) setTerms(t); });
    return () => { cancel = true; };
  }, []);

  if (!terms || terms.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const lower = text.toLowerCase();
  const hits: Array<{ start: number; end: number; term: string }> = [];
  for (const t of terms) {
    if (t.length < 2) continue;
    let idx = 0;
    while ((idx = lower.indexOf(t.toLowerCase(), idx)) !== -1) {
      const before = idx === 0 || /[^a-zA-Z0-9]/.test(text[idx - 1]);
      const after = idx + t.length === text.length || /[^a-zA-Z0-9]/.test(text[idx + t.length]);
      if (before && after) {
        hits.push({ start: idx, end: idx + t.length, term: t });
      }
      idx += t.length;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const dedup: typeof hits = [];
  let last = -1;
  for (const h of hits) {
    if (h.start >= last) {
      dedup.push(h);
      last = h.end;
    }
  }

  const parts: React.ReactNode[] = [];
  let cur = 0;
  dedup.forEach((h, i) => {
    if (h.start > cur) parts.push(<span key={`t${i}`}>{text.slice(cur, h.start)}</span>);
    parts.push(
      <AmbossTerm key={`a${i}`} term={h.term}>
        {text.slice(h.start, h.end)}
      </AmbossTerm>
    );
    cur = h.end;
  });
  if (cur < text.length) parts.push(<span key="tail">{text.slice(cur)}</span>);
  return <span className={className}>{parts}</span>;
}
