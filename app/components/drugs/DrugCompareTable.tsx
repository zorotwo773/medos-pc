"use client";
import { useState } from "react";
import type { DrugProfile } from "@/types/drugs";

interface Props {
  drugs: DrugProfile[];
  onClose: () => void;
  onRemove: (drugId: number) => void;
}

const COMPARE_SECTIONS = [
  { key: "adult_dosing",               label: "Adult Dosing" },
  { key: "renal_dosing",               label: "Renal Dosing" },
  { key: "hepatic_dosing",             label: "Hepatic Dosing" },
  { key: "adverse_effects",            label: "Adverse Effects" },
  { key: "interactions_major",         label: "Major Interactions" },
  { key: "interactions_contraindicated", label: "Contraindicated" },
  { key: "mechanism",                  label: "Mechanism" },
  { key: "half_life",                  label: "Half-Life" },
  { key: "monitoring",                 label: "Monitoring" },
  { key: "pregnancy",                  label: "Pregnancy" },
];

function Cell({ text, hasBbw }: { text: string; hasBbw?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > 200;
  const display   = !truncated || expanded ? text : text.slice(0, 200) + "…";

  return (
    <td style={{
      padding: "9px 12px", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.65,
      verticalAlign: "top", border: "1px solid var(--border)",
      background: hasBbw ? "rgba(239,68,68,0.04)" : undefined,
      maxWidth: 240,
    }}>
      {text ? (
        <>
          {display}
          {truncated && (
            <button
              onClick={() => setExpanded(e => !e)}
              style={{
                display: "block", marginTop: 4, fontSize: 10, fontWeight: 600,
                color: "var(--accent)", background: "none", border: "none",
                cursor: "pointer", padding: 0,
              }}
            >{expanded ? "show less ▲" : "show more ▾"}</button>
          )}
        </>
      ) : (
        <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>—</span>
      )}
    </td>
  );
}

export default function DrugCompareTable({ drugs, onClose, onRemove }: Props) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel, var(--bg-card))",
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
          Drug Comparison ({drugs.length} drugs)
        </span>
        <button
          onClick={onClose}
          style={{
            fontSize: 12, fontWeight: 600, padding: "5px 10px",
            background: "transparent", color: "var(--text-muted)",
            border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
          }}
        >✕ Close</button>
      </div>

      {/* Scrollable table */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
          <thead>
            <tr>
              <th style={{
                position: "sticky", top: 0, zIndex: 10,
                padding: "8px 12px", fontSize: 11, fontWeight: 700,
                textTransform: "uppercase", letterSpacing: "0.05em",
                background: "var(--bg-panel, var(--bg-card))",
                border: "1px solid var(--border)",
                color: "var(--text-muted)", textAlign: "left", minWidth: 120,
              }}>Section</th>
              {drugs.map(d => (
                <th key={d.drug_id} style={{
                  position: "sticky", top: 0, zIndex: 10,
                  padding: "8px 12px", fontSize: 12, fontWeight: 700,
                  background: "var(--bg-panel, var(--bg-card))",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)", textAlign: "left", minWidth: 180,
                }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{d.generic_name}</div>
                      {d.brand_names.length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}>
                          {d.brand_names[0]}
                        </div>
                      )}
                      {d.has_black_box && (
                        <span style={{
                          fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 3,
                          background: "rgba(239,68,68,0.1)", color: "var(--red, #ef4444)",
                          display: "inline-block", marginTop: 2,
                        }}>BBW</span>
                      )}
                    </div>
                    <button
                      onClick={() => onRemove(d.drug_id)}
                      style={{
                        fontSize: 11, color: "var(--text-muted)", background: "none",
                        border: "none", cursor: "pointer", flexShrink: 0,
                      }}
                    >✕</button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Meta rows */}
            {[
              { label: "Drug Class",    fn: (d: DrugProfile) => d.drug_class.join(", ") },
              { label: "Brand Names",   fn: (d: DrugProfile) => d.brand_names.slice(0, 3).join(", ") },
              { label: "Regulatory",    fn: (d: DrugProfile) => d.regulatory_status },
              { label: "Generic Avail", fn: (d: DrugProfile) => d.is_generic_available ? "Yes" : "No" },
            ].map(row => (
              <tr key={row.label}>
                <td style={{
                  padding: "7px 12px", fontSize: 11, fontWeight: 700,
                  color: "var(--text-muted)", border: "1px solid var(--border)",
                  background: "var(--bg-card)", whiteSpace: "nowrap",
                }}>{row.label}</td>
                {drugs.map(d => (
                  <td key={d.drug_id} style={{
                    padding: "7px 12px", fontSize: 12, color: "var(--text-secondary)",
                    border: "1px solid var(--border)",
                  }}>{row.fn(d) || "—"}</td>
                ))}
              </tr>
            ))}

            {/* BBW row */}
            <tr>
              <td style={{
                padding: "7px 12px", fontSize: 11, fontWeight: 700,
                color: "var(--text-muted)", border: "1px solid var(--border)",
                background: "var(--bg-card)", whiteSpace: "nowrap",
              }}>BBW</td>
              {drugs.map(d => (
                <Cell
                  key={d.drug_id}
                  text={d.quick_info.bbw_snippet || "None"}
                  hasBbw={d.has_black_box}
                />
              ))}
            </tr>

            {/* Clinical section rows */}
            {COMPARE_SECTIONS.map(sec => (
              <tr key={sec.key}>
                <td style={{
                  padding: "7px 12px", fontSize: 11, fontWeight: 700,
                  color: "var(--text-muted)", border: "1px solid var(--border)",
                  background: "var(--bg-card)", whiteSpace: "nowrap",
                }}>{sec.label}</td>
                {drugs.map(d => {
                  const s = d.sections[sec.key as keyof typeof d.sections];
                  return <Cell key={d.drug_id} text={s?.text || ""} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
