"use client";
/* Shared primitives for the ACLS module. */

import type { CSSProperties, ReactNode } from "react";
import type { Rich } from "@/lib/acls/types";

/** Material Symbols glyph (same pattern as the Sidebar). */
export function M({ name, size = 20, fill = false, weight, style }: {
  name: string; size?: number; fill?: boolean; weight?: number; style?: CSSProperties;
}) {
  const w = weight ?? (fill ? 420 : 300);
  return (
    <span
      className="material-symbols-outlined"
      aria-hidden="true"
      style={{ fontSize: size, lineHeight: 1, fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' ${w}, 'GRAD' 0, 'opsz' ${size}`, ...style }}
    >
      {name}
    </span>
  );
}

/** Render rich bullet segments (plain + bold). */
export function RichLine({ parts }: { parts: Rich[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? <span key={i}>{p}</span> : <b key={i} style={{ color: "var(--text-primary)", fontWeight: 650 }}>{p.b}</b>,
      )}
    </>
  );
}

export const monoLabel: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

export function SectionTitle({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...monoLabel, margin: "0 0 8px", ...style }}>{children}</div>;
}

/** Numbered AHA-style step badge. */
export function NumBadge({ n, tone = "var(--text-secondary)" }: { n?: number; tone?: string }) {
  if (!n) return null;
  return (
    <span style={{
      width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: tone, color: "var(--text-inverted)",
      fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700,
    }}>{n}</span>
  );
}

export const cardStyle: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "0 1px 2px rgba(15,23,42,0.05)",
};

/** Scoped keyframes used across the module. */
export const ACLS_CSS = `
@keyframes acls-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(225,29,72,0.45); } 50% { box-shadow: 0 0 0 9px rgba(225,29,72,0); } }
@keyframes acls-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
@keyframes acls-in { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
.acls-in { animation: acls-in .22s ease both; }
.acls-btn { transition: transform .08s, filter .12s, background .12s, border-color .12s; cursor: pointer; }
.acls-btn:hover { filter: brightness(1.05); }
.acls-btn:active { transform: scale(0.98); }
.acls-chip { transition: background .12s, border-color .12s; cursor: pointer; }
.acls-chip:hover { border-color: var(--border-strong); background: var(--bg-card-hover); }
.acls-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.acls-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
@media (prefers-reduced-motion: reduce) {
  .acls-in { animation: none; }
}
`;
