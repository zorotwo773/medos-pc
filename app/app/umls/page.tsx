"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import ConceptSearchBox from "@/components/common/ConceptSearchBox";

interface UmlsConcept {
  cui: string;
  preferred_name: string;
  semantic_group?: string;
  definition?: string;
  preferred_source?: string;
  terms?: Array<{ term: string; source: string; code?: string; is_pref?: boolean }>;
  codes?: Array<{ source: string; code: string; term: string }>;
  relations?: Array<{ cui: string; preferred_name: string; semantic_group?: string; rela?: string; rel?: string }>;
}

interface SearchHit extends UmlsConcept {
  matched_term?: string;
  matched_source_label?: string;
  matched_code?: string;
}

interface Mention {
  source: string;
  source_id: string;
  title: string;
  subtitle?: string;
  href: string;
  matched_term: string;
  hit_count: number;
  semantic_group?: string;
  kind?: string;
}

interface MentionsResponse {
  cui: string;
  total_mentions: number;
  results: Mention[];
  source_counts?: Record<string, number>;
}

interface CtgovStudy {
  nct_id: string;
  title: string;
  status: string;
  phase: string;
  enrollment: number | null;
  start_date: string;
  conditions: string[];
  summary: string;
  url: string;
  is_recruiting: boolean;
}

interface CtgovResponse {
  studies: CtgovStudy[];
  total_count: number;
  recruiting_count: number;
  _error?: boolean;   // true when the live ClinicalTrials.gov lookup failed (e.g. offline)
}

interface MimicResult {
  cui: string;
  preferred_name: string;
  semantic_group?: string;
  href: string;
  shared_phenotypes: number;
  total_phenotypes: number;
  jaccard: number;
}

const _DISEASE_GROUPS = new Set(["disease", "finding", "pathology"]);

export default function UmlsPage() {
  return (
    <Suspense fallback={<main style={{ minHeight: "100vh", background: "var(--bg-page)", color: "var(--text-primary)", padding: 24 }}>Loading...</main>}>
      <UmlsPageInner />
    </Suspense>
  );
}

function UmlsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialCui = searchParams.get("cui") || "";
  const initialQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState("");
  const [concept, setConcept] = useState<UmlsConcept | null>(null);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [mentions, setMentions] = useState<MentionsResponse | null>(null);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const [trials, setTrials] = useState<CtgovResponse | null>(null);
  const [trialsLoading, setTrialsLoading] = useState(false);
  const [mimics, setMimics] = useState<MimicResult[] | null>(null);

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (!initialCui) return;
    let cancelled = false;
    setLoading(true);
    setMentions(null);
    fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(initialCui)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        if (!cancelled) setConcept(data);
      })
      .catch(() => {
        if (!cancelled) setConcept(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    setMentionsLoading(true);
    fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(initialCui)}/mentions?per_source=6&limit=240`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: MentionsResponse) => {
        if (!cancelled) setMentions(data);
      })
      .catch(() => {
        if (!cancelled) setMentions(null);
      })
      .finally(() => {
        if (!cancelled) setMentionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [initialCui]);

  // Fetch clinical trials + phenotypic mimics when a disease concept is loaded
  useEffect(() => {
    if (!concept) { setTrials(null); setMimics(null); return; }
    const sg = (concept.semantic_group || "").toLowerCase();
    if (!_DISEASE_GROUPS.has(sg)) { setTrials(null); setMimics(null); return; }
    let cancelled = false;

    // Clinical trials
    setTrialsLoading(true);
    setTrials(null);
    fetch(`${getBackendUrl()}/trials/by-cui/${encodeURIComponent(concept.cui)}?limit=10`)
      .then(r => r.ok ? r.json() as Promise<CtgovResponse> : Promise.reject(r.status))
      .then(data => { if (!cancelled) setTrials(data); })
      .catch(() => { if (!cancelled) setTrials(null); })
      .finally(() => { if (!cancelled) setTrialsLoading(false); });

    // Phenotypic mimics
    setMimics(null);
    fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(concept.cui)}/mimics?limit=6`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: { mimics: MimicResult[] }) => { if (!cancelled) setMimics(data.mimics || []); })
      .catch(() => { if (!cancelled) setMimics([]); });

    return () => { cancelled = true; };
  }, [concept]);

  const title = concept?.preferred_name || "UMLS";
  const codeRows = useMemo(() => (concept?.codes || []).slice(0, 18), [concept]);
  const synonymRows = useMemo(() => (concept?.terms || []).slice(0, 28), [concept]);
  const sourceCounts = mentions?.source_counts ?? {};
  const nSources = Object.keys(sourceCounts).length;
  const totalItems = Object.values(sourceCounts).reduce((a, b) => a + b, 0);

  function openConcept(cui: string) {
    router.push(`/umls?cui=${encodeURIComponent(cui)}`);
  }

  function openInAppTab(href: string, title: string) {
    window.dispatchEvent(new CustomEvent("TabBar:open", {
      detail: { href, title },
    }));
  }

  function openGraph(cui: string, title = `Graph · ${cui}`) {
    openInAppTab(`/graph?cui=${encodeURIComponent(cui)}`, title);
  }

  async function runSearch(value = query) {
    const q = value.trim();
    if (!q) return;
    setLoading(true);
    setConcept(null);
    try {
      const res = await fetch(`${getBackendUrl()}/umls/search?q=${encodeURIComponent(q)}&limit=24`);
      const data = await res.json();
      setResults(data.results || []);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg-page)", color: "var(--text-primary)", padding: 24 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: "var(--accent-strong)" }}>UMLS CONCEPT LAYER</div>
            <h1 style={{ margin: "4px 0 0", fontSize: 28, lineHeight: 1.15 }}>{title}</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", minWidth: 280, maxWidth: 520, flex: "1 1 360px" }}>
            <ConceptSearchBox
              buttonLabel="Go"
              placeholder="Search terms, diseases, drugs, labs…"
              onPick={openConcept}
            />
          </div>
        </header>

        {loading && <p style={{ color: "var(--text-muted)" }}>Loading...</p>}

        {concept && (
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
            <article>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  {concept.cui}
                  {concept.semantic_group ? ` · ${concept.semantic_group}` : ""}
                  {concept.preferred_source ? ` · ${concept.preferred_source}` : ""}
                </span>
                <a
                  href={`/graph?cui=${concept.cui}`}
                  onClick={e => {
                    e.preventDefault();
                    openGraph(concept.cui);
                  }}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12,
                    color: "var(--accent-strong)", background: "var(--accent-glow)", border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
                    borderRadius: 20, padding: "2px 10px", textDecoration: "none",
                    fontWeight: 600, letterSpacing: "0.01em",
                  }}
                >
                  ⬡ Explore causation →
                </a>
              </div>
              {concept.definition && <p style={{ fontSize: 16, lineHeight: 1.6, maxWidth: 820 }}>{concept.definition}</p>}
              <h2 style={{ fontSize: 14, marginTop: 26 }}>Synonyms</h2>
              <div style={{ display: "grid", gap: 6 }}>
                {synonymRows.map((item, index) => (
                  <div key={`${item.source}:${item.code}:${index}`} style={{ display: "flex", gap: 10, fontSize: 13, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                    <strong style={{ width: 90, color: item.is_pref ? "var(--accent-strong)" : "var(--text-muted)" }}>{item.source}</strong>
                    <span>{item.term}</span>
                  </div>
                ))}
              </div>
            </article>
            <aside>
              <h2 style={{ fontSize: 14, marginTop: 0 }}>Codes</h2>
              {codeRows.map((item, index) => (
                <div key={`${item.source}:${item.code}:${index}`} style={{ marginBottom: 9, fontSize: 13 }}>
                  <strong>{item.source}</strong> <code>{item.code}</code>
                  <div style={{ color: "var(--text-muted)" }}>{item.term}</div>
                </div>
              ))}
              <h2 style={{ fontSize: 14, marginTop: 22 }}>Related</h2>
              {(concept.relations || []).slice(0, 12).map(item => (
                <a key={`${item.cui}:${item.rela || item.rel}`} href={`/umls?cui=${item.cui}`} onClick={e => { e.preventDefault(); openConcept(item.cui); }} style={{ display: "block", color: "var(--text-secondary)", fontSize: 13, textDecoration: "none", marginBottom: 8 }}>
                  <ExternalLink size={12} /> {item.preferred_name}
                </a>
              ))}

              {mimics && mimics.length > 0 && (
                <div style={{ marginTop: 24 }}>
                  <h2 style={{ fontSize: 14, margin: "0 0 6px" }}>
                    Phenotypic Mimics
                    <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 500, marginLeft: 6 }}>
                      — similar HPO profile
                    </span>
                  </h2>
                  <div style={{ display: "grid", gap: 6 }}>
                    {mimics.map(m => (
                      <a
                        key={m.cui}
                        href={m.href}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                          borderRadius: 6, border: "1px solid var(--border)",
                          textDecoration: "none", color: "var(--text-primary)", fontSize: 12,
                          background: "var(--bg-card)",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {m.preferred_name}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>
                            {m.shared_phenotypes} shared features · Jaccard {m.jaccard}
                          </div>
                        </div>
                        <span style={{
                          flexShrink: 0, fontSize: 9, fontWeight: 800, padding: "2px 5px", borderRadius: 4,
                          background: `rgba(99,102,241,${Math.min(0.08 + m.jaccard * 0.25, 0.32)})`,
                          color: "#4338ca",
                        }}>
                          {Math.round(m.jaccard * 100)}%
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </section>
        )}

        {concept && mentions && mentions.results.length > 0 && (
          <section style={{ marginTop: 28 }}>
            <h2 style={{ fontSize: 14, margin: 0, marginBottom: 10 }}>
              Across your libraries{" "}
              <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>
                {nSources > 0
                  ? `(${nSources} source${nSources === 1 ? "" : "s"} · ${totalItems.toLocaleString()} item${totalItems === 1 ? "" : "s"})`
                  : `(${mentions.total_mentions} paragraph${mentions.total_mentions === 1 ? "" : "s"})`}
              </span>
            </h2>
            <MentionsList
              mentions={mentions}
              onOpenHref={openInAppTab}
              onFilterSource={(src) => router.push(`/umls?cui=${encodeURIComponent(mentions.cui)}&source=${encodeURIComponent(src)}`)}
            />
          </section>
        )}
        {concept && mentionsLoading && !mentions && (
          <p style={{ marginTop: 24, color: "var(--text-muted)", fontSize: 12 }}>Loading mentions...</p>
        )}

        {/* ── ClinicalTrials.gov panel ── */}
        {concept && trialsLoading && !trials && (
          <p style={{ marginTop: 24, color: "var(--text-muted)", fontSize: 12 }}>Loading clinical trials...</p>
        )}
        {concept && trials && (
          <section style={{ marginTop: 28 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <h2 style={{ fontSize: 14, margin: 0 }}>Clinical Trials</h2>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {trials.total_count.toLocaleString()} total
                {trials.recruiting_count > 0 && (
                  <> · <span style={{ color: "#0d9488", fontWeight: 700 }}>{trials.recruiting_count} recruiting</span></>
                )}
              </span>
              <a
                href={`https://clinicaltrials.gov/search?cond=${encodeURIComponent(concept.preferred_name)}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto", textDecoration: "none" }}
              >View all on ClinicalTrials.gov ↗</a>
            </div>
            <TrialsPanel trials={trials} />
          </section>
        )}

        {!concept && results.length > 0 && (
          <section style={{ display: "grid", gap: 8 }}>
            {results.map(item => (
              <a key={item.cui} href={`/umls?cui=${item.cui}`} onClick={e => { e.preventDefault(); openConcept(item.cui); }} style={{ display: "block", padding: "10px 0", borderBottom: "1px solid var(--border)", color: "inherit", textDecoration: "none" }}>
                <strong>{item.preferred_name}</strong>
                <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  {item.cui} {item.semantic_group ? ` · ${item.semantic_group}` : ""} {item.matched_source_label ? ` · ${item.matched_source_label}` : ""}
                </div>
                {item.definition && <div style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 4 }}>{item.definition}</div>}
              </a>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  RECRUITING:                  { bg: "#d1fae5", fg: "#065f46", label: "Recruiting" },
  ACTIVE_NOT_RECRUITING:       { bg: "#fef3c7", fg: "#92400e", label: "Active" },
  ENROLLING_BY_INVITATION:     { bg: "#dbeafe", fg: "#1e40af", label: "By invitation" },
  NOT_YET_RECRUITING:          { bg: "#ede9fe", fg: "#5b21b6", label: "Not yet" },
  COMPLETED:                   { bg: "#f3f4f6", fg: "#6b7280", label: "Completed" },
  TERMINATED:                  { bg: "#fee2e2", fg: "#991b1b", label: "Terminated" },
  WITHDRAWN:                   { bg: "#fce7f3", fg: "#9d174d", label: "Withdrawn" },
  SUSPENDED:                   { bg: "#fef3c7", fg: "#92400e", label: "Suspended" },
};

function TrialsPanel({ trials }: { trials: CtgovResponse }) {
  if (trials._error) {
    return <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Clinical trials are unavailable offline — connect to the internet to load current studies from ClinicalTrials.gov.</p>;
  }
  if (!trials.studies.length) {
    return <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No clinical trials found for this concept.</p>;
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {trials.studies.map(study => {
        const statusStyle = STATUS_STYLE[study.status] || { bg: "#f3f4f6", fg: "#6b7280", label: study.status };
        return (
          <a
            key={study.nct_id}
            href={study.url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "block", padding: "10px 12px", borderRadius: 8,
              border: `1px solid ${study.is_recruiting ? "rgba(13,148,136,0.3)" : "var(--border)"}`,
              background: study.is_recruiting ? "rgba(13,148,136,0.04)" : "var(--bg-card)",
              textDecoration: "none", color: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
              <span style={{
                flexShrink: 0, fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                background: statusStyle.bg, color: statusStyle.fg,
                border: `1px solid ${statusStyle.fg}22`,
              }}>{statusStyle.label}</span>
              {study.phase && (
                <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-muted)", padding: "2px 6px", borderRadius: 4, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                  {study.phase}
                </span>
              )}
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "var(--text-muted)", marginLeft: "auto" }}>
                {study.nct_id}
              </span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.4, marginBottom: 4 }}>
              {study.title}
            </div>
            <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
              {study.enrollment && <span>{study.enrollment.toLocaleString()} enrolled</span>}
              {study.start_date && <span>Started {study.start_date}</span>}
            </div>
          </a>
        );
      })}
    </div>
  );
}

const SOURCE_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  amboss:        { label: "AMB",  bg: "#eaf4ff", fg: "#1e5f9f" },
  utd:           { label: "UTD",  bg: "#effaf1", fg: "#226937" },
  qbank:         { label: "UW",   bg: "#fff8dc", fg: "#7b5600" },
  uworld:        { label: "UWL",  bg: "var(--accent-glow)", fg: "var(--accent-strong)" },
  books:         { label: "BK",   bg: "#f4ecff", fg: "#5b3aa8" },
  firstaid:      { label: "FA",   bg: "#fff0e6", fg: "#a44a16" },
  drugs:         { label: "RX",   bg: "#f3f4f6", fg: "#374151" },
  diseases:      { label: "DX",   bg: "#fef2f2", fg: "#9b2c2c" },
  calc:          { label: "CALC", bg: "#edf1f7", fg: "#3b4a60" },
  anatomy:       { label: "ANAT", bg: "#ecfeff", fg: "#155e75" },
};

function MentionsList({
  mentions,
  onOpenHref,
  onFilterSource,
}: {
  mentions: MentionsResponse;
  onOpenHref: (href: string, title: string) => void;
  onFilterSource: (source: string) => void;
}) {
  const grouped = useMemo(() => {
    const map: Record<string, Mention[]> = {};
    for (const m of mentions.results) {
      (map[m.source] ||= []).push(m);
    }
    return map;
  }, [mentions]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {Object.entries(grouped).map(([src, list]) => {
        const badge = SOURCE_BADGE[src] || { label: src.toUpperCase(), bg: "#f3f4f6", fg: "#374151" };
        const sourceTotal = mentions.source_counts?.[src] ?? list.length;
        return (
          <div key={src}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{
                fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 4,
                background: badge.bg, color: badge.fg,
              }}>{badge.label}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{sourceTotal} item{sourceTotal === 1 ? "" : "s"}</span>
            </div>
            <div style={{ display: "grid", gap: 4 }}>
              {list.slice(0, 12).map((m, mi) => (
                <a
                  key={`${m.source}:${m.source_id}:${mi}`}
                  href={m.href}
                  onClick={e => {
                    if (/^https?:\/\//i.test(m.href)) return;
                    e.preventDefault();
                    onOpenHref(m.href, m.title);
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 50px",
                    gap: 10, padding: "7px 10px", borderRadius: 6,
                    border: "1px solid var(--border)", textDecoration: "none",
                    color: "var(--text-primary)", fontSize: 12, lineHeight: 1.4,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.title}
                    </div>
                    {m.subtitle && (
                      <div style={{ color: "var(--text-muted)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.subtitle} · matched &quot;{m.matched_term}&quot;
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", fontSize: 10, color: "var(--text-muted)", alignSelf: "center" }}>
                    {m.hit_count}×
                  </div>
                </a>
              ))}
              {sourceTotal > Math.min(list.length, 12) && (
                <a href={`/umls?cui=${mentions.cui}&source=${src}`} onClick={e => { e.preventDefault(); onFilterSource(src); }} style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none", padding: "2px 6px" }}>
                  + {sourceTotal - Math.min(list.length, 12)} more
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
