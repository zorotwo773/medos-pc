"use client";
import type { DrugQuickInfo } from "@/types/drugs";

interface Props {
  drug: DrugQuickInfo;
  onOpen: () => void;
  onAddToCompare: () => void;
  isInCompareList: boolean;
}

export default function DrugResultCard({ drug, onOpen, onAddToCompare, isInCompareList }: Props) {
  const brands = drug.brand_names
    ? drug.brand_names.split(",").map(b => b.trim()).filter(Boolean).slice(0, 3)
    : [];

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(14,165,233,0.35)";
        (e.currentTarget as HTMLDivElement).style.boxShadow  = "0 0 0 1px rgba(14,165,233,0.2)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)";
        (e.currentTarget as HTMLDivElement).style.boxShadow  = "none";
      }}
    >
      {/* BBW banner */}
      {drug.has_black_box && (
        <div style={{
          background: "var(--red-glow, rgba(239,68,68,0.1))",
          borderBottom: "1px solid rgba(239,68,68,0.2)",
          padding: "4px 12px",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11"
               style={{ color: "var(--red, #ef4444)", flexShrink: 0 }}>
            <path d="m10.29 3.86-8.71 15.07a1 1 0 0 0 .88 1.5h17.42a1 1 0 0 0 .88-1.5L11.71 3.86a1 1 0 0 0-1.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span style={{
            fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
            textTransform: "uppercase", color: "var(--red, #ef4444)",
          }}>Black Box Warning</span>
        </div>
      )}

      {/* Card body */}
      <div style={{ padding: "12px 14px", flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        {/* Name row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary)", lineHeight: 1.3 }}>
            {drug.generic_name}
          </span>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: "rgba(99,102,241,0.1)", color: "#818cf8", flexShrink: 0,
          }}>{drug.regulatory_status}</span>
        </div>

        {/* Brands */}
        {brands.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {brands.join(" · ")}
          </div>
        )}

        {drug.alias_match && (
          <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 700 }}>
            via {drug.alias_match}
          </div>
        )}

        {/* Drug class */}
        {drug.drug_class && (
          <div style={{ marginTop: 2 }}>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
              background: "rgba(245,158,11,0.1)", color: "#d97706",
            }}>{drug.drug_class.split("|")[0].slice(0, 50)}</span>
          </div>
        )}

        {/* Dose snippet */}
        {drug.dose_snippet && (
          <div style={{
            fontSize: 12, color: "var(--text-secondary)",
            borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 4,
            lineHeight: 1.5,
          }}>
            <span style={{ fontWeight: 600, color: "var(--text-muted)", fontSize: 10,
                           textTransform: "uppercase", letterSpacing: "0.04em" }}>Dose: </span>
            {drug.dose_snippet}
          </div>
        )}
      </div>

      {/* Action row */}
      <div style={{
        display: "flex", gap: 6, padding: "8px 12px",
        borderTop: "1px solid var(--border)",
        background: "rgba(0,0,0,0.02)",
      }}>
        <button
          onClick={onOpen}
          style={{
            flex: 1, padding: "6px 12px", fontSize: 12, fontWeight: 600,
            background: "var(--accent)", color: "var(--accent-ink)",
            border: "none", borderRadius: 6, cursor: "pointer",
          }}
        >
          Open ▸
        </button>
        <button
          onClick={onAddToCompare}
          style={{
            padding: "6px 10px", fontSize: 11, fontWeight: 600,
            background: isInCompareList ? "var(--accent)" : "transparent",
            color: isInCompareList ? "var(--accent-ink)" : "var(--text-muted)",
            border: `1px solid ${isInCompareList ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 6, cursor: "pointer",
          }}
        >
          {isInCompareList ? "✓ Added" : "+ Compare"}
        </button>
      </div>
    </div>
  );
}
