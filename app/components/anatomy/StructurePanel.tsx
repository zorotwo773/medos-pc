"use client";
import { useState, useEffect } from "react";
import { X, Activity, BookOpen, AlertCircle, Pill, ChevronRight } from "lucide-react";
import type { Disease } from "@/types/medical";
import { getOrganCategory, getDiseasesForMesh } from "./organMap";

interface Props {
  meshName: string;
  diseases: Disease[];
  onClose: () => void;
  onSelectDisease: (d: Disease) => void;
}

// Module-level cache — avoids re-fetching on every click
let defsCache: Record<string, string> | null = null;

function lookupDefinition(defs: Record<string, string>, meshName: string): string | null {
  // Strip laterality suffix and trailing digits, then lowercase
  const clean = meshName
    .replace(/\s*\((right|left|r|l)\)\s*$/i, "")
    .replace(/\s*\d+$/, "")
    .trim()
    .toLowerCase();

  // 1. Exact match
  if (defs[clean]) return defs[clean];

  const keys = Object.keys(defs);

  // 2. Key starts with cleaned name — pick shortest winning key
  let best: string | null = null;
  let minLen = Infinity;
  for (const k of keys) {
    if (k.startsWith(clean) && k.length < minLen) { minLen = k.length; best = defs[k]; }
  }
  if (best) return best;

  // 3. Cleaned name starts with key (reverse prefix) — pick shortest key
  minLen = Infinity;
  for (const k of keys) {
    if (clean.startsWith(k) && k.length >= 5 && k.length < minLen) { minLen = k.length; best = defs[k]; }
  }
  if (best) return best;

  // 4. Substring containment (min 6 chars to avoid noise)
  for (const k of keys) {
    if (k.length >= 6 && (clean.includes(k) || k.includes(clean))) return defs[k];
  }

  return null;
}

export default function StructurePanel({ meshName, diseases, onClose, onSelectDisease }: Props) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview"|"diseases">("overview");

  const organ = getOrganCategory(meshName);
  const related = getDiseasesForMesh(meshName, diseases);

  const displayName = meshName.slice(0, 60);

  // Load anatomy definition — cached after first fetch
  useEffect(() => {
    if (defsCache) {
      setDefinition(lookupDefinition(defsCache, meshName));
      return;
    }
    fetch("/anatomy_defs.json")
      .then(r => r.json())
      .then((defs: Record<string, string>) => {
        defsCache = defs;
        setDefinition(lookupDefinition(defs, meshName));
      })
      .catch(() => setDefinition(null));
  }, [meshName]);

  return (
    <div style={{
      position: "absolute", right: 0, top: 0, bottom: 0,
      width: 320, background: "color-mix(in srgb, var(--bg-card) 95%, transparent)",
      borderLeft: "1px solid var(--border)",
      display: "flex", flexDirection: "column",
      backdropFilter: "blur(12px)",
      zIndex: 20,
      boxShadow: "-4px 0 20px rgba(0,0,0,0.06)",
    }}
      className="animate-slide-up"
    >
      {/* Header */}
      <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--border)", borderLeft: `3px solid var(--accent)` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)", marginBottom: 4, lineHeight: 1.3 }}>
              {displayName}
            </h3>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {organ && <span className="tag tag-blue">{organ}</span>}
              {related.length > 0 && (
                <span className="tag tag-red">{related.length} disease{related.length > 1 ? "s" : ""}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", color: "var(--text-muted)", padding: "4px 6px", flexShrink: 0, fontSize: 16 }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, marginTop: 12 }}>
          {(["overview", "diseases"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: "7px 8px", fontSize: 12, fontWeight: 500,
              background: "none", border: "none", cursor: "pointer",
              color: tab === t ? "var(--accent)" : "var(--text-muted)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}>
              {t === "overview" ? "📐 Overview" : `🩺 Diseases (${related.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "14px 16px" }}>
        {tab === "overview" && (
          <div>
            {/* Anatomical definition */}
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 8 }}>
                <BookOpen size={11} style={{ display: "inline", marginRight: 4 }} />
                Anatomy Definition
              </p>
              {definition ? (
                <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>{definition}</p>
              ) : (
                <p style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>
                  Definition not available. Search &quot;{displayName}&quot; in medical references.
                </p>
              )}
            </div>

            {/* Quick disease summary */}
            {related.length > 0 && (
              <div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 8 }}>
                  <AlertCircle size={11} style={{ display: "inline", marginRight: 4 }} />
                  Clinical Relevance
                </p>
                <div style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: 8, padding: "10px 12px" }}>
                  <p style={{ fontSize: 12, color: "#f87171", marginBottom: 6, fontWeight: 600 }}>
                    {related.length} associated condition{related.length > 1 ? "s" : ""} in Cliniccons
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {related.slice(0, 5).map(d => (
                      <button
                        key={d.disease_name}
                        onClick={() => { setTab("diseases"); onSelectDisease(d); }}
                        style={{
                          background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)",
                          borderRadius: 4, padding: "3px 8px", fontSize: 11, color: "#f87171",
                          cursor: "pointer",
                        }}
                      >
                        {d.disease_name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {related.length === 0 && (
              <div style={{ padding: "16px 12px", background: "var(--bg-card)", borderRadius: 8, border: "1px solid var(--border)", textAlign: "center" }}>
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No diseases linked to this structure in the current database.</p>
              </div>
            )}
          </div>
        )}

        {tab === "diseases" && (
          <div>
            {related.length === 0 ? (
              <div style={{ textAlign: "center", paddingTop: 30 }}>
                <Activity size={28} color="var(--text-muted)" style={{ margin: "0 auto 10px" }} />
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No diseases associated with this structure.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {related.map(d => (
                  <button
                    key={d.disease_name}
                    onClick={() => onSelectDisease(d)}
                    style={{
                      textAlign: "left", padding: "11px 12px",
                      background: "var(--bg-card)", border: "1px solid var(--border)",
                      borderRadius: 8, cursor: "pointer", width: "100%",
                      color: "var(--text-primary)",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--red)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 3 }}>
                          {d.disease_name}
                        </p>
                        <div style={{ display: "flex", gap: 5 }}>
                          <span className={`tag ${d.primary_organ === organ ? "tag-red" : "tag-gray"}`}>
                            {d.primary_organ === organ ? "Primary" : "Related"}
                          </span>
                          <span className="tag tag-gray">{d.primary_organ}</span>
                        </div>
                      </div>
                      <ChevronRight size={14} color="var(--text-muted)" />
                    </div>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
                      {(d.clinical_synthesis || d.harrisons_synthesis || [])[0]?.slice(0, 90)}…
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
