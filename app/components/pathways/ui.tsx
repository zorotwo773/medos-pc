"use client";
/* Shared primitives for the Pathways module. */

import type { CSSProperties, ReactNode } from "react";

/** Material Symbols glyph (same pattern as the Sidebar / ACLS). */
export function M({ name, size = 20, fill = false, weight, style }: {
  name: string; size?: number; fill?: boolean; weight?: number; style?: CSSProperties;
}) {
  const w = weight ?? (fill ? 440 : 300);
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

export const cardStyle: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  boxShadow: "0 1px 2px rgba(15,23,42,0.05)",
};

/** Kind → icon + label for a node badge. */
export function kindMeta(kind: string): { glyph: string; label: string } {
  if (kind === "decision") return { glyph: "help", label: "Decision" };
  if (kind === "outcome") return { glyph: "flag", label: "Recommendation" };
  return { glyph: "arrow_forward", label: "Step" };
}

/** A small pill chip. */
export function Pill({ icon, children, color, style }: { icon?: string; children: ReactNode; color?: string; style?: CSSProperties }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 550,
      background: color ? `color-mix(in srgb, ${color} 12%, var(--bg-card))` : "var(--bg-card)",
      color: color || "var(--text-secondary)",
      border: `1px solid ${color ? `color-mix(in srgb, ${color} 30%, transparent)` : "var(--border)"}`,
      whiteSpace: "nowrap", ...style,
    }}>
      {icon && <M name={icon} size={13} />}
      {children}
    </span>
  );
}

/** Scoped keyframes + hover states for the module. */
export const PW_CSS = `
@keyframes pw-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes pw-pop { 0% { opacity: 0; transform: scale(.96); } 100% { opacity: 1; transform: none; } }
@keyframes pw-pulse { 0%,100% { box-shadow: 0 0 0 0 var(--pw-pulse, rgba(219,39,119,.4)); } 50% { box-shadow: 0 0 0 10px transparent; } }
@keyframes pw-sheen { to { background-position: 200% 0; } }
.pw-in { animation: pw-in .24s cubic-bezier(.4,0,.2,1) both; }
.pw-pop { animation: pw-pop .2s ease both; }
.pw-btn { transition: transform .08s, filter .12s, background .12s, border-color .12s, box-shadow .12s; cursor: pointer; }
.pw-btn:hover { filter: brightness(1.03); }
.pw-btn:active { transform: scale(0.985); }
.pw-card { transition: transform .13s cubic-bezier(.4,0,.2,1), box-shadow .13s, border-color .13s; cursor: pointer; }
.pw-card:hover { transform: translateY(-3px); box-shadow: 0 10px 26px -12px rgba(15,23,42,.28); }
.pw-chip { transition: background .12s, border-color .12s, color .12s; cursor: pointer; }
.pw-chip:hover { filter: brightness(1.04); border-color: var(--border-strong); }
.pw-scroll::-webkit-scrollbar { width: 7px; height: 7px; }
.pw-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.pw-scroll::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
.pw-teach a.pw-res { color: var(--mod-pathways); font-weight: 600; text-decoration: none; border-bottom: 1px dotted color-mix(in srgb, var(--mod-pathways) 55%, transparent); cursor: pointer; }
.pw-teach a.pw-res:hover { background: color-mix(in srgb, var(--mod-pathways) 12%, transparent); border-radius: 3px; }
.pw-teach p { margin: 0 0 8px; }
.pw-teach ul, .pw-teach ol { margin: 4px 0 8px; padding-left: 20px; }
.pw-teach li { margin: 2px 0; }
.pw-teach h4, .pw-teach h3 { font-size: 13px; margin: 8px 0 4px; font-weight: 700; }
.pw-teach table { border-collapse: collapse; margin: 6px 0; font-size: 12.5px; }
.pw-teach td, .pw-teach th { border: 1px solid var(--border); padding: 4px 8px; }
@media (prefers-reduced-motion: reduce) { .pw-in, .pw-pop { animation: none; } }
`;
