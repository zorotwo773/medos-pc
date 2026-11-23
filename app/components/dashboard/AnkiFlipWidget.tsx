"use client";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { getBackendUrl } from "@/lib/api";
import { ReferenceLayer } from "@/components/common/ReferenceLayer";
import { openFirstAid } from "@/components/firstaid/FirstAidSnippet";

interface AnkiCard {
  card_id: number;
  deck_id: number;
  deck_name: string;
  tags: string[];
  front_html: string;
  back_html: string;
  firstaid_refs?: FirstAidRef[];
}

interface FirstAidRef {
  heading_id: number;
  title: string;
  hierarchy?: string;
  page?: number;
}

interface Deck {
  id: number;
  name: string;
  total: number;
}

const T = {
  card:  "color-mix(in srgb, var(--bg-card) 92%, transparent)",
  ink:   "var(--text-primary)",
  ink3:  "var(--text-muted)",
  ink4:  "var(--text-muted)",
  mono:  "var(--font-mono)",
  serif: "var(--font-serif)",
};

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 12000, 15000] as const;

function retryDelay(attempt: number) {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

function FirstAidRefButton({ refs }: { refs?: FirstAidRef[] }) {
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
        minWidth: 0,
        maxWidth: 150,
        padding: "2px 7px",
        borderRadius: 5,
        border: "1px solid rgba(248,113,113,0.36)",
        background: "rgba(248,113,113,0.12)",
        color: "var(--red-dim)",
        fontFamily: T.mono,
        fontSize: 8,
        fontWeight: 800,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        cursor: "pointer",
      }}
    >
      <span style={{ flexShrink: 0 }}>FA</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {ref.title}
      </span>
    </button>
  );
}

