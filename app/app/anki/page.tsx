"use client";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { getBackendUrl } from "@/lib/api";
import { recordRecent } from "@/lib/useRecent";
import { ReferenceLayer } from "@/components/common/ReferenceLayer";
import { openFirstAid } from "@/components/firstaid/FirstAidSnippet";

// ── Types ─────────────────────────────────────────────────────────────────

interface Deck {
  id: number;
  name: string;
  new: number;
  learning: number;
  due: number;
  total: number;
}

interface CardData {
  card_id: number;
  deck_id: number;
  deck_name: string;
  tags: string[];
  front_html: string;
  back_html: string;
  firstaid_refs?: FirstAidRef[];
  total_remaining: number;
  is_new: boolean;
  base_ivl?: number;
  base_factor?: number;
}

interface FirstAidRef {
  heading_id: number;
  title: string;
  hierarchy?: string;
  page?: number;
}

interface TagEntry {
  tag: string;
  count: number;
}

interface SearchResult {
  card_id: number;
  deck_name: string;
  front_html: string;
  tags: string[];
}

type Mode = "decks" | "study" | "search";

// ── Theme ────────────────────────────────────────────────────────────────

const T = {
  bg:      "var(--bg-base)",
  card:    "color-mix(in srgb, var(--bg-card) 96%, transparent)",
  border:  "var(--border)",
  accent:  "var(--anki-accent)",
  ink:     "var(--text-primary)",
  ink2:    "var(--text-secondary)",
  ink3:    "var(--text-muted)",
  ink4:    "var(--text-muted)",
  mono:    "var(--font-mono)",
  serif:   "var(--font-serif)",
  sans:    "'Inter', system-ui, sans-serif",
};

const RATING_CONFIG = [
  { label: "Again", value: 1, color: "#ef4444" },
  { label: "Hard",  value: 2, color: "#f59e0b" },
  { label: "Good",  value: 3, color: "#10b981" },
  { label: "Easy",  value: 4, color: "#0ea5e9" },
];

