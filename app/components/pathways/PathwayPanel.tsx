"use client";
import { useState } from "react";
import type { PathwayGraph, PathwayResource } from "@/lib/pathways/types";
import { M, cardStyle, kindMeta, monoLabel, Pill } from "./ui";
import { TeachingHtml, ResourceRail } from "./Teaching";

export default function PathwayPanel({
  graph,
  path,
  accent,
  resources,
  openResource,
  onChoose,
  onJump
}: {
  graph: PathwayGraph;
  path: string[];
  accent: string;
  resources: Record<string, PathwayResource>;
  openResource: (r: PathwayResource | undefined) => void;
  onChoose: (to: string) => void;
  onJump: (id: string) => void;
}) {
  const [showTeaching, setShowTeaching] = useState<Record<string, boolean>>({});

  const toggleTeaching = (id: string) => {
    setShowTeaching((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="pw-scroll" style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
      {path.map((id, index) => {
        const node = graph.nodes[id];
        if (!node) return null;

        const isLast = index === path.length - 1;
        const chosenTo = !isLast ? path[index + 1] : null;
        const km = kindMeta(node.kind);
        const isOutcome = node.branches.length === 0;

        return (
          <div key={id} className="pw-in" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <div style={{
              ...cardStyle,
              border: isLast ? `2px solid ${accent}` : "1px solid var(--border)",
              padding: "20px 22px",
              opacity: isLast ? 1 : 0.75,
              background: isLast ? "var(--bg-card)" : "var(--chrome-bg)"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 26, height: 26, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: `color-mix(in srgb, ${accent} 14%, var(--bg-card))`, color: accent, flexShrink: 0,
                }}>
                  <M name={km.glyph} size={16} fill />
                </span>
                <span style={{ ...monoLabel, color: accent }}>{km.label}</span>
                <span style={{ flex: 1 }} />
                <span style={{ ...monoLabel }}>Step {index + 1}</span>
              </div>

              <h2 style={{ margin: "12px 0 0", fontFamily: "var(--font-serif)", fontSize: 21, fontWeight: 620, lineHeight: 1.2, color: "var(--text-primary)" }}>
                {node.title}
              </h2>

              {node.question && (
                <p style={{ margin: "12px 0 0", fontSize: 15, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.45 }}>
                  {node.question}
                </p>
              )}

              {/* teaching */}
              {node.teachingHtml && (
                <div style={{ marginTop: 14 }}>
                  <div className="pw-in" style={{ paddingLeft: 12, borderLeft: `2px solid color-mix(in srgb, ${accent} 30%, var(--border))` }}>
                    <TeachingHtml html={node.teachingHtml} resources={resources} onOpen={openResource} />
                  </div>
                </div>
              )}

              {/* attached resources */}
              {node.resourceKeys.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ ...monoLabel, marginBottom: 7 }}>Learn more</div>
                  <ResourceRail keys={node.resourceKeys} resources={resources} onOpen={openResource} />
                </div>
              )}

              {/* branches / choices */}
              {!isOutcome && (
                <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
                  {node.branches.map((b, i) => {
                    const isSelected = b.to === chosenTo;
                    const label = b.label || (graph.nodes[b.to]?.title ?? "Continue");
                    const isSingle = node.branches.length === 1;

                    if (isLast) {
                      return (
                        <button
                          key={b.to}
                          type="button"
                          onClick={() => onChoose(b.to)}
                          className="pw-btn pw-choice-btn"
                          style={{
                            display: "flex", alignItems: "center", gap: 12, width: "100%",
                            padding: "12px 14px", borderRadius: 8, background: isSingle ? accent : "var(--bg-base)",
                            border: isSingle ? "none" : "1px solid var(--border)", cursor: "pointer", textAlign: "left",
                            color: isSingle ? "#fff" : "var(--text-primary)",
                            transition: "all 0.1s ease-in-out"
                          }}
                        >
                          {!isSingle && <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--text-muted)", flexShrink: 0 }} />}
                          <span style={{ fontSize: 15, fontWeight: isSingle ? 600 : 500 }}>{isSingle ? `Continue: ${label}` : label}</span>
                          {isSingle && <M name="arrow_forward" size={18} style={{ marginLeft: "auto" }} />}
                        </button>
                      );
                    } else {
                      return (
                        <div key={b.to} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 8, opacity: isSelected ? 1 : 0.5 }}>
                          {!isSingle && (
                            <div style={{
                              width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
                              border: isSelected ? `5px solid ${accent}` : "2px solid var(--text-muted)",
                            }} />
                          )}
                          <span style={{ fontSize: 15, fontWeight: isSelected ? 600 : 500, color: "var(--text-primary)" }}>{label}</span>
                        </div>
                      );
                    }
                  })}
                </div>
              )}

              {/* outcome */}
              {isOutcome && isLast && (
                <div className="pw-in" style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <M name="check_circle" size={20} fill style={{ color: accent }} />
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: 16, fontWeight: 640, color: "var(--text-primary)" }}>Recommendation reached</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                    <button type="button" onClick={() => onJump(graph.rootId)} className="pw-btn" style={primaryBtn(accent)}>
                      <M name="restart_alt" size={16} /> Start over
                    </button>
                    {path.length > 1 && (
                      <button type="button" onClick={() => onJump(path[path.length - 2])} className="pw-btn" style={ghostBtn}>
                        <M name="undo" size={16} /> Back one step
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function primaryBtn(accent: string): React.CSSProperties {
  return { display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 15px", borderRadius: 10, background: accent, color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" };
}

const ghostBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 10,
  background: "var(--bg-card)", color: "var(--text-secondary)", border: "1px solid var(--border)", fontSize: 13, fontWeight: 550, cursor: "pointer",
};
