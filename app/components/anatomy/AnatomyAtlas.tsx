"use client";
import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { LAYERS, type MeshInfo, type HighlightState, type CrossSection } from "./Viewer3D";
import StructurePanel from "./StructurePanel";
import OrthoPanel from "./OrthoPanel";
import BonePanel from "./BonePanel";
import DiseaseDetailModal from "./DiseaseDetailModal";
import type { Disease } from "@/types/medical";
import { Eye, EyeOff, RotateCcw, Search, ChevronDown, ChevronRight, Focus, Scissors } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { getRegionForMesh } from "./orthoMeshMap";
import { recordRecent } from "@/lib/useRecent";
import { useBoneConfig } from "./boneRegistry";

const Viewer3D = dynamic(() => import("./Viewer3D"), {
  ssr: false,
  loading: () => (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-base)" }}>
      <div style={{ textAlign: "center" }}>
        <div className="loader" style={{ width: 32, height: 32, margin: "0 auto 12px" }} />
        <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>Initialising 3D engine…</p>
      </div>
    </div>
  ),
});

const CAM_VIEWS = [
  { id: "anterior",  label: "Ant" },
  { id: "posterior", label: "Post" },
  { id: "left",      label: "L" },
  { id: "right",     label: "R" },
  { id: "superior",  label: "Top" },
  { id: "inferior",  label: "Bot" },
];

const DEFAULT_CROSS: CrossSection = { enabled: false, axis: "y", position: 0.85, flip: false };
const SYSTEM_LAYER_PRESETS: Record<string, string[]> = {
  cardiovascular: ["cardiovascular"],
  cardio: ["cardiovascular"],
  nervous: ["nervous"],
  neuro: ["nervous"],
  respiratory: ["visceral"],
  pulmonary: ["visceral"],
  musculoskeletal: ["skeletal", "muscular", "joints"],
  msk: ["skeletal", "muscular", "joints"],
  skeletal: ["skeletal"],
  muscular: ["muscular"],
  visceral: ["visceral"],
  lymphatic: ["lymphoid"],
  lymphoid: ["lymphoid"],
  immune: ["lymphoid"],
};

