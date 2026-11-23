"use client";
import { Calculator, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { getBackendUrl } from "@/lib/api";
import type { AdjustmentGuidance, DoseFormOption, DoseResult, Indication } from "@/types/drugs";
import PrescriptionBlock from "./PrescriptionBlock";

const guidanceTone: Record<AdjustmentGuidance["status"], { fg: string; bg: string; label: string }> = {
  avoid: { fg: "#b91c1c", bg: "rgba(239,68,68,0.10)", label: "AVOID" },
  no_change: { fg: "#15803d", bg: "rgba(34,197,94,0.10)", label: "NO CHANGE" },
  factor: { fg: "#1d4ed8", bg: "rgba(59,130,246,0.10)", label: "DOSE ADJUSTED" },
  day_cap: { fg: "#1d4ed8", bg: "rgba(59,130,246,0.10)", label: "DAILY CAP" },
  replace: { fg: "#7c3aed", bg: "rgba(139,92,246,0.10)", label: "USE SOURCE REGIMEN" },
  increase_possible: { fg: "#b45309", bg: "rgba(245,158,11,0.10)", label: "MAY NEED MORE" },
  verify: { fg: "#b45309", bg: "rgba(245,158,11,0.10)", label: "VERIFY" },
  none: { fg: "#64748b", bg: "rgba(100,116,139,0.10)", label: "NO DATA" },
};

function GuidanceBox({ title, guidance }: { title: string; guidance: AdjustmentGuidance }) {
  const tone = guidanceTone[guidance.status] || guidanceTone.verify;
  return (
    <div style={{
      marginTop: 8,
      padding: "8px 10px",
      borderRadius: 6,
      border: `1px solid ${tone.fg}33`,
      background: tone.bg,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--text-primary)" }}>{title}</span>
        <span style={{ fontSize: 9, fontWeight: 900, letterSpacing: "0.06em", color: tone.fg, border: `1px solid ${tone.fg}55`, borderRadius: 999, padding: "1px 7px" }}>
          {tone.label}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>{guidance.message}</div>
      {guidance.source_text ? (
        <div style={{ marginTop: 5, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, fontStyle: "italic" }}>
          Source: “{guidance.source_text}”
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  drugId: number;
  indications?: Indication[];
  defaultIndicationId?: number | null;
  defaultWeightKg?: number;
  formOptions?: DoseFormOption[];
  renalAdjustmentAvailable?: boolean;
  hepaticAdjustmentAvailable?: boolean;
  initialOpen?: boolean;
  hideTrigger?: boolean;
  onClose?: () => void;
}

const confidenceColors: Record<string, string> = {
  reviewed: "var(--green, #22c55e)",
  high: "var(--green, #22c55e)",
  medium: "var(--amber, #f59e0b)",
  low: "var(--red, #ef4444)",
};

function indicationLabel(status: string) {
  if (status === "fda_labeled") return "FDA";
  if (status === "off_label") return "off-label";
  if (status === "unsupported") return "unsupported";
  if (status === "dosing_section") return "dose";
  return "source";
}

export default function DoseCalculator({
  drugId,
  indications = [],
  defaultIndicationId = null,
  defaultWeightKg = 60,
  formOptions = [],
  renalAdjustmentAvailable = false,
  hepaticAdjustmentAvailable = false,
  initialOpen = false,
  hideTrigger = false,
  onClose,
}: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [indicationId, setIndicationId] = useState(defaultIndicationId ? String(defaultIndicationId) : "");
  const [weight, setWeight] = useState(String(defaultWeightKg));
  const [age, setAge] = useState("");
  const [doseForm, setDoseForm] = useState("");
  const [renal, setRenal] = useState(false);
  const [hepatic, setHepatic] = useState(false);
  const [crcl, setCrcl] = useState("");
  const [childPugh, setChildPugh] = useState("A");
  const [result, setResult] = useState<DoseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Self-fetched metadata for callers that only pass drugId (drug detail modal):
  // without it the indication dropdown is empty and adjustments show "verify".
  const [fetchedMeta, setFetchedMeta] = useState<{
    indications: Indication[];
    defaultIndicationId: number | null;
    formOptions: DoseFormOption[];
    renalAvailable: boolean;
    hepaticAvailable: boolean;
  } | null>(null);

  useEffect(() => {
    setIndicationId(defaultIndicationId ? String(defaultIndicationId) : "");
  }, [defaultIndicationId]);

  useEffect(() => {
    setWeight(String(defaultWeightKg));
  }, [defaultWeightKg]);

  useEffect(() => {
    if (!open || indications.length > 0 || fetchedMeta) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/drugs/popup/${drugId}`);
        if (!res.ok) return;
        const p = await res.json();
        if (cancelled) return;
        setFetchedMeta({
          indications: p.indications ?? [],
          defaultIndicationId: p.default_indication_id ?? null,
          formOptions: p.identity?.form_options ?? [],
          renalAvailable: Boolean(p.adjustments?.renal_available),
          hepaticAvailable: Boolean(p.adjustments?.hepatic_available),
        });
        if (p.default_indication_id && !defaultIndicationId) {
          setIndicationId(String(p.default_indication_id));
        }
      } catch {
        // metadata is an enhancement; the calculator still works without it
      }
    })();
    return () => { cancelled = true; };
  }, [open, indications.length, fetchedMeta, drugId, defaultIndicationId]);

  const effectiveIndications = indications.length > 0 ? indications : (fetchedMeta?.indications ?? []);
  const effectiveFormOptions = formOptions.length > 0 ? formOptions : (fetchedMeta?.formOptions ?? []);
  const effectiveRenalAvailable = renalAdjustmentAvailable || Boolean(fetchedMeta?.renalAvailable);
  const effectiveHepaticAvailable = hepaticAdjustmentAvailable || Boolean(fetchedMeta?.hepaticAvailable);

  const calculate = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ drug_id: String(drugId) });
      if (indicationId) params.set("indication_id", indicationId);
      if (weight) params.set("weight_kg", weight);
      if (age) params.set("age_years", age);
      if (doseForm) params.set("dose_form", doseForm);
      if (renal && crcl) params.set("crcl", crcl);
      if (hepatic && childPugh) params.set("child_pugh", childPugh);
      const res = await fetch(`${getBackendUrl()}/drugs/dose?${params}`);
      if (!res.ok) {
        const e = await res.json();
        setError(e.detail || "Dose lookup failed");
        setResult(null);
        return;
      }
      setResult(await res.json());
    } catch {
      setError("Request failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [age, childPugh, crcl, doseForm, drugId, hepatic, indicationId, open, renal, weight]);

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      calculate();
    }, 250);
    return () => window.clearTimeout(handle);
  }, [calculate, open]);

  const close = () => {
    setOpen(false);
    onClose?.();
  };

  if (!open && !hideTrigger) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          fontSize: 12,
          fontWeight: 700,
          color: "var(--accent, #0ea5e9)",
          background: "rgba(14,165,233,0.08)",
          border: "1px dashed rgba(14,165,233,0.3)",
          borderRadius: 6,
          cursor: "pointer",
          marginTop: 12,
        }}
      >
        <Calculator size={14} />
        Calculate Dose
      </button>
    );
  }

  if (!open) return null;

  const confidenceColor = confidenceColors[result?.confidence || "low"];

  return (
    <div style={{
      marginTop: 12,
      padding: 14,
      borderRadius: 8,
      border: "1px solid var(--border)",
      background: "var(--bg-card)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 800, color: "var(--text-primary)" }}>
          <Calculator size={15} />
          Dose Calculator
        </span>
        <button
          onClick={close}
          title="Close dose calculator"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 6,
            cursor: "pointer",
            color: "var(--text-muted)",
          }}
        >
          <X size={14} />
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(88px, 0.7fr) minmax(88px, 0.7fr)", gap: 8 }}>
        <label style={labelStyle}>
          <span style={labelTextStyle}>Indication</span>
          <select value={indicationId} onChange={e => setIndicationId(e.target.value)} style={inputStyle}>
            <option value="">Primary source indication</option>
            {effectiveIndications.map(indication => (
              <option key={indication.id} value={indication.id}>
                {indication.indication_text}{indication.label_status ? ` (${indicationLabel(indication.label_status)})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          <span style={labelTextStyle}>Weight kg</span>
          <input type="number" min="1" max="500" step="0.1" value={weight} onChange={e => setWeight(e.target.value)} placeholder={String(defaultWeightKg)} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          <span style={labelTextStyle}>Age years</span>
          <input type="number" min="0" max="120" step="1" value={age} onChange={e => setAge(e.target.value)} placeholder="optional" style={inputStyle} />
        </label>
      </div>

      {effectiveFormOptions.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, marginTop: 8 }}>
          <label style={labelStyle}>
            <span style={labelTextStyle}>Form</span>
            <select value={doseForm} onChange={e => setDoseForm(e.target.value)} style={inputStyle}>
              <option value="">Best matching form</option>
              {effectiveFormOptions.map((option, index) => (
                <option key={`${option.dose_form || "form"}-${option.route || ""}-${index}`} value={option.dose_form || ""}>
                  {option.dose_form || "Unspecified form"}
                  {option.strengths.length ? ` (${option.strengths.slice(0, 3).join(", ")})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
        <label style={toggleStyle}>
          <input type="checkbox" checked={renal} onChange={e => setRenal(e.target.checked)} />
          Renal adjustment
          {effectiveRenalAvailable ? <span style={toggleMetaStyle}>source</span> : <span style={toggleMetaStyle}>verify</span>}
        </label>
        <label style={toggleStyle}>
          <input type="checkbox" checked={hepatic} onChange={e => setHepatic(e.target.checked)} />
          Hepatic adjustment
          {effectiveHepaticAvailable ? <span style={toggleMetaStyle}>source</span> : <span style={toggleMetaStyle}>verify</span>}
        </label>
      </div>

      {(renal || hepatic) && (
        <div style={{ display: "grid", gridTemplateColumns: renal && hepatic ? "1fr 1fr" : "1fr", gap: 8, marginTop: 8 }}>
          {renal && (
            <label style={labelStyle}>
              <span style={labelTextStyle}>CrCl mL/min</span>
              <input type="number" min="1" max="999" step="1" value={crcl} onChange={e => setCrcl(e.target.value)} placeholder="e.g. 45" style={inputStyle} />
            </label>
          )}
          {hepatic && (
            <label style={labelStyle}>
              <span style={labelTextStyle}>Child-Pugh</span>
              <select value={childPugh} onChange={e => setChildPugh(e.target.value)} style={inputStyle}>
                <option value="A">Class A</option>
                <option value="B">Class B</option>
                <option value="C">Class C</option>
              </select>
            </label>
          )}
        </div>
      )}

      {loading && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
          Calculating...
        </div>
      )}
      {error && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--red, #ef4444)" }}>
          {error}
        </div>
      )}
      {result && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)", lineHeight: 1.4 }}>
                {result.display || "No structured dose available"}
              </div>
              {result.computed_dose !== null && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                  Computed: {result.computed_dose} {result.dose_unit}
                  {result.weight_kg ? ` · weight ${result.weight_kg} kg` : ""}
                  {result.doses_per_day ? `, ${result.doses_per_day} doses/day` : ""}
                  {result.total_mg_per_day ? `, ${result.total_mg_per_day} mg/day` : ""}
                </div>
              )}
            </div>
            <span style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 800,
              textTransform: "uppercase",
              color: confidenceColor,
              border: `1px solid ${confidenceColor}`,
              borderRadius: 999,
              padding: "3px 8px",
            }}>
              {result.confidence}
            </span>
          </div>

          {result.indication_fallback && (
            <div style={{ ...noticeStyle, color: "#1d4ed8", background: "rgba(59,130,246,0.10)" }}>
              No parsed rule for “{result.indication_fallback.requested_text || "the selected indication"}” —
              showing the closest available rule ({result.indication_fallback.used_text || "another indication"}).
              Verify it applies to your patient.
            </div>
          )}
          {result.capped_by_max && (
            <div style={noticeStyle}>Capped by parsed maximum dose.</div>
          )}
          {result.renal_guidance && <GuidanceBox title="Renal adjustment" guidance={result.renal_guidance} />}
          {result.hepatic_guidance && <GuidanceBox title="Hepatic adjustment" guidance={result.hepatic_guidance} />}
          {result.adjustments_applied
            .filter(item => item !== "none")
            .filter(item => item !== result.renal_guidance?.message && item !== result.hepatic_guidance?.message)
            .map(item => (
              <div key={item} style={noticeStyle}>{item}</div>
            ))}
          {result.assumptions
            // the indication-fallback banner above already says this
            .filter(item => !(result.indication_fallback && item.startsWith("no parsed rule for")))
            .map(item => (
              <div key={item} style={noticeStyle}>{item}</div>
            ))}
          {result.needs.length > 0 && (
            <div style={noticeStyle}>Needs: {result.needs.join(", ")}</div>
          )}

          {(result.calculation_steps?.length ?? 0) > 0 && (
            <div style={{
              marginTop: 12,
              padding: "10px 12px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "rgba(14,165,233,0.04)",
            }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text-primary)", marginBottom: 6 }}>
                How this dose was calculated
              </div>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {result.calculation_steps?.map(step => (
                  <li key={step} style={{
                    fontSize: 12,
                    color: step.startsWith("SAFETY") ? "#b91c1c" : "var(--text-secondary)",
                    fontWeight: step.startsWith("SAFETY") ? 700 : 400,
                    lineHeight: 1.6,
                  }}>
                    {step}
                  </li>
                ))}
              </ol>
              {result.max_mg_per_day_ceiling ? (
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
                  Source maximum: {result.max_mg_per_day_ceiling} mg/day
                </div>
              ) : null}
            </div>
          )}

          {(result.dose_notes?.length ?? 0) > 0 && (
            <div style={{ marginTop: 10 }}>
              {result.dose_notes?.map(note => (
                <div key={note} style={{
                  marginTop: 6,
                  padding: "6px 8px",
                  borderRadius: 6,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: "var(--text-secondary)",
                  background: "rgba(100,116,139,0.08)",
                  borderLeft: "3px solid rgba(100,116,139,0.4)",
                }}>
                  {note}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <PrescriptionBlock prescription={result.prescription} />
          </div>

          <div style={{
            marginTop: 10,
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.55,
          }}>
            Source: {result.source?.name || "structured table"} · {result.review_status}
            {result.parse_warnings.length > 0 ? ` · ${result.parse_warnings.join(", ")}` : ""}
          </div>
          <div style={{
            marginTop: 8,
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.55,
            padding: "8px 10px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.04)",
          }}>
            {result.disclaimer}
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
};

const labelTextStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 9px",
  fontSize: 12,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  outline: "none",
};

const toggleStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "var(--text-secondary)",
};

const toggleMetaStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
};

const noticeStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "6px 8px",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.45,
  color: "#b45309",
  background: "rgba(245,158,11,0.1)",
};
