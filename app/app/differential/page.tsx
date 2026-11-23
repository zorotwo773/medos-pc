"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plus, Search, Sparkles, X } from "lucide-react";
import { getBackendUrl } from "@/lib/api";

interface PhenotypeConcept {
  cui: string;
  preferred_name: string;
  semantic_group?: string;
  definition?: string;
}

interface DifferentialResult {
  cui: string;
  preferred_name: string;
  semantic_group: string;
  matched_count: number;
  score: number;
  match_ic: number;
  coverage: number;
  matched_phenotypes: string[];
  sources: string[];
  href: string;
}

interface DifferentialResponse {
  phenotypes: PhenotypeConcept[];
  results: DifferentialResult[];
  suggestions?: CofindingSuggestion[];
  summary?: {
    input_count: number;
    expanded_phenotype_count: number;
    candidate_count: number;
  };
  message?: string;
}

interface CofindingSuggestion {
  cui: string;
  preferred_name: string;
  disease_count: number;
  ic: number;
  score?: number;
}

const STARTER_EXAMPLES: Array<{ label: string; phenotypes: string[] }> = [
  {
    label: "Ciliopathy presentation",
    phenotypes: ["Polydactyly", "Coloboma", "Renal cyst"],
  },
  {
    label: "Marfan-spectrum",
    phenotypes: ["Aortic root dilation", "Arachnodactyly", "Ectopia lentis", "Mitral valve prolapse"],
  },
  {
    label: "Pediatric epileptic encephalopathy",
    phenotypes: ["Seizure", "Microcephaly", "Hypotonia"],
  },
  {
    label: "Storage disorder hint",
    phenotypes: ["Hepatosplenomegaly", "Coarse facial features", "Short stature"],
  },
];

function useQueryParam(name: string) {
  const [state, setState] = useState<{ value: string; ready: boolean }>({ value: "", ready: false });
  useEffect(() => {
    if (typeof window === "undefined") {
      setState({ value: "", ready: true });
      return;
    }
    setState({ value: new URLSearchParams(window.location.search).get(name) || "", ready: true });
  }, [name]);
  return state;
}