function FirstAidRefPill({ refs, compact = false }: { refs?: FirstAidRef[]; compact?: boolean }) {
  const ref = refs?.[0];
  if (!ref) return null;
  return (
    <button
      type="button"
      onClick={event => {
        event.stopPropagation();
        openFirstAid(ref.heading_id, [ref.heading_id], ref.title);
      }}
      title={`Open First Aid: ${ref.title}${ref.page ? `, p. ${ref.page}` : ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        minHeight: compact ? 20 : 24,
        maxWidth: compact ? 180 : 260,
        padding: compact ? "2px 7px" : "3px 9px",
        borderRadius: 5,
        border: "1px solid rgba(248,113,113,0.36)",
        background: "rgba(248,113,113,0.12)",
        color: "var(--red-dim)",
        fontFamily: T.mono,
        fontSize: compact ? 8 : 8.5,
        fontWeight: 800,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <span style={{ flexShrink: 0 }}>FA</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {ref.title}
      </span>
      {ref.page ? <span style={{ flexShrink: 0, color: "var(--red-dim)" }}>p.{ref.page}</span> : null}
    </button>
  );
}

// ── Deck Browser ──────────────────────────────────────────────────────────

function DeckBrowser({
  decks, tags, loading, onStudy, onSearch, filterTag, setFilterTag,
}: {
  decks: Deck[];
  tags: TagEntry[];
  loading: boolean;
  onStudy: (deckId: number | null) => void;
  onSearch: (q: string) => void;
  filterTag: string;
  setFilterTag: (t: string) => void;
}) {
  const [searchQ, setSearchQ] = useState("");

  const filtered = filterTag
    ? decks // can't filter decks by tag meaningfully; tag filter applies in study
    : decks;

  return (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-start", maxWidth: 1100, margin: "0 auto" }}>
      {/* Main deck grid */}
      <div style={{ flex: 1 }}>
        {/* Search bar */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <input
            type="text"
            placeholder="Search cards…"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && searchQ.trim()) onSearch(searchQ.trim()); }}
            style={{
              flex: 1, padding: "8px 14px", borderRadius: 8,
              border: "1px solid var(--border)", background: T.card,
              fontFamily: T.sans, fontSize: 13, color: T.ink, outline: "none",
            }}
          />
          <button
            onClick={() => { if (searchQ.trim()) onSearch(searchQ.trim()); }}
            style={{
              padding: "8px 16px", borderRadius: 8, border: "none",
              background: T.accent, color: "var(--anki-accent-ink)", fontFamily: T.mono,
              fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Search
          </button>
          <button
            onClick={() => onStudy(null)}
            style={{
              padding: "8px 16px", borderRadius: 8, border: "none",
              background: "#0f766e", color: "#fff", fontFamily: T.mono,
              fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Study All
          </button>
        </div>

        {loading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
            {[1, 2, 3, 4].map(i => (
              <div key={i} style={{ height: 110, borderRadius: 12, background: "var(--bg-subtle)", animation: "fade-in 0.4s" }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: T.ink3, fontFamily: T.serif, fontSize: 16 }}>
            No decks found in your Anki collection.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
            {filtered.map(deck => {
              const displayName = deck.name.split("::").pop() ?? deck.name;
              const parentPath  = deck.name.includes("::") ? deck.name.split("::").slice(0, -1).join(" › ") : "";
              return (
                <button
                  key={deck.id}
                  onClick={() => onStudy(deck.id)}
                  style={{
                    textAlign: "left", border: "1px solid var(--border)",
                    borderRadius: 12, padding: "14px 16px",
                    background: T.card, cursor: "pointer",
                    transition: "transform 0.15s, box-shadow 0.15s",
                    boxShadow: "0 2px 8px rgba(15,23,42,0.05)",
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
                    (e.currentTarget as HTMLElement).style.boxShadow = "0 6px 20px rgba(15,23,42,0.1)";
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.transform = "";
                    (e.currentTarget as HTMLElement).style.boxShadow = "0 2px 8px rgba(15,23,42,0.05)";
                  }}
                >
                  {parentPath && (
                    <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.ink4, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
                      {parentPath}
                    </div>
                  )}
                  <div style={{ fontFamily: T.serif, fontSize: 15, fontWeight: 600, color: T.ink, marginBottom: 10, lineHeight: 1.3 }}>
                    {displayName}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {deck.new > 0 && (
                      <span style={{ fontFamily: T.mono, fontSize: 9, padding: "2px 8px", borderRadius: 5, background: "var(--bg-subtle)", color: T.ink2, border: "1px solid var(--border)", letterSpacing: "0.1em" }}>
                        {deck.new} new
                      </span>
                    )}
                    {deck.learning > 0 && (
                      <span style={{ fontFamily: T.mono, fontSize: 9, padding: "2px 8px", borderRadius: 5, background: "var(--bg-subtle)", color: T.ink2, border: "1px solid var(--border)", letterSpacing: "0.1em" }}>
                        {deck.learning} learning
                      </span>
                    )}
                    {deck.due > 0 && (
                      <span style={{ fontFamily: T.mono, fontSize: 9, padding: "2px 8px", borderRadius: 5, background: "var(--bg-subtle)", color: T.ink2, border: "1px solid var(--border)", letterSpacing: "0.1em" }}>
                        {deck.due} due
                      </span>
                    )}
                    {deck.total === 0 && (
                      <span style={{ fontFamily: T.mono, fontSize: 9, padding: "2px 8px", borderRadius: 5, background: "var(--bg-subtle)", color: T.ink2, border: "1px solid var(--border)" }}>
                        caught up
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Tag sidebar */}
      <div style={{
        width: 180, flexShrink: 0,
        background: T.card, border: "1px solid var(--border)",
        borderRadius: 12, padding: "14px 12px",
        maxHeight: "calc(100vh - 160px)", overflowY: "auto",
      }}>
        <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: T.ink4, marginBottom: 10 }}>
          Tags
        </div>
        {filterTag && (
          <button
            onClick={() => setFilterTag("")}
            style={{
              width: "100%", marginBottom: 8, padding: "4px 8px",
              borderRadius: 6, border: "1px solid var(--anki-accent-border)",
              background: "var(--anki-accent-soft)", color: "var(--anki-accent-text)",
              fontFamily: T.mono, fontSize: 9, cursor: "pointer",
              letterSpacing: "0.1em", textTransform: "uppercase",
            }}
          >
            ✕ Clear filter
          </button>
        )}
        {tags.slice(0, 60).map(t => (
          <button
            key={t.tag}
            onClick={() => setFilterTag(filterTag === t.tag ? "" : t.tag)}
            style={{
              display: "block", width: "100%", textAlign: "left",
              padding: "4px 6px", marginBottom: 3, borderRadius: 5, border: "none",
              background: filterTag === t.tag ? "var(--anki-accent-soft)" : "transparent",
              color: filterTag === t.tag ? "var(--anki-accent-text)" : T.ink3,
              fontFamily: T.mono, fontSize: 9.5, cursor: "pointer",
              letterSpacing: "0.06em",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              transition: "background 0.12s",
            }}
            title={t.tag}
          >
            {t.tag}
            <span style={{ float: "right", color: T.ink4, fontSize: 8.5 }}>{t.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Study Session ──────────────────────────────────────────────────────────

function StudySession({
  card, flipped, onFlip, onRate, onBury, onNext, onBack, loading, doneToday,
}: {
  card: CardData | null;
  flipped: boolean;
  onFlip: () => void;
  onRate: (r: number) => void;
  onBury: () => void;
  onNext: () => void;
  onBack: () => void;
  loading: boolean;
  doneToday: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedAnswerShown, setExpandedAnswerShown] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const remaining = card?.total_remaining ?? 0;
  const total = doneToday + remaining;
  const pct   = total > 0 ? Math.round((doneToday / total) * 100) : 0;

  // Expand all <details> in modal view so every reference section is visible
  const modalBackHtml = useMemo(
    () => card?.back_html.replace(/<details class="anki-hint"/g, '<details class="anki-hint" open') ?? "",
    [card?.back_html]
  );

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target instanceof Element ? e.target : null;
      if (tgt?.closest("input,textarea,[contenteditable]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (expanded) {
        switch (e.key) {
          case " ": case "Enter":
            e.preventDefault();
            if (!loading) setExpandedAnswerShown(true);
            break;
          case "ArrowRight": case "n": case "N":
            e.preventDefault();
            setExpandedAnswerShown(false);
            if (!loading) onNext();
            break;
          case "Escape":
            setExpanded(false);
            break;
        }
        return;
      }
      switch (e.key) {
        case " ": case "Enter":
          e.preventDefault();
          if (!flipped) onFlip();
          break;
        case "1": if (flipped) onRate(1); break;
        case "2": if (flipped) onRate(2); break;
        case "3": if (flipped) onRate(3); break;
        case "4": if (flipped) onRate(4); break;
        case "b": case "B":
          if (flipped) onBury();
          break;
        case "e": case "E":
          if (card) {
            setExpandedAnswerShown(flipped);
            setExpanded(true);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipped, expanded, card, loading, onFlip, onRate, onBury, onNext]);

  // ── Touch swipe ──────────────────────────────────────────────────────────
  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const dx = e.changedTouches[0].clientX - touchStart.current.x;
    const dy = e.changedTouches[0].clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) < 30 && Math.abs(dy) < 30) {
      if (!flipped) onFlip();
      return;
    }
    if (!flipped) { onFlip(); return; }
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx < 0) onRate(1); // left = Again
      else onRate(4);        // right = Easy
    } else {
      if (dy < 0) onRate(3); // up = Good
      else onBury();         // down = Bury
    }
  };

  // ── Done state ───────────────────────────────────────────────────────────
  if (!loading && !card) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400, gap: 20, textAlign: "center" }}>
        <div style={{ fontSize: 48 }}>🎉</div>
        <div style={{ fontFamily: T.serif, fontSize: 22, color: T.ink, fontWeight: 600 }}>All caught up!</div>
        <div style={{ fontFamily: T.sans, fontSize: 14, color: T.ink3 }}>
          {doneToday > 0 ? `You reviewed ${doneToday} card${doneToday === 1 ? "" : "s"} today.` : "No cards due right now."}
        </div>
        <button onClick={onBack} style={{ padding: "10px 24px", borderRadius: 8, border: "1px solid var(--border)", background: "none", color: T.ink2, fontFamily: T.mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", cursor: "pointer" }}>
          ← Back to Decks
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: T.ink3, cursor: "pointer", fontFamily: T.mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", padding: "4px 0" }}>
          ← Decks
        </button>
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
          <div style={{ height: "100%", borderRadius: 2, background: "linear-gradient(90deg, #0f766e, #10b981)", width: `${pct}%`, transition: "width 0.5s ease" }} />
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink4, whiteSpace: "nowrap" }}>{remaining} left</div>
      </div>

      {/* Card badges */}
      {card && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.15em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 5, color: card.is_new ? "#000" : "#fff", background: card.is_new ? "#6366f1" : "#0f766e" }}>
            {card.is_new ? "New" : "Review"}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.ink4 }}>{card.deck_name.split("::").pop()}</span>
          <FirstAidRefPill refs={card.firstaid_refs} />
        </div>
      )}

      {/* ── Expanded modal ─────────────────────────────────────────────── */}
      {expanded && card && (
        <div
          onClick={() => setExpanded(false)}
          style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(15,23,42,0.76)", backdropFilter: "blur(16px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        >
          <div
            className="anki-expanded-modal"
            onClick={e => e.stopPropagation()}
            style={{ width: "min(980px, 96vw)", maxHeight: "94vh", background: "var(--bg-card)", borderRadius: 16, boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: "0.18em", textTransform: "uppercase", color: T.ink4 }}>Anki Card</span>
                <span style={{ fontFamily: T.mono, fontSize: 8, padding: "2px 8px", borderRadius: 4, background: "var(--anki-accent)", color: "var(--anki-accent-ink)" }}>{card.deck_name.split("::").pop()}</span>
                <span style={{ fontFamily: T.mono, fontSize: 8, padding: "2px 8px", borderRadius: 4, background: card.is_new ? "#6366f1" : "#0f766e", color: card.is_new ? "#000" : "#fff" }}>{card.is_new ? "New" : "Review"}</span>
                <FirstAidRefPill refs={card.firstaid_refs} compact />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontFamily: T.mono, fontSize: 8, color: T.ink4 }}>Space Answer · → Next · Esc Close</span>
                {!loading && !expandedAnswerShown && (
                  <button onClick={() => setExpandedAnswerShown(true)} title="Show answer (Space)" style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "none", color: T.ink3, fontFamily: T.mono, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>
                    Show Answer
                  </button>
                )}
                <button onClick={() => { setExpandedAnswerShown(false); onNext(); }} disabled={loading} title="Next card (→)" style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "none", color: T.ink3, fontFamily: T.mono, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", cursor: loading ? "wait" : "pointer", opacity: loading ? 0.55 : 1 }}>
                  {loading ? "Loading…" : "Next →"}
                </button>
                <button onClick={() => setExpanded(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: T.ink4, padding: "2px 8px", lineHeight: 1 }}>✕</button>
              </div>
            </div>
            {/* Scrollable content */}
            <div style={{ overflowY: "auto", flex: 1, padding: "22px 28px" }}>
              {loading ? (
                <div style={{ minHeight: 220, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink4 }}>
                  Loading next card…
                </div>
              ) : (
                <>
                  {/* Front */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.18em", textTransform: "uppercase", color: T.ink4, marginBottom: 10 }}>Question</div>
                    <ReferenceLayer html={card.front_html} className="anki-modal-content" />
                  </div>
                  {/* Answer */}
                  {expandedAnswerShown && (
                    <div style={{ borderTop: "2px solid var(--border)", paddingTop: 18, marginBottom: 16 }}>
                      <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.18em", textTransform: "uppercase", color: "#0f766e", marginBottom: 10 }}>Answer</div>
                      <ReferenceLayer html={modalBackHtml} className="anki-modal-content" />
                    </div>
                  )}
                  {/* Tags */}
                  {card.tags.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
                      {card.tags.slice(0, 14).map(t => (
                        <span key={t} style={{ fontFamily: T.mono, fontSize: 8, padding: "2px 7px", borderRadius: 4, background: "var(--anki-accent-soft)", color: "var(--anki-accent-text)", border: "1px solid var(--anki-accent-border)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t}>
                          {t.split("::").pop()}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Flip card ──────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ height: 300, borderRadius: 14, background: "var(--bg-subtle)", animation: "pulse-entry 0.4s" }} />
      ) : (
        <div
          className="anki-card-scene"
          style={{ minHeight: 260 }}
          onClick={!flipped ? onFlip : undefined}
          onDoubleClick={() => { setExpandedAnswerShown(flipped); setExpanded(true); }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          title="Click to flip · Double-click to expand"
        >
          <div className={`anki-card-inner${flipped ? " flipped" : ""}`} style={{ minHeight: 260, cursor: flipped ? "default" : "pointer" }}>
            {/* Front */}
            <div className="anki-card-front" style={{ minHeight: 260, padding: 20 }}>
              {!flipped && (
                <div style={{ position: "absolute", top: 10, right: 12, fontFamily: T.mono, fontSize: 8, color: T.ink4, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  Space / tap to reveal
                </div>
              )}
              <div style={{ fontFamily: T.serif, fontSize: 16, lineHeight: 1.6, color: T.ink }} dangerouslySetInnerHTML={{ __html: card?.front_html ?? "" }} />
            </div>
            {/* Back */}
            <div className="anki-card-back" style={{ minHeight: 260, padding: 20 }}>
              <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.65, color: T.ink }} dangerouslySetInnerHTML={{ __html: card?.back_html ?? "" }} />
            </div>
          </div>
        </div>
      )}

      {/* Tags */}
      {card && card.tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
          {card.tags.slice(0, 8).map(tag => (
            <span key={tag} style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.1em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 5, background: "var(--anki-accent-soft)", color: "var(--anki-accent-text)", border: "1px solid var(--anki-accent-border)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={tag}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* ── Rating row (after flip) ────────────────────────────────────── */}
      {flipped && !loading && (
        <div className="anki-rating-row" style={{ marginTop: 16 }}>
          {RATING_CONFIG.map(r => (
            <button key={r.value} className="anki-rating-btn" style={{ background: r.color }} onClick={() => onRate(r.value)}>
              {r.label}
            </button>
          ))}
          <button onClick={onBury} title="Bury — skip for today (B)" style={{ padding: "7px 12px", borderRadius: 7, border: "1px dashed var(--border)", background: "none", color: T.ink3, fontFamily: T.mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>
            Bury
          </button>
          <button onClick={() => { setExpandedAnswerShown(true); setExpanded(true); }} title="Expand card (E)" style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", background: "none", color: T.ink3, cursor: "pointer", fontSize: 14, lineHeight: 1 }}>
            ⤢
          </button>
        </div>
      )}

      {/* Keyboard / swipe hint */}
      {!loading && card && !expanded && (
        <div style={{ textAlign: "center", fontFamily: T.mono, fontSize: 8, color: T.ink4, letterSpacing: "0.1em", textTransform: "uppercase", marginTop: 10 }}>
          {flipped
            ? "1 Again · 2 Hard · 3 Good · 4 Easy · B Bury · E Expand  |  Swipe ← Again · → Easy · ↑ Good · ↓ Bury"
            : "Space or tap to reveal · Double-click / E to expand"}
        </div>
      )}
    </div>
  );
}

// ── Search Results ────────────────────────────────────────────────────────

function SearchResults({
  results, query, loading, onStudyCard, onBack,
}: {
  results: SearchResult[];
  query: string;
  loading: boolean;
  onStudyCard: (id: number) => void;
  onBack: () => void;
}) {
  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button
          onClick={onBack}
          style={{ background: "none", border: "none", color: T.ink3, cursor: "pointer", fontFamily: T.mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}
        >
          ← Decks
        </button>
        <div style={{ fontFamily: T.serif, fontSize: 15, color: T.ink2 }}>
          Results for <strong>&ldquo;{query}&rdquo;</strong>
        </div>
      </div>
      {loading ? (
        <div style={{ color: T.ink3, fontFamily: T.sans, fontSize: 14 }}>Searching…</div>
      ) : results.length === 0 ? (
        <div style={{ color: T.ink3, fontFamily: T.serif, fontSize: 16, textAlign: "center", padding: 40 }}>
          No cards matched &ldquo;{query}&rdquo;
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {results.map(r => (
            <button
              key={r.card_id}
              onClick={() => onStudyCard(r.card_id)}
              style={{
                textAlign: "left", border: "1px solid var(--border)", borderRadius: 10,
                padding: "12px 16px", background: T.card, cursor: "pointer",
                transition: "box-shadow 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.ink4 }}>
                  {r.deck_name.split("::").pop()}
                </span>
                {r.tags.slice(0, 3).map(t => (
                  <span key={t} style={{
                    fontFamily: T.mono, fontSize: 8, padding: "1px 5px", borderRadius: 4,
                    background: "var(--anki-accent-soft)", color: "var(--anki-accent-text)",
                  }}>
                    {t.split("::").pop()}
                  </span>
                ))}
              </div>
              <div
                className="anki-modal-content"
                style={{ fontFamily: T.serif, fontSize: 13.5, color: T.ink, lineHeight: 1.4,
                  overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box",
                  WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
                }}
                dangerouslySetInnerHTML={{ __html: r.front_html }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function AnkiPage() {
  const [mode, setMode]             = useState<Mode>("decks");
  const [decks, setDecks]           = useState<Deck[]>([]);
  const [tags, setTags]             = useState<TagEntry[]>([]);
  const [filterTag, setFilterTag]   = useState("");
  const [decksLoading, setDecksLoading] = useState(true);

  // Study session state
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [card, setCard]                     = useState<CardData | null>(null);
  const [flipped, setFlipped]               = useState(false);
  const [studyLoading, setStudyLoading]     = useState(false);
  const [doneToday, setDoneToday]           = useState(0);

  // Search state
  const [searchQuery, setSearchQuery]     = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const baseRef = useRef<string>("");

  // ── Boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      baseRef.current = getBackendUrl();
      fetchDecks();
      fetchTags();
      recordRecent({
        tag: "ANKI", label: "Anki Review", href: "/anki",
        source: "anki", kind: "anki",
      });
    })();
  }, []);

  const fetchDecks = async () => {
    setDecksLoading(true);
    try {
      const res  = await fetch(`${baseRef.current}/anki/decks`);
      const data = await res.json();
      setDecks(Array.isArray(data) ? data : []);
    } catch {
      setDecks([]);
    } finally {
      setDecksLoading(false);
    }
  };

  const fetchTags = async () => {
    try {
      const res  = await fetch(`${baseRef.current}/anki/tags?limit=100`);
      const data = await res.json();
      setTags(Array.isArray(data) ? data : []);
    } catch {
      setTags([]);
    }
  };

  // ── Study ────────────────────────────────────────────────────────────────
  const startStudy = useCallback(async (deckId: number | null) => {
    setSelectedDeckId(deckId);
    setMode("study");
    setFlipped(false);
    setDoneToday(0);
    await fetchNextCard(deckId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTag]);

  const fetchNextCard = useCallback(async (deckId: number | null, excludeCardId: number | null = null) => {
    setStudyLoading(true);
    setFlipped(false);
    try {
      const params = new URLSearchParams();
      if (deckId)    params.set("deck_id", String(deckId));
      if (filterTag) params.set("tag", filterTag);
      if (excludeCardId !== null) params.set("exclude_card_id", String(excludeCardId));
      const res  = await fetch(`${baseRef.current}/anki/study?${params}`);
      const data = await res.json();
      if (data.card_id) {
        setCard(data as CardData);
      } else {
        setCard(null);
      }
    } catch {
      setCard(null);
    } finally {
      setStudyLoading(false);
    }
  }, [filterTag]);

  const handleRate = async (rating: number) => {
    if (!card) return;
    try {
      await fetch(`${baseRef.current}/anki/card/${card.card_id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
    } catch { /* ignore — advance anyway */ }
    setDoneToday(d => d + 1);
    setTimeout(() => fetchNextCard(selectedDeckId), 220);
  };

  const handleBury = async () => {
    if (!card) return;
    try {
      await fetch(`${baseRef.current}/anki/card/${card.card_id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bury" }),
      });
    } catch { /* ignore */ }
    setTimeout(() => fetchNextCard(selectedDeckId), 220);
  };

  // ── Search ────────────────────────────────────────────────────────────────
  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    setMode("search");
    setSearchLoading(true);
    try {
      const params = new URLSearchParams({ q, limit: "30" } as Record<string, string>);
      const res    = await fetch(`${baseRef.current}/anki/search?${params}`);
      const data   = await res.json();
      setSearchResults(Array.isArray(data) ? data : []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleStudyCard = async (cardId: number) => {
    setMode("study");
    setFlipped(false);
    setStudyLoading(true);
    try {
      const res  = await fetch(`${baseRef.current}/anki/card/${cardId}/front`);
      const data = await res.json();
      setCard({ ...data, total_remaining: 1, is_new: false });
    } catch {
      setCard(null);
    } finally {
      setStudyLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      position: "absolute", inset: 0, overflow: "auto",
      background: T.bg, padding: "32px 28px 40px",
    }}>
      {/* Page header */}
      <div style={{ maxWidth: mode === "decks" ? 1100 : 720, margin: "0 auto 28px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: "linear-gradient(135deg, var(--anki-accent), #fb923c)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 12px rgba(249,115,22,0.35)",
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--anki-accent-ink)" strokeWidth="1.8" width="18" height="18">
              <rect x="3" y="5" width="18" height="13" rx="2"/>
              <path d="M7 9h10M7 13h6"/>
            </svg>
          </div>
          <div>
            <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 700, color: T.ink, margin: 0 }}>
              Anki
            </h1>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink4, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              Spaced Repetition Review
            </div>
          </div>
          {mode !== "decks" && (
            <button
              onClick={() => { setMode("decks"); fetchDecks(); }}
              style={{
                marginLeft: "auto", background: "none", border: "1px solid var(--border)",
                borderRadius: 7, padding: "6px 14px", color: T.ink3, cursor: "pointer",
                fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase",
              }}
            >
              ← Decks
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {mode === "decks" && (
        <DeckBrowser
          decks={decks}
          tags={tags}
          loading={decksLoading}
          onStudy={startStudy}
          onSearch={handleSearch}
          filterTag={filterTag}
          setFilterTag={setFilterTag}
        />
      )}
      {mode === "study" && (
        <StudySession
          card={card}
          flipped={flipped}
          onFlip={() => setFlipped(true)}
          onRate={handleRate}
          onBury={handleBury}
          onNext={() => fetchNextCard(selectedDeckId, card?.card_id ?? null)}
          onBack={() => { setMode("decks"); fetchDecks(); }}
          loading={studyLoading}
          doneToday={doneToday}
        />
      )}
      {mode === "search" && (
        <SearchResults
          results={searchResults}
          query={searchQuery}
          loading={searchLoading}
          onStudyCard={handleStudyCard}
          onBack={() => setMode("decks")}
        />
      )}
    </div>
  );
}
