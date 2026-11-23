"use client";
import { useEffect, useRef, useState } from "react";
import { getBackendUrl } from "@/lib/api";
import { useMultiTouchSwipe } from "@/lib/useTouchGestures";

interface LexiResult {
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export default function LexiView() {
  const shellRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [results, setResults] = useState<LexiResult[]>([]);

  useEffect(() => {
    fetch(`${getBackendUrl()}/lexi/health`)
      .then(r => r.json())
      .then(d => setConfigured(Boolean(d?.configured && d?.exists)))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${getBackendUrl()}/lexi/search?q=${encodeURIComponent(term)}&limit=30`);
        const d = await r.json();
        setResults(d?.results || []);
      } catch {
        setResults([]);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  useMultiTouchSwipe(shellRef, {
    fingers: 2,
    ignoreSelector: "input, button, a",
    onSwipeLeft: () => window.history.forward(),
    onSwipeRight: () => window.history.back(),
    onSwipeUp: () => window.dispatchEvent(new CustomEvent("medos:open-search", { detail: { query: q, run: false } })),
  });

  useMultiTouchSwipe(shellRef, {
    fingers: 3,
    ignoreSelector: "input, button, a",
    onSwipeLeft: () => window.history.forward(),
    onSwipeRight: () => window.history.back(),
    onSwipeUp: () => window.dispatchEvent(new CustomEvent("medos:open-command-center")),
  });

  return (
    <div ref={shellRef} className="touch-gesture-surface" style={{ flex: 1, display: "flex", flexDirection: "column", padding: "16px 20px", gap: 12 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600 }}>Lexicomp</h2>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search drug term..."
        style={{ padding: "8px 10px", fontSize: 13, maxWidth: 420 }}
      />
      {configured === false && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Lexicomp database is not configured on this machine (`LEXI_DB_PATH` missing or invalid).
        </p>
      )}
      <div style={{ overflow: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
        {results.length === 0 ? (
          <p style={{ padding: 12, fontSize: 12, color: "var(--text-muted)" }}>
            {q.trim() ? "No results." : "Start typing to search Lexicomp."}
          </p>
        ) : (
          results.map(r => (
            <div key={r.id} style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{r.title}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.subtitle}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
