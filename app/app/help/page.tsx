"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { markdownToHtml } from "@/lib/markdown";

type DocKey = "user-guide" | "readme";
const DOCS: { key: DocKey; label: string }[] = [
  { key: "user-guide", label: "User Guide" },
  { key: "readme", label: "README" },
];

export default function HelpPage() {
  const [doc, setDoc] = useState<DocKey>("user-guide");
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/help/${doc}`)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(d => { if (!cancelled) setHtml(markdownToHtml(d.markdown || "")); })
      .catch(() => { if (!cancelled) setError("Couldn't load this document."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [doc]);

  return (
    <div style={{
      flex: 1, minHeight: 0, height: "100%",
      display: "flex", flexDirection: "column", overflow: "hidden",
      background: "var(--bg-base)", color: "var(--text-primary)",
    }}>
      <header style={{
        flexShrink: 0,
        display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
        padding: "14px 20px", borderBottom: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--bg-card) 88%, transparent)", backdropFilter: "blur(8px)",
      }}>
        <Link href="/" style={{ color: "var(--text-secondary)", textDecoration: "none", fontSize: 13, fontWeight: 600 }}>← MedOS</Link>
        <strong style={{ fontFamily: "var(--font-serif)", fontSize: 18 }}>Help &amp; Documentation</strong>
        <div role="tablist" style={{ marginLeft: "auto", display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          {DOCS.map(d => (
            <button
              key={d.key}
              role="tab"
              aria-selected={doc === d.key}
              onClick={() => setDoc(d.key)}
              style={{
                padding: "6px 14px", fontSize: 13, fontWeight: 700, border: "none",
                borderLeft: d.key !== "user-guide" ? "1px solid var(--border)" : "none",
                background: doc === d.key ? "var(--accent, #0ea5e9)" : "transparent",
                color: doc === d.key ? "#fff" : "var(--text-secondary)", cursor: "pointer",
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 22px 80px" }}>
          {loading && <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading…</div>}
          {error && <div style={{ color: "var(--red, #ef4444)", fontSize: 14 }}>{error}</div>}
          {!loading && !error && (
            <article className="doc-content" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </main>
    </div>
  );
}
