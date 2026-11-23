"use client";

/**
 * UtdDdxRoot — the UpToDate DDx reader.
 *
 * Article-first: a selected presenting diagnosis and its differential list fill
 * the main column; the index (live search + a lettered A–Z browse from
 * /utdddx/browse) is a panel on the RIGHT. Each differential shows the
 * distinguishing SIGNS and TESTS. The differential block renders through
 * <AmbossHtml source="utdddx"> for UMLS hover underlines.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getBackendUrl } from "@/lib/api";
import { AmbossHtml } from "@/components/amboss/AmbossHtml";

type Hit = { id: number; title: string; is_main: boolean; differential_count: number; href: string };
type BrowseTopic = { id: number; title: string; differential_count: number; href: string };
type Differential = { diagnosis: string; signs: string; tests: string };
type Topic = { id: number; title: string; is_main: boolean; differential_count: number; differentials: Differential[] };

/* Material Symbol glyph — matches the app-wide icon component (Sidebar.tsx). */
function M({ name, size = 20, fill = false, color, style }: { name: string; size?: number; fill?: boolean; color?: string; style?: React.CSSProperties }) {
  return (
    <span className="material-symbols-outlined" aria-hidden="true"
      style={{ fontSize: size, color, lineHeight: 1, flexShrink: 0,
        fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 320, 'GRAD' 0, 'opsz' ${size}`, ...style }}>
      {name}
    </span>
  );
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build the differential list as one HTML block (rendered via AmbossHtml). */
function buildDdxHtml(topic: Topic): string {
  if (!topic.differentials.length) return `<p class="ddx-empty">No differential entries for this diagnosis.</p>`;
  const cards = topic.differentials.map((d, i) => `
    <section class="ddx-card">
      <div class="ddx-card-head"><span class="ddx-num">${i + 1}</span><h3>${esc(d.diagnosis)}</h3></div>
      ${d.signs ? `<div class="ddx-field"><span class="ddx-label ddx-label-signs">Distinguishing signs</span><p>${esc(d.signs)}</p></div>` : ""}
      ${d.tests ? `<div class="ddx-field"><span class="ddx-label ddx-label-tests">Tests</span><p>${esc(d.tests)}</p></div>` : ""}
    </section>`).join("");
  return `<div class="ddx-list">${cards}</div>`;
}

export default function UtdDdxRoot() {
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get("id");

  const [index, setIndex] = useState<BrowseTopic[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = getBackendUrl();

  useEffect(() => {
    fetch(`${base}/utdddx/browse?limit=1000`).then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.topics && setIndex(d.topics)).catch(() => {});
  }, [base]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    searchTimer.current = setTimeout(() => {
      fetch(`${base}/utdddx/search?q=${encodeURIComponent(q)}&limit=50`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => setResults(d?.results ?? [])).catch(() => setResults([]));
    }, 170);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, base]);

  useEffect(() => {
    if (!activeId) { setTopic(null); return; }
    setLoading(true);
    fetch(`${base}/utdddx/topic/${activeId}`).then((r) => (r.ok ? r.json() : null))
      .then((d) => setTopic(d)).catch(() => setTopic(null)).finally(() => setLoading(false));
  }, [activeId, base]);

  const openTopic = useCallback((id: number) => router.push(`/utdddx?id=${id}`), [router]);

  const lettered = useMemo(() => {
    const map = new Map<string, BrowseTopic[]>();
    for (const t of index) {
      const L = (t.title[0] || "#").toUpperCase();
      const key = /[A-Z]/.test(L) ? L : "#";
      (map.get(key) ?? map.set(key, []).get(key)!).push(t);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [index]);

  const bodyHtml = useMemo(() => (topic ? buildDdxHtml(topic) : ""), [topic]);
  const searching = query.trim().length >= 2;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, height: "100%", background: "var(--bg-base)" }}>
      {/* ── Differential view (left / main) ────────────────────────── */}
      <main style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
        ) : topic ? (
          <div style={{ maxWidth: 840, margin: "0 auto", padding: "30px 40px 90px" }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999,
              fontSize: 11, fontWeight: 700, letterSpacing: 0.2, marginBottom: 8,
              color: "var(--mod-utdddx)", background: "color-mix(in srgb, var(--mod-utdddx) 13%, transparent)",
            }}><M name="account_tree" size={14} color="currentColor" />{topic.differential_count} differentials</span>
            <h1 style={{ fontSize: 28, fontWeight: 750, color: "var(--text-primary)", margin: "0 0 6px", letterSpacing: -0.3 }}>{topic.title}</h1>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 22px" }}>Differential diagnosis — distinguishing signs &amp; tests for each candidate.</p>
            <AmbossHtml className="utdddx-body medos-reader-html" html={bodyHtml} source="utdddx" sourceId={String(topic.id)} />
          </div>
        ) : (
          <Welcome count={index.length} />
        )}
      </main>

      {/* ── Index (right panel) ────────────────────────────────────── */}
      <aside style={{
        width: 336, minWidth: 300, borderLeft: "1px solid var(--border)",
        display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-elevated)",
      }}>
        <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 13 }}>
            <span style={{
              width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
              background: "color-mix(in srgb, var(--mod-utdddx) 15%, transparent)", color: "var(--mod-utdddx)",
            }}><M name="account_tree" size={22} fill /></span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 750, color: "var(--text-primary)", fontSize: 15.5, lineHeight: 1.15 }}>UpToDate DDx</div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Differential diagnosis · {index.length.toLocaleString() || "…"} presentations</div>
            </div>
          </div>
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <M name="search" size={18} color="var(--text-muted)" style={{ position: "absolute", left: 10, pointerEvents: "none" }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a diagnosis…"
              style={{
                width: "100%", padding: "9px 12px 9px 34px", borderRadius: 9, fontSize: 13,
                border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--text-primary)", outline: "none",
              }} />
            {query && (
              <button onClick={() => setQuery("")} aria-label="Clear"
                style={{ position: "absolute", right: 6, background: "transparent", border: "none", cursor: "pointer", display: "flex", padding: 4 }}>
                <M name="close" size={16} color="var(--text-muted)" />
              </button>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px 28px" }}>
          {searching ? (
            results.length ? (
              <>
                <div style={{ padding: "4px 10px 8px", fontSize: 11, color: "var(--text-muted)" }}>{results.length} result{results.length !== 1 ? "s" : ""}</div>
                {results.map((r) => (
                  <DxRow key={r.id} title={r.title} count={r.differential_count} isMain={r.is_main}
                    active={String(r.id) === activeId} onClick={() => openTopic(r.id)} />
                ))}
              </>
            ) : <div style={{ padding: "22px 14px", fontSize: 12.5, color: "var(--text-muted)", textAlign: "center" }}>No matches for “{query.trim()}”</div>
          ) : (
            lettered.map(([letter, topics]) => (
              <div key={letter} style={{ marginBottom: 4 }}>
                <div style={{ position: "sticky", top: 0, background: "var(--bg-elevated)", padding: "5px 10px 4px", fontSize: 11, fontWeight: 700, color: "var(--mod-utdddx)", letterSpacing: 0.5, zIndex: 1 }}>{letter}</div>
                {topics.map((t) => (
                  <DxRow key={t.id} title={t.title} count={t.differential_count} isMain
                    active={String(t.id) === activeId} onClick={() => openTopic(t.id)} />
                ))}
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

function DxRow({ title, count, isMain, active, onClick }: { title: string; count: number; isMain: boolean; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8,
      padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer", marginBottom: 1,
      borderLeft: `2px solid ${active ? "var(--mod-utdddx)" : "transparent"}`,
      background: active ? "color-mix(in srgb, var(--mod-utdddx) 14%, transparent)" : "transparent",
      color: "var(--text-primary)", transition: "background .12s",
    }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "color-mix(in srgb, var(--text-primary) 5%, transparent)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
      <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: active ? 650 : 450 }}>{title}</span>
      {isMain && count > 0 && (
        <span style={{
          fontSize: 10.5, color: "var(--mod-utdddx)", fontWeight: 600, flexShrink: 0,
          padding: "1px 7px", borderRadius: 999, background: "color-mix(in srgb, var(--mod-utdddx) 12%, transparent)",
        }}>{count}</span>
      )}
    </button>
  );
}

function Welcome({ count }: { count: number }) {
  return (
    <div style={{ maxWidth: 540, margin: "0 auto", padding: "12vh 30px", textAlign: "center" }}>
      <span style={{
        width: 68, height: 68, borderRadius: 18, display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "color-mix(in srgb, var(--mod-utdddx) 14%, transparent)", color: "var(--mod-utdddx)", marginBottom: 16,
      }}><M name="account_tree" size={38} fill /></span>
      <h1 style={{ fontSize: 25, fontWeight: 750, color: "var(--text-primary)", margin: "0 0 8px" }}>UpToDate DDx</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0, lineHeight: 1.55 }}>
        {(count || 854).toLocaleString()} presenting diagnoses, each with its differentials and the signs &amp; tests
        that distinguish them. Search or browse the index on the right.
      </p>
    </div>
  );
}
