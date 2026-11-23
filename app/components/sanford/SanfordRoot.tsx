"use client";

/**
 * SanfordRoot — the Sanford Guide reader.
 *
 * Article-first layout: the topic fills the main column; the index (live search
 * + a category accordion from /sanford/browse) is a panel on the RIGHT. Bodies
 * render through <AmbossHtml> (source="sanford") so UMLS hover underlines work
 * inside Sanford articles; internal cross-links carry data-sanford-slug and open
 * in-app. Sanford is the antimicrobial authority — drug + organism topics lead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getBackendUrl } from "@/lib/api";
import { AmbossHtml } from "@/components/amboss/AmbossHtml";

type SearchHit = {
  id: number; title: string; slug: string; kind: string;
  label: string; subject: string; trade_name: string; is_drug: boolean; href: string;
};
type BrowseTopic = { id: number; title: string; kind: string; subject: string; trade_name: string; href: string };
type BrowseGroup = { label: string; topics: BrowseTopic[] };
type Topic = {
  id: number; slug: string; title: string; subject: string; label: string;
  kind: string; trade_name: string; keywords: string; is_drug: boolean; body_html: string;
};

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

const KIND_ACCENT: Record<string, string> = {
  drug: "var(--mod-sanford)", organism: "#0891b2", condition: "#e11d48",
  prophylaxis: "#0ea5e9", vaccine: "#16a34a", tool: "#f59e0b", reference: "#64748b",
};
const kindGlyph = (kind: string): string =>
  kind === "drug" ? "medication" : kind === "organism" ? "coronavirus"
  : kind === "condition" ? "clinical_notes" : kind === "prophylaxis" ? "shield"
  : kind === "vaccine" ? "vaccines" : kind === "tool" ? "calculate" : "menu_book";
const GROUP_GLYPH: Record<string, string> = {
  "Antimicrobial": "medication", "Organism": "coronavirus", "Clinical Condition": "clinical_notes",
  "Prophylaxis & Prevention": "shield", "Hepatitis": "medical_services", "HIV / Specialty": "science",
  "Vaccines": "vaccines", "Tools & Tables": "calculate", "Reference": "menu_book",
};

export default function SanfordRoot() {
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get("id");

  const [groups, setGroups] = useState<BrowseGroup[]>([]);
  const [openGroup, setOpenGroup] = useState<string | null>("Antimicrobial");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = getBackendUrl();

  useEffect(() => {
    fetch(`${base}/sanford/browse`).then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.groups && setGroups(d.groups)).catch(() => {});
  }, [base]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    searchTimer.current = setTimeout(() => {
      fetch(`${base}/sanford/search?q=${encodeURIComponent(q)}&limit=40`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => setResults(d?.results ?? [])).catch(() => setResults([]));
    }, 170);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, base]);

  useEffect(() => {
    if (!activeId) { setTopic(null); return; }
    setLoading(true);
    fetch(`${base}/sanford/topic/${activeId}`).then((r) => (r.ok ? r.json() : null))
      .then((d) => setTopic(d)).catch(() => setTopic(null)).finally(() => setLoading(false));
  }, [activeId, base]);

  const openTopic = useCallback((id: number) => router.push(`/sanford?id=${id}`), [router]);

  const onArticleClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-sanford-slug]");
    if (!el) return;
    e.preventDefault();
    const slug = el.dataset.sanfordSlug;
    if (!slug) return;
    fetch(`${base}/sanford/topic-by-slug/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.id) openTopic(d.id); }).catch(() => {});
  }, [base, openTopic]);

  const totalTopics = useMemo(() => groups.reduce((n, g) => n + g.topics.length, 0), [groups]);
  const searching = query.trim().length >= 2;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, height: "100%", background: "var(--bg-base)" }}>
      {/* ── Article (left / main) ──────────────────────────────────── */}
      <main style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        {loading ? (
          <Centered><span style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</span></Centered>
        ) : topic ? (
          <article style={{ maxWidth: 860, margin: "0 auto", padding: "30px 40px 90px", display: "flex", flexDirection: "column" }}>
            <button
              onClick={() => router.push('/sanford')}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                background: "none", border: "none", color: "var(--text-muted)",
                cursor: "pointer", fontSize: 13, fontWeight: 600, padding: 0,
                marginBottom: 20, alignSelf: "flex-start"
              }}
            >
              <M name="arrow_back" size={16} />
              Back to index
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999,
                fontSize: 11, fontWeight: 700, letterSpacing: 0.2,
                color: KIND_ACCENT[topic.kind] || "var(--mod-sanford)",
                background: `color-mix(in srgb, ${KIND_ACCENT[topic.kind] || "var(--mod-sanford)"} 12%, transparent)`,
              }}>
                <M name={kindGlyph(topic.kind)} size={14} color="currentColor" />{topic.label}
              </span>
              {topic.trade_name && <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{topic.trade_name}</span>}
            </div>
            <h1 style={{ fontSize: 28, fontWeight: 750, color: "var(--text-primary)", margin: "0 0 20px", letterSpacing: -0.3 }}>{topic.title}</h1>
            <AmbossHtml className="sanford-article medos-reader-html" html={topic.body_html || "<p>No content.</p>"}
              source="sanford" sourceId={String(topic.id)} onClick={onArticleClick} />
          </article>
        ) : (
          <Welcome totalTopics={totalTopics} groups={groups} onOpenGroup={setOpenGroup} onPick={openTopic} base={base} />
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
              background: "color-mix(in srgb, var(--mod-sanford) 15%, transparent)", color: "var(--mod-sanford)",
            }}><M name="health_and_safety" size={22} fill /></span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 750, color: "var(--text-primary)", fontSize: 15.5, lineHeight: 1.15 }}>Sanford Guide</div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Antimicrobial Therapy · {totalTopics.toLocaleString() || "…"} topics</div>
            </div>
          </div>
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <M name="search" size={18} color="var(--text-muted)" style={{ position: "absolute", left: 10, pointerEvents: "none" }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search drugs, organisms, infections…"
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
                  <IndexRow key={r.id} title={r.title} kind={r.kind} sub={r.trade_name || r.subject} category={r.label}
                    active={String(r.id) === activeId} onClick={() => openTopic(r.id)} />
                ))}
              </>
            ) : <Empty label={`No matches for “${query.trim()}”`} />
          ) : (
            groups.map((g) => {
              const open = openGroup === g.label;
              return (
                <div key={g.label} style={{ marginBottom: 2 }}>
                  <button onClick={() => setOpenGroup(open ? null : g.label)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "8px 10px",
                      background: open ? "color-mix(in srgb, var(--mod-sanford) 8%, transparent)" : "transparent",
                      border: "none", borderRadius: 8, cursor: "pointer", color: "var(--text-primary)", fontWeight: 650, fontSize: 12.5,
                    }}>
                    <M name={GROUP_GLYPH[g.label] || "folder"} size={18} color={open ? "var(--mod-sanford)" : "var(--text-muted)"} />
                    <span style={{ flex: 1, textAlign: "left" }}>{g.label}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{g.topics.length}</span>
                    <M name="chevron_right" size={18} color="var(--text-muted)"
                      style={{ transition: "transform .15s ease", transform: open ? "rotate(90deg)" : "none" }} />
                  </button>
                  {open && (
                    <div style={{ margin: "2px 0 6px", paddingLeft: 4 }}>
                      {g.topics.map((t) => (
                        <IndexRow key={t.id} title={t.title} kind={t.kind} sub={t.trade_name || t.subject}
                          active={String(t.id) === activeId} onClick={() => openTopic(t.id)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}

function IndexRow({ title, kind, sub, category, active, onClick }: {
  title: string; kind: string; sub?: string; category?: string; active: boolean; onClick: () => void;
}) {
  const accent = KIND_ACCENT[kind] || "var(--text-muted)";
  return (
    <button onClick={onClick} title={title} style={{
      width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10,
      padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer", marginBottom: 1,
      borderLeft: `2px solid ${active ? accent : "transparent"}`,
      background: active ? "color-mix(in srgb, var(--mod-sanford) 14%, transparent)" : "transparent",
      color: "var(--text-primary)",
      transition: "background .12s",
    }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "color-mix(in srgb, var(--text-primary) 5%, transparent)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
      <M name={kindGlyph(kind)} size={17} color={accent} style={{ opacity: active ? 1 : 0.85 }} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: active ? 650 : 450 }}>
          {title}
          {category && <span style={{ fontSize: 9.5, padding: "1px 5px", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-muted)", fontWeight: 500 }}>{category}</span>}
        </span>
        {sub && <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{sub}</span>}
      </span>
    </button>
  );
}

function Empty({ label }: { label: string }) {
  return <div style={{ padding: "22px 14px", fontSize: 12.5, color: "var(--text-muted)", textAlign: "center" }}>{label}</div>;
}
function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>{children}</div>;
}

function Welcome({ totalTopics, groups, onOpenGroup, onPick, base }: { totalTopics: number; groups: BrowseGroup[]; onOpenGroup: (label: string) => void; onPick: (id: number) => void; base: string }) {
  const [suggest, setSuggest] = useState<SearchHit[]>([]);
  useEffect(() => {
    Promise.all(["vancomycin", "meropenem", "ceftriaxone", "azithromycin", "MRSA", "pseudomonas"].map((q) =>
      fetch(`${base}/sanford/search?q=${encodeURIComponent(q)}&limit=1`).then((r) => (r.ok ? r.json() : null)).then((d) => d?.results?.[0]).catch(() => null)))
      .then((xs) => setSuggest(xs.filter(Boolean) as SearchHit[]));
  }, [base]);
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "8vh 40px", textAlign: "center" }}>
      <span style={{
        width: 68, height: 68, borderRadius: 18, display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "color-mix(in srgb, var(--mod-sanford) 14%, transparent)", color: "var(--mod-sanford)", marginBottom: 16,
      }}><M name="health_and_safety" size={38} fill /></span>
      <h1 style={{ fontSize: 25, fontWeight: 750, color: "var(--text-primary)", margin: "0 0 8px" }}>Sanford Guide</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 32px", lineHeight: 1.55 }}>
        The antimicrobial-therapy reference — {(totalTopics || 1248).toLocaleString()} drug, organism, and infection topics.
        Search or browse the index on the right.
      </p>

      {groups.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, textAlign: "left", marginBottom: 32 }}>
          {groups.map(g => (
            <button key={g.label} onClick={() => onOpenGroup(g.label)} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 12,
              background: "var(--bg-card)", border: "1px solid var(--border)", cursor: "pointer",
              transition: "all .15s", boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--mod-sanford)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.transform = "none"; }}
            >
              <span style={{
                width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                background: "color-mix(in srgb, var(--mod-sanford) 10%, transparent)", color: "var(--mod-sanford)"
              }}>
                <M name={GROUP_GLYPH[g.label] || "folder"} size={20} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.label}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{g.topics.length} topics</div>
              </div>
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
        {suggest.map((s) => (
          <button key={s.id} onClick={() => onPick(s.id)} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
            border: "1px solid color-mix(in srgb, var(--mod-sanford) 38%, transparent)",
            background: "color-mix(in srgb, var(--mod-sanford) 9%, transparent)", color: "var(--text-primary)",
          }}><M name={kindGlyph(s.kind)} size={15} color="var(--mod-sanford)" />{s.title}</button>
        ))}
      </div>
    </div>
  );
}
