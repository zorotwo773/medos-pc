"use client";
/* ──────────────────────────────────────────────────────────────
   Map mode — the whole algorithm as the familiar two-column
   chart. Built from the same node graph as walk mode (map layout
   hints on each node), so the two views never drift apart.
   Every box is tappable: tapping moves the walker there.
   ────────────────────────────────────────────────────────────── */

import type { Algorithm, AlgoNode } from "@/lib/acls/types";
import { M, NumBadge, RichLine, monoLabel } from "./ui";

const GAP = 30;

function nodeBoxStyle(node: AlgoNode, current: boolean, accent: string): React.CSSProperties {
  const base: React.CSSProperties = {
    position: "relative",
    borderRadius: 10,
    padding: "10px 12px",
    textAlign: "left",
    width: "100%",
    border: "1px solid var(--border)",
    background: "var(--bg-card)",
    outline: current ? `2.5px solid ${accent}` : "none",
    outlineOffset: 2,
    animation: current ? "acls-pulse 1.6s ease-in-out infinite" : undefined,
  };
  if (node.kind === "decision") {
    return { ...base, background: "color-mix(in srgb, var(--red) 8%, var(--bg-card))", border: "1.5px solid color-mix(in srgb, var(--red) 45%, var(--border))", borderRadius: 999, textAlign: "center", padding: "9px 14px" };
  }
  if (node.kind === "outcome") {
    return { ...base, background: "color-mix(in srgb, var(--green) 10%, var(--bg-card))", border: "1.5px solid color-mix(in srgb, var(--green) 40%, var(--border))" };
  }
  if (node.kind === "loop") {
    return { ...base, background: "color-mix(in srgb, var(--accent) 7%, var(--bg-card))" };
  }
  if (node.primaryEvent === "shock") {
    return { ...base, border: "1.5px solid color-mix(in srgb, var(--red) 55%, var(--border))" };
  }
  return base;
}

export default function MapView({ algo, currentId, onJump, accent }: {
  algo: Algorithm;
  currentId: string | null;
  onJump: (id: string) => void;
  accent: string;
}) {
  const nodes = Object.values(algo.nodes).filter((n) => n.map);
  const nCols = Math.max(...nodes.map((n) => (n.map!.col + (n.map!.span ?? 1)))) || 1;

  return (
    <div className="acls-in acls-scroll" style={{ overflowX: "auto", padding: "4px 2px 20px" }}>
      <div style={{ maxWidth: nCols > 1 ? 760 : 460, margin: "0 auto", minWidth: nCols > 1 ? 560 : 320 }}>
        {/* Column headers */}
        {algo.mapCols && (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${nCols}, minmax(0,1fr))`, gap: GAP, marginBottom: 12 }}>
            {algo.mapCols.map((c, i) => (
              <div key={c} style={{ ...monoLabel, textAlign: "center", color: i === 0 ? "var(--red-dim)" : "var(--text-muted)" }}>{c}</div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: `repeat(${nCols}, minmax(0,1fr))`, columnGap: GAP, rowGap: 26 }}>
          {nodes.map((node) => {
            const m = node.map!;
            const current = node.id === currentId;
            const flowsDown = !!node.next || (node.choices?.some((c) => algo.nodes[c.to]?.map && algo.nodes[c.to].map!.row > m.row) ?? false);
            return (
              <div
                key={node.id}
                style={{
                  gridColumn: `${m.col + 1}${m.span === 2 ? " / span 2" : ""}`,
                  gridRow: m.row + 1,
                  position: "relative",
                  display: "flex",
                  alignItems: "stretch",
                }}
              >
                <button type="button" className="acls-chip" onClick={() => onJump(node.id)} style={nodeBoxStyle(node, current, accent)} title={`Go to: ${node.title}`}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: node.kind === "decision" ? "center" : "flex-start" }}>
                    <NumBadge n={node.num} tone={node.kind === "loop" ? "var(--accent-dim)" : "var(--text-secondary)"} />
                    <span style={{
                      fontSize: node.kind === "decision" ? 12.5 : 13.5,
                      fontWeight: 700,
                      color: node.kind === "decision" ? "var(--red-dim)" : "var(--text-primary)",
                      lineHeight: 1.25,
                    }}>
                      {node.kind === "decision" ? (node.question ?? node.title) : node.title}
                      {node.primaryEvent === "shock" && <M name="bolt" size={14} fill style={{ color: "var(--red)", verticalAlign: -2, marginLeft: 3 }} />}
                    </span>
                  </span>

                  {node.kind !== "decision" && node.bullets && (
                    <ul style={{ margin: "6px 0 0", padding: "0 0 0 16px", display: "flex", flexDirection: "column", gap: 2.5 }}>
                      {node.bullets.slice(0, 4).map((b, i) => (
                        <li key={i} style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.4 }}>
                          <RichLine parts={b} />
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Decision yes/no hints */}
                  {node.kind === "decision" && node.choices && (
                    <span style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
                      {node.choices.map((c) => (
                        <span key={c.label} style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: c.tone === "danger" ? "var(--red-dim)" : "var(--text-muted)" }}>
                          {c.label.split("—")[0].trim()} → {algo.nodes[c.to]?.num ? `step ${algo.nodes[c.to].num}` : algo.nodes[c.to]?.title ?? ""}
                        </span>
                      ))}
                    </span>
                  )}

                  {/* Cross-reference chip (e.g. "Go to 5") */}
                  {node.goto && (
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6,
                      fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--accent-strong)",
                      border: "1px dashed var(--accent-dim)", borderRadius: 999, padding: "2px 8px",
                    }}>
                      <M name="u_turn_left" size={12} /> {node.goto.label}
                    </span>
                  )}
                </button>

                {/* Down-flow connector */}
                {flowsDown && (
                  <span style={{ position: "absolute", left: "50%", bottom: -26, transform: "translateX(-50%)", height: 26, display: "flex", alignItems: "center", pointerEvents: "none" }}>
                    <M name="south" size={17} style={{ color: "var(--border-strong)" }} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
