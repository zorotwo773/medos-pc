"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Search } from "lucide-react";
import { getBackendUrl } from "@/lib/api";

interface LabCode {
  loinc: string;
  display: string;
  units?: string;
  ref_low?: string;
  ref_high?: string;
  note?: string;
  cui?: string;
  loinc_long_name?: string;
}

interface LabPanel {
  id: string;
  name: string;
  description: string;
  codes: LabCode[];
}

interface LabsGroupsResponse {
  panels: LabPanel[];
  umls_enriched: boolean;
}

interface LabsCodeDetail {
  loinc: string;
  cui: string;
  preferred_name: string;
  curated: LabCode | null;
  synonyms: string[];
  related: Array<{ cui: string; name: string; rela: string; sab: string }>;
  in_panels: Array<{ id: string; name: string }>;
  href: string;
}

interface SearchHit {
  cui: string;
  preferred_name: string;
  matched_code?: string;
  matched_source_label?: string;
  definition?: string;
}

export default function LabsPage() {
  const router = useRouter();
  const [groups, setGroups] = useState<LabsGroupsResponse | null>(null);
  const [activePanel, setActivePanel] = useState<string>("");
  const [activeLoinc, setActiveLoinc] = useState<string>("");
  const [detail, setDetail] = useState<LabsCodeDetail | null>(null);
  const [search, setSearch] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 860px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${getBackendUrl()}/umls/labs/groups`)
      .then(r => r.json())
      .then((data: LabsGroupsResponse) => {
        if (cancelled) return;
        setGroups(data);
        if (data.panels[0]) setActivePanel(data.panels[0].id);
      });
    return () => { cancelled = true; };
  }, []);

  const activePanelData = useMemo(
    () => groups?.panels.find(p => p.id === activePanel) || null,
    [groups, activePanel],
  );

  const pageGridColumns = compact ? "minmax(0, 1fr)" : "minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 360px)";
  const codeGridColumns = compact ? "minmax(0, 1fr) auto" : "100px minmax(0, 1fr) 90px minmax(160px, 1fr) 90px 60px";

  function openConcept(href: string, title: string) {
    window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href, title } }));
    router.push(href);
  }

  const loadDetail = useCallback(async (loinc: string) => {
    if (!loinc) return;
    setLoadingDetail(true);
    setActiveLoinc(loinc);
    try {
      const res = await fetch(`${getBackendUrl()}/umls/labs/code/${encodeURIComponent(loinc)}`);
      if (res.ok) {
        const data: LabsCodeDetail = await res.json();
        setDetail(data);
      } else {
        setDetail(null);
      }
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchHits([]);
      return;
    }
    const handle = setTimeout(async () => {
      const res = await fetch(
        `${getBackendUrl()}/umls/labs/search?q=${encodeURIComponent(search.trim())}&limit=12`,
      );
      const data = await res.json();
      setSearchHits(data.results || []);
    }, 200);
    return () => clearTimeout(handle);
  }, [search]);

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg-page)", color: "var(--text-primary)", padding: 24 }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <header style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.14em", color: "var(--accent-strong)" }}>
            LABS EXPLORER · LOINC
          </div>
          <h1 style={{ margin: "4px 0 0", fontSize: 26, lineHeight: 1.15 }}>Clinical lab panels</h1>
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, maxWidth: 720 }}>
            12 curated panels, ~70 lab codes mapped to LOINC. Reference ranges are conservative adult defaults;
            always defer to your local lab&apos;s reported range. Click any lab for synonyms and related concepts.
          </p>
        </header>

        <div style={{ position: "relative", marginBottom: 18, maxWidth: 480 }}>
          <Search size={14} style={{ position: "absolute", top: 11, left: 11, color: "var(--text-muted)" }} />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search any lab (e.g. troponin, creatinine, INR)..."
            style={{
              width: "100%", height: 36, paddingLeft: 32, paddingRight: 10,
              border: "1px solid var(--border)", borderRadius: 8,
              background: "var(--bg-card)", color: "var(--text-primary)", fontSize: 13,
            }}
          />
          {searchHits.length > 0 && (
            <div style={{
              position: "absolute", top: 40, left: 0, right: 0, zIndex: 10,
              border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)",
              boxShadow: "0 12px 32px rgba(15,23,42,0.18)", maxHeight: 320, overflowY: "auto",
            }}>
              {searchHits.map(hit => (
                <button
                  key={`${hit.cui}:${hit.matched_code || ""}`}
                  type="button"
                  onClick={() => {
                    if (hit.matched_code) {
                      void loadDetail(hit.matched_code);
                      setSearch("");
                      setSearchHits([]);
                    }
                  }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "8px 12px", border: "none", background: "transparent",
                    cursor: "pointer", color: "var(--text-primary)", fontSize: 13,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <strong>{hit.preferred_name}</strong>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {hit.matched_code ? `LOINC ${hit.matched_code}` : hit.cui}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: pageGridColumns, gap: 16 }}>
          <aside style={{
            border: "1px solid var(--border)", borderRadius: 10, padding: 8,
            background: "var(--bg-card)", height: "fit-content",
            ...(compact ? { display: "flex", gap: 6, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "thin" as const } : {}),
          }}>
            {groups?.panels.map(panel => (
              <button
                key={panel.id}
                type="button"
                onClick={() => setActivePanel(panel.id)}
                style={{
                  display: "block", width: compact ? 190 : "100%", minWidth: compact ? 190 : undefined, textAlign: "left",
                  padding: "10px 12px", borderRadius: 8,
                  background: panel.id === activePanel ? "rgba(20,184,166,0.10)" : "transparent",
                  color: panel.id === activePanel ? "var(--accent-strong)" : "var(--text-primary)",
                  border: "none", cursor: "pointer", marginBottom: 2,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 13 }}>{panel.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {panel.codes.length} codes
                </div>
              </button>
            ))}
          </aside>

          <section style={{
            border: "1px solid var(--border)", borderRadius: 10, padding: 14,
            background: "var(--bg-card)",
          }}>
            {activePanelData ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 18 }}>{activePanelData.name}</h2>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                    {activePanelData.description}
                  </div>
                </div>
                {!compact && (
                <div style={{
                  display: "grid",
                  gridTemplateColumns: codeGridColumns,
                  gap: 8, padding: "6px 10px",
                  fontSize: 10, fontWeight: 800, color: "var(--text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.05em",
                  borderBottom: "1px solid var(--border)",
                }}>
                  <span>LOINC</span>
                  <span>Test</span>
                  <span>Units</span>
                  <span>Reference range</span>
                  <span style={{ textAlign: "right" }}>CUI</span>
                  <span style={{ textAlign: "right" }} />
                </div>
                )}
                {activePanelData.codes.map(code => (
                  <button
                    key={code.loinc}
                    type="button"
                    onClick={() => void loadDetail(code.loinc)}
                    style={{
                      display: "grid", width: "100%",
                      gridTemplateColumns: codeGridColumns,
                      gap: compact ? 6 : 8, padding: compact ? "11px 10px" : "9px 10px",
                      borderBottom: "1px solid var(--border)",
                      border: "none", borderLeft: "none", borderRight: "none", borderTop: "none",
                      background: activeLoinc === code.loinc ? "rgba(20,184,166,0.08)" : "transparent",
                      cursor: "pointer", textAlign: "left", color: "var(--text-primary)", fontSize: 12,
                    }}
                  >
                    {compact ? (
                      <>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", fontWeight: 700, overflowWrap: "anywhere" }}>{code.display}</span>
                          <span style={{ display: "block", marginTop: 4, color: "var(--text-muted)", fontFamily: "ui-monospace, monospace", fontSize: 10 }}>
                            LOINC {code.loinc}{code.units ? ` · ${code.units}` : ""}
                          </span>
                          <span style={{ display: "block", marginTop: 3, color: "var(--text-secondary)", fontSize: 11 }}>
                            {code.ref_low && code.ref_high ? `${code.ref_low} – ${code.ref_high}` : code.ref_high || code.ref_low || "No range"}
                          </span>
                        </span>
                        <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", color: "var(--text-muted)" }}>
                          <ExternalLink size={13} />
                        </span>
                      </>
                    ) : (
                      <>
                        <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--text-muted)" }}>
                          {code.loinc}
                        </span>
                        <span style={{ fontWeight: 600 }}>{code.display}</span>
                        <span style={{ color: "var(--text-muted)" }}>{code.units || "—"}</span>
                        <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                          {code.ref_low && code.ref_high ? `${code.ref_low} – ${code.ref_high}` : code.ref_high || code.ref_low || "—"}
                        </span>
                        <span style={{
                          textAlign: "right", color: "var(--text-muted)", fontSize: 10,
                          fontFamily: "ui-monospace, monospace",
                        }}>{code.cui || ""}</span>
                        <span style={{ textAlign: "right" }}>
                          <ExternalLink size={11} color="var(--text-muted)" />
                        </span>
                      </>
                    )}
                  </button>
                ))}
              </>
            ) : (
              <div style={{ color: "var(--text-muted)" }}>Loading...</div>
            )}
          </section>

          <aside style={{
            border: "1px solid var(--border)", borderRadius: 10, padding: 14,
            background: "var(--bg-card)", height: "fit-content",
          }}>
            {loadingDetail && <div style={{ color: "var(--text-muted)" }}>Loading detail...</div>}
            {!loadingDetail && detail && (
              <>
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "ui-monospace, monospace" }}>
                  LOINC {detail.loinc} · {detail.cui}
                </div>
                <h3 style={{ margin: "6px 0 8px", fontSize: 15 }}>
                  {detail.curated?.display || detail.preferred_name}
                </h3>
                {detail.preferred_name && (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
                    {detail.preferred_name}
                  </div>
                )}
                {detail.curated && (
                  <div style={{ marginBottom: 14, fontSize: 12 }}>
                    <div><strong>Units:</strong> {detail.curated.units || "—"}</div>
                    <div><strong>Range:</strong> {detail.curated.ref_low && detail.curated.ref_high ? `${detail.curated.ref_low} – ${detail.curated.ref_high}` : (detail.curated.ref_high || detail.curated.ref_low || "—")}</div>
                  </div>
                )}
                {detail.synonyms.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>
                      Synonyms
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
                      {detail.synonyms.slice(0, 6).map(syn => (
                        <span key={syn} style={{
                          fontSize: 11, padding: "2px 7px", borderRadius: 4,
                          background: "rgba(148,163,184,0.10)", color: "var(--text-secondary)",
                          border: "1px solid var(--border)",
                        }}>{syn}</span>
                      ))}
                    </div>
                  </>
                )}
                {detail.related.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>
                      Related
                    </div>
                    <div style={{ display: "grid", gap: 4, marginBottom: 12 }}>
                      {detail.related.slice(0, 8).map(rel => (
                        <a
                          key={`${rel.cui}:${rel.rela}`}
                          href={`/umls?cui=${rel.cui}`}
                          onClick={event => {
                            event.preventDefault();
                            openConcept(`/umls?cui=${encodeURIComponent(rel.cui)}`, rel.name);
                          }}
                          style={{
                            fontSize: 12, color: "var(--text-secondary)",
                            textDecoration: "none", padding: "3px 0",
                          }}
                        >
                          <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {rel.rela}
                          </span>
                          <br />
                          {rel.name}
                        </a>
                      ))}
                    </div>
                  </>
                )}
                <a
                  href={detail.href}
                  onClick={event => {
                    if (/^https?:\/\//i.test(detail.href)) return;
                    event.preventDefault();
                    openConcept(detail.href, detail.preferred_name || detail.curated?.display || "UMLS");
                  }}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    fontSize: 12, color: "var(--accent-strong)", textDecoration: "none", fontWeight: 700,
                  }}
                >
                  <ExternalLink size={12} /> Open concept page
                </a>
              </>
            )}
            {!loadingDetail && !detail && (
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                Click any lab to see synonyms and related concepts.
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
