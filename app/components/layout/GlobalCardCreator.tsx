"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { getBackendUrl } from "@/lib/api";

interface SelectionData {
  html: string;
  text: string;
  rect: { top: number; left: number; width: number; bottom: number };
}

interface Deck {
  id: number;
  name: string;
}

interface CreatorEventDetail {
  html?: string;
  text?: string;
}

const T = {
  card:  "color-mix(in srgb, var(--bg-card) 98%, transparent)",
  ink:   "var(--text-primary)",
  ink3:  "var(--text-muted)",
  ink4:  "var(--text-muted)",
  mono:  "var(--font-mono)",
  serif: "var(--font-serif)",
  sans:  "'Inter', system-ui, sans-serif",
};

export default function GlobalCardCreator() {
  const [selection, setSelection] = useState<SelectionData | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [decks, setDecks]         = useState<Deck[]>([]);
  const [front, setFront]         = useState("");
  const [back, setBack]           = useState("");
  const [deckId, setDeckId]       = useState<number>(0);
  const [deckName, setDeckName]   = useState("MedOS Cards");
  const [tags, setTags]           = useState("");
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const baseRef = useRef("");
  const frontRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const base = getBackendUrl();
    baseRef.current = base;
    fetch(`${base}/anki/decks`).then(r => r.json()).then((data: unknown) => {
      if (Array.isArray(data)) setDecks(data as Deck[]);
    }).catch(() => {});
  }, []);

  const handleMouseUp = useCallback((e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    // Don't intercept selection inside inputs, existing tooltips, or the modal itself
    if (target.closest(".anki-expanded-modal")) {
      setSelection(null);
      return;
    }
    if (target.closest("input, textarea, [contenteditable], .medos-amboss-tooltip, .anki-creator-modal, .anki-selection-actions")) {
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelection(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 4) {
      setSelection(null);
      return;
    }

    try {
      const range = sel.getRangeAt(0);
      const rect  = range.getBoundingClientRect();
      const div   = document.createElement("div");
      div.appendChild(range.cloneContents());
      setSelection({
        html: div.innerHTML,
        text,
        rect: { top: rect.top, left: rect.left, width: rect.width, bottom: rect.bottom },
      });
    } catch {
      setSelection(null);
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setModalOpen(false);
      setSelection(null);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleMouseUp, handleKeyDown]);

  const openModal = useCallback((prefill?: CreatorEventDetail) => {
    const frontHtml = prefill?.html || prefill?.text || selection?.html || selection?.text || "";
    setFront(frontHtml);
    setBack("");
    setTags("");
    setSaved(false);
    setSaving(false);
    setModalOpen(true);
    setSelection(null);
    // Sync front contenteditable after render
    setTimeout(() => {
      if (frontRef.current) {
        frontRef.current.innerHTML = frontHtml;
      }
    }, 50);
  }, [selection]);

  const openSearch = useCallback(() => {
    if (!selection) return;
    window.dispatchEvent(new CustomEvent("medos:open-search", { detail: { query: selection.text, run: true } }));
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection]);

  useEffect(() => {
    const handleCreateCard = (event: Event) => {
      const detail = (event as CustomEvent<CreatorEventDetail>).detail ?? {};
      const selected = window.getSelection?.()?.toString().replace(/\s+/g, " ").trim() ?? "";
      openModal({
        html: detail.html,
        text: detail.text ?? selected,
      });
    };
    window.addEventListener("medos:create-anki-card", handleCreateCard);
    return () => window.removeEventListener("medos:create-anki-card", handleCreateCard);
  }, [openModal]);

  const closeModal = () => {
    setModalOpen(false);
    setSelection(null);
  };

  const handleSave = async () => {
    const frontHtml = frontRef.current?.innerHTML ?? front;
    if (!frontHtml.trim() || !back.trim()) return;
    setSaving(true);
    try {
      const chosenDeck = decks.find(d => d.id === deckId);
      await fetch(`${baseRef.current}/anki/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          front_html: frontHtml,
          back_html: back,
          tags,
          deck_id: deckId,
          deck_name: chosenDeck?.name ?? deckName,
        }),
      });
      setSaved(true);
      setTimeout(closeModal, 800);
    } catch {
      setSaving(false);
    }
  };

  // ── Floating button ────────────────────────────────────────────────────
  const showButton = selection && !modalOpen;
  const btnLeft = selection
    ? Math.max(8, Math.min(window.innerWidth - 164, selection.rect.left + selection.rect.width / 2 - 74))
    : 0;
  const btnTop = selection ? Math.max(8, selection.rect.top - 44) : 0;

  return (
    <>
      {/* Floating selection actions */}
      {showButton && (
        <div
          className="anki-selection-actions"
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
          style={{
            position: "fixed",
            top: btnTop,
            left: btnLeft,
            zIndex: 9999,
            display: "flex",
            gap: 6,
            animation: "slide-up 0.18s ease",
            userSelect: "none",
          }}
        >
          <button
            onClick={() => openModal()}
            style={{
              background: "#f97316",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "5px 10px",
              fontFamily: T.mono,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              cursor: "pointer",
              boxShadow: "0 4px 16px rgba(249,115,22,0.35)",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.8" width="12" height="12">
              <path d="M8 2v12M2 8h12"/>
            </svg>
            Anki+
          </button>
          <button
            onClick={openSearch}
            style={{
              background: "var(--bg-card)",
              color: T.ink3,
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "5px 10px",
              fontFamily: T.mono,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              cursor: "pointer",
              boxShadow: "0 4px 16px rgba(15,23,42,0.14)",
            }}
          >
            Search
          </button>
        </div>
      )}

      {/* Modal */}
      {modalOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={closeModal}
            style={{
              position: "fixed", inset: 0, zIndex: 10040,
              background: "var(--overlay-bg)", backdropFilter: "blur(3px)",
            }}
          />
          {/* Modal box */}
          <div
            className="anki-creator-modal"
            style={{
              position: "fixed", zIndex: 10050,
              top: "50%", left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(600px, 94vw)",
              maxHeight: "88vh",
              overflowY: "auto",
              background: T.card,
              borderRadius: 16,
              boxShadow: "0 24px 64px rgba(15,23,42,0.22)",
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              animation: "slide-up 0.22s ease",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 7,
                  background: "linear-gradient(135deg, #f97316, #fb923c)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" width="14" height="14">
                    <rect x="3" y="5" width="18" height="13" rx="2"/>
                    <path d="M7 9h10M7 13h6"/>
                  </svg>
                </div>
                <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 600, color: T.ink }}>
                  Create Anki Card
                </div>
              </div>
              <button
                onClick={closeModal}
                style={{
                  background: "none", border: "none", color: T.ink4,
                  fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "2px 6px",
                }}
              >
                ✕
              </button>
            </div>

            {/* Front */}
            <div>
              <label style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink3, display: "block", marginBottom: 6 }}>
                Front
              </label>
              <div
                ref={frontRef}
                contentEditable
                suppressContentEditableWarning
                style={{
                  minHeight: 80, border: "1px solid var(--border)", borderRadius: 8,
                  padding: "10px 12px", fontFamily: T.serif, fontSize: 14, color: T.ink,
                  lineHeight: 1.5, outline: "none",
                  background: "rgba(249,115,22,0.03)",
                }}
              />
            </div>

            {/* Back */}
            <div>
              <label style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink3, display: "block", marginBottom: 6 }}>
                Back (Answer)
              </label>
              <textarea
                value={back}
                onChange={e => setBack(e.target.value)}
                placeholder="Type the answer here…"
                rows={4}
                style={{
                  width: "100%", boxSizing: "border-box",
                  border: "1px solid var(--border)", borderRadius: 8,
                  padding: "10px 12px", fontFamily: T.serif, fontSize: 14, color: T.ink,
                  lineHeight: 1.5, outline: "none", resize: "vertical",
                  background: "rgba(15,118,110,0.02)",
                }}
              />
            </div>

            {/* Deck + Tags row */}
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink3, display: "block", marginBottom: 6 }}>
                  Deck
                </label>
                {decks.length > 0 ? (
                  <select
                    value={deckId}
                    onChange={e => {
                      const id = Number(e.target.value);
                      setDeckId(id);
                      setDeckName(decks.find(d => d.id === id)?.name ?? "MedOS Cards");
                    }}
                    style={{
                      width: "100%", padding: "8px 10px", borderRadius: 7,
                      border: "1px solid var(--border)", background: T.card,
                      fontFamily: T.sans, fontSize: 12.5, color: T.ink, outline: "none",
                    }}
                  >
                    <option value={0}>MedOS Cards (new deck)</option>
                    {decks.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name.split("::").join(" › ")}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={deckName}
                    onChange={e => setDeckName(e.target.value)}
                    placeholder="Deck name"
                    style={{
                      width: "100%", boxSizing: "border-box",
                      padding: "8px 10px", borderRadius: 7,
                      border: "1px solid var(--border)", background: T.card,
                      fontFamily: T.sans, fontSize: 12.5, color: T.ink, outline: "none",
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink3, display: "block", marginBottom: 6 }}>
                  Tags (comma-separated)
                </label>
                <input
                  value={tags}
                  onChange={e => setTags(e.target.value)}
                  placeholder="e.g. cardiology, step1"
                  style={{
                    width: "100%", boxSizing: "border-box",
                    padding: "8px 10px", borderRadius: 7,
                    border: "1px solid var(--border)", background: T.card,
                    fontFamily: T.sans, fontSize: 12.5, color: T.ink, outline: "none",
                  }}
                />
              </div>
            </div>

            {/* Save button */}
            <button
              onClick={handleSave}
              disabled={saving || saved}
              style={{
                padding: "10px 20px", borderRadius: 9, border: "none",
                background: saved ? "#10b981" : "#f97316",
                color: "#fff", fontFamily: T.mono, fontSize: 11,
                letterSpacing: "0.14em", textTransform: "uppercase",
                cursor: saving || saved ? "default" : "pointer",
                transition: "background 0.2s",
                alignSelf: "flex-end",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saved ? "✓ Saved" : saving ? "Saving…" : "Save Card"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
