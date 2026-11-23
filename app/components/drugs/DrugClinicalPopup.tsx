"use client";
import { AlertTriangle, Check, ExternalLink, Plus, X } from "lucide-react";
import type React from "react";
import { useRef } from "react";
import { useModalA11y } from "@/lib/useModalA11y";
import { zIndex } from "@/lib/zIndex";
import type { DrugPopup, DrugQuickInfo } from "@/types/drugs";
import DoseCalculator from "./DoseCalculator";

interface Props {
  popup: DrugPopup;
  onClose: () => void;
  onOpenFull: (drugId: number) => void;
  onAddToCompare?: (drug: DrugQuickInfo) => void;
  isInCompareList?: boolean;
}

export default function DrugClinicalPopup({
  popup,
  onClose,
  onOpenFull,
  onAddToCompare,
  isInCompareList,
}: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const drug = popup.drug;
  const warningLine = popup.warnings_quick.map(w => w.warning_text).slice(0, 2).join(" · ");
  const sideEffectLine = popup.side_effects_quick.map(e => e.effect_text).slice(0, 5).join(", ");
  const interactionLine = popup.interactions_quick.map(i => i.interacting_name).slice(0, 5).join(", ");
  const coverageLabel = coverageText(drug.coverage_tier, drug.coverage_status);
  useModalA11y(modalRef, onClose);

  const quickInfo: DrugQuickInfo = {
    drug_id: drug.drug_id,
    generic_name: drug.generic_name,
    brand_names: drug.brand_names.join(", "),
    drug_class: drug.drug_class.join(" | "),
    dose_snippet: drug.dose_snippet,
    bbw_snippet: drug.bbw_snippet,
    regulatory_status: drug.regulatory_status,
    has_black_box: drug.has_black_box,
    href: `/drugs?id=${drug.drug_id}`,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: zIndex.modalOverlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
        background: "rgba(0,0,0,0.45)",
      }}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drug-clinical-popup-title"
        tabIndex={-1}
        style={{
        width: "min(820px, 100%)",
        maxHeight: "min(760px, calc(100vh - 36px))",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-card)",
        boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
        zIndex: zIndex.modalPanel,
      }}>
        <div style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h2 id="drug-clinical-popup-title" style={{
                margin: 0,
                fontSize: 20,
                lineHeight: 1.2,
                fontWeight: 850,
                color: "var(--text-primary)",
              }}>
                {drug.generic_name}
              </h2>
              <Badge>{drug.rxcui_tty === "BN" ? "Brand" : "Generic"}</Badge>
              <Badge>{drug.regulatory_status || "RX"}</Badge>
              <Badge tone={drug.coverage_tier >= 3 ? "green" : drug.coverage_tier >= 2 ? "amber" : "muted"}>
                {coverageLabel}
              </Badge>
            </div>
            <div style={{ marginTop: 5, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {drug.brand_names.length > 0 ? `Brands: ${drug.brand_names.slice(0, 5).join(", ")}` : "No brand aliases loaded"}
              {drug.drug_class.length > 0 ? ` · Class: ${drug.drug_class[0]}` : ""}
              {drug.rxcui ? ` · RXCUI: ${drug.rxcui}` : ""}
            </div>
            {popup.identity?.atc && popup.identity.atc.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>ATC</span>
                {popup.identity.atc.slice(0, 4).map(item => (
                  <a
                    key={item.atc_code}
                    href={`https://www.whocc.no/atc_ddd_index/?code=${item.atc_code}`}
                    target="_blank"
                    rel="noreferrer"
                    title={item.atc_name}
                    style={{
                      fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 4,
                      background: "rgba(20,184,166,0.12)", color: "#0f766e",
                      border: "1px solid rgba(20,184,166,0.28)", textDecoration: "none",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    }}
                  >{item.atc_code}</a>
                ))}
                {popup.identity.atc[0]?.atc_name && (
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    — {popup.identity.atc[0].atc_name}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            style={iconButtonStyle}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: 16 }}>
          {warningLine && (
            <div style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "9px 10px",
              borderRadius: 8,
              border: "1px solid rgba(239,68,68,0.28)",
              background: "rgba(239,68,68,0.08)",
              color: "var(--text-secondary)",
              fontSize: 12,
              lineHeight: 1.5,
              marginBottom: 14,
            }}>
              <AlertTriangle size={15} style={{ color: "var(--red, #ef4444)", flexShrink: 0, marginTop: 1 }} />
              <div><strong style={{ color: "var(--text-primary)" }}>Warnings:</strong> {warningLine}</div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
            <div style={{ minWidth: 0 }}>
              <SectionTitle>Indications</SectionTitle>
              {popup.indications.length > 0 ? (
                <ol style={{ margin: "0 0 14px", paddingLeft: 18, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6 }}>
                  {popup.indications.slice(0, 5).map(indication => (
                    <li key={indication.id}>
                      <span>{indication.indication_text}</span>
                      {indication.label_status ? (
                        <span style={{ marginLeft: 6, color: "var(--text-muted)", fontSize: 11 }}>
                          {indicationLabel(indication.label_status)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyText>No structured indications extracted yet.</EmptyText>
              )}

              <SectionTitle>Common Side Effects</SectionTitle>
              <InlineText>{sideEffectLine || "No quick side-effect summary extracted yet."}</InlineText>

              <SectionTitle>Top Interactions</SectionTitle>
              <InlineText>{interactionLine || "No quick interaction summary extracted yet."}</InlineText>

              <SectionTitle>Ingredients</SectionTitle>
              <InlineText>
                {popup.ingredients.length > 0
                  ? popup.ingredients.map(i => i.ingredient_name).slice(0, 6).join(", ")
                  : "No structured ingredient rows loaded yet."}
              </InlineText>
            </div>

            <div style={{ minWidth: 0 }}>
              <DoseCalculator
                key={drug.drug_id}
                drugId={drug.drug_id}
                indications={popup.indications}
                defaultIndicationId={popup.default_indication_id}
                defaultWeightKg={popup.default_weight_kg || 60}
                formOptions={popup.identity.form_options || []}
                renalAdjustmentAvailable={Boolean(popup.adjustments?.renal_available)}
                hepaticAdjustmentAvailable={Boolean(popup.adjustments?.hepatic_available)}
                initialOpen
                hideTrigger
              />
            </div>
          </div>
        </div>

        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderTop: "1px solid var(--border)",
          background: "rgba(0,0,0,0.02)",
        }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 520, lineHeight: 1.45 }}>
            {popup.disclaimer}
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button type="button" onClick={() => onOpenFull(drug.drug_id)} style={secondaryButtonStyle}>
              <ExternalLink size={14} />
              Open full reference
            </button>
            {onAddToCompare && (
              <button type="button" onClick={() => onAddToCompare(quickInfo)} style={secondaryButtonStyle}>
                {isInCompareList ? <Check size={14} /> : <Plus size={14} />}
                {isInCompareList ? "In compare" : "Add to compare"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function coverageText(tier: number, status: string) {
  if (tier >= 4) return "Reviewed broad";
  if (tier === 3) return "Rx ready";
  if (tier === 2) return "Parsed dose";
  if (tier === 1) return "Summary";
  return status === "extract_error" ? "Needs review" : "Identity";
}

function indicationLabel(status: string) {
  if (status === "fda_labeled") return "FDA";
  if (status === "off_label") return "off-label";
  if (status === "unsupported") return "unsupported";
  if (status === "dosing_section") return "dose";
  return "source";
}

function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "green" | "amber" }) {
  const color = tone === "green" ? "var(--green, #22c55e)" : tone === "amber" ? "#d97706" : "var(--text-muted)";
  const bg = tone === "green" ? "rgba(34,197,94,0.1)" : tone === "amber" ? "rgba(245,158,11,0.1)" : "rgba(148,163,184,0.1)";
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 800,
      padding: "2px 7px",
      borderRadius: 999,
      color,
      background: bg,
      border: "1px solid rgba(148,163,184,0.18)",
    }}>
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      margin: "0 0 6px",
      fontSize: 11,
      fontWeight: 850,
      color: "var(--text-muted)",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
    }}>
      {children}
    </div>
  );
}

function InlineText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.55 }}>
      {children}
    </div>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
      {children}
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-card)",
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 750,
  cursor: "pointer",
};
