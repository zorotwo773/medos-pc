"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getBackendUrl } from "@/lib/api";
import { recordRecent } from "@/lib/useRecent";
import { useScrollRestore } from "@/lib/useScrollRestore";
import type { DrugClassArea, DrugHealth, DrugPopup, DrugProfile, DrugQuickInfo } from "@/types/drugs";
import DrugSearchBar   from "./DrugSearchBar";
import DrugResultCard  from "./DrugResultCard";
import DrugDetailModal from "./DrugDetailModal";
import DrugCompareTable from "./DrugCompareTable";
import DrugClassSidebar from "./DrugClassSidebar";
import DrugClinicalPopup from "./DrugClinicalPopup";

type View = "search" | "detail" | "compare";

export default function DrugReference() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const [dbHealth,      setDbHealth]      = useState<DrugHealth | null>(null);
  const [view,          setView]          = useState<View>("search");
  const [searchResults, setSearchResults] = useState<DrugQuickInfo[]>([]);
  const [selectedDrug,  setSelectedDrug]  = useState<DrugProfile | null>(null);
  const [selectedPopup, setSelectedPopup] = useState<DrugPopup | null>(null);
  const [compareList,   setCompareList]   = useState<DrugProfile[]>([]);
  const [loadingDrug,   setLoadingDrug]   = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [classAreas,    setClassAreas]    = useState<DrugClassArea[]>([]);
  const [classesLoading,setClassesLoading]= useState(false);
  const [selectedNodeId,setSelectedNodeId]= useState<number | null>(null);
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [resultLabel,   setResultLabel]   = useState<string | null>(null);
  const queryParam = searchParams.get("q") || "";
  const listScrollRef = useRef<HTMLDivElement>(null);
  // Restore the results-list scroll per query/class so returning to a search
  // lands where you left off.
  useScrollRestore(listScrollRef, view === "search" ? `/drugs:list:${selectedNodeId ?? selectedClass ?? queryParam}` : null);

  // ── Check DB health on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetch(`${getBackendUrl()}/drugs/health`)
      .then(r => r.json())
      .then(setDbHealth)
      .catch(() => setDbHealth({ configured: false, exists: false }));
  }, []);

  useEffect(() => {
    setClassesLoading(true);
    fetch(`${getBackendUrl()}/drugs/class-tree`)
      .then(r => r.json())
      .then(data => setClassAreas(data.available ? (data.areas || []) : []))
      .catch(() => setClassAreas([]))
      .finally(() => setClassesLoading(false));
  }, []);

  // ── Handle URL params for deep-linking ───────────────────────────────────
  useEffect(() => {
    const id = searchParams.get("id");
    if (id) {
      const drugId = parseInt(id, 10);
      if (!selectedDrug || selectedDrug.drug_id !== drugId || view !== "detail") {
        openDrug(drugId, false);
      }
      return;
    }
    const q = searchParams.get("q");
    if (q) {
      setView("search");
      setSelectedDrug(null);
      setSelectedPopup(null);
      setSelectedClass(null);
      setSelectedNodeId(null);
      setResultLabel(null);
      return;
    }
    const compare = searchParams.get("compare");
    if (compare) {
      const ids = compare.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length >= 2) Promise.all(ids.map(fetchDrugProfile)).then(profiles => {
        setCompareList(profiles.filter(Boolean) as DrugProfile[]);
        setView("compare");
      });
      return;
    }

    if (view === "detail" || view === "compare") {
      setSelectedDrug(null);
      setSelectedPopup(null);
      setView("search");
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchDrugProfile = async (drugId: number): Promise<DrugProfile | null> => {
    try {
      const res = await fetch(`${getBackendUrl()}/drugs/${drugId}`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  };

  const fetchDrugPopup = async (drugId: number): Promise<DrugPopup | null> => {
    try {
      const res = await fetch(`${getBackendUrl()}/drugs/popup/${drugId}`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  };

  const openDrug = useCallback(async (drugId: number, updateUrl = true) => {
    setLoadingDrug(true);
    setError(null);
    setSelectedPopup(null);
    try {
      const profile = await fetchDrugProfile(drugId);
      if (!profile) { setError("Drug not found"); return; }
      setSelectedDrug(profile);
      setView("detail");
      if (updateUrl) router.replace(`/drugs?id=${drugId}`, { scroll: false });
    } catch { setError("Failed to load drug"); } finally { setLoadingDrug(false); }
  }, [router]);

  const openClinicalPopup = useCallback(async (drugId: number) => {
    setLoadingDrug(true);
    setError(null);
    try {
      const popup = await fetchDrugPopup(drugId);
      if (!popup) { setError("Drug not found"); return; }
      setSelectedPopup(popup);
      recordRecent({
        tag: "DRUG",
        label: popup.drug.brand_names?.[0] || popup.drug.generic_name,
        href: `/drugs?id=${popup.drug.drug_id}`,
        source: "drugs",
        kind: "article",
        detail: popup.drug.drug_class?.[0] || popup.drug.generic_name,
      });
    } catch {
      setError("Failed to load drug");
    } finally {
      setLoadingDrug(false);
    }
  }, []);

  // Report current drug to backend so the extension syncs automatically
  useEffect(() => {
    if (!selectedDrug) return;
    const name = selectedDrug.brand_names?.[0] || selectedDrug.generic_name || "";
    if (!name) return;
    recordRecent({
      tag: "DRUG",
      label: name,
      href: `/drugs?id=${selectedDrug.drug_id}`,
      source: "drugs",
      kind: "article",
      detail: selectedDrug.drug_class?.[0] || selectedDrug.generic_name,
    });
    fetch(`${getBackendUrl()}/session/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_term: name,
        current_source: "drug",
        current_id: String(selectedDrug.drug_id),
        current_title: name,
        qbank_active: false,
      }),
    }).catch(() => {});
  }, [selectedDrug?.drug_id]);

  const addToCompare = useCallback(async (drug: DrugQuickInfo) => {
    if (compareList.some(d => d.drug_id === drug.drug_id)) {
      setCompareList(list => list.filter(d => d.drug_id !== drug.drug_id));
      return;
    }
    if (compareList.length >= 4) return;
    const profile = await fetchDrugProfile(drug.drug_id);
    if (profile) setCompareList(list => [...list, profile]);
  }, [compareList]);

  const removeFromCompare = (drugId: number) => {
    setCompareList(list => {
      const next = list.filter(d => d.drug_id !== drugId);
      if (view === "compare") {
        if (next.length >= 2) {
          router.replace(`/drugs?compare=${next.map(d => d.drug_id).join(",")}`, { scroll: false });
        } else {
          setView("search");
          router.replace("/drugs", { scroll: false });
        }
      }
      return next;
    });
  };

  const openCompare = () => {
    if (compareList.length >= 2) {
      setView("compare");
      router.replace(`/drugs?compare=${compareList.map(d => d.drug_id).join(",")}`, { scroll: false });
    }
  };

  const isInCompare = (drugId: number) => compareList.some(d => d.drug_id === drugId);

  const resetHome = useCallback(() => {
    setView("search");
    setSelectedDrug(null);
    setSelectedPopup(null);
    setSelectedClass(null);
    setSelectedNodeId(null);
    setResultLabel(null);
    setSearchResults([]);
    router.replace("/drugs", { scroll: false });
  }, [router]);

  const selectNode = useCallback(async (nodeId: number, label: string) => {
    setSelectedNodeId(nodeId);
    setSelectedClass(label);
    setSelectedPopup(null);
    setResultLabel(label);
    setError(null);
    setLoadingDrug(true);
    try {
      const res = await fetch(`${getBackendUrl()}/drugs/by-node?node_id=${nodeId}&limit=1000`);
      const data = await res.json();
      setSearchResults(data.results || []);
      setView("search");
      router.replace("/drugs", { scroll: false });
    } catch {
      setError("Failed to load medication class");
    } finally {
      setLoadingDrug(false);
    }
  }, [router]);

  const handleSearchResults = useCallback((results: DrugQuickInfo[], query: string) => {
    setSelectedClass(null);
    setSelectedNodeId(null);
    setSelectedPopup(null);
    setResultLabel(query ? `Search: ${query}` : null);
    setSearchResults(results);
    if (query) {
      router.replace(`/drugs?q=${encodeURIComponent(query)}`, { scroll: false });
    }
  }, [router]);

  // ── Not configured ────────────────────────────────────────────────────────
  if (dbHealth && !dbHealth.exists) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", height: "100%", gap: 12, padding: 32, textAlign: "center",
      }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" width="40" height="40"
             style={{ color: "var(--text-muted)", opacity: 0.4 }}>
          <rect x="3" y="10" width="18" height="11" rx="2"/>
          <path d="M8 10V6a4 4 0 0 1 8 0v4"/>
          <line x1="12" y1="14" x2="12" y2="17"/>
        </svg>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
          Drug Reference Not Built Yet
        </div>
        <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 380, lineHeight: 1.6 }}>
          Run the build pipeline to create the unified drug database:
        </div>
        <code style={{
          fontSize: 12, padding: "8px 14px", borderRadius: 6,
          background: "rgba(0,0,0,0.2)", color: "var(--text-secondary)",
          fontFamily: "monospace",
        }}>
          python scripts/build_drug_reference.py
        </code>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Use <code>--limit 50</code> for a quick 50-drug test build (~2 min)
        </div>
      </div>
    );
  }

  // ── Compare view ──────────────────────────────────────────────────────────
  if (view === "compare") {
    return (
      <DrugCompareTable
        drugs={compareList}
        onClose={resetHome}
        onRemove={removeFromCompare}
      />
    );
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  if (view === "detail" && selectedDrug) {
    return (
      <DrugDetailModal
        drug={selectedDrug}
        onClose={resetHome}
        onAddToCompare={addToCompare}
        isInCompareList={isInCompare(selectedDrug.drug_id)}
      />
    );
  }

  // ── Search view ───────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <DrugClassSidebar
        areas={classAreas}
        selectedNodeId={selectedNodeId}
        loading={classesLoading}
        onSelectNode={selectNode}
      />

      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", flex: 1, minWidth: 0 }}>
      {/* Module header */}
      <div style={{
        padding: "14px 18px 10px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18"
                 style={{ color: "var(--accent)" }}>
              <rect x="3" y="10" width="18" height="11" rx="2"/>
              <path d="M8 10V6a4 4 0 0 1 8 0v4"/>
              <line x1="12" y1="14" x2="12" y2="17"/>
            </svg>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
              <button
                type="button"
                onClick={resetHome}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  margin: 0,
                  font: "inherit",
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  cursor: "pointer",
                }}
              >
                Drug Reference
              </button>
            </h1>
            {dbHealth?.drug_count && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {dbHealth.drug_count.toLocaleString()} drugs
              </span>
            )}
          </div>
          {/* Compare button */}
          {compareList.length >= 2 && (
            <button
              onClick={openCompare}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 12px", fontSize: 12, fontWeight: 700,
                background: "var(--accent)", color: "var(--accent-ink)",
                border: "none", borderRadius: 6, cursor: "pointer",
              }}
            >
              Compare {compareList.length} drugs ▸
            </button>
          )}
        </div>

        {/* Search bar */}
        <DrugSearchBar
          onSearch={handleSearchResults}
          onOpenDrug={openClinicalPopup}
          initialQuery={queryParam}
        />

        {/* Compare staging tray */}
        {compareList.length > 0 && (
          <div style={{
            marginTop: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
          }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Comparing:</span>
            {compareList.map(d => (
              <span key={d.drug_id} style={{
                fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 12,
                background: "rgba(14,165,233,0.1)", color: "var(--accent)",
                display: "flex", alignItems: "center", gap: 4,
              }}>
                {d.generic_name}
                <button
                  onClick={() => removeFromCompare(d.drug_id)}
                  style={{ background: "none", border: "none", cursor: "pointer",
                           color: "var(--text-muted)", fontSize: 11, padding: 0, lineHeight: 1 }}
                >✕</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Loading / error states */}
      {loadingDrug && (
        <div style={{ padding: "12px 18px", fontSize: 13, color: "var(--text-muted)" }}>
          Loading drug…
        </div>
      )}
      {error && (
        <div style={{ padding: "12px 18px", fontSize: 13, color: "var(--red, #ef4444)" }}>
          {error}
        </div>
      )}

      {/* Results grid */}
      <div ref={listScrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
        {resultLabel && (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
            gap: 10,
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                Medication class
              </div>
              <div style={{
                fontSize: 14,
                fontWeight: 800,
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {resultLabel}
              </div>
            </div>
            <button
              type="button"
              onClick={resetHome}
              style={{
                flexShrink: 0,
                padding: "5px 9px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "transparent",
                color: "var(--text-muted)",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              All classes
            </button>
          </div>
        )}

        {searchResults.length === 0 && !loadingDrug && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", paddingTop: 60, gap: 10, opacity: 0.5,
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" width="36" height="36"
                 style={{ color: "var(--text-muted)" }}>
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Search for a drug by generic name, brand name, or class
            </div>
          </div>
        )}

        {searchResults.length > 0 && (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 10,
          }}>
            {searchResults.map(drug => (
              <DrugResultCard
                key={drug.drug_id}
                drug={drug}
                onOpen={() => openClinicalPopup(drug.drug_id)}
                onAddToCompare={() => addToCompare(drug)}
                isInCompareList={isInCompare(drug.drug_id)}
              />
            ))}
          </div>
        )}
      </div>
      {selectedPopup && (
        <DrugClinicalPopup
          popup={selectedPopup}
          onClose={() => setSelectedPopup(null)}
          onOpenFull={(drugId) => openDrug(drugId)}
          onAddToCompare={addToCompare}
          isInCompareList={isInCompare(selectedPopup.drug.drug_id)}
        />
      )}
      </div>
    </div>
  );
}
