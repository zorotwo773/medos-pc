"use client";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Search, ChevronRight, BookOpen, Activity, X, Image as ImageIcon, Tags } from "lucide-react";
import type { Disease } from "@/types/medical";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { AmbossAutoText } from "@/components/amboss/AmbossTerm";
import { recordRecent } from "@/lib/useRecent";
import { useScrollRestore } from "@/lib/useScrollRestore";

const ORGAN_COLORS: Record<string, string> = {
  Heart: "tag-red", Lung: "tag-blue", Kidney: "tag-amber",
  Liver: "tag-green", Brain: "tag-purple", GI: "tag-amber",
  Pancreas: "tag-amber", Thyroid: "tag-green", Blood: "tag-red",
  Skin: "tag-gray", Bone: "tag-gray", Muscle: "tag-gray",
  "Blood Vessels": "tag-red", Intestine: "tag-amber", Stomach: "tag-amber",
  Uterus: "tag-purple", Bladder: "tag-amber", Eye: "tag-blue",
};

function getTagStyle(organ: string): string {
  for (const [k, v] of Object.entries(ORGAN_COLORS)) {
    if (organ.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return "tag-gray";
}

function getClinicalPoints(disease: Disease): string[] {
  return disease.clinical_synthesis || disease.harrisons_synthesis || [];
}

function DiseaseCard({ disease, onSelect }: { disease: Disease; onSelect: () => void }) {
  const points = getClinicalPoints(disease);
  return (
    <button
      onClick={onSelect}
      style={{
        width: "100%", textAlign: "left", background: "var(--bg-card)",
        border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px",
        cursor: "pointer", transition: "all 0.15s",
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.borderColor = "var(--accent-dim)";
        el.style.boxShadow = "0 0 0 1px rgba(2,132,199,0.2)";
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.borderColor = "var(--border)";
        el.style.boxShadow = "none";
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
          {disease.disease_name}
        </h3>
        <ChevronRight size={14} color="var(--text-muted)" />
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <span className={`tag ${getTagStyle(disease.primary_organ)}`}>{disease.primary_organ}</span>
        {disease.primary_system && <span className="tag tag-gray">{disease.primary_system}</span>}
        {!!disease.icd_codes?.length && <span className="tag tag-gray">{disease.icd_codes.length} ICD</span>}
        {!!disease.algorithm_refs?.length && <span className="tag tag-amber">{disease.algorithm_refs.length} ALG</span>}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {points[0]?.slice(0, 130)}{points[0] && points[0].length > 130 ? "..." : ""}
      </p>
    </button>
  );
}

function DiseaseDetail({ disease, onClose }: { disease: Disease; onClose: () => void }) {
  const [tab, setTab] = useState<"clinical" | "treatment" | "codes" | "algorithms" | "source">("clinical");
  const [preview, setPreview] = useState<{ title: string; url: string } | null>(null);
  const points = getClinicalPoints(disease);
  const treatment = disease.treatment_pearls || [];
  const icdCodes = disease.icd_codes || [];
  const algorithmRefs = disease.algorithm_refs || [];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border)",
        borderRadius: 12, width: "min(680px, 92vw)", maxHeight: "85vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 24px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>
              {disease.disease_name}
            </h2>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span className={`tag ${getTagStyle(disease.primary_organ)}`}>{disease.primary_organ}</span>
              {disease.primary_system && <span className="tag tag-gray">{disease.primary_system}</span>}
              {disease.anatomy_model && <span className="tag tag-gray">{disease.anatomy_model.replace(".glb", "")}</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 24px" }}>
          {(["clinical", "treatment", "codes", "algorithms", "source"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "10px 16px", fontSize: 13, fontWeight: 500,
                background: "none", border: "none", cursor: "pointer",
                color: tab === t ? "var(--accent)" : "var(--text-secondary)",
                borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
                transition: "color 0.15s",
              }}
            >
              {t === "clinical" ? "Clinical" : t === "treatment" ? "Treatment" : t === "codes" ? "ICD" : t === "algorithms" ? "Algorithms" : "Source"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
          {tab === "clinical" && (
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
              {points.map((point, i) => (
                <li key={i} style={{ display: "flex", gap: 12 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: "50%",
                    background: "var(--accent-glow)", border: "1px solid rgba(14,165,233,0.2)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0, fontSize: 10, fontWeight: 700, color: "var(--accent)",
                  }}>
                    {i + 1}
                  </div>
                  <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.65 }}>
                    <AmbossAutoText text={point} />
                  </p>
                </li>
              ))}
            </ul>
          )}

          {tab === "treatment" && (
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 12 }}>
              {treatment.length === 0 && (
                <li style={{ fontSize: 13, color: "var(--text-muted)" }}>No treatment section was available in the plaintext index for this entry.</li>
              )}
              {treatment.map((pearl, i) => (
                <li key={i} style={{ display: "flex", gap: 12 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: "50%",
                    background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.2)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0, fontSize: 10, fontWeight: 700, color: "var(--green)",
                  }}>
                    {i + 1}
                  </div>
                  <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.65 }}>{pearl}</p>
                </li>
              ))}
            </ul>
          )}

          {tab === "codes" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {icdCodes.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No ICD mappings found for this entry.</p>
              ) : icdCodes.slice(0, 80).map((code, i) => (
                <div key={`${code.code}-${i}`} style={{ padding: "9px 11px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-base)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
                    <Tags size={13} color="var(--accent)" />
                    <strong style={{ fontSize: 12, color: "var(--text-primary)" }}>{code.code || "Code"}</strong>
                    <span className="tag tag-gray">{code.system}</span>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>{code.description}</p>
                </div>
              ))}
            </div>
          )}

          {tab === "algorithms" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {algorithmRefs.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No algorithm image was mapped to this entry.</p>
              ) : algorithmRefs.map((ref, i) => (
                <div key={`${ref.title}-${i}`} style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-base)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: ref.images.length ? 8 : 0 }}>
                    <ImageIcon size={14} color="#d97706" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{ref.title}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {ref.images.map(image => (
                      <button
                        key={image.url}
                        onClick={() => setPreview({ title: ref.title, url: image.url })}
                        style={{
                          border: "none", background: "transparent", padding: 0,
                          color: "#d97706", textDecoration: "underline", textDecorationThickness: 2,
                          textUnderlineOffset: 3, cursor: "pointer", fontSize: 13, fontWeight: 600,
                        }}
                      >
                        {image.filename}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "source" && (
            <div style={{ padding: "12px 16px", background: "var(--bg-base)", borderRadius: 8, border: "1px solid var(--border)" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                <BookOpen size={16} color="var(--accent)" />
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{disease.source || "Lexicomp Clinical Conditions"}</span>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                <strong>Document:</strong> {disease.document_id || disease.citation?.page_number}
              </p>
              {disease.aliases && disease.aliases.length > 0 && (
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 6 }}>
                  <strong>Aliases:</strong> {disease.aliases.slice(0, 12).join(", ")}
                </p>
              )}
            </div>
          )}
        </div>

        {preview && (
          <div
            onClick={() => setPreview(null)}
            style={{ position: "fixed", inset: 0, zIndex: 140, background: "rgba(15,23,42,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
          >
            <div onClick={e => e.stopPropagation()} style={{ maxWidth: "min(980px, 95vw)", maxHeight: "88vh", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.45)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>{preview.title}</strong>
                <button onClick={() => setPreview(null)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)" }}><X size={16} /></button>
              </div>
              <img src={preview.url} alt={preview.title} style={{ display: "block", maxWidth: "95vw", maxHeight: "78vh", objectFit: "contain", background: "#fff" }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DiseaseReference() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [search, setSearch] = useState("");
  const [organFilter, setOrganFilter] = useState("All");
  const [selected, setSelected] = useState<Disease | null>(null);

  // Close the detail modal AND drop the ?disease= param — otherwise the open
  // effect below re-matches the still-present param and immediately reopens it
  // (the "won't close" bug).
  const closeDetail = useCallback(() => {
    setSelected(null);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (params.has("disease")) {
      params.delete("disease");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [router, pathname, searchParams]);
  const listScrollRef = useRef<HTMLDivElement>(null);
  useScrollRestore(listScrollRef, "/diseases:list");

  useEffect(() => {
    fetch("/cliniccons_disease_database.json")
      .then(r => r.json())
      .then(data => setDiseases(data.diseases || data || []))
      .catch(console.error);
  }, []);

  useEffect(() => {
    const initialSearch = searchParams.get("search");
    if (initialSearch) setSearch(initialSearch);
  }, [searchParams]);

  // Open the detail from the ?disease= URL param exactly once per distinct
  // param value. Keyed off the param (not `selected`) so closing — which clears
  // both `selected` and the param — does not immediately re-open it (the race
  // that made the modal "won't close"). When the param is gone, the guard
  // resets so navigating back to the same disease opens it again.
  const openedFromUrlRef = useRef<string | null>(null);
  useEffect(() => {
    const diseaseName = searchParams.get("disease");
    if (!diseaseName) { openedFromUrlRef.current = null; return; }
    if (diseases.length === 0) return;
    const key = diseaseName.toLowerCase();
    if (openedFromUrlRef.current === key) return;
    const match = diseases.find(d => d.disease_name.toLowerCase() === key);
    if (match) { openedFromUrlRef.current = key; setSelected(match); }
  }, [searchParams, diseases]);

  useEffect(() => {
    if (!selected?.disease_name) return;
    recordRecent({
      tag: "DIS",
      label: selected.disease_name,
      href: `/diseases?disease=${encodeURIComponent(selected.disease_name)}`,
      source: "diseases",
      kind: "article",
      detail: selected.primary_system || selected.primary_organ,
    });
  }, [selected?.disease_name, selected?.primary_organ, selected?.primary_system]);

  const organs = useMemo(() => {
    const set = new Set<string>(diseases.map(d => d.primary_organ));
    return ["All", ...Array.from(set).sort()];
  }, [diseases]);

  const filtered = useMemo(() => {
    return diseases.filter(d => {
      const matchSearch = !search ||
        d.disease_name.toLowerCase().includes(search.toLowerCase()) ||
        d.primary_organ.toLowerCase().includes(search.toLowerCase()) ||
        (d.primary_system || "").toLowerCase().includes(search.toLowerCase()) ||
        getClinicalPoints(d).some(s => s.toLowerCase().includes(search.toLowerCase())) ||
        (d.icd_codes || []).some(c => c.code.toLowerCase().includes(search.toLowerCase()) || c.description.toLowerCase().includes(search.toLowerCase()));
      const matchOrgan = organFilter === "All" || d.primary_organ === organFilter;
      return matchSearch && matchOrgan;
    });
  }, [diseases, search, organFilter]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        padding: "16px 20px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-card)", flexShrink: 0,
      }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Disease Reference</h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
          Lexicomp Clinical Conditions · ICD mapping, primary organ tags &amp; algorithm references
        </p>
      </div>

      {/* Search + Filter */}
      <div style={{
        padding: "14px 20px", borderBottom: "1px solid var(--border)",
        display: "flex", gap: 12, flexShrink: 0, background: "var(--bg-base)",
      }}>
        <div style={{ flex: 1, position: "relative" }}>
          <Search size={14} color="var(--text-muted)" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search diseases, organs, symptoms..."
            style={{ width: "100%", padding: "8px 12px 8px 34px", fontSize: 13 }}
          />
        </div>
        <select
          value={organFilter}
          onChange={e => setOrganFilter(e.target.value)}
          style={{ padding: "8px 12px", fontSize: 13, minWidth: 140 }}
        >
          {organs.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px" }}>
          <Activity size={14} color="var(--text-muted)" />
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{filtered.length} diseases</span>
        </div>
      </div>

      {/* Disease list */}
      <div ref={listScrollRef} style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
        {diseases.length === 0 ? (
          <div style={{ textAlign: "center", paddingTop: 60, color: "var(--text-muted)" }}>
            <div className="loader" style={{ margin: "0 auto 12px" }} />
            <p style={{ fontSize: 13 }}>Loading clinical conditions...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", paddingTop: 60, color: "var(--text-muted)" }}>
            <p style={{ fontSize: 14 }}>No diseases found for &ldquo;{search}&rdquo;</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 12 }}>
            {filtered.map(d => (
              <DiseaseCard key={d.disease_name} disease={d} onSelect={() => setSelected(d)} />
            ))}
          </div>
        )}
      </div>

      {selected && <DiseaseDetail disease={selected} onClose={closeDetail} />}
    </div>
  );
}