export default function AnkiFlipWidget() {
  const [card, setCard]               = useState<AnkiCard | null>(null);
  const [flipped, setFlipped]         = useState(false);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(false);
  const [decks, setDecks]             = useState<Deck[]>([]);
  const [selectedDeck, setSelectedDeck] = useState<number | null>(null);
  const [expanded, setExpanded]       = useState(false);
  const [expandedAnswerShown, setExpandedAnswerShown] = useState(false);
  const [recovering, setRecovering]   = useState(false);

  const cardRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deckRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCardRequestRef = useRef(0);

  const base = getBackendUrl();

  // Open all hint details in expanded modal view
  const modalBackHtml = useMemo(
    () => card?.back_html.replace(/<details class="anki-hint"/g, '<details class="anki-hint" open') ?? "",
    [card?.back_html]
  );

  const fetchDecks = useCallback(async (attempt = 0) => {
    if (deckRetryTimerRef.current) {
      clearTimeout(deckRetryTimerRef.current);
      deckRetryTimerRef.current = null;
    }

    try {
      const res = await fetch(`${base}/anki/decks`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return;

      const deckData = data as Deck[];
      const topLevel = deckData.filter(d => !d.name.includes("::") && d.total > 0);
      setDecks(topLevel.length ? topLevel : deckData.filter(d => d.total > 0).slice(0, 20));
      const anking = deckData.find(d => d.name === "AnKing");
      if (anking) setSelectedDeck(anking.id);
    } catch {
      if (attempt < RETRY_DELAYS_MS.length) {
        deckRetryTimerRef.current = setTimeout(() => {
          deckRetryTimerRef.current = null;
          void fetchDecks(attempt + 1);
        }, retryDelay(attempt));
      }
    }
  }, [base]);

  const fetchCard = useCallback(async (
    deckId: number | null,
    excludeCardId: number | null = null,
    attempt = 0,
  ) => {
    const requestId = ++activeCardRequestRef.current;
    if (cardRetryTimerRef.current) {
      clearTimeout(cardRetryTimerRef.current);
      cardRetryTimerRef.current = null;
    }

    setLoading(true);
    setFlipped(false);
    setError(false);
    setRecovering(attempt > 0);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let retryScheduled = false;

    try {
      const params = new URLSearchParams();
      if (deckId !== null) params.set("deck_id", String(deckId));
      if (excludeCardId !== null) params.set("exclude_card_id", String(excludeCardId));
      const query = params.toString();
      const url = `${base}/anki/card/random${query ? `?${query}` : ""}`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (requestId !== activeCardRequestRef.current) return;
      setCard(data.card_id ? (data as AnkiCard) : null);
      setRecovering(false);
    } catch {
      if (requestId !== activeCardRequestRef.current) return;
      if (attempt < RETRY_DELAYS_MS.length) {
        retryScheduled = true;
        setRecovering(true);
        cardRetryTimerRef.current = setTimeout(() => {
          cardRetryTimerRef.current = null;
          void fetchCard(deckId, excludeCardId, attempt + 1);
        }, retryDelay(attempt));
      } else {
        setCard(null);
        setError(true);
        setRecovering(false);
      }
    } finally {
      clearTimeout(timer);
      if (requestId === activeCardRequestRef.current && !retryScheduled) {
        setLoading(false);
      }
    }
  }, [base]);

  useEffect(() => {
    void fetchDecks();
  }, [fetchDecks]);

  useEffect(() => {
    void fetchCard(null);
  }, [fetchCard]);

  useEffect(() => {
    if (selectedDeck !== null) void fetchCard(selectedDeck);
  }, [selectedDeck, fetchCard]);

  useEffect(() => {
    return () => {
      activeCardRequestRef.current += 1;
      if (cardRetryTimerRef.current) clearTimeout(cardRetryTimerRef.current);
      if (deckRetryTimerRef.current) clearTimeout(deckRetryTimerRef.current);
    };
  }, []);

  const handleDeckChange = (id: number | null) => {
    setSelectedDeck(id);
  };

  const fetchDifferentCard = useCallback(() => {
    setExpandedAnswerShown(false);
    void fetchCard(selectedDeck, card?.card_id ?? null);
  }, [card?.card_id, fetchCard, selectedDeck]);

  // Keyboard shortcuts — only active when modal is open
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target instanceof Element ? e.target : null;
      if (tgt?.closest("input,textarea,[contenteditable]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case " ": case "Enter":
          e.preventDefault();
          if (!loading) setExpandedAnswerShown(true);
          break;
        // Navigate to next card without closing modal
        case "ArrowRight": case "n": case "N":
          e.preventDefault();
          if (!loading) fetchDifferentCard();
          break;
        case "Escape": setExpanded(false); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, fetchDifferentCard, loading]);

  const displayDeck = card?.deck_name?.split("::")?.pop() ?? "";

  // ── Error / empty ────────────────────────────────────────────────────────
  if (!loading && (error || !card)) {
    return (
      <div className="dash-widget-card" style={{ background: T.card, border: "1px solid var(--border)", borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 12, backdropFilter: "blur(8px)", minHeight: 200, justifyContent: "center", alignItems: "center" }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.22em", textTransform: "uppercase", color: T.ink4 }}>Anki Review</div>
        <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink3, textAlign: "center" }}>
          {error ? "Anki collection unavailable." : "No cards due right now."}
        </div>
        <Link href="/anki" style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--anki-accent-text)", textDecoration: "none", padding: "5px 12px", border: "1px solid var(--anki-accent-border)", borderRadius: 6 }}>
          Open Anki →
        </Link>
      </div>
    );
  }

  return (
    <>
      {/* ── Expanded modal ────────────────────────────────────────────── */}
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
                <span style={{ fontFamily: T.mono, fontSize: 8, padding: "2px 8px", borderRadius: 4, background: "var(--anki-accent)", color: "var(--anki-accent-ink)" }}>{displayDeck}</span>
                <FirstAidRefButton refs={card.firstaid_refs} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: T.mono, fontSize: 8, color: T.ink4 }}>Space Answer · → Next · Esc Close</span>
                {!loading && !expandedAnswerShown && (
                  <button onClick={() => setExpandedAnswerShown(true)} title="Show answer (Space)" style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "none", color: T.ink3, fontFamily: T.mono, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>
                    Show Answer
                  </button>
                )}
                <button onClick={fetchDifferentCard} disabled={loading} title="Next card (→)" style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "none", color: T.ink3, fontFamily: T.mono, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", cursor: loading ? "wait" : "pointer", opacity: loading ? 0.55 : 1 }}>
                  {loading ? "Loading…" : "Next →"}
                </button>
                <button onClick={() => setExpanded(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: T.ink4, padding: "2px 8px", lineHeight: 1 }}>✕</button>
              </div>
            </div>

            {/* Content */}
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
                      {card.tags.slice(0, 12).map(t => (
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

      {/* ── Widget ──────────────────────────────────────────────────────── */}
      <div className="dash-widget-card" style={{ background: T.card, border: "1px solid var(--border)", borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 10, backdropFilter: "blur(8px)" }}>
        {/* Header: label + deck picker */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.22em", textTransform: "uppercase", color: T.ink3 }}>Anki Review</span>
          {decks.length > 0 ? (
            <select
              value={selectedDeck ?? ""}
              onChange={e => handleDeckChange(e.target.value ? Number(e.target.value) : null)}
              style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.08em", padding: "3px 6px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--anki-accent-soft)", color: "var(--anki-accent-text)", maxWidth: 140, cursor: "pointer", outline: "none" }}
            >
              <option value="">All decks</option>
              {decks.map(d => (
                <option key={d.id} value={d.id}>{d.name.split("::").pop()?.slice(0, 22)}</option>
              ))}
            </select>
          ) : displayDeck ? (
            <span style={{ fontFamily: T.mono, fontSize: 8.5, padding: "2px 7px", borderRadius: 4, background: "var(--anki-accent)", color: "var(--anki-accent-ink)" }}>
              {displayDeck.length > 22 ? displayDeck.slice(0, 22) + "…" : displayDeck}
            </span>
          ) : null}
          <FirstAidRefButton refs={card?.firstaid_refs} />
        </div>

        {/* Flip card */}
        {loading ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
            {[80, 60, 40].map(w => (
              <div key={w} style={{ height: 12, width: `${w}%`, background: "var(--bg-subtle)", borderRadius: 6 }} />
            ))}
            {recovering && (
              <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.ink4, letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 4 }}>
                Connecting to Anki…
              </div>
            )}
          </div>
        ) : (
          <div
            className="anki-card-scene"
            onClick={() => { if (!flipped && card) setFlipped(true); }}
            onDoubleClick={() => { setExpandedAnswerShown(flipped); setExpanded(true); }}
            title="Click to flip · Double-click to expand"
          >
            <div className={`anki-card-inner${flipped ? " flipped" : ""}`}>
              <div className="anki-card-front">
                <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.55, color: T.ink, width: "100%" }} dangerouslySetInnerHTML={{ __html: card?.front_html ?? "" }} />
              </div>
              <div className="anki-card-back">
                <div style={{ fontFamily: T.serif, fontSize: 13, lineHeight: 1.6, color: T.ink }} dangerouslySetInnerHTML={{ __html: card?.back_html ?? "" }} />
              </div>
            </div>
          </div>
        )}

        {/* Flip hint */}
        {!loading && !flipped && card && (
          <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.ink4, letterSpacing: "0.12em", textTransform: "uppercase", textAlign: "center" }}>
            Click to reveal · Double-click to expand
          </div>
        )}

        {/* Tags */}
        {!loading && card && card.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {card.tags.slice(0, 4).map(tag => (
              <span key={tag} style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: "0.1em", textTransform: "uppercase", padding: "1px 6px", borderRadius: 4, background: "var(--anki-accent-soft)", color: "var(--anki-accent-text)", border: "1px solid var(--anki-accent-border)", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={tag}>
                {tag.split("::").pop()}
              </span>
            ))}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
          <Link href="/anki" style={{ flex: 1, fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--anki-accent-ink)", background: "var(--anki-accent)", border: "none", borderRadius: 7, padding: "7px 10px", cursor: "pointer", textDecoration: "none", textAlign: "center", display: "block" }}>
            Study Now
          </Link>
          <button onClick={fetchDifferentCard} disabled={loading} style={{ flex: 1, fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.15em", textTransform: "uppercase", color: T.ink3, background: "none", border: "1px dashed var(--border)", borderRadius: 7, padding: "7px 10px", cursor: loading ? "wait" : "pointer", opacity: loading ? 0.5 : 1 }}>
            {loading ? "Loading…" : "Next Card"}
          </button>
        </div>
      </div>
    </>
  );
}
