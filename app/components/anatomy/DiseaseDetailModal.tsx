"use client";
import { useRef, useState } from "react";
import { X, BookOpen } from "lucide-react";
import { useModalA11y } from "@/lib/useModalA11y";
import { zIndex } from "@/lib/zIndex";
import type { Disease } from "@/types/medical";

export default function DiseaseDetailModal({ disease, onClose }: { disease: Disease; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"patho"|"tx"|"cite">("patho");
  const clinicalPoints = disease.clinical_synthesis || disease.harrisons_synthesis || [];
  useModalA11y(modalRef, onClose);

  return (
    <div className="disease-detail-modal" style={{
      position: "fixed", inset: 0, zIndex: zIndex.modalOverlay,
      background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={modalRef}
        className="disease-detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="disease-detail-title"
        tabIndex={-1}
        style={{
        background: "var(--bg-card)", border: "1px solid var(--border)",
        borderRadius: 12, width: "min(600px, 90vw)", maxHeight: "80vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 24px 60px rgba(0,0,0,0.7)",
        zIndex: zIndex.modalPanel,
      }}>
        <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
          <div>
            <h2 id="disease-detail-title" style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>{disease.disease_name}</h2>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span className="tag tag-red">{disease.primary_organ}</span>
              {disease.primary_system && <span className="tag tag-gray">{disease.primary_system}</span>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close disease details" title="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}><X size={18} /></button>
        </div>
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 20px" }}>
          {(["patho","tx","cite"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "8px 14px", fontSize: 12, fontWeight: 500,
              background: "none", border: "none", cursor: "pointer",
              color: tab === t ? "var(--accent)" : "var(--text-secondary)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}>
              {t === "patho" ? "Clinical" : t === "tx" ? "Treatment" : "Source"}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "18px 20px" }}>
          {tab === "patho" && (
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
              {clinicalPoints.map((p, i) => (
                <li key={i} style={{ display: "flex", gap: 10 }}>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--accent-glow)", border: "1px solid rgba(14,165,233,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 10, fontWeight: 700, color: "var(--accent)" }}>{i+1}</div>
                  <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>{p}</p>
                </li>
              ))}
            </ul>
          )}
          {tab === "tx" && (
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
              {(disease.treatment_pearls || []).map((p, i) => (
                <li key={i} style={{ display: "flex", gap: 10 }}>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 10, fontWeight: 700, color: "var(--green)" }}>{i+1}</div>
                  <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>{p}</p>
                </li>
              ))}
            </ul>
          )}
          {tab === "cite" && (
            <div style={{ background: "var(--bg-base)", borderRadius: 8, border: "1px solid var(--border)", padding: "14px 16px" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <BookOpen size={14} color="var(--accent)" />
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{disease.source || "Lexicomp Clinical Conditions"}</span>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}><strong>Document:</strong> {disease.document_id || disease.citation?.page_number}</p>
              {!!disease.icd_codes?.length && (
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}><strong>ICD mappings:</strong> {disease.icd_codes.length}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
