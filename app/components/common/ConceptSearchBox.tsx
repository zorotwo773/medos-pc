"use client";
/**
 * ConceptSearchBox — a reusable, type-ahead medical-concept search field.
 *
 * Backed by GET /umls/autocomplete (prefix suggestions, one row per concept) with
 * an inline "ghost" completion (Tab to accept) and a keyboard-navigable dropdown.
 * Picking a suggestion (or resolving free text on Enter/▶) fires onPick(cui, term).
 *
 * Drop it into any search surface that should resolve to a UMLS concept:
 *   <ConceptSearchBox onPick={(cui) => goTo(cui)} />
 */
import { useEffect, useRef, useState } from "react";
import { getBackendUrl } from "@/lib/api";

interface Suggestion { term: string; cui: string; semantic_group?: string; preferred_name?: string }

interface Props {
  onPick: (cui: string, term?: string) => void;
  placeholder?: string;
  buttonLabel?: string;
  initialValue?: string;
  autoFocus?: boolean;
  /** Visual width hint for the wrapping field. */
  minWidth?: number;
}

export default function ConceptSearchBox({ onPick, placeholder = "Search any medical concept…", buttonLabel = "Search", initialValue = "", autoFocus, minWidth = 220 }: Props) {
  const [value, setValue] = useState(initialValue);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [notFound, setNotFound] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipFetch = useRef(false); // set right after a pick so the value change doesn't re-open the dropdown

  // Debounced prefix fetch.
  useEffect(() => {
    const q = value.trim();
    setNotFound(false);
    if (skipFetch.current) { skipFetch.current = false; setSugs([]); setOpen(false); return; }
    if (q.length < 1) { setSugs([]); return; }
    let on = true;
    const t = setTimeout(() => {
      fetch(`${getBackendUrl()}/umls/autocomplete?q=${encodeURIComponent(q)}&limit=8`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (on) { setSugs(d?.suggestions || []); setActive(0); setOpen(true); } })
        .catch(() => { if (on) setSugs([]); });
    }, 110);
    return () => { on = false; clearTimeout(t); };
  }, [value]);

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const ghost = open && sugs[active] && sugs[active].term.toLowerCase().startsWith(value.toLowerCase()) && sugs[active].term.length > value.length
    ? sugs[active].term.slice(value.length) : "";

  const choose = (s: Suggestion) => { skipFetch.current = true; setValue(s.term); setSugs([]); setOpen(false); onPick(s.cui, s.term); };

  const submitText = async () => {
    if (open && sugs[active]) { choose(sugs[active]); return; }
    const q = value.trim();
    if (!q) return;
    try {
      const res = await fetch(`${getBackendUrl()}/umls/resolve?q=${encodeURIComponent(q)}`);
      const d = res.ok ? await res.json() : null;
      if (d?.cui) { setOpen(false); onPick(d.cui, q); }
      else setNotFound(true);
    } catch { setNotFound(true); }
  };

  return (
    <div ref={boxRef} style={{ position: "relative", display: "flex", gap: 6, flex: 1, minWidth }}>
      <div style={{ position: "relative", flex: 1 }}>
        {ghost && (
          <div aria-hidden style={{ position: "absolute", inset: 0, height: 34, padding: "0 10px", display: "flex", alignItems: "center", fontSize: 13, pointerEvents: "none", whiteSpace: "pre", overflow: "hidden" }}>
            <span style={{ color: "transparent" }}>{value}</span><span style={{ color: "var(--text-muted)", opacity: 0.55 }}>{ghost}</span>
          </div>
        )}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={e => { setValue(e.target.value); setOpen(true); }}
          onFocus={() => value.trim().length >= 1 && sugs.length > 0 && setOpen(true)}
          onKeyDown={e => {
            if (e.key === "ArrowDown" && open) { e.preventDefault(); setActive(a => Math.min(a + 1, sugs.length - 1)); }
            else if (e.key === "ArrowUp" && open) { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
            else if (e.key === "Tab" && ghost) { e.preventDefault(); setValue(sugs[active].term); }
            else if (e.key === "Enter") { e.preventDefault(); void submitText(); }
            else if (e.key === "Escape") setOpen(false);
          }}
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && sugs.length > 0}
          aria-controls="concept-search-suggestions"
          aria-activedescendant={open && sugs[active] ? `concept-search-suggestion-${active}` : undefined}
          style={{ position: "relative", width: "100%", height: 34, border: `1px solid ${notFound ? "rgba(239,68,68,0.5)" : "var(--border)"}`, borderRadius: 6, padding: "0 10px", fontSize: 13, background: "transparent", color: "var(--text-primary)" }}
        />
      </div>
      <button type="button" onClick={() => void submitText()}
        style={{ height: 34, padding: "0 14px", borderRadius: 6, background: "#0f766e", color: "white", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>{buttonLabel}</button>

      {open && sugs.length > 0 && (
        <div id="concept-search-suggestions" role="listbox" aria-label="Suggested concepts" style={{ position: "absolute", top: 38, left: 0, right: 0, zIndex: 40, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", overflow: "hidden", maxHeight: 340, overflowY: "auto" }}>
          {sugs.map((s, i) => (
            <button id={`concept-search-suggestion-${i}`} key={s.cui + i} type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(s)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px 11px", border: "none", cursor: "pointer", background: i === active ? "var(--bg-subtle)" : "transparent", color: "var(--text-primary)", fontSize: 13 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.term}</span>
              {s.semantic_group && <span style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", flexShrink: 0 }}>{s.semantic_group}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