export default function AnatomyAtlas() {
  const searchParams = useSearchParams();
  const [visibleLayers, setVisibleLayers] = useState<Set<string>>(
    new Set(["skeletal", "cardiovascular", "visceral"])
  );
  const [selectedMesh, setSelectedMesh] = useState<string | null>(null);
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [selectedDisease, setSelectedDisease] = useState<Disease | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightState, setHighlightState] = useState<HighlightState | null>(null);
  const [crossSection, setCrossSection] = useState<CrossSection>(DEFAULT_CROSS);
  const [showCutPanel, setShowCutPanel] = useState(false);

  const [meshRegistry, setMeshRegistry] = useState<Record<string, MeshInfo[]>>({});
  const [hiddenMeshes, setHiddenMeshes] = useState<Set<string>>(new Set());
  const [expandedLayers, setExpandedLayers] = useState<Record<string, boolean>>({});
  const [meshFilter, setMeshFilter] = useState<Record<string, string>>({});
  const [cameraPreset, setCameraPreset] = useState<string | null>(null);
  const [focusMesh, setFocusMesh] = useState<{ name: string; seq: number } | null>(null);
  const [resetSeq, setResetSeq] = useState(0);
  const [structureSearch, setStructureSearch] = useState("");
  const [orthoMode, setOrthoMode] = useState(false);
  const [orthoFullscreen, setOrthoFullscreen] = useState(false);
  const [boneOnlyMode, setBoneOnlyMode] = useState(false);
  const [orthoSlug, setOrthoSlug] = useState<string | undefined>();
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false);
  const [mobileRightOpen, setMobileRightOpen] = useState(false);
  const ORTHO_LAYERS = new Set(["skeletal", "joints"]);
  const ORTHO_BONE_ONLY_LAYERS = new Set(["skeletal"]);

  useEffect(() => {
    fetch("/cliniccons_disease_database.json")
      .then(r => r.json())
      .then(d => setDiseases(Array.isArray(d) ? d : d.diseases || []))
      .catch(console.error);
  }, []);

  // Rehydrate orthoMode from localStorage on mount
  useEffect(() => {
    try {
      if (localStorage.getItem("medos.orthoMode") === "1") setOrthoMode(true);
    } catch { /* ignore */ }
  }, []);

  // Persist orthoMode to localStorage
  useEffect(() => {
    try { localStorage.setItem("medos.orthoMode", orthoMode ? "1" : "0"); } catch { /* ignore */ }
  }, [orthoMode]);

  useEffect(() => {
    const structure = searchParams.get("structure");
    const disease = searchParams.get("search");
    const ortho = searchParams.get("ortho");
    const slug = searchParams.get("slug");
    const system = searchParams.get("system");
    if (structure) setStructureSearch(structure);
    if (disease) handleSearch(disease);
    if (system) {
      const key = system.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const layers = SYSTEM_LAYER_PRESETS[key];
      if (layers) {
        setOrthoMode(false);
        setOrthoFullscreen(false);
        setBoneOnlyMode(false);
        setSelectedMesh(null);
        setHiddenMeshes(new Set());
        setVisibleLayers(new Set(layers));
        setExpandedLayers(Object.fromEntries(layers.map(layer => [layer, true])));
      }
    }
    if (ortho === "1") { setOrthoMode(true); setBoneOnlyMode(true); if (slug) setOrthoSlug(slug); }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelect = useCallback((cleanedName: string) => {
    setSelectedMesh(cleanedName);
    setMobileRightOpen(true);
    recordRecent({
      tag: orthoMode ? "ORTHO" : "ANAT",
      label: orthoMode ? `Ortho: ${cleanedName}` : cleanedName,
      href: orthoMode
        ? `/anatomy?ortho=1&structure=${encodeURIComponent(cleanedName)}`
        : `/anatomy?structure=${encodeURIComponent(cleanedName)}`,
      source: orthoMode ? "ortho" : "anatomy",
      kind: "anatomy",
    });
    if (orthoMode) {
      getRegionForMesh(cleanedName).then(slugs => {
        if (slugs.length) setOrthoSlug(slugs[0]);
      });
    }
  }, [orthoMode]);

  const handleMeshesLoaded = useCallback((layerId: string, meshes: MeshInfo[]) => {
    setMeshRegistry(prev => ({ ...prev, [layerId]: meshes }));
  }, []);

  const toggleLayer = (id: string) => {
    setVisibleLayers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMesh = (cn: string) => {
    setHiddenMeshes(prev => {
      const next = new Set(prev);
      if (next.has(cn)) next.delete(cn);
      else next.add(cn);
      return next;
    });
  };

  const handleFocusMesh = (name: string) => {
    setFocusMesh(prev => ({ name, seq: (prev?.seq ?? 0) + 1 }));
  };

  const handleCameraPreset = (id: string) => {
    setCameraPreset(id);
    setTimeout(() => setCameraPreset(null), 100);
  };

  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (!q.trim()) { setHighlightState(null); return; }
    const matches = diseases.filter(d => d.disease_name.toLowerCase().includes(q.toLowerCase()));
    if (matches.length === 0) { setHighlightState(null); return; }
    const primary = matches[0].primary_organ;
    setHighlightState({ primaryOrgan: primary, secondaryOrgans: [] });
  };

  const handleReset = () => {
    setResetSeq(s => s + 1);
    setSelectedMesh(null);
    setHighlightState(null);
    setSearchQuery("");
    setStructureSearch("");
    setHiddenMeshes(new Set());
    setVisibleLayers(new Set(["skeletal", "cardiovascular", "visceral"]));
    setCrossSection(DEFAULT_CROSS);
    setOrthoMode(false);
    setOrthoFullscreen(false);
    setBoneOnlyMode(false);
    setOrthoSlug(undefined);
  };

  const handleOrthoToggle = () => {
    setOrthoMode(p => {
      const next = !p;
      if (next) setBoneOnlyMode(true);
      if (next) setMobileRightOpen(true);
      if (!next) setOrthoFullscreen(false);
      return next;
    });
  };

  const activeBone = useBoneConfig(selectedMesh, orthoSlug);
  const activeVisibleLayers = orthoMode
    ? new Set(boneOnlyMode ? ORTHO_BONE_ONLY_LAYERS : ORTHO_LAYERS)
    : visibleLayers;
  const viewerModeKey = orthoMode
    ? (boneOnlyMode ? "ortho-bone-only" : "ortho-with-joints")
    : "standard";

  return (
    <div className="anatomy-atlas-shell" style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

      {/* ── Top bar ── */}
      <div className="anatomy-toolbar" style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "7px 14px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-card)", flexShrink: 0, flexWrap: "wrap",
      }}>
        <div className="anatomy-mobile-panel-toggles">
          <button type="button" onClick={() => setMobileLeftOpen(v => !v)} aria-label={mobileLeftOpen ? "Hide anatomy layers" : "Show anatomy layers"}>
            {mobileLeftOpen ? "Hide layers" : "Layers"}
          </button>
          <button type="button" onClick={() => setMobileRightOpen(v => !v)} disabled={!selectedMesh && !orthoMode} aria-label={mobileRightOpen ? "Hide anatomy information" : "Show anatomy information"}>
            {mobileRightOpen ? "Hide info" : "Info"}
          </button>
        </div>

        {/* Camera view buttons */}
        <div style={{ display: "flex", gap: 3 }}>
          {CAM_VIEWS.map(v => (
            <button key={v.id} onClick={() => handleCameraPreset(v.id)} aria-label={`Set ${v.id} camera view`} title={`${v.id} camera view`} style={{
              padding: "4px 9px", fontSize: 11, fontWeight: 600,
              background: "var(--bg-base)", border: "1px solid var(--border)",
              borderRadius: 5, cursor: "pointer", color: "var(--text-secondary)",
            }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)"}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"}
            >{v.label}</button>
          ))}
        </div>

        <div style={{ width: 1, height: 20, background: "var(--border)", marginInline: 4 }} />

        {/* Structure search */}
        <div style={{ position: "relative", flex: 1, maxWidth: 220 }}>
          <Search size={11} color="var(--text-muted)" style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)" }} />
          <input
            value={structureSearch}
            onChange={e => setStructureSearch(e.target.value)}
            placeholder="Search structures…"
            style={{ width: "100%", padding: "5px 8px 5px 24px", fontSize: 11 }}
          />
        </div>

        {/* Disease highlight search */}
        <div style={{ position: "relative", flex: 1, maxWidth: 220 }}>
          <Search size={11} color="#f87171" style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)" }} />
          <input
            value={searchQuery}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Highlight by disease…"
            style={{ width: "100%", padding: "5px 8px 5px 24px", fontSize: 11 }}
          />
        </div>

        {/* Ortho Mode toggle */}
        <button
          onClick={handleOrthoToggle}
          aria-label={orthoMode ? "Disable ortho mode" : "Enable ortho mode"}
          title="Ortho Mode — skeletal + joints only, with AO Surgery Reference panel"
          style={{
            display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
            fontSize: 11, cursor: "pointer", borderRadius: 5,
            background: orthoMode ? "rgba(56,161,105,0.15)" : "var(--bg-base)",
            border: orthoMode ? "1px solid #38a169" : "1px solid var(--border)",
            color: orthoMode ? "#38a169" : "var(--text-secondary)",
            fontWeight: orthoMode ? 700 : 400,
          }}
        >
          🦴 Ortho
        </button>

        {/* Bone Only toggle — hides joint and attachment overlays for clean bone selection */}
        <button
          onClick={() => setBoneOnlyMode(p => !p)}
          aria-label={boneOnlyMode ? "Disable bone-only mode" : "Enable bone-only mode"}
          title="Bone Only — hide joint and attachment overlays for clean bone selection"
          style={{
            display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
            fontSize: 11, cursor: "pointer", borderRadius: 5,
            background: boneOnlyMode ? "rgba(245,158,11,0.15)" : "var(--bg-base)",
            border: boneOnlyMode ? "1px solid #f59e0b" : "1px solid var(--border)",
            color: boneOnlyMode ? "#d97706" : "var(--text-secondary)",
            fontWeight: boneOnlyMode ? 700 : 400,
          }}
        >
          🦷 Bone Only
        </button>

        {/* Cut / cross-section toggle */}
        <button
          onClick={() => setShowCutPanel(p => !p)}
          aria-label={showCutPanel ? "Hide cross-section controls" : "Show cross-section controls"}
          title={showCutPanel ? "Hide cross-section controls" : "Show cross-section controls"}
          style={{
            display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
            fontSize: 11, cursor: "pointer", borderRadius: 5,
            background: crossSection.enabled ? "rgba(49,130,206,0.15)" : "var(--bg-base)",
            border: crossSection.enabled ? "1px solid #3182ce" : "1px solid var(--border)",
            color: crossSection.enabled ? "#3182ce" : "var(--text-secondary)",
          }}
        >
          <Scissors size={11} /> Cut
        </button>

        <button onClick={handleReset} aria-label="Reset anatomy atlas view" title="Reset anatomy atlas view" style={{
          display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
          fontSize: 11, background: "var(--bg-base)", border: "1px solid var(--border)",
          borderRadius: 5, cursor: "pointer", color: "var(--text-secondary)",
        }}>
          <RotateCcw size={11} /> Reset
        </button>
      </div>

      {/* ── Cross-section panel ── */}
      {showCutPanel && (
        <div style={{
          padding: "8px 14px", borderBottom: "1px solid var(--border)",
          background: "var(--bg-card)", display: "flex", alignItems: "center", gap: 14, flexShrink: 0,
        }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
            <input
              type="checkbox"
              checked={crossSection.enabled}
              onChange={e => setCrossSection(p => ({ ...p, enabled: e.target.checked }))}
            />
            Enable
          </label>

          {/* Axis selector */}
          <div style={{ display: "flex", gap: 4 }}>
            {(["x", "y", "z"] as const).map(ax => (
              <button key={ax} onClick={() => setCrossSection(p => ({ ...p, axis: ax, enabled: true }))} aria-label={`Cut along ${ax.toUpperCase()} axis`} title={`Cut along ${ax.toUpperCase()} axis`}
                style={{
                  padding: "3px 9px", fontSize: 11, fontWeight: 700, borderRadius: 4, cursor: "pointer",
                  background: crossSection.axis === ax ? "#3182ce" : "var(--bg-base)",
                  color: crossSection.axis === ax ? "#fff" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >{ax.toUpperCase()}</button>
            ))}
          </div>

          {/* Position slider */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, maxWidth: 240 }}>
            <span style={{ fontSize: 10, color: "var(--text-muted)", minWidth: 32 }}>Pos</span>
            <input
              aria-label="Cross-section position"
              type="range" min={-2} max={3} step={0.01}
              value={crossSection.position}
              onChange={e => setCrossSection(p => ({ ...p, position: parseFloat(e.target.value), enabled: true }))}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)", minWidth: 32 }}>{crossSection.position.toFixed(2)}</span>
          </div>

          {/* Flip */}
          <button
            onClick={() => setCrossSection(p => ({ ...p, flip: !p.flip, enabled: true }))}
            aria-label="Flip cross-section side"
            title="Flip cross-section side"
            style={{
              padding: "3px 9px", fontSize: 11, borderRadius: 4, cursor: "pointer",
              background: crossSection.flip ? "#3182ce" : "var(--bg-base)",
              color: crossSection.flip ? "#fff" : "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
          >Flip</button>
        </div>
      )}

      {/* ── Body ── */}
      <div className="anatomy-workspace" style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Left: Layer + mesh controls */}
        <div className={`anatomy-left-panel ${mobileLeftOpen ? "is-open" : ""}`} style={{
          width: 210, borderRight: "1px solid var(--border)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-sidebar)", flexShrink: 0, overflow: "hidden",
        }}>
          <div style={{ padding: "10px 12px 8px", borderBottom: "1px solid var(--border)" }}>
            <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.7px" }}>
              Anatomical Systems
            </p>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: "6px 8px" }}>
            {orthoMode && (
              <div style={{
                padding: "5px 8px", marginBottom: 6, borderRadius: 4,
                background: "rgba(56,161,105,0.1)", border: "1px solid rgba(56,161,105,0.25)",
                fontSize: 9, color: "#38a169", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em",
              }}>
                Ortho Mode — other systems hidden
              </div>
            )}
            {LAYERS.map(layer => {
              const on = activeVisibleLayers.has(layer.id);
              const locked = orthoMode && (boneOnlyMode ? layer.id !== "skeletal" : !ORTHO_LAYERS.has(layer.id));
              const meshes = meshRegistry[layer.id] ?? [];
              const isExp = !!expandedLayers[layer.id];
              const filter = meshFilter[layer.id] ?? "";
              const visibleMeshes = filter
                ? meshes.filter(m => m.cleanName.toLowerCase().includes(filter.toLowerCase()))
                : meshes;
              const filteredBySearch = structureSearch
                ? visibleMeshes.filter(m => m.cleanName.toLowerCase().includes(structureSearch.toLowerCase()))
                : visibleMeshes;

              return (
                <div key={layer.id} style={{ marginBottom: 2, opacity: locked ? 0.4 : 1 }}>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "7px 8px", borderRadius: 6,
                    background: on ? `${layer.color}14` : "transparent",
                    outline: on ? `1px solid ${layer.color}30` : "none",
                    pointerEvents: locked ? "none" : "auto",
                    cursor: locked ? "not-allowed" : "pointer",
                  }}>
                    <div style={{
                      width: 7, height: 7, borderRadius: "50%",
                      background: on ? layer.color : "var(--border)",
                      boxShadow: on ? `0 0 5px ${layer.color}` : "none", flexShrink: 0,
                    }} />
                    <button
                      type="button"
                      onClick={() => toggleLayer(layer.id)}
                      aria-label={`${on ? "Hide" : "Show"} ${layer.label} layer`}
                      style={{ fontSize: 12, color: on ? "var(--text-primary)" : "var(--text-muted)", flex: 1, cursor: "pointer", userSelect: "none", background: "none", border: "none", padding: 0, textAlign: "left" }}
                    >{layer.label}</button>
                    {on && meshes.length > 0 && (
                      <button onClick={() => setExpandedLayers(p => ({ ...p, [layer.id]: !p[layer.id] }))} aria-label={`${isExp ? "Collapse" : "Expand"} ${layer.label} structures`} title={`${isExp ? "Collapse" : "Expand"} ${layer.label} structures`}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}>
                        {isExp ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    )}
                    <button onClick={() => toggleLayer(layer.id)} aria-label={`${on ? "Hide" : "Show"} ${layer.label} layer`} title={`${on ? "Hide" : "Show"} ${layer.label} layer`}
                      style={{ background: "none", border: "none", cursor: "pointer", color: on ? layer.color : "var(--text-muted)", padding: 0, display: "flex" }}>
                      {on ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>
                  </div>

                  {on && isExp && meshes.length > 0 && (
                    <div style={{ marginLeft: 14, marginTop: 2, marginBottom: 4 }}>
                      {meshes.length > 8 && (
                        <div style={{ position: "relative", marginBottom: 4 }}>
                          <input
                            value={filter}
                            onChange={e => setMeshFilter(p => ({ ...p, [layer.id]: e.target.value }))}
                            placeholder="Filter…"
                            style={{ width: "100%", padding: "4px 6px", fontSize: 10 }}
                          />
                        </div>
                      )}
                      {filteredBySearch.length === 0 && (
                        <p style={{ fontSize: 10, color: "var(--text-muted)", padding: "3px 6px" }}>No match</p>
                      )}
                      {filteredBySearch.map(mesh => {
                        const hidden = hiddenMeshes.has(mesh.cleanName);
                        return (
                          <div key={mesh.name} style={{
                            display: "flex", alignItems: "center", gap: 4,
                            padding: "3px 6px", borderRadius: 4,
                            background: hidden ? "rgba(239,68,68,0.06)" : "transparent",
                            opacity: hidden ? 0.5 : 1,
                          }}>
                            <span style={{ fontSize: 10, color: "var(--text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              title={mesh.cleanName}>{mesh.cleanName}</span>
                            <button onClick={() => toggleMesh(mesh.cleanName)}
                              aria-label={`${hidden ? "Show" : "Hide"} ${mesh.cleanName}`}
                              title={hidden ? "Show" : "Hide"}
                              style={{ background: "none", border: "none", cursor: "pointer", color: hidden ? "#f87171" : "var(--text-muted)", padding: 0, display: "flex" }}>
                              {hidden ? <EyeOff size={10} /> : <Eye size={10} />}
                            </button>
                            <button onClick={() => handleFocusMesh(mesh.name)}
                              aria-label={`Focus camera on ${mesh.cleanName}`}
                              title="Focus camera"
                              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}>
                              <Focus size={10} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Centre: 3D canvas */}
        <div
          className="anatomy-stage"
          style={{
            flex: 1,
            display: orthoFullscreen ? "none" : undefined,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {highlightState && (
            <div style={{
              position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
              background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 20, padding: "4px 12px", fontSize: 11, color: "#f87171",
              zIndex: 10, whiteSpace: "nowrap",
            }}>
              {searchQuery} — <span style={{ color: "#ef4444", fontWeight: 700 }}>{highlightState.primaryOrgan}</span>
              {highlightState.secondaryOrgans.length > 0 &&
                ` + ${highlightState.secondaryOrgans.slice(0, 2).join(", ")}${highlightState.secondaryOrgans.length > 2 ? ` +${highlightState.secondaryOrgans.length - 2}` : ""}`}
            </div>
          )}

          <Viewer3D
            key={viewerModeKey}
            visibleLayers={activeVisibleLayers}
            selectedName={selectedMesh}
            onSelect={handleSelect}
            highlightState={highlightState}
            hiddenMeshes={hiddenMeshes}
            onMeshesLoaded={handleMeshesLoaded}
            cameraPreset={cameraPreset}
            focusMesh={focusMesh}
            resetSeq={resetSeq}
            crossSection={crossSection}
            selectableLayers={orthoMode ? new Set(["skeletal"]) : undefined}
            boneOnlyMode={orthoMode || boneOnlyMode}
          />
        </div>

        {/* Right: Structure panel / Ortho panel / Humerus panel */}
        {(orthoMode || selectedMesh) && (
          <div
            className={`anatomy-right-panel ${mobileRightOpen ? "is-open" : ""}`}
            style={{ width: orthoFullscreen ? "100%" : orthoMode ? 420 : 320 }}
          >
            {orthoMode ? (
              activeBone ? (
                <BonePanel
                  boneName={activeBone.boneKey}
                  displayName={activeBone.displayName}
                  BoneSVG={activeBone.BoneSVG}
                  focusMeshHint={activeBone.focusMeshHint}
                  onFocusSegment={handleFocusMesh}
                  onClose={() => { setOrthoMode(false); setOrthoFullscreen(false); setMobileRightOpen(false); }}
                  fullscreen={orthoFullscreen}
                  onFullscreen={() => setOrthoFullscreen(true)}
                  onExitFullscreen={() => setOrthoFullscreen(false)}
                />
              ) : (
                <OrthoPanel
                  initialSlug={orthoSlug}
                  selectedMesh={selectedMesh}
                  onFocusMesh={handleFocusMesh}
                  onClose={() => { setOrthoMode(false); setOrthoFullscreen(false); setMobileRightOpen(false); }}
                  fullscreen={orthoFullscreen}
                  onFullscreen={() => setOrthoFullscreen(true)}
                  onExitFullscreen={() => setOrthoFullscreen(false)}
                />
              )
            ) : selectedMesh ? (
              <StructurePanel
                meshName={selectedMesh}
                diseases={diseases}
                onClose={() => { setSelectedMesh(null); setMobileRightOpen(false); }}
                onSelectDisease={d => setSelectedDisease(d)}
              />
            ) : null}
          </div>
        )}
      </div>

      {selectedDisease && (
        <DiseaseDetailModal disease={selectedDisease} onClose={() => setSelectedDisease(null)} />
      )}
    </div>
  );
}
