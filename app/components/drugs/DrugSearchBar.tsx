"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBackendUrl } from "@/lib/api";
import type { DrugQuickInfo } from "@/types/drugs";

interface Props {
  onSearch: (results: DrugQuickInfo[], query: string) => void;
  onOpenDrug: (drugId: number) => void;
  initialQuery?: string;
}

const PillIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" style={{ opacity: 0.6 }}>
    <rect x="3" y="10" width="18" height="11" rx="2" />
    <path d="M8 10V6a4 4 0 0 1 8 0v4" />
    <line x1="12" y1="14" x2="12" y2="17" />
  </svg>
);

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
);

export default function DrugSearchBar({ onSearch, onOpenDrug, initialQuery = "" }: Props) {
  const [query, setQuery]             = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<DrugQuickInfo[]>([]);
  const [showDrop, setShowDrop]       = useState(false);
  const [activeIdx, setActiveIdx]     = useState(-1);
  const [loading, setLoading]         = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef  = useRef<HTMLInputElement>(null);
  const dropRef   = useRef<HTMLDivElement>(null);

  const runSearch = useCallback(async (searchTerm: string, resultLimit = 20) => {
    const trimmed = searchTerm.trim();
    if (!trimmed) return;
    setLoading(true);
    setSearchError(null);
    setShowDrop(false);
    try {
      const res  = await fetch(`${getBackendUrl()}/drugs/search?q=${encodeURIComponent(trimmed)}&limit=${resultLimit}`);
      if (!res.ok) throw new Error("Drug search unavailable");
      const data = await res.json();
      onSearch(data.results || [], trimmed);
    } catch {
      setSearchError("Drug search unavailable. Check that the backend is running.");
      setShowDrop(true);
      onSearch([], trimmed);
    } finally { setLoading(false); }
  }, [onSearch]);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); setSearchError(null); setShowDrop(false); return; }
    setLoading(true);
    setSearchError(null);
    try {
      const res  = await fetch(`${getBackendUrl()}/drugs/search?q=${encodeURIComponent(q)}&limit=8`);
      if (!res.ok) throw new Error("Drug search unavailable");
      const data = await res.json();
      setSuggestions(data.results || []);
      setShowDrop(true);
      setActiveIdx(-1);
    } catch {
      setSuggestions([]);
      setSearchError("Drug suggestions unavailable. Keep typing or try Search.");
      setShowDrop(true);
      setActiveIdx(-1);
    } finally { setLoading(false); }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => fetchSuggestions(val), 200);
  };

  const handleSearch = useCallback(async () => {
    await runSearch(query);
  }, [query, runSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDrop || suggestions.length === 0) {
      if (e.key === "Enter") handleSearch();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0) {
        onOpenDrug(suggestions[activeIdx].drug_id);
        setShowDrop(false);
      } else {
        handleSearch();
      }
    } else if (e.key === "Escape") {
      setShowDrop(false);
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowDrop(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    setQuery(initialQuery);
    if (debounce.current) clearTimeout(debounce.current);
    if (initialQuery.trim()) {
      runSearch(initialQuery);
    } else {
      setSuggestions([]);
      setShowDrop(false);
    }
  }, [initialQuery, runSearch]);

  return (
    <div style={{ position: "relative", width: "100%" }}>
      {/* Search input */}
      <div style={{ position: "relative" }}>
        <span style={{
          position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
          color: "var(--text-muted)", pointerEvents: "none",
        }}>
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => query.length >= 2 && (suggestions.length > 0 || searchError) && setShowDrop(true)}
          placeholder="Search drugs by generic name, brand name, or class…"
          style={{
            width: "100%",
            padding: "10px 44px 10px 38px",
            fontSize: 14,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text-primary)",
            outline: "none",
            boxSizing: "border-box",
          }}
          onFocusCapture={e => {
            (e.target as HTMLInputElement).style.borderColor = "var(--accent)";
            (e.target as HTMLInputElement).style.boxShadow  = "0 0 0 2px rgba(14,165,233,0.15)";
          }}
          onBlurCapture={e => {
            (e.target as HTMLInputElement).style.borderColor = "var(--border)";
            (e.target as HTMLInputElement).style.boxShadow  = "none";
          }}
        />
        {/* Search button */}
        <button
          onClick={handleSearch}
          disabled={loading}
          style={{
            position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
            padding: "4px 12px", fontSize: 12, fontWeight: 600,
            background: "var(--accent)", color: "var(--accent-ink)", opacity: loading ? 0.72 : 1,
            border: "none", borderRadius: 6, cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "..." : "Search"}
        </button>
      </div>

      {/* Autosuggest dropdown */}
      {showDrop && (suggestions.length > 0 || searchError) && (
        <div
          ref={dropRef}
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 50,
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
            overflow: "hidden",
          }}
        >
          {searchError && (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--red, #ef4444)", background: "rgba(239,68,68,0.08)", borderBottom: suggestions.length ? "1px solid var(--border)" : "none" }}>
              {searchError}
            </div>
          )}
          {suggestions.map((drug, i) => (
            <div
              key={drug.drug_id}
              onClick={() => { onOpenDrug(drug.drug_id); setShowDrop(false); }}
              style={{
                display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 12px",
                cursor: "pointer",
                background: i === activeIdx ? "var(--bg-hover, rgba(255,255,255,0.04))" : "transparent",
                borderBottom: i < suggestions.length - 1 ? "1px solid var(--border)" : "none",
              }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span style={{ marginTop: 2, flexShrink: 0, color: "var(--text-muted)" }}>
                <PillIcon />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {drug.has_black_box && (
                    <span style={{
                      fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                      background: "var(--red-glow, rgba(239,68,68,0.1))", color: "var(--red, #ef4444)",
                      padding: "1px 5px", borderRadius: 3,
                    }}>BBW</span>
                  )}
                  <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>
                    {drug.generic_name}
                  </span>
                  {drug.brand_names && (
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      — {drug.brand_names.split(",").slice(0, 2).join(", ")}
                    </span>
                  )}
                  {drug.alias_match && (
                    <span style={{
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "rgba(14,165,233,0.1)",
                      color: "var(--accent)",
                      fontWeight: 700,
                    }}>
                      via {drug.alias_match}
                    </span>
                  )}
                  {drug.drug_class && (
                    <span style={{
                      fontSize: 10, padding: "1px 6px", borderRadius: 4,
                      background: "rgba(245,158,11,0.1)", color: "#d97706",
                      fontWeight: 600,
                    }}>{drug.drug_class.split("|")[0].slice(0, 30)}</span>
                  )}
                </div>
                {drug.dose_snippet && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    {drug.dose_snippet.slice(0, 80)}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0, marginTop: 2 }}>
                {drug.regulatory_status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
