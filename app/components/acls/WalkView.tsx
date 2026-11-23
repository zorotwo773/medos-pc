"use client";
/* ──────────────────────────────────────────────────────────────
   Walk mode — one node at a time. The current step renders as a
   large card with big decision buttons / a primary action, med
   chips that log doses, and an expandable teaching layer. A
   breadcrumb trail shows the path taken so far.
   ────────────────────────────────────────────────────────────── */

import { useState } from "react";
import type { Algorithm, AlgoNode, MedDose, NodeChoice } from "@/lib/acls/types";
import { M, NumBadge, RichLine, cardStyle, monoLabel } from "./ui";

export interface WalkHandlers {
  onChoose: (choice: NodeChoice) => void;
  onPrimary: (node: AlgoNode) => void;
  onJump: (nodeId: string) => void;
  onMed?: (med: MedDose) => void;
}

const toneColors: Record<string, { bg: string; fg: string; border: string }> = {
  danger: { bg: "var(--red)", fg: "#fff", border: "var(--red)" },
  safe: { bg: "var(--green)", fg: "#fff", border: "var(--green)" },
  neutral: { bg: "var(--bg-card)", fg: "var(--text-primary)", border: "var(--border-strong)" },
};

export default function WalkView({ algo, nodeId, path, handlers, accent, cprDue }: {
  algo: Algorithm;
  nodeId: string;
  path: string[];
  handlers: WalkHandlers;
  accent: string;
  cprDue?: boolean;
}) {
  const node = algo.nodes[nodeId];
  const [showDetail, setShowDetail] = useState(false);
  const [medInfo, setMedInfo] = useState<MedDose | null>(null);

  if (!node) return null;

  const kindLabel =
    node.kind === "decision" ? "Decision" :
    node.kind === "loop" ? "CPR cycle" :
    node.kind === "outcome" ? "Hand-off" : "Action";

  return (
    <div className="acls-in" key={nodeId} style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 620, margin: "0 auto", width: "100%" }}>
      {/* Breadcrumb trail */}
      <div className="acls-scroll" style={{ display: "flex", gap: 5, overflowX: "auto", padding: "2px 1px", alignItems: "center" }}>
        {path.slice(-7).map((id, i, arr) => {
          const n = algo.nodes[id];
          const last = i === arr.length - 1;
          return (
            <span key={`${id}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
              <button
                type="button"
                className="acls-chip"
                onClick={() => !last && handlers.onJump(id)}
                style={{
                  border: `1px solid ${last ? accent : "var(--border)"}`,
                  background: last ? `color-mix(in srgb, ${accent} 12%, var(--bg-card))` : "var(--bg-card)",
                  color: last ? "var(--text-primary)" : "var(--text-muted)",
                  borderRadius: 999, padding: "3px 10px", fontSize: 11,
                  fontWeight: last ? 650 : 450, whiteSpace: "nowrap",
                }}
              >
                {n?.num ? `${n.num} · ` : ""}{n?.title ?? id}
              </button>
              {!last && <M name="chevron_right" size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />}
            </span>
          );
        })}
      </div>

      {/* Current node card */}
      <div style={{ ...cardStyle, borderTop: `3px solid ${accent}`, padding: "18px 20px 16px", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <NumBadge n={node.num} tone={accent} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...monoLabel, fontSize: 9 }}>{kindLabel}</div>
            <h2 style={{ margin: "1px 0 0", fontFamily: "var(--font-serif)", fontSize: 24, fontWeight: 620, color: "var(--text-primary)", lineHeight: 1.15 }}>
              {node.title}
            </h2>
          </div>
          {node.kind === "loop" && (
            <M name="autorenew" size={22} style={{ color: accent, opacity: 0.85 }} />
          )}
        </div>

        {node.question && (
          <p style={{ margin: "12px 0 2px", fontSize: 16.5, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.45 }}>
            {node.question}
          </p>
        )}

        {node.bullets && (
          <ul style={{ margin: "12px 0 2px", padding: "0 0 0 20px", display: "flex", flexDirection: "column", gap: 7 }}>
            {node.bullets.map((b, i) => (
              <li key={i} style={{ fontSize: 14.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                <RichLine parts={b} />
              </li>
            ))}
          </ul>
        )}

        {/* Med chips */}
        {node.meds && node.meds.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={monoLabel}>Meds at this step — tap to {handlers.onMed ? "log" : "view"}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 7 }}>
              {node.meds.map((m) => (
                <div key={m.name} style={{ display: "flex", alignItems: "stretch", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden", background: "var(--bg-subtle)" }}>
                  <button
                    type="button"
                    className="acls-chip"
                    onClick={() => (handlers.onMed ? handlers.onMed(m) : setMedInfo(m))}
                    style={{ border: 0, background: "transparent", padding: "7px 10px", textAlign: "left" }}
                    title={handlers.onMed ? `Log ${m.name}` : m.name}
                  >
                    <span style={{ display: "block", fontSize: 13, fontWeight: 650, color: "var(--text-primary)" }}>
                      {handlers.onMed && <M name="add_circle" size={13} style={{ color: "var(--green-dim)", marginRight: 4, verticalAlign: -2 }} />}
                      {m.name}
                    </span>
                    <span style={{ display: "block", fontSize: 11.5, color: "var(--text-muted)", marginTop: 1 }}>{m.dose}</span>
                  </button>
                  {m.detail && (
                    <button
                      type="button"
                      className="acls-chip"
                      onClick={() => setMedInfo(medInfo?.name === m.name ? null : m)}
                      style={{ border: 0, borderLeft: "1px solid var(--border)", background: "transparent", padding: "0 8px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}
                      title="Dosing detail"
                    >
                      <M name="info" size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {medInfo?.detail && (
              <div className="acls-in" style={{ marginTop: 9, padding: "10px 12px", borderRadius: 9, background: "var(--bg-subtle)", border: "1px dashed var(--border-strong)", fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                <b style={{ color: "var(--text-primary)" }}>{medInfo.name}.</b> {medInfo.detail}
              </div>
            )}
          </div>
        )}

        {/* Teaching layer */}
        {node.detail && (
          <div style={{ marginTop: 13 }}>
            <button
              type="button"
              className="acls-chip"
              onClick={() => setShowDetail((v) => !v)}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 999, padding: "4px 11px", fontSize: 11.5, color: "var(--text-secondary)", fontWeight: 550 }}
            >
              <M name={showDetail ? "expand_less" : "school"} size={15} />
              {showDetail ? "Hide detail" : "Why / how — detail"}
            </button>
            {showDetail && (
              <p className="acls-in" style={{ margin: "9px 0 0", padding: "10px 12px", borderRadius: 9, background: "var(--bg-subtle)", fontSize: 13.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>
                {node.detail}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Advance controls */}
      {node.kind === "decision" && node.choices && (
        <div style={{ display: "grid", gridTemplateColumns: node.choices.length > 1 ? "1fr 1fr" : "1fr", gap: 10 }}>
          {node.choices.map((c) => {
            const t = toneColors[c.tone ?? "neutral"];
            return (
              <button
                key={c.label}
                type="button"
                className="acls-btn"
                onClick={() => handlers.onChoose(c)}
                style={{
                  border: `1.5px solid ${t.border}`, background: t.bg, color: t.fg,
                  borderRadius: 12, padding: "15px 14px", textAlign: "center",
                  display: "flex", flexDirection: "column", gap: 3, alignItems: "center",
                }}
              >
                <span style={{ fontSize: 16.5, fontWeight: 700, lineHeight: 1.2 }}>{c.label}</span>
                {c.sub && <span style={{ fontSize: 11.5, opacity: 0.85, fontWeight: 500 }}>{c.sub}</span>}
              </button>
            );
          })}
        </div>
      )}

      {(node.kind === "action" || node.kind === "loop") && node.primaryLabel && node.next && (
        <button
          type="button"
          className="acls-btn"
          onClick={() => handlers.onPrimary(node)}
          style={{
            border: 0, borderRadius: 12, padding: "16px 14px",
            background: node.primaryEvent === "shock" ? "var(--red)" : accent,
            color: "#fff", fontSize: 17, fontWeight: 700, letterSpacing: "0.01em",
            animation: node.kind === "loop" && cprDue ? "acls-pulse 1.1s ease-in-out infinite" : undefined,
          }}
        >
          {node.primaryLabel}
          {node.kind === "loop" && cprDue && <span style={{ display: "block", fontSize: 11.5, fontWeight: 550, marginTop: 2, opacity: 0.9 }}>2-minute cycle complete — check rhythm now</span>}
        </button>
      )}

      {node.kind === "outcome" && (
        <div style={{ ...cardStyle, padding: "13px 16px", display: "flex", alignItems: "center", gap: 10, borderLeft: `3px solid ${accent}` }}>
          <M name="flag" size={19} style={{ color: accent }} />
          <span style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            End of this pathway. Use the map to review, or jump back to any earlier step from the trail above.
          </span>
        </div>
      )}
    </div>
  );
}
