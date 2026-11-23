"use client";
/**
 * RelatedRail — persistent right-side panel showing parallel titles
 * in other sources for the currently-viewed article.
 *
 * Usage (in any reader page):
 *   <RelatedRail source="amboss" id="12345" />
 *
 * The component fetches GET /search/related?source=amboss&id=12345
 * and groups results by source (UTD, Books, Q-Bank, etc.).
 *
 * Clicking a result navigates inline (replaces current view).
 * Ctrl+click / middle-click fires a TabBar:open event for new-tab behaviour.
 */
import Link from "next/link";
import { useState, useEffect, type MouseEvent } from "react";
import { getBackendUrl } from "@/lib/api";

interface RelatedItem {
  source:     string;
  id:         string | number;
  title:      string;
  href:       string;
  similarity: number;
}

interface Props {
  source: string;
  id:     string | number;
  /** Optionally collapse to an icon-only strip initially */
  collapsed?: boolean;
  /** Render bare (no aside chrome / no viewport guard) for embedding inside a
   *  host panel — e.g. a tab in the UpToDate reader's side panel. */
  embedded?: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  utd:      "UpToDate",
  amboss:   "AMBOSS",
  uworld:   "UWorld Library",
  qbank:    "UWorld Q-Bank",
  books:    "Books",
  firstaid: "First Aid",
  drugs:    "Drugs",
  diseases: "Diseases",
  calc:     "Calculators",
  anatomy:  "Anatomy",
};
const SOURCE_COLORS: Record<string, string> = {
  utd:      "#0ea5e9",
  amboss:   "#8b5cf6",
  uworld:   "#0d9488",
  qbank:    "#db2777",
  books:    "#d97706",
  firstaid: "#ea580c",
  drugs:    "#64748b",
  diseases: "#dc2626",
  calc:     "#3b4a60",
  anatomy:  "#0891b2",
};

// Stable display order so the rail reads consistently across articles.
const SOURCE_ORDER = ["utd", "amboss", "uworld", "qbank", "books", "firstaid", "drugs", "diseases", "calc", "anatomy"];
function orderedSources(grouped: Record<string, RelatedItem[]>): string[] {
  const keys = Object.keys(grouped);
  return keys.sort((a, b) => {
    const ia = SOURCE_ORDER.indexOf(a), ib = SOURCE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function openInTab(href: string, e: MouseEvent) {
  if (e.ctrlKey || e.metaKey || e.button === 1) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href } }));
  }
}

export default function RelatedRail({ source, id, collapsed: initialCollapsed = false, embedded = false }: Props) {
  const [grouped,   setGrouped]   = useState<Record<string, RelatedItem[]>>({});
  const [loading,   setLoading]   = useState(true);
  const [total,     setTotal]     = useState(0);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  // Side rail only makes sense with horizontal room — hide it on narrow viewports
  // so reader layouts don't get squeezed on phones/tablets.
  const [wide, setWide] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1000px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!source || !id || (!wide && !embedded)) return;
    let cancelled = false;
    setLoading(true);
    setGrouped({});

    fetch(`${getBackendUrl()}/search/related?source=${encodeURIComponent(source)}&id=${encodeURIComponent(String(id))}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        if (cancelled) return;
        setGrouped(data.related || {});
        setTotal(data.total || 0);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [source, id, wide, embedded]);

  const hasContent = total > 0;

  if (!wide && !embedded) return null;

  return (
    <aside style={embedded ? {
      width: "100%",
      maxHeight: "100%",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
    } : {
      width: collapsed ? 32 : 240,
      minWidth: collapsed ? 32 : 240,
      maxHeight: "100%",
      overflowY: "auto",
      borderLeft: "1px solid var(--border)",
      background: "rgba(248,247,244,0.9)",
      display: "flex",
      flexDirection: "column",
      flexShrink: 0,
      transition: "width .2s, min-width .2s",
    }}>
      {/* Header */}
      {!embedded && (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: collapsed ? "12px 6px" : "10px 12px",
        borderBottom: "1px solid var(--border)",
        position: "sticky", top: 0, background: "rgba(248,247,244,0.97)", zIndex: 1,
      }}>
        {!collapsed && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.16em",
            textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600,
          }}>
            Related reading
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? "Expand related reading" : "Collapse"}
          style={{
            background: "none", border: "none", cursor: "pointer",
            padding: 2, color: "var(--text-muted)", lineHeight: 1,
            marginLeft: collapsed ? 0 : "auto",
          }}
        >
          {collapsed ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m9 18 6-6-6-6"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m15 18-6-6 6-6"/>
            </svg>
          )}
        </button>
      </div>
      )}

      {/* Content */}
      {(!collapsed || embedded) && (
        <div style={{ padding: "10px 12px", flex: 1 }}>
          {loading ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>Loading…</div>
          ) : !hasContent ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic", lineHeight: 1.5 }}>
              No linked concepts for this article yet.
            </div>
          ) : (
            orderedSources(grouped).map((src) => {
              const items = grouped[src];
              return (
              <section key={src} style={{ marginBottom: 16 }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 5, marginBottom: 5,
                }}>
                  <span style={{
                    display: "inline-block", width: 5, height: 5, borderRadius: "50%",
                    background: SOURCE_COLORS[src] || "#94a3b8", flexShrink: 0,
                  }} />
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em",
                    textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600,
                  }}>
                    {SOURCE_LABELS[src] || src} ({items.length})
                  </span>
                </div>
                {items.map(item => (
                  <Link
                    key={`${item.source}:${item.id}`}
                    href={item.href}
                    onClick={e => openInTab(item.href, e as unknown as MouseEvent)}
                    style={{
                      display: "block",
                      fontSize: 12, color: "var(--text-secondary)",
                      textDecoration: "none", padding: "3px 0",
                      borderBottom: "1px dashed transparent",
                      transition: "color .12s, border-color .12s",
                      lineHeight: 1.4,
                    }}
                    onMouseEnter={e => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.color = "var(--accent-strong)";
                      el.style.borderBottomColor = "var(--accent-dim)";
                    }}
                    onMouseLeave={e => {
                      const el = e.currentTarget as HTMLElement;
                      el.style.color = "var(--text-secondary)";
                      el.style.borderBottomColor = "transparent";
                    }}
                  >
                    {item.title}
                  </Link>
                ))}
              </section>
              );
            })
          )}
        </div>
      )}
    </aside>
  );
}
