"use client";
import type React from "react";
import { useState } from "react";
import type { DrugProfile, DrugQuickInfo, OpenFdaSection } from "@/types/drugs";
import DrugSectionTab, { DrugSectionContent, DrugIdContext } from "./DrugSectionTab";
import DoseCalculator from "./DoseCalculator";

interface Props {
  drug: DrugProfile;
  onClose: () => void;
  onAddToCompare: (drug: DrugQuickInfo) => void;
  isInCompareList: boolean;
}

const TABS = [
  { key: "dosing",        label: "Dosing" },
  { key: "adverse",       label: "Adverse FX" },
  { key: "interactions",  label: "Interactions" },
  { key: "pharmacology",  label: "Pharmacology" },
  { key: "monitoring",    label: "Monitoring" },
  { key: "supplies",      label: "Supplies" },
  { key: "fda",           label: "FDA Label" },
  { key: "identity",      label: "Identity" },
];

export default function DrugDetailModal({ drug, onClose, onAddToCompare, isInCompareList }: Props) {
  const [activeTab, setActiveTab] = useState("dosing");
  const [bbwExpanded, setBbwExpanded] = useState(false);
  const [doseOpen, setDoseOpen] = useState(false);

  const bbwSection = drug.sections.black_box_warning;
  const bbwText    = bbwSection?.text || drug.quick_info.bbw_snippet || "";

  const toQuickInfo = (): DrugQuickInfo => ({
    drug_id:          drug.drug_id,
    generic_name:     drug.generic_name,
    brand_names:      drug.brand_names.join(", "),
    drug_class:       drug.drug_class.join(" | "),
    dose_snippet:     drug.quick_info.dose_snippet,
    bbw_snippet:      drug.quick_info.bbw_snippet,
    regulatory_status: drug.regulatory_status,
    has_black_box:    drug.has_black_box,
    href:             `/drugs?id=${drug.drug_id}`,
  });

  return (
    <DrugIdContext.Provider value={drug.drug_id}>
    <div className="drug-detail-modal" style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: "var(--bg-card)", borderLeft: "1px solid var(--border)",
      overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <div style={{
        padding: "14px 16px 12px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel, var(--bg-card))",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18"
                   style={{ color: "var(--accent)", flexShrink: 0 }}>
                <rect x="3" y="10" width="18" height="11" rx="2"/>
                <path d="M8 10V6a4 4 0 0 1 8 0v4"/>
                <line x1="12" y1="14" x2="12" y2="17"/>
              </svg>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
                {drug.generic_name}
              </h2>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                background: "rgba(99,102,241,0.1)", color: "#818cf8",
              }}>{drug.regulatory_status}</span>
              {drug.is_generic_available && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                  background: "rgba(34,197,94,0.1)", color: "var(--green, #22c55e)",
                }}>Generic ✓</span>
              )}
            </div>

            {drug.brand_names.length > 0 && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                {drug.brand_names.slice(0, 5).join(" · ")}
              </div>
            )}

            {drug.drug_class.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
                {drug.drug_class.slice(0, 3).map((cls, i) => (
                  <span key={i} style={{
                    fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
                    background: "rgba(245,158,11,0.1)", color: "#d97706",
                  }}>{cls}</span>
                ))}
              </div>
            )}

            {Boolean(drug.identity?.atc?.length || drug.clinical_umls?.mechanism_class?.length) && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
                {(drug.identity?.atc || []).slice(0, 3).map(item => (
                  <a
                    key={item.atc_code}
                    href={`https://www.whocc.no/atc_ddd_index/?code=${item.atc_code}`}
                    target="_blank"
                    rel="noreferrer"
                    title={item.atc_name}
                    style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                      background: "rgba(20,184,166,0.12)", color: "#0f766e",
                      border: "1px solid rgba(20,184,166,0.28)", textDecoration: "none",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    }}
                  >ATC {item.atc_code}</a>
                ))}
                {(drug.clinical_umls?.mechanism_class || []).slice(0, 2).map(item => (
                  <a
                    key={item.cui}
                    href={`/umls?cui=${item.cui}`}
                    title={item.name}
                    style={{
                      fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
                      background: "rgba(99,102,241,0.10)", color: "#6366f1",
                      border: "1px solid rgba(99,102,241,0.25)", textDecoration: "none",
                    }}
                  >{item.name}</a>
                ))}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              onClick={() => setDoseOpen(v => !v)}
              style={{
                fontSize: 11, fontWeight: 700, padding: "5px 8px",
                background: doseOpen ? "var(--accent)" : "rgba(14,165,233,0.08)",
                color: doseOpen ? "#fff" : "var(--accent)",
                border: "1px solid rgba(14,165,233,0.3)", borderRadius: 6, cursor: "pointer",
              }}
            >Calculate Dose</button>
            {drug.utd_topic_id && (
              <a
                href={`/uptodate?t=${drug.utd_topic_id}`}
                style={{
                  fontSize: 11, fontWeight: 600, padding: "5px 8px",
                  background: "rgba(0,133,124,0.1)", color: "#00857c",
                  border: "1px solid rgba(0,133,124,0.25)", borderRadius: 6, cursor: "pointer",
                  textDecoration: "none",
                }}
              >UTD</a>
            )}
            {drug.related_links.filter(link => link.source !== "utd").slice(0, 2).map(link => (
              <a
                key={`${link.source}:${link.href}`}
                href={link.href}
                style={{
                  fontSize: 11, fontWeight: 600, padding: "5px 8px",
                  background: "rgba(99,102,241,0.08)", color: "#818cf8",
                  border: "1px solid rgba(99,102,241,0.22)", borderRadius: 6, cursor: "pointer",
                  textDecoration: "none",
                }}
              >{link.source.toUpperCase()}</a>
            ))}
            <button
              onClick={() => onAddToCompare(toQuickInfo())}
              style={{
                fontSize: 11, fontWeight: 600, padding: "5px 8px",
                background: isInCompareList ? "var(--accent)" : "transparent",
                color: isInCompareList ? "#fff" : "var(--text-muted)",
                border: `1px solid ${isInCompareList ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 6, cursor: "pointer",
              }}
            >{isInCompareList ? "✓ In Compare" : "+ Compare"}</button>
            <button
              onClick={onClose}
              style={{
                fontSize: 14, fontWeight: 700, padding: "5px 8px",
                background: "transparent", color: "var(--text-muted)",
                border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
              }}
            >✕</button>
          </div>
        </div>
        {doseOpen && (
          // The calculator lives in the fixed header; without a height cap its
          // results push the tab bar and section content off-screen with no
          // way to scroll. Cap it and let it scroll internally.
          <div style={{ marginTop: 10, maxHeight: "58vh", overflowY: "auto", paddingRight: 4 }}>
            <DoseCalculator
              key={drug.drug_id}
              drugId={drug.drug_id}
              initialOpen
              hideTrigger
              onClose={() => setDoseOpen(false)}
            />
          </div>
        )}
      </div>

      {/* ── BBW Banner (always above tabs) ── */}
      {drug.has_black_box && bbwText && (
        <div className="drug-bbw-banner" style={{ margin: "10px 14px 0" }}>
          <div className="bbw-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12">
              <path d="m10.29 3.86-8.71 15.07a1 1 0 0 0 .88 1.5h17.42a1 1 0 0 0 .88-1.5L11.71 3.86a1 1 0 0 0-1.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            Black Box Warning
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {bbwExpanded
              ? (bbwSection ? <DrugSectionContent section={bbwSection} /> : bbwText)
              : <>{bbwText.slice(0, 280)}{bbwText.length > 280 ? "…" : ""}</>
            }
          </div>
          {bbwText.length > 280 && (
            <button
              onClick={() => setBbwExpanded(e => !e)}
              style={{
                marginTop: 6, fontSize: 11, fontWeight: 600,
                color: "var(--red, #ef4444)", background: "none", border: "none",
                cursor: "pointer", padding: 0,
              }}
            >{bbwExpanded ? "Show less ▲" : "Show more ▾"}</button>
          )}
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{
        display: "flex", gap: 0, borderBottom: "1px solid var(--border)",
        overflowX: "auto", flexShrink: 0, padding: "0 14px", marginTop: 10,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: "7px 14px", fontSize: 12, fontWeight: 600,
              background: "none", border: "none", cursor: "pointer",
              color: activeTab === tab.key ? "var(--accent)" : "var(--text-muted)",
              borderBottom: activeTab === tab.key ? "2px solid var(--accent)" : "2px solid transparent",
              whiteSpace: "nowrap", transition: "color 0.12s",
            }}
          >{tab.label}</button>
        ))}
      </div>

      {/* ── Tab content (scrollable) ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
        {activeTab === "dosing" && (
          <div>
            <DrugSectionTab section={drug.sections.adult_dosing}       label="Adult Dosing" />
            <DrugSectionTab section={drug.sections.adult_dosing_elderly} label="Elderly Dosing" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.pediatric_dosing}   label="Pediatric Dosing" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.renal_dosing}       label="Renal Dosing" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.hepatic_dosing}     label="Hepatic Dosing" defaultExpanded={false} />
          </div>
        )}

        {activeTab === "adverse" && (
          <div>
            <DrugSectionTab section={drug.sections.adverse_effects} />
            <UmlsChipRow
              label="Contraindications (MED-RT)"
              tone="red"
              items={drug.clinical_umls?.contraindications || []}
            />
            <UmlsChipRow
              label="Reported reactions (SNOMED / MED-RT)"
              tone="amber"
              items={drug.clinical_umls?.reactions || []}
            />
          </div>
        )}

        {activeTab === "interactions" && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <div className="severity-contraindicated drug-section-badge" style={{ marginBottom: 8, padding: "3px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800 }}>
                ⛔ Contraindicated
              </div>
              <DrugSectionTab section={drug.sections.interactions_contraindicated} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div className="severity-major drug-section-badge" style={{ marginBottom: 8, padding: "3px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800 }}>
                ⚠ Major
              </div>
              <DrugSectionTab section={drug.sections.interactions_major} />
            </div>
            <div>
              <div className="severity-moderate drug-section-badge" style={{ marginBottom: 8, padding: "3px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800 }}>
                ℹ Moderate
              </div>
              <DrugSectionTab section={drug.sections.interactions_moderate} />
            </div>
          </div>
        )}

        {activeTab === "pharmacology" && (
          <div>
            <UmlsChipRow
              label="Mechanism class (MED-RT)"
              tone="indigo"
              items={drug.clinical_umls?.mechanism_class || []}
            />
            <UmlsChipRow
              label="Physiologic effects (MED-RT)"
              tone="teal"
              items={drug.clinical_umls?.physiologic_effects || []}
            />
            <DrugSectionTab section={drug.sections.mechanism}        label="Mechanism of Action" />
            <DrugSectionTab section={drug.sections.pharmacokinetics} label="Pharmacokinetics" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.absorption}       label="Absorption" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.distribution}     label="Distribution" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.metabolism}       label="Metabolism" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.excretion}        label="Excretion" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.half_life}        label="Half-Life" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.pregnancy}        label="Pregnancy" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.breast_feeding}   label="Breast Feeding" defaultExpanded={false} />
          </div>
        )}

        {activeTab === "monitoring" && (
          <div>
            <DrugSectionTab section={drug.sections.monitoring}     />
            <DrugSectionTab section={drug.sections.contraindications} label="Contraindications" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.precautions}       label="Warnings / Precautions" defaultExpanded={false} />
          </div>
        )}

        {activeTab === "supplies" && (
          <div>
            <UmlsChipRow
              label="Indications (MED-RT may_treat)"
              tone="green"
              items={drug.clinical_umls?.indications || []}
            />
            <UmlsChipRow
              label="May prevent (MED-RT)"
              tone="green"
              items={drug.clinical_umls?.may_prevent || []}
            />
            <DrugSectionTab section={drug.sections.how_supplied}         label="How Supplied" />
            <DrugSectionTab section={drug.sections.administration}       label="Administration" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.indications}          label="Indications" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.toxicology_effects}   label="Toxicology: Effects" defaultExpanded={false} />
            <DrugSectionTab section={drug.sections.toxicology_treatment} label="Toxicology: Treatment" defaultExpanded={false} />

            {drug.icd_codes.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase",
                               letterSpacing: "0.06em", marginBottom: 6 }}>ICD Codes</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {drug.icd_codes.map((c, i) => (
                    <span key={i} style={{
                      fontSize: 11, padding: "2px 7px", borderRadius: 4, fontFamily: "monospace",
                      background: "rgba(99,102,241,0.08)", color: "#818cf8",
                    }}>{c.icd10 || c.icd9}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "fda" && (
          <FdaLabelTab label={drug.openfda} genericName={drug.generic_name} />
        )}

        {activeTab === "identity" && (
          <div>
            <IdentityBlock label="RxNorm">
              <IdentityLine name="RXCUI" value={drug.identity?.rxcui || "Not linked"} />
              <IdentityLine name="TTY" value={drug.identity?.rxcui_tty || "-"} />
              <IdentityLine name="Coverage" value={`${drug.identity?.coverage_tier ?? 0}: ${drug.identity?.coverage_status || "identity_only"}`} />
            </IdentityBlock>

            <IdentityBlock label="Ingredients">
              {drug.identity?.ingredients?.length ? drug.identity.ingredients.map(ingredient => (
                <IdentityLine
                  key={`${ingredient.ingredient_rxcui}:${ingredient.ingredient_name}`}
                  name={ingredient.ingredient_rxcui || "ingredient"}
                  value={ingredient.ingredient_name}
                />
              )) : <EmptyIdentity />}
            </IdentityBlock>

            <IdentityBlock label="ATC">
              {drug.identity?.atc?.length ? drug.identity.atc.map(row => (
                <IdentityLine key={row.atc_code} name={row.atc_code} value={row.atc_name} />
              )) : <EmptyIdentity />}
            </IdentityBlock>

            <IdentityBlock label="Forms and Strengths">
              {drug.identity?.strengths?.length ? drug.identity.strengths.slice(0, 24).map((row, i) => (
                <IdentityLine
                  key={`${row.strength_text}:${i}`}
                  name={row.strength_text || "strength"}
                  value={[row.dose_form, row.route].filter(Boolean).join(" · ") || "RxNorm strength"}
                />
              )) : <EmptyIdentity />}
            </IdentityBlock>

            <IdentityBlock label="NDCs">
              {drug.identity?.ndcs?.length ? drug.identity.ndcs.slice(0, 30).map(row => (
                <IdentityLine key={row.ndc} name={row.ndc} value={row.package_desc || "Package"} />
              )) : <EmptyIdentity />}
            </IdentityBlock>
          </div>
        )}
      </div>
    </div>
    </DrugIdContext.Provider>
  );
}

function IdentityBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 800,
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        marginBottom: 7,
      }}>
        {label}
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
}

function IdentityLine({ name, value }: { name: string; value: string }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "150px minmax(0, 1fr)",
      gap: 10,
      padding: "7px 10px",
      borderBottom: "1px solid var(--border)",
      fontSize: 12,
      lineHeight: 1.45,
    }}>
      <div style={{ color: "var(--text-muted)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
        {name}
      </div>
      <div style={{ color: "var(--text-secondary)", minWidth: 0, overflowWrap: "anywhere" }}>
        {value}
      </div>
    </div>
  );
}

function EmptyIdentity() {
  return (
    <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-muted)" }}>
      Not available.
    </div>
  );
}

/* ── FDA Label Tab ────────────────────────────────────────────────────────── */

function FdaSectionBlock({ section, defaultExpanded = true }: { section: OpenFdaSection; defaultExpanded?: boolean }) {
  const [open, setOpen] = useState(defaultExpanded);
  const isBbw = section.key === "boxed_warning";
  return (
    <div style={{
      marginBottom: 10, border: `1px solid ${isBbw ? "rgba(239,68,68,0.35)" : "var(--border)"}`,
      borderRadius: 8, overflow: "hidden",
    }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%", textAlign: "left", padding: "8px 12px",
          background: isBbw ? "rgba(239,68,68,0.08)" : "var(--bg-subtle)",
          border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        }}
      >
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: "0.04em",
          color: isBbw ? "#b91c1c" : "var(--text-secondary)",
          textTransform: "uppercase",
        }}>
          {section.label}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{open ? "▲" : "▾"}</span>
      </button>
      {open && (
        <div style={{
          padding: "10px 12px",
          fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.65,
          whiteSpace: "pre-wrap", overflowWrap: "break-word",
          background: "var(--bg-card)",
          maxHeight: 360, overflowY: "auto",
        }}>
          {section.text}
        </div>
      )}
    </div>
  );
}

function FdaLabelTab({ label, genericName }: { label: DrugProfile["openfda"]; genericName: string }) {
  if (!label) {
    return (
      <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>🏥</div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>No FDA label found for {genericName}</div>
        <div style={{ fontSize: 11 }}>
          The FDA drug label data is fetched on demand and cached locally.
          It may not be available for all drugs.
        </div>
        <a
          href={`https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=`}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-block", marginTop: 14,
            fontSize: 11, color: "#4338ca",
            textDecoration: "underline",
          }}
        >Search FDA Drug Database ↗</a>
      </div>
    );
  }

  const bbwSection = label.sections.find(s => s.key === "boxed_warning");
  const otherSections = label.sections.filter(s => s.key !== "boxed_warning");

  return (
    <div>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 14, flexWrap: "wrap", gap: 8,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
            {label.generic_names[0] || genericName}
          </div>
          {label.brand_names.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {label.brand_names.slice(0, 4).join(" · ")}
            </div>
          )}
          {label.manufacturer && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
              Manufacturer: {label.manufacturer}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {label.has_black_box && (
            <span style={{
              fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
              background: "rgba(239,68,68,0.12)", color: "#b91c1c",
              border: "1px solid rgba(239,68,68,0.35)",
            }}>⚠ BBW</span>
          )}
          {label.rxcuis.slice(0, 2).map(rxcui => (
            <span key={rxcui} style={{
              fontSize: 9, fontFamily: "monospace", fontWeight: 700,
              padding: "2px 6px", borderRadius: 4,
              background: "rgba(99,102,241,0.08)", color: "#6366f1",
              border: "1px solid rgba(99,102,241,0.22)",
            }}>RxNorm {rxcui}</span>
          ))}
          {label.fda_url && (
            <a
              href={label.fda_url}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                background: "rgba(59,130,246,0.08)", color: "#1d4ed8",
                border: "1px solid rgba(59,130,246,0.25)",
                textDecoration: "none",
              }}
            >View on DailyMed ↗</a>
          )}
        </div>
      </div>

      {/* BBW first */}
      {bbwSection && <FdaSectionBlock section={bbwSection} defaultExpanded />}

      {/* Remaining sections */}
      {otherSections.map(sec => (
        <FdaSectionBlock
          key={sec.key}
          section={sec}
          defaultExpanded={sec.key === "indications_and_usage"}
        />
      ))}
    </div>
  );
}

type UmlsChipTone = "indigo" | "teal" | "green" | "amber" | "red";

const UMLS_CHIP_PALETTE: Record<UmlsChipTone, { bg: string; border: string; fg: string }> = {
  indigo: { bg: "rgba(99,102,241,0.10)",  border: "rgba(99,102,241,0.30)",  fg: "#6366f1" },
  teal:   { bg: "rgba(20,184,166,0.10)",  border: "rgba(20,184,166,0.30)",  fg: "#0f766e" },
  green:  { bg: "rgba(34,197,94,0.10)",   border: "rgba(34,197,94,0.32)",   fg: "#15803d" },
  amber:  { bg: "rgba(245,158,11,0.10)",  border: "rgba(245,158,11,0.32)",  fg: "#b45309" },
  red:    { bg: "rgba(239,68,68,0.10)",   border: "rgba(239,68,68,0.32)",   fg: "#b91c1c" },
};

function UmlsChipRow({
  label,
  tone,
  items,
}: {
  label: string;
  tone: UmlsChipTone;
  items: Array<{ cui: string; name: string; source?: string }>;
}) {
  if (!items || items.length === 0) return null;
  const palette = UMLS_CHIP_PALETTE[tone];
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
        textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {items.slice(0, 24).map(item => {
          const href = `/umls?cui=${item.cui}`;
          return (
            <a
              key={item.cui}
              href={href}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href, title: `UMLS · ${item.name}` } }));
              }}
              title={item.source ? `${item.name} · ${item.source} · ${item.cui}` : `${item.name} · ${item.cui}`}
              style={{
                fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 5,
                background: palette.bg, color: palette.fg,
                border: `1px solid ${palette.border}`, textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >{item.name}</a>
          );
        })}
        {items.length > 24 && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", padding: "3px 9px" }}>
            +{items.length - 24} more
          </span>
        )}
      </div>
    </div>
  );
}