export default function DifferentialPage() {
  const { value: initial, ready: initialReady } = useQueryParam("p");
  const hydratedInitialRef = useRef(false);
  const skipInitialEmptySyncRef = useRef(false);
  const [chips, setChips] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<PhenotypeConcept[]>([]);
  const [response, setResponse] = useState<DifferentialResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchingSuggestions, setSearchingSuggestions] = useState(false);

  useEffect(() => {
    if (!initialReady || hydratedInitialRef.current) return;
    hydratedInitialRef.current = true;
    if (initial) {
      const parts = initial.split("|").map(s => decodeURIComponent(s).trim()).filter(Boolean);
      if (parts.length) {
        skipInitialEmptySyncRef.current = true;
        setChips(parts);
      }
    }
  }, [initial, initialReady]);

  const runDifferential = useCallback(async (phenotypes: string[]) => {
    if (!phenotypes.length) {
      setResponse(null);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${getBackendUrl()}/umls/phenotype/differential?limit=24`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phenotypes }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: DifferentialResponse = await res.json();
      setResponse(data);
    } catch (err) {
      setResponse(null);
      setError(err instanceof Error ? err.message : "Differential request failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialReady) return;
    if (skipInitialEmptySyncRef.current && chips.length === 0) return;
    if (skipInitialEmptySyncRef.current) skipInitialEmptySyncRef.current = false;
    void runDifferential(chips);
    if (typeof window !== "undefined") {
      const encoded = chips.map(c => encodeURIComponent(c)).join("|");
      const url = encoded ? `?p=${encoded}` : window.location.pathname;
      window.history.replaceState(null, "", url);
    }
  }, [chips, initialReady, runDifferential]);

  useEffect(() => {
    if (input.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const handle = setTimeout(async () => {
      setSearchingSuggestions(true);
      try {
        const res = await fetch(
          `${getBackendUrl()}/umls/search?q=${encodeURIComponent(input.trim())}&semantic_group=finding&limit=10`,
        );
        const data = await res.json();
        let results = (data.results || []) as PhenotypeConcept[];
        if (!results.length) {
          // Some HPO concepts are tagged as 'disease' (e.g. Polydactyly). Try unfiltered.
          const r2 = await fetch(`${getBackendUrl()}/umls/search?q=${encodeURIComponent(input.trim())}&limit=12`);
          const d2 = await r2.json();
          results = (d2.results || []) as PhenotypeConcept[];
        }
        setSuggestions(results);
      } finally {
        setSearchingSuggestions(false);
      }
    }, 180);
    return () => clearTimeout(handle);
  }, [input]);

  const addChip = useCallback((value: string, split = true) => {
    const values = (split ? value.split(/[+,;]+/) : [value])
      .map(v => v.trim())
      .filter(Boolean);
    if (!values.length) return;
    setChips(prev => {
      const next = [...prev];
      for (const value of values) {
        if (!next.some(item => item.toLowerCase() === value.toLowerCase())) next.push(value);
      }
      return next;
    });
    setInput("");
    setSuggestions([]);
  }, []);

  const removeChip = useCallback((value: string) => {
    setChips(prev => prev.filter(c => c !== value));
  }, []);

  const phenotypeBlocks = useMemo(() => {
    if (!response?.phenotypes?.length) return null;
    return response.phenotypes.map(p => (
      <span
        key={p.cui}
        title={`${p.preferred_name} · ${p.cui}${p.semantic_group ? ` · ${p.semantic_group}` : ""}`}
        style={{
          fontSize: 11, padding: "2px 7px", borderRadius: 4, fontFamily: "ui-monospace, monospace",
          background: "rgba(99,102,241,0.12)", color: "var(--mod-library)",
          border: "1px solid rgba(99,102,241,0.28)",
        }}
      >
        {p.preferred_name} · {p.cui}
      </span>
    ));
  }, [response]);

  const nextFindings = response?.suggestions || [];
  const summary = response?.summary;

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg-page)", color: "var(--text-primary)", padding: 24 }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.14em", color: "var(--mod-concepts)" }}>
            UMLS DIFFERENTIAL COACH
          </div>
          <h1 style={{ margin: "4px 0 0", fontSize: 28, lineHeight: 1.15 }}>
            Phenotype-driven differential diagnosis
          </h1>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--text-muted)", maxWidth: 760, lineHeight: 1.55 }}>
            Add clinical findings one at a time. Diseases are ranked by Information-Content–weighted overlap
            against UMLS phenotype links (OMIM, Orphanet, NCI, SNOMED). Rare distinguishing findings
            dominate over common ones.
          </p>
        </header>

        <section style={{ marginBottom: 18, padding: 14, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-card)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, alignItems: "center" }}>
            {chips.map(chip => (
              <span key={chip} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                fontSize: 13, padding: "5px 4px 5px 10px", borderRadius: 999,
                background: "rgba(20,184,166,0.10)", color: "var(--mod-concepts)",
                border: "1px solid rgba(20,184,166,0.32)",
              }}>
                {chip}
                <button
                  type="button"
                  onClick={() => removeChip(chip)}
                  aria-label={`Remove ${chip}`}
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 18, height: 18, borderRadius: 999, border: "none",
                    background: "rgba(20,184,166,0.18)", color: "var(--mod-concepts)", cursor: "pointer",
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <div style={{ position: "relative", flex: "1 1 220px", minWidth: 200 }}>
              <input
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && input.trim()) {
                    event.preventDefault();
                    addChip(input.trim());
                  }
                  if (event.key === "Backspace" && !input && chips.length) {
                    setChips(prev => prev.slice(0, -1));
                  }
                }}
                placeholder="Add a finding (e.g. Aortic root dilation)"
                style={{
                  width: "100%", height: 34,
                  border: "1px solid var(--border)", borderRadius: 6,
                  background: "var(--bg-page)", color: "var(--text-primary)",
                  padding: "0 10px", fontSize: 13,
                }}
              />
              {suggestions.length > 0 && (
                <div style={{
                  position: "absolute", top: 38, left: 0, right: 0, zIndex: 10,
                  border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden",
                  background: "var(--bg-card)", boxShadow: "0 12px 32px rgba(15,23,42,0.18)",
                  maxHeight: 320, overflowY: "auto",
                }}>
                  {suggestions.map(item => (
                    <button
                      key={item.cui}
                      type="button"
                      onClick={() => addChip(item.preferred_name, false)}
                      style={{
                        display: "block", width: "100%", textAlign: "left",
                        padding: "8px 10px", border: "none", background: "transparent",
                        cursor: "pointer", color: "var(--text-primary)", fontSize: 13,
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <strong>{item.preferred_name}</strong>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {item.cui}
                        {item.semantic_group ? ` · ${item.semantic_group}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {searchingSuggestions && !suggestions.length && (
                <div style={{
                  position: "absolute", top: 38, left: 0, zIndex: 10,
                  display: "inline-flex", alignItems: "center", gap: 6,
                  border: "1px solid var(--border)", borderRadius: 999,
                  background: "var(--bg-card)", color: "var(--text-muted)",
                  boxShadow: "0 10px 28px rgba(15,23,42,0.14)",
                  padding: "5px 10px", fontSize: 11,
                }}>
                  <Loader2 size={12} style={{ animation: "spin 0.8s linear infinite" }} />
                  searching UMLS
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => addChip(input.trim())}
              disabled={!input.trim()}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "0 14px", height: 34, fontSize: 12, fontWeight: 700,
                background: input.trim() ? "var(--mod-concepts)" : "var(--bg-page)",
                color: input.trim() ? "var(--accent-ink)" : "var(--text-muted)",
                border: "1px solid var(--border)", borderRadius: 6,
                cursor: input.trim() ? "pointer" : "not-allowed",
              }}
            >
              <Plus size={14} /> Add
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Try:
            </span>
            {STARTER_EXAMPLES.map(ex => (
              <button
                key={ex.label}
                type="button"
                onClick={() => setChips(ex.phenotypes)}
                style={{
                  fontSize: 11, padding: "3px 10px", borderRadius: 999,
                  border: "1px solid var(--border)", background: "transparent",
                  color: "var(--text-secondary)", cursor: "pointer",
                }}
              >{ex.label}</button>
            ))}
            {chips.length > 0 && (
              <button
                type="button"
                onClick={() => setChips([])}
                style={{
                  fontSize: 11, padding: "3px 10px", borderRadius: 999,
                  border: "1px solid var(--border)", background: "transparent",
                  color: "var(--red, #ef4444)", cursor: "pointer", marginLeft: "auto",
                }}
              >Clear all</button>
            )}
          </div>
        </section>

        {error && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 12px", marginBottom: 12, borderRadius: 8,
            border: "1px solid rgba(239,68,68,0.35)",
            background: "rgba(239,68,68,0.08)", color: "#b91c1c", fontSize: 13,
          }}>
            <AlertTriangle size={15} />
            Differential backend failed: {error}
          </div>
        )}

        {(loading || response) && (
          <section style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: 14,
            alignItems: "start",
          }}>
            <div>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 10, marginBottom: 8,
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 800, color: "var(--text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.06em",
                }}>
                  Top differential {response?.results?.length ? `(${response.results.length})` : ""}
                </div>
                {summary && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "ui-monospace, monospace" }}>
                    {summary.candidate_count} candidates · {summary.expanded_phenotype_count} linked findings
                  </div>
                )}
              </div>

              {loading && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: 16, color: "var(--text-muted)", fontSize: 13,
                  border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-card)",
                }}>
                  <Loader2 size={15} style={{ animation: "spin 0.8s linear infinite" }} />
                  Ranking diseases by IC overlap...
                </div>
              )}

              {!loading && response && response.results.length === 0 && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: 16, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6,
                  border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-card)",
                }}>
                  <Sparkles size={15} /> {response.message || "No diseases matched."}
                </div>
              )}

              {!loading && response && response.results.length > 0 && (
                <div style={{ display: "grid", gap: 8 }}>
                  {response.results.map((row, idx) => (
                    <ResultRow key={row.cui} row={row} rank={idx + 1} />
                  ))}
                </div>
              )}
            </div>

            <aside style={{ display: "grid", gap: 10 }}>
              {nextFindings.length > 0 && (
                <div style={{
                  padding: 12, border: "1px solid var(--border)", borderRadius: 10,
                  background: "var(--bg-card)",
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 800, color: "var(--mod-concepts)",
                    textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8,
                  }}>
                    Next useful findings
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {nextFindings.slice(0, 10).map(item => (
                      <button
                        key={item.cui}
                        type="button"
                        onClick={() => addChip(item.preferred_name, false)}
                        title={`${item.disease_count} candidate diseases · IC ${item.ic.toFixed(2)} · ${item.cui}`}
                        style={{
                          fontSize: 11, padding: "4px 8px", borderRadius: 999,
                          border: "1px solid rgba(20,184,166,0.35)",
                          background: "rgba(20,184,166,0.08)", color: "var(--mod-concepts)",
                          cursor: "pointer",
                        }}
                      >
                        + {item.preferred_name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {phenotypeBlocks && (
                <div style={{
                  padding: 12, border: "1px solid var(--border)", borderRadius: 10,
                  background: "var(--bg-card)",
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 800, color: "var(--text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8,
                  }}>
                    Resolved UMLS/HPO concepts
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {phenotypeBlocks}
                  </div>
                </div>
              )}
            </aside>
          </section>
        )}

        {!chips.length && !loading && (
          <section style={{
            padding: 30, textAlign: "center", border: "1px dashed var(--border)",
            borderRadius: 12, color: "var(--text-muted)",
          }}>
            <Search size={20} style={{ marginBottom: 10 }} />
            <div style={{ fontSize: 14 }}>Add at least one clinical finding to generate a differential.</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Or click a preset above.
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function ResultRow({ row, rank }: { row: DifferentialResult; rank: number }) {
  const matched = (row.matched_phenotypes || []).slice(0, 4).join(" · ");
  const coverage = Math.max(0, Math.min(row.coverage || 0, 1));
  return (
    <a
      href={row.href}
      style={{
        display: "grid", gridTemplateColumns: "32px minmax(0, 1fr) 86px",
        gap: 12, alignItems: "center", padding: "10px 14px",
        border: "1px solid var(--border)", borderRadius: 10,
        background: "var(--bg-card)", textDecoration: "none", color: "inherit",
      }}
    >
      <div style={{
        width: 28, height: 28, borderRadius: 999,
        display: "grid", placeItems: "center",
        background: rank === 1 ? "rgba(20,184,166,0.18)" : "rgba(148,163,184,0.18)",
        color: rank === 1 ? "var(--mod-concepts)" : "var(--text-muted)",
        fontSize: 12, fontWeight: 800,
      }}>{rank}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.3, color: "var(--text-primary)" }}>
          {row.preferred_name}
        </div>
        <div style={{
          fontSize: 11, color: "var(--text-muted)", marginTop: 3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {row.cui} · IC overlap {row.match_ic.toFixed(2)} · {row.matched_count} match{row.matched_count === 1 ? "" : "es"} · {(row.sources || []).join("/")}
        </div>
        {matched && (
          <div style={{
            fontSize: 11, color: "var(--text-secondary)", marginTop: 3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            Matched: {matched}
          </div>
        )}
        <div style={{ marginTop: 7, height: 4, borderRadius: 999, background: "rgba(148,163,184,0.18)", overflow: "hidden" }}>
          <div style={{ width: `${Math.max(6, coverage * 100)}%`, height: "100%", background: "var(--mod-concepts)" }} />
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: "var(--mod-concepts)" }}>{row.score.toFixed(1)}</div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          score
        </div>
      </div>
    </a>
  );
}
