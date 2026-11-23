"use client";
/**
 * /graph — Concept Walk & Causal Chain Explorer
 *
 * Mind-map view of a UMLS concept's causal / conceptual neighbourhood, built on
 * React Flow (@xyflow/react). Concentric layers (center → hop 1 → hop 2) with the
 * far ring faded back. Hover highlights a node and its links; left-click walks the
 * graph; right-click / long-press opens that concept inline below; and a masonry
 * "Across the libraries" card wall shows the concept's cross-source content.
 *
 * Hover highlighting is driven through React Context so the React Flow node/edge
 * arrays stay referentially STABLE across hovers — rebuilding them on every hover
 * churned the DOM, which caused the flicker loop and swallowed clicks.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type WheelEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { forceSimulation, forceManyBody, forceLink, forceCollide, forceRadial, forceX, forceY } from "d3-force";
import { ExternalLink, ImageOff, Loader2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import ConceptSearchBox from "@/components/common/ConceptSearchBox";
import MediaActions from "@/components/common/MediaActions";
import type { MediaDescriptor } from "@/lib/mediaInterop";

interface GraphNode { cui: string; preferred_name: string; semantic_group: string; href: string; is_center: boolean; }
interface GraphEdge { source_cui: string; target_cui: string; rela: string; label: string; }
interface GraphData { center_cui: string; nodes: GraphNode[]; edges: GraphEdge[]; }
interface Mention { source: string; source_id: string; title: string; subtitle?: string; href: string; matched_term?: string; hit_count?: number; kind?: string; }

const SEM_COLORS: Record<string, string> = {
  disease: "#ef4444", finding: "#f59e0b", pathology: "#dc2626",
  drug: "#0d9488", substance: "#8b5cf6", procedure: "#7c3aed",
  lab: "#0891b2", anatomy: "#a855f7", gene: "#0f766e",
};
const DEFAULT_COLOR = "#6366f1";
const nodeColor = (sem: string) => SEM_COLORS[(sem || "").toLowerCase()] ?? DEFAULT_COLOR;
const nodeInk = (hex: string) => {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "var(--text-primary)";
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > 0.22 ? "#06111f" : "#ffffff";
};

const RELA_COLOR: Record<string, string> = {
  causes: "#ef4444", "caused by": "#f97316", "manifests as": "#8b5cf6",
  "manifests in": "#a855f7", induces: "#f59e0b", "induced by": "#fbbf24",
  "is a": "#6b7280", "is type of": "#9ca3af", "found at": "#0891b2",
  "site of": "#06b6d4", associated: "#22c55e", "associated finding": "#4ade80",
};
const edgeColor = (label: string) => RELA_COLOR[label] ?? "#94a3b8";

const SOURCE_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  utd: { label: "UpToDate", bg: "#effaf1", fg: "#226937" },
  amboss: { label: "AMBOSS", bg: "#eaf4ff", fg: "#1e5f9f" },
  uworld: { label: "UWorld Library", bg: "#e7f6f4", fg: "#0f766e" },
  qbank: { label: "UWorld Q-Bank", bg: "#fff8dc", fg: "#7b5600" },
  books: { label: "Books", bg: "#f4ecff", fg: "#5b3aa8" },
  firstaid: { label: "First Aid", bg: "#fff0e6", fg: "#a44a16" },
  drugs: { label: "Drugs", bg: "#eef2f6", fg: "#374151" },
  diseases: { label: "Diseases", bg: "#fef2f2", fg: "#9b2c2c" },
  calc: { label: "Calculators", bg: "#edf1f7", fg: "#3b4a60" },
  anatomy: { label: "Anatomy", bg: "#ecfeff", fg: "#155e75" },
};
const SOURCE_PRIORITY = ["qbank", "uworld", "amboss", "utd", "diseases", "firstaid", "books", "drugs", "calc", "anatomy"];
const MEDIA_SOURCE_BADGE: Record<string, { label: string; bg: string; fg: string; name: string }> = {
  utd: { label: "UT", name: "UpToDate", bg: "#e8f8ef", fg: "#17633a" },
  amboss: { label: "AM", name: "AMBOSS", bg: "#eaf3ff", fg: "#185a9d" },
  uworld: { label: "UW", name: "UWorld", bg: "#e6f7f4", fg: "#0f766e" },
  qbank: { label: "QB", name: "UWorld Q-Bank", bg: "#fff4cc", fg: "#775a00" },
  books: { label: "BK", name: "Books", bg: "#f0e7ff", fg: "#5b3aa8" },
  firstaid: { label: "FA", name: "First Aid", bg: "#fff0e5", fg: "#a44a16" },
  diseases: { label: "DS", name: "Diseases", bg: "#ffe8e8", fg: "#9b2c2c" },
  drugs: { label: "RX", name: "Drugs", bg: "#eef2f6", fg: "#374151" },
  calc: { label: "CA", name: "Calculators", bg: "#edf1f7", fg: "#3b4a60" },
  anatomy: { label: "AN", name: "Anatomy", bg: "#e8fbff", fg: "#155e75" },
};

/* ── Hover context (keeps the node/edge arrays stable; only internals re-render) ── */
const HoverCtx = createContext<{ hovered: string | null; neighbours: Set<string> }>({ hovered: null, neighbours: new Set() });

type ConceptNodeData = { id: string; label: string; sub: string; color: string; isCenter: boolean; baseOpacity: number };

function ConceptNode({ data }: NodeProps) {
  const d = data as unknown as ConceptNodeData;
  const { hovered, neighbours } = useContext(HoverCtx);
  const dimmed = hovered ? !neighbours.has(d.id) : false;
  const emphasized = hovered === d.id;
  const opacity = dimmed ? 0.16 : d.baseOpacity;
  const size = d.isCenter ? { padW: 16, padH: 11, font: 13, maxW: 168 } : { padW: 12, padH: 8, font: 11.5, maxW: 150 };
  return (
    <div
      style={{
        opacity,
        transition: "opacity .16s ease, box-shadow .16s ease, transform .16s ease",
        transform: emphasized ? "scale(1.05)" : "scale(1)",
        background: d.isCenter ? d.color : "var(--bg-card, #fff)",
        color: d.isCenter ? nodeInk(d.color) : "var(--text-primary, #14201d)",
        border: `${d.isCenter ? 2.5 : 1.5}px solid ${d.color}`,
        borderRadius: 999,
        padding: `${size.padH}px ${size.padW}px`,
        fontSize: size.font,
        fontWeight: d.isCenter ? 700 : 600,
        maxWidth: size.maxW,
        textAlign: "center",
        lineHeight: 1.2,
        boxShadow: emphasized
          ? `0 0 0 4px ${d.color}33, 0 6px 18px rgba(0,0,0,0.12)`
          : d.isCenter ? "0 4px 14px rgba(0,0,0,0.12)" : "0 1px 4px rgba(0,0,0,0.06)",
        cursor: d.isCenter ? "default" : "pointer",
        userSelect: "none",
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, left: "50%", top: "50%", width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, left: "50%", top: "50%", width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0 }} />
      <div style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{d.label}</div>
      {!d.isCenter && d.sub && (
        <div style={{ fontSize: 8.5, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: d.color, marginTop: 2, opacity: 0.85 }}>{d.sub}</div>
      )}
    </div>
  );
}
const nodeTypes = { concept: ConceptNode };

function hopLevels(graph: GraphData): Map<string, number> {
  const adj = new Map<string, Set<string>>();
  for (const n of graph.nodes) adj.set(n.cui, new Set());
  for (const e of graph.edges) { adj.get(e.source_cui)?.add(e.target_cui); adj.get(e.target_cui)?.add(e.source_cui); }
  const level = new Map<string, number>();
  const center = graph.nodes.find(n => n.is_center)?.cui ?? graph.center_cui;
  const queue = [center]; level.set(center, 0);
  while (queue.length) {
    const cur = queue.shift()!; const lv = level.get(cur)!;
    for (const nb of adj.get(cur) ?? []) if (!level.has(nb)) { level.set(nb, lv + 1); queue.push(nb); }
  }
  for (const n of graph.nodes) if (!level.has(n.cui)) level.set(n.cui, 2);
  return level;
}

/* Force-directed layout: radial layers (center → ring1 → ring2) with collision
   detection so wide pill nodes never overlap. Runs synchronously (the sim is
   ticked to rest, then stopped) and returns final positions. */
function forceLayout(graph: GraphData, level: Map<string, number>, W: number, H: number): Map<string, { x: number; y: number }> {
  const cx = W / 2, cy = H / 2;
  const r1 = Math.min(W, H) * 0.34, r2 = Math.min(W, H) * 0.58;
  interface SimNode { id: string; level: number; x: number; y: number; fx?: number; fy?: number }
  const c1 = graph.nodes.filter(n => (level.get(n.cui) ?? 2) === 1).length || 1;
  const c2 = graph.nodes.filter(n => (level.get(n.cui) ?? 2) >= 2).length || 1;
  let i1 = 0, i2 = 0;
  const nodes: SimNode[] = graph.nodes.map(n => {
    const lv = Math.min(level.get(n.cui) ?? 2, 2);
    let x = cx, y = cy;
    if (lv === 1) { const a = (2 * Math.PI * i1++) / c1; x = cx + r1 * Math.cos(a); y = cy + r1 * Math.sin(a); }
    else if (lv === 2) { const a = (2 * Math.PI * i2++) / c2 + 0.4; x = cx + r2 * Math.cos(a); y = cy + r2 * Math.sin(a); }
    return { id: n.cui, level: lv, x, y };
  });
  const center = nodes.find(n => n.level === 0);
  if (center) { center.fx = cx; center.fy = cy; }
  const links = graph.edges.map(e => ({ source: e.source_cui, target: e.target_cui }));
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sim = forceSimulation(nodes as any)
    .force("charge", forceManyBody().strength(-320))
    .force("link", forceLink(links as any).id((d: any) => d.id).distance(86).strength(0.1))
    .force("collide", forceCollide().radius((d: any) => (d.level === 0 ? 92 : 80)).strength(1).iterations(3))
    .force("radial", forceRadial((d: any) => (d.level === 0 ? 0 : d.level === 1 ? r1 : r2), cx, cy).strength((d: any) => (d.level === 0 ? 1 : 0.45)))
    .force("x", forceX(cx).strength(0.012))
    .force("y", forceY(cy).strength(0.012))
    .stop();
  /* eslint-enable @typescript-eslint/no-explicit-any */
  for (let t = 0; t < 320; t++) sim.tick();
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) pos.set(n.id, { x: n.x ?? cx, y: n.y ?? cy });
  return pos;
}

/* Build stable React Flow arrays — NO hover dependency. */
function buildGraph(graph: GraphData, W: number, H: number): { nodes: RFNode[]; edges: RFEdge[] } {
  const level = hopLevels(graph);
  const pos = forceLayout(graph, level, W, H);
  const baseOpacity = (lv: number) => (lv >= 2 ? 0.6 : lv === 1 ? 0.96 : 1);
  const nodes: RFNode[] = graph.nodes.map(n => {
    const p = pos.get(n.cui) ?? { x: W / 2, y: H / 2 };
    const w = n.is_center ? 170 : 150, h = n.is_center ? 56 : 44;
    return {
      id: n.cui, type: "concept", position: { x: p.x - w / 2, y: p.y - h / 2 }, draggable: false,
      data: { id: n.cui, label: n.preferred_name, sub: n.semantic_group, color: nodeColor(n.semantic_group), isCenter: n.is_center, baseOpacity: baseOpacity(level.get(n.cui) ?? 2) } satisfies ConceptNodeData as unknown as Record<string, unknown>,
    };
  });
  const edges: RFEdge[] = graph.edges.map((e, i) => {
    const lv = Math.max(level.get(e.source_cui) ?? 1, level.get(e.target_cui) ?? 1);
    const c = edgeColor(e.label);
    return {
      id: `e${i}`, source: e.source_cui, target: e.target_cui,
      label: lv >= 2 ? undefined : e.label,
      labelStyle: { fontSize: 9, fill: c, fontWeight: 600 },
      labelBgStyle: { fill: "var(--bg-card, #fff)", fillOpacity: 0.75 },
      labelBgPadding: [3, 1] as [number, number],
      style: { stroke: c, strokeWidth: 1.4, opacity: lv >= 2 ? 0.32 : 0.62 },
    };
  });
  return { nodes, edges };
}

function useQueryParam(name: string) {
  const [v, setV] = useState("");
  useEffect(() => { setV(new URLSearchParams(window.location.search).get(name) || ""); }, [name]);
  return v;
}

export default function GraphPage() {
  const initialCui = useQueryParam("cui");
  const [currentCui, setCurrentCui] = useState("");
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walkHistory, setWalkHistory] = useState<Array<{ cui: string; name: string }>>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ cui: string; name: string } | null>(null);
  const flowWrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 900, h: 540 });

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([]);

  useEffect(() => {
    const el = flowWrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver(es => {
      const r = es[0]?.contentRect;
      if (r) setDims(prev => (Math.abs(prev.w - r.width) > 8 || Math.abs(prev.h - r.height) > 8 ? { w: Math.max(420, r.width), h: Math.max(420, r.height) } : prev));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const loadGraph = useCallback(async (cui: string, push = true) => {
    if (!cui) return;
    setLoading(true); setError(null); setOpened(null); setHovered(null);
    try {
      const res = await fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(cui)}/causal-graph?limit=18&depth=2`);
      if (!res.ok) { setError(`No concept found for CUI ${cui}`); setGraph(null); return; }
      const data: GraphData = await res.json();
      setGraph(data); setCurrentCui(cui);
      // Reflect the walk in the URL + browser history so Back/Forward work.
      if (push && typeof window !== "undefined") {
        try { window.history.pushState({ cui }, "", `/graph?cui=${cui}`); } catch { /* ignore */ }
      }
    } catch { setError("Failed to load concept graph."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (initialCui) { setCurrentCui(initialCui); void loadGraph(initialCui, false); } }, [initialCui, loadGraph]);

  // Browser Back/Forward → walk to the cui in the URL (without re-pushing).
  useEffect(() => {
    const onPop = () => {
      const cui = new URLSearchParams(window.location.search).get("cui") || "";
      if (cui) void loadGraph(cui, false);
      else { setGraph(null); setCurrentCui(""); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [loadGraph]);

  // Rebuild the React Flow arrays only when the graph or canvas size changes.
  const base = useMemo(() => (graph ? buildGraph(graph, dims.w, dims.h) : { nodes: [], edges: [] }), [graph, dims]);
  useEffect(() => { setNodes(base.nodes); setEdges(base.edges); }, [base, setNodes, setEdges]);

  const neighbours = useMemo(() => {
    const s = new Set<string>();
    if (hovered && graph) { s.add(hovered); for (const e of graph.edges) { if (e.source_cui === hovered) s.add(e.target_cui); if (e.target_cui === hovered) s.add(e.source_cui); } }
    return s;
  }, [hovered, graph]);
  const hoverValue = useMemo(() => ({ hovered, neighbours }), [hovered, neighbours]);

  const centerNode = graph?.nodes.find(n => n.is_center);

  const walkTo = useCallback((cui: string) => {
    if (!cui || cui === currentCui) return;
    if (centerNode) setWalkHistory(h => h.some(e => e.cui === centerNode.cui) ? h : [...h, { cui: centerNode.cui, name: centerNode.preferred_name }]);
    void loadGraph(cui);
  }, [centerNode, currentCui, loadGraph]);

  const layers = graph ? new Set([...hopLevels(graph).values()]).size : 0;

  return (
    <main style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg-page)", color: "var(--text-primary)", padding: "20px 24px 64px" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", width: "100%" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: "var(--mod-concepts)", marginBottom: 3 }}>CONCEPT WALK · CAUSAL EXPLORER</div>
            <h1 style={{ margin: 0, fontSize: 24, lineHeight: 1.2 }}>{centerNode?.preferred_name || "Concept Graph"}</h1>
            {centerNode && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{currentCui} · {centerNode.semantic_group}</div>}
          </div>
          <div style={{ display: "flex", minWidth: 260, flex: "0 1 360px" }}>
            <ConceptSearchBox buttonLabel="Explore" onPick={(cui) => { setWalkHistory([]); void loadGraph(cui); }} />
          </div>
        </div>

        {walkHistory.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginRight: 4 }}>Walk:</span>
            {walkHistory.map((entry, i) => (
              <button key={entry.cui} onClick={() => { setWalkHistory(h => h.slice(0, i)); void loadGraph(entry.cui); }}
                style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "var(--bg-subtle)", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={`Go back to ${entry.name}`}>{entry.name}</button>
            ))}
            <span style={{ fontSize: 9, color: "var(--text-muted)" }}>→ {centerNode?.preferred_name}</span>
          </div>
        )}

        {error && <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", color: "#b91c1c", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {loading && <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: 13 }}>Loading concept graph…</div>}

        {!loading && graph && graph.nodes.length > 1 && (
          <>
            <div ref={flowWrapRef} style={{ height: "min(62vh, 620px)", width: "100%", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)", position: "relative", overflow: "hidden" }}>
              <HoverCtx.Provider value={hoverValue}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  nodeTypes={nodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  minZoom={0.3}
                  maxZoom={2.2}
                  proOptions={{ hideAttribution: true }}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  nodesDraggable={false}
                  onNodeMouseEnter={(_, n) => setHovered(n.id)}
                  onNodeMouseLeave={() => setHovered(null)}
                  onNodeClick={(_, n) => { if (n.id !== currentCui) walkTo(n.id); }}
                  onNodeContextMenu={(e, n) => {
                    e.preventDefault();
                    const gn = graph.nodes.find(x => x.cui === n.id);
                    setOpened({ cui: n.id, name: gn?.preferred_name || n.id });
                    requestAnimationFrame(() => document.getElementById("concept-detail")?.scrollIntoView({ behavior: "smooth", block: "center" }));
                  }}
                >
                  <Background gap={20} size={1} color="var(--border)" />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </HoverCtx.Provider>
              <div style={{ position: "absolute", top: 10, right: 14, fontSize: 9, color: "var(--text-muted)", pointerEvents: "none", textAlign: "right", lineHeight: 1.5 }}>
                {graph.nodes.length - 1} relations · {layers} layers<br />
                <span style={{ opacity: 0.8 }}>left-click to walk · right-click / long-press to open below</span>
              </div>
            </div>

            {opened && <ConceptDetail key={opened.cui} cui={opened.cui} name={opened.name} onWalk={walkTo} onClose={() => setOpened(null)} />}
            {centerNode && <CardWall cui={currentCui} title={`Across the libraries · ${centerNode.preferred_name}`} />}
            {centerNode && <MediaWall key={`media-${currentCui}`} cui={currentCui} title={`Images, tables & diagrams · ${centerNode.preferred_name}`} />}
          </>
        )}

        {!loading && graph && graph.nodes.length === 1 && (
          <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
            <div>No causal or conceptual relations found for <b>{centerNode?.preferred_name}</b></div>
            {centerNode && <CardWall cui={currentCui} title={`Across the libraries · ${centerNode.preferred_name}`} />}
          </div>
        )}

        {!loading && !graph && !error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, padding: "80px 40px" }}>
            <div style={{ fontSize: 48 }}>🕸️</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Concept Walk</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 440, textAlign: "center" }}>
              Search for any medical concept to explore its causal chains, manifestations, and related conditions as a mind map — then dive into every source that covers it.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function ConceptDetail({ cui, name, onWalk, onClose }: { cui: string; name: string; onWalk: (c: string) => void; onClose: () => void }) {
  const [def, setDef] = useState<{ preferred_name?: string; semantic_group?: string; definition?: string } | null>(null);
  useEffect(() => {
    let on = true;
    fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(cui)}`).then(r => r.ok ? r.json() : null).then(d => { if (on) setDef(d); }).catch(() => {});
    return () => { on = false; };
  }, [cui]);
  return (
    <div id="concept-detail" style={{ marginTop: 18, border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)", padding: "16px 18px", scrollMarginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", color: "var(--mod-concepts)" }}>OPENED CONCEPT</div>
          <h2 style={{ margin: "2px 0 0", fontSize: 19 }}>{def?.preferred_name || name}</h2>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{cui}{def?.semantic_group ? ` · ${def.semantic_group}` : ""}</div>
        </div>
        <button onClick={() => onWalk(cui)} style={{ fontSize: 11, fontWeight: 700, padding: "5px 11px", borderRadius: 6, border: "1px solid color-mix(in srgb, var(--mod-concepts) 55%, var(--border))", background: "var(--accent-glow)", color: "var(--mod-concepts)", cursor: "pointer" }}>Center here →</button>
        <a href={`/umls?cui=${cui}`} style={{ fontSize: 11, fontWeight: 700, padding: "5px 11px", borderRadius: 6, border: "1px solid var(--border)", color: "var(--text-secondary)", textDecoration: "none" }}>Full page ↗</a>
        <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 2 }}>×</button>
      </div>
      {def?.definition && <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text-secondary)", margin: "10px 0 0", maxWidth: 820 }}>{def.definition}</p>}
      <CardWall cui={cui} title="Found in" compact />
    </div>
  );
}

function CardWall({ cui, title, compact }: { cui: string; title: string; compact?: boolean }) {
  const [mentions, setMentions] = useState<Mention[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let on = true; setMentions(null);
    fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(cui)}/mentions?per_source=${compact ? 4 : 8}&limit=300`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (on && d) { setMentions(d.results || []); setCounts(d.source_counts || {}); } })
      .catch(() => { if (on) setMentions([]); });
    return () => { on = false; };
  }, [cui, compact]);

  const grouped = useMemo(() => {
    const m: Record<string, Mention[]> = {};
    for (const it of mentions || []) {
      if (it.kind === "clinic_image" || it.kind === "uworld_table") continue; // rendered in the media wall
      (m[it.source] ||= []).push(it);
    }
    return SOURCE_PRIORITY.filter(s => m[s]?.length).map(s => [s, m[s]] as const)
      .concat(Object.entries(m).filter(([s]) => !SOURCE_PRIORITY.includes(s)));
  }, [mentions]);

  if (mentions === null) return <div style={{ padding: "18px 0", color: "var(--text-muted)", fontSize: 12 }}>Loading content…</div>;
  if (mentions.length === 0) return <div style={{ padding: "14px 0", color: "var(--text-muted)", fontSize: 12 }}>No linked content yet.</div>;

  return (
    <section style={{ marginTop: compact ? 14 : 26 }}>
      <h2 style={{ fontSize: 14, margin: "0 0 12px" }}>{title}<span style={{ color: "var(--text-muted)", fontWeight: 500 }}> · {grouped.length} source{grouped.length === 1 ? "" : "s"}</span></h2>
      <div style={{ columns: compact ? "230px" : "260px", columnGap: 14 }}>
        {grouped.flatMap(([src, items]) => {
          const badge = SOURCE_BADGE[src] || { label: src.toUpperCase(), bg: "#f3f4f6", fg: "#374151" };
          const total = counts[src] ?? items.length;
          return items.map((it, i) => (
            <a key={`${src}:${it.source_id}:${i}`} href={it.href}
              style={{ breakInside: "avoid", display: "block", marginBottom: 14, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-card)", padding: "11px 12px", textDecoration: "none", color: "var(--text-primary)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 4, background: badge.bg, color: badge.fg }}>{badge.label}</span>
                {it.kind && it.kind !== "topic" && it.kind !== "article" && (
                  <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{it.kind.replace(/_/g, " ")}</span>
                )}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>{it.title}</div>
              {it.subtitle && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.4 }}>{it.subtitle}</div>}
              {it.matched_term && <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 5 }}>matched “{it.matched_term}”{it.hit_count ? ` · ${it.hit_count}×` : ""} · {total} in {badge.label}</div>}
            </a>
          ));
        })}
      </div>
    </section>
  );
}

/* ── Media wall: actual diagram images + UWorld exhibit tables (masonry) ── */
export interface MediaItem {
  source: string;
  source_id: string;
  title: string;
  href: string;
  preview_href?: string;
  source_href?: string;
  kind: string;
  media_type: "image" | "exhibit";
}

interface UtdGraphicMeta {
  title?: string;
  caption?: string;
  legendText?: string;
  imageHtml?: string;
  graphicInfo?: { title?: string; displayName?: string };
}

function mediaBadge(source: string) {
  const key = (source || "").toLowerCase();
  return MEDIA_SOURCE_BADGE[key] || {
    label: key.slice(0, 2).toUpperCase() || "MD",
    name: source || "Media",
    bg: "#f3f4f6",
    fg: "#374151",
  };
}

function mediaUrl(base: string, href?: string) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  return `${base}${href.startsWith("/") ? "" : "/"}${href}`;
}

export function withBackendDocumentBase(raw: string, base: string) {
  let root: URL;
  try {
    root = new URL("/", base.endsWith("/") ? base : `${base}/`);
  } catch {
    return raw;
  }
  if (!/^https?:$/.test(root.protocol) || root.username || root.password) return raw;
  const escapedRoot = root.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const baseTag = `<base href="${escapedRoot}">`;
  return /<head\b[^>]*>/i.test(raw)
    ? raw.replace(/<head\b[^>]*>/i, match => `${match}${baseTag}`)
    : `${baseTag}${raw}`;
}

function mediaPreviewHref(item: MediaItem) {
  if (item.preview_href) return item.preview_href;
  if (item.source === "utd" && item.href.startsWith("/utd/graphic/")) {
    return item.href.replace("/utd/graphic/", "/utd/thumb/");
  }
  return item.href;
}

function mediaSourceHref(base: string, item: MediaItem) {
  if (item.source_href) return item.source_href;
  return mediaUrl(base, item.href);
}

function utdGraphicId(item: MediaItem) {
  const raw = item.source_id || item.href.match(/\/utd\/graphic\/(\d+)/)?.[1] || "";
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function stripUnsafeHtml(raw: string) {
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(['"]).*?\1/gi, "");
}

/* ── Media mosaic (CSS Grid, content-aware spans) ──────────────────────────
   Each card sizes itself to its content: wide tables span multiple columns
   (and scale to fit so they show in full, no scrollbar), images span by aspect.
   grid-auto-flow:dense packs them gaplessly like a jigsaw. */
const G_ROW = 8, G_GAP = 14, G_BASE = 215, G_MAXSPAN = 3;

function MediaWall({ cui, title }: { cui: string; title: string }) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [activeItem, setActiveItem] = useState<MediaItem | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState({ cols: 4, colW: G_BASE });
  useEffect(() => {
    let on = true; setItems(null);
    fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(cui)}/media?limit=120`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (on) setItems(d?.items || []); })
      .catch(() => { if (on) setItems([]); });
    return () => { on = false; };
  }, [cui]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => {
      const w = el.clientWidth; if (!w) return;
      const cols = Math.max(1, Math.floor((w + G_GAP) / (G_BASE + G_GAP)));
      const colW = (w - (cols - 1) * G_GAP) / cols;
      setGrid(p => (p.cols !== cols || Math.abs(p.colW - colW) > 1) ? { cols, colW } : p);
    };
    const ro = new ResizeObserver(update); ro.observe(el); update();
    return () => ro.disconnect();
  }, [items]);

  if (!items || items.length === 0) return null;
  const base = getBackendUrl();
  return (
    <section style={{ marginTop: 26 }}>
      <h2 style={{ fontSize: 14, margin: "0 0 12px" }}>{title}
        <span style={{ color: "var(--text-muted)", fontWeight: 500 }}> · {items.length} item{items.length === 1 ? "" : "s"}</span>
      </h2>
      <div ref={ref} style={{ display: "grid", gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridAutoRows: `${G_ROW}px`, gap: `${G_GAP}px`, gridAutoFlow: "dense" }}>
        {items.map((it, i) => <MosaicCard key={`${it.source}:${it.source_id}:${i}`} item={it} base={base} cols={grid.cols} colW={grid.colW} onOpen={setActiveItem} />)}
      </div>
      {activeItem && <GraphMediaViewer item={activeItem} base={base} onClose={() => setActiveItem(null)} />}
    </section>
  );
}

function MosaicCard({ item, base, cols, colW, onOpen }: { item: MediaItem; base: string; cols: number; colW: number; onOpen: (item: MediaItem) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [colSpan, setColSpan] = useState(item.media_type === "exhibit" ? Math.min(2, cols) : 1);
  const [rowSpan, setRowSpan] = useState(22);
  const [shown, setShown] = useState(false);
  const span = Math.min(colSpan, cols);
  const cellW = span * colW + (span - 1) * G_GAP;
  const badge = mediaBadge(item.source);

  const remeasure = useCallback(() => {
    const el = ref.current; if (!el) return;
    const h = el.getBoundingClientRect().height;
    setRowSpan(Math.max(1, Math.ceil((h + G_GAP) / (G_ROW + G_GAP))));
    setShown(true);
  }, []);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(remeasure); ro.observe(el); remeasure();
    return () => ro.disconnect();
  }, [remeasure, cellW]);

  // Decide how many columns the content wants from its natural width.
  const reqSpan = useCallback((naturalW: number) => {
    if (!naturalW || !colW) return;
    const minSpan = item.media_type === "exhibit" ? 2 : 1;
    setColSpan(Math.min(cols, G_MAXSPAN, Math.max(minSpan, Math.round(naturalW / colW))));
  }, [cols, colW, item.media_type]);

  return (
    <div style={{ gridColumn: `span ${span}`, gridRow: `span ${rowSpan}`, minWidth: 0 }}>
      <div ref={ref} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--bg-card)", opacity: shown ? 1 : 0, transition: "opacity .35s ease" }}>
        {item.media_type === "image"
          ? <ImageContent item={item} base={base} reqSpan={reqSpan} onSized={remeasure} onOpen={onOpen} />
          : <ExhibitContent item={item} base={base} cellW={cellW} reqSpan={reqSpan} onSized={remeasure} onOpen={onOpen} />}
        <div style={{ padding: "7px 10px" }}>
          <span title={badge.name} style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4, background: badge.bg, color: badge.fg }}>{badge.label}</span>
          <div style={{ fontSize: 12, marginTop: 5, lineHeight: 1.35, color: "var(--text-primary)" }}>{item.title}</div>
        </div>
      </div>
    </div>
  );
}

function ImageContent({ item, base, reqSpan, onSized, onOpen }: { item: MediaItem; base: string; reqSpan: (w: number) => void; onSized: () => void; onOpen: (item: MediaItem) => void }) {
  const primarySrc = mediaUrl(base, mediaPreviewHref(item));
  const fallbackSrc = mediaUrl(base, item.href);
  const [src, setSrc] = useState(primarySrc);
  useEffect(() => {
    setSrc(primarySrc);
  }, [primarySrc]);
  const open = () => onOpen(item);
  return (
    <div role="button" tabIndex={0} aria-label={`Open ${item.title || "media"}`} onClick={open}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      style={{ display: "block", cursor: "zoom-in", outlineOffset: -2 }}>
      <img src={src} alt={item.title}
        data-medos-media-title={item.title}
        data-medos-media-source={mediaBadge(item.source).name}
        data-medos-media-source-url={mediaUrl(base, item.href)}
        onLoad={e => { reqSpan(e.currentTarget.naturalWidth); onSized(); }}
        onError={() => { if (src !== fallbackSrc) setSrc(fallbackSrc); else onSized(); }}
        style={{ display: "block", width: "100%", height: "auto", background: "#fff" }} />
    </div>
  );
}

/* Exhibit: fetch the self-contained HTML, render via srcDoc (same-origin → we can
   read its real width/height), request enough columns, and SCALE it to fit the
   cell so the whole table shows — readable, no inner scrollbar. */
function ExhibitContent({ item, base, cellW, reqSpan, onSized, onOpen }: { item: MediaItem; base: string; cellW: number; reqSpan: (w: number) => void; onSized: () => void; onOpen: (item: MediaItem) => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const iref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let on = true;
    fetch(mediaUrl(base, item.href)).then(r => r.ok ? r.text() : null).then(t => {
      if (on && t) setHtml(withBackendDocumentBase(t, base));
    }).catch(() => {});
    return () => { on = false; };
  }, [base, item.href]);
  const measure = () => {
    try {
      const doc = iref.current?.contentDocument;
      if (doc?.body) {
        const w = Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth, 1);
        const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 1);
        setNat({ w, h }); reqSpan(w);
      }
    } catch { /* same-origin srcDoc, but guard anyway */ }
    onSized();
  };
  const scale = nat.w > 0 ? Math.min(1, cellW / nat.w) : 1;
  const open = () => onOpen(item);
  return (
    <div role="button" tabIndex={0} aria-label={`Open ${item.title || "media"}`} onClick={open}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      style={{ display: "block", position: "relative", cursor: "zoom-in", outlineOffset: -2 }}>
      <div style={{ height: nat.h ? Math.round(nat.h * scale) : 240, overflow: "hidden", background: "#fff" }}>
        {html != null && (
          <iframe ref={iref} srcDoc={html} title={item.title} onLoad={measure} scrolling="no"
            style={{ width: nat.w || cellW, height: nat.h || 240, border: 0, display: "block", background: "#fff", transform: `scale(${scale})`, transformOrigin: "top left" }} />
        )}
      </div>
    </div>
  );
}

type ViewerLoad = {
  status: "loading" | "ok" | "error";
  imageSrc?: string;
  html?: string;
  title?: string;
  caption?: string;
};

const VIEWER_MIN_ZOOM = 0.55;
const VIEWER_MAX_ZOOM = 3;
const VIEWER_ZOOM_STEP = 0.18;

function clampViewerZoom(value: number) {
  return Math.min(VIEWER_MAX_ZOOM, Math.max(VIEWER_MIN_ZOOM, Number(value.toFixed(2))));
}

export function GraphMediaViewer({ item, base, onClose }: { item: MediaItem; base: string; onClose: () => void }) {
  const [load, setLoad] = useState<ViewerLoad>({ status: "loading" });
  const [htmlTable, setHtmlTable] = useState<HTMLTableElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const badge = mediaBadge(item.source);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") setZoom(z => clampViewerZoom(z + VIEWER_ZOOM_STEP));
      if (e.key === "-" || e.key === "_") setZoom(z => clampViewerZoom(z - VIEWER_ZOOM_STEP));
      if (e.key === "0") {
        setZoom(1);
        stageRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    setLoad({ status: "loading" });
    setHtmlTable(null);
    setZoom(1);
    stageRef.current?.scrollTo({ top: 0, left: 0 });

    async function loadItem() {
      try {
        if (item.media_type === "exhibit") {
          const resp = await fetch(mediaUrl(base, item.href));
          if (!resp.ok) throw new Error("exhibit failed");
          const html = withBackendDocumentBase(await resp.text(), base);
          if (!cancelled) setLoad({ status: "ok", html, title: item.title });
          return;
        }

        const graphicId = item.source === "utd" ? utdGraphicId(item) : null;
        if (graphicId) {
          let meta: UtdGraphicMeta | null = null;
          const metaResp = await fetch(`${base}/utd/graphic/${graphicId}/meta`).catch(() => null);
          if (metaResp?.ok) meta = await metaResp.json();

          const title = meta?.title || meta?.graphicInfo?.title || meta?.graphicInfo?.displayName || item.title;
          const caption = meta?.caption || meta?.legendText;
          const imageResp = await fetch(`${base}/utd/graphic/${graphicId}`).catch(() => null);

          if (cancelled) return;
          if (imageResp?.ok) {
            const blob = await imageResp.blob();
            if (cancelled) return;
            const url = URL.createObjectURL(blob);
            objectUrls.push(url);
            if (!cancelled) setLoad({ status: "ok", imageSrc: url, title, caption });
            return;
          }

          if (meta?.imageHtml) {
            setLoad({ status: "ok", html: stripUnsafeHtml(meta.imageHtml), title, caption });
            return;
          }

          const thumbResp = await fetch(`${base}/utd/thumb/${graphicId}`).catch(() => null);
          if (cancelled) return;
          if (thumbResp?.ok) {
            const blob = await thumbResp.blob();
            if (cancelled) return;
            const url = URL.createObjectURL(blob);
            objectUrls.push(url);
            if (!cancelled) setLoad({ status: "ok", imageSrc: url, title, caption });
            return;
          }
          throw new Error("utd graphic failed");
        }

        setLoad({ status: "ok", imageSrc: mediaUrl(base, item.href), title: item.title });
      } catch {
        if (!cancelled) setLoad({ status: "error", title: item.title });
      }
    }

    void loadItem();
    return () => {
      cancelled = true;
      objectUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [base, item]);

  const title = load.title || item.title || "Media";
  const sourceHref = mediaSourceHref(base, item);
  const graphicId = item.source === "utd" ? utdGraphicId(item) : null;
  const stableMediaUrl = graphicId
    ? `${base}/utd/graphic/${graphicId}`
    : mediaUrl(base, item.href);
  const rendersHtml = Boolean(load.html);
  const mediaDescriptor = useMemo(() => graphMediaDescriptor({
    item,
    base,
    title,
    source: badge.name,
    rendersHtml,
    htmlTable,
  }), [base, badge.name, htmlTable, item, rendersHtml, title]);
  const zoomStyle = { zoom } as CSSProperties & { zoom: number };

  const captureHtmlTable = useCallback((node: HTMLDivElement | null) => {
    const table = node?.querySelector("table") || null;
    setHtmlTable(current => current === table ? current : table);
  }, []);

  function adjustZoom(delta: number) {
    setZoom(prev => clampViewerZoom(prev + delta));
  }

  function resetZoom() {
    setZoom(1);
    requestAnimationFrame(() => stageRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" }));
  }

  function onWheel(e: WheelEvent<HTMLDivElement>) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? VIEWER_ZOOM_STEP : -VIEWER_ZOOM_STEP);
  }

  function openSourceInAppTab() {
    if (!sourceHref) return;
    window.dispatchEvent(new CustomEvent("TabBar:open", {
      detail: { href: sourceHref, title },
    }));
    onClose();
  }

  return (
    <>
      <div className="graph-media-backdrop" onClick={onClose} />
      <section className="graph-media-viewer" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <header className="graph-media-viewer-header">
          <div className="graph-media-viewer-title">
            <span style={{ background: badge.bg, color: badge.fg }}>{badge.label}</span>
            <h2>{title}</h2>
          </div>
          <div className="graph-media-viewer-controls">
            <MediaActions descriptor={mediaDescriptor} compact />
            <button type="button" className="graph-media-source-link" onClick={openSourceInAppTab} title="Open source article">
              <ExternalLink size={15} />
              <span>Source</span>
            </button>
            <button type="button" onClick={() => adjustZoom(-VIEWER_ZOOM_STEP)} disabled={zoom <= VIEWER_MIN_ZOOM} title="Zoom out" aria-label="Zoom out">
              <ZoomOut size={16} />
            </button>
            <button type="button" onClick={() => adjustZoom(VIEWER_ZOOM_STEP)} disabled={zoom >= VIEWER_MAX_ZOOM} title="Zoom in" aria-label="Zoom in">
              <ZoomIn size={16} />
            </button>
            <button type="button" onClick={resetZoom} title="Reset view" aria-label="Reset view">
              <RotateCcw size={16} />
            </button>
            <button type="button" onClick={onClose} title="Close" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="graph-media-viewer-stage" ref={stageRef} onWheel={onWheel}>
          {load.status === "loading" && (
            <div className="graph-media-state">
              <Loader2 className="graph-media-spin" size={30} />
              <span>Loading visual...</span>
            </div>
          )}
          {load.status === "error" && (
            <div className="graph-media-state">
              <ImageOff size={30} />
              <span>Visual could not be loaded.</span>
            </div>
          )}
          {load.status === "ok" && load.imageSrc && (
            <figure
              className="graph-media-figure"
              style={zoomStyle}
              data-medos-media-pan-active={zoom > 1 ? "true" : undefined}
            >
              <img
                src={load.imageSrc}
                alt={title}
                draggable={zoom <= 1}
                data-medos-media-title={title}
                data-medos-media-source={badge.name}
                data-medos-media-source-url={stableMediaUrl}
                onError={() => setLoad({ status: "error", title })}
              />
              {load.caption && <figcaption>{load.caption}</figcaption>}
            </figure>
          )}
          {load.status === "ok" && load.html && (
            <div className="graph-media-html-shell" style={zoomStyle}>
              {item.media_type === "exhibit"
                ? <iframe title={title} srcDoc={load.html} />
                : <div ref={captureHtmlTable} className="graph-media-html" dangerouslySetInnerHTML={{ __html: load.html }} />}
            </div>
          )}
        </div>
      </section>

      <style>{`
        .graph-media-backdrop {
          position: fixed;
          inset: 0;
          z-index: 1000;
          background: rgba(5, 10, 22, 0.72);
          backdrop-filter: blur(2px);
        }
        .graph-media-viewer {
          position: fixed;
          inset: 18px;
          z-index: 1001;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: #f8fafc;
          border: 1px solid rgba(203, 213, 225, 0.95);
          border-radius: 10px;
          box-shadow: 0 24px 90px rgba(2, 6, 23, 0.42);
        }
        .graph-media-viewer-header {
          min-height: 58px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          padding: 10px 12px 10px 16px;
          border-bottom: 1px solid rgba(203, 213, 225, 0.92);
          background: rgba(255, 255, 255, 0.98);
        }
        .graph-media-viewer-title {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .graph-media-viewer-title span {
          flex: 0 0 auto;
          min-width: 27px;
          border-radius: 4px;
          padding: 3px 6px;
          text-align: center;
          font-size: 10px;
          font-weight: 850;
        }
        .graph-media-viewer-title h2 {
          min-width: 0;
          margin: 0;
          overflow: hidden;
          color: #0f172a;
          font-size: 15px;
          line-height: 1.25;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .graph-media-viewer-controls {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .graph-media-viewer-controls button,
        .graph-media-source-link {
          height: 32px;
          border: 1px solid #d8e2f0;
          border-radius: 7px;
          background: #fff;
          color: #172033;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          text-decoration: none;
        }
        .graph-media-viewer-controls button {
          width: 32px;
          padding: 0;
          cursor: pointer;
        }
        .graph-media-viewer-controls button:disabled {
          cursor: not-allowed;
          opacity: 0.45;
        }
        .graph-media-source-link {
          width: auto;
          padding: 0 10px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
        }
        .graph-media-viewer-stage {
          flex: 1;
          min-height: 0;
          overflow: auto;
          padding: 22px;
          background: #101827;
        }
        .graph-media-state {
          min-height: 100%;
          display: grid;
          place-content: center;
          gap: 10px;
          color: #dbe8f7;
          text-align: center;
          font-size: 13px;
        }
        .graph-media-state svg:first-child {
          justify-self: center;
        }
        .graph-media-spin {
          animation: graphMediaSpin 1s linear infinite;
        }
        .graph-media-state svg:first-child + span {
          display: block;
        }
        .graph-media-figure {
          width: max-content;
          max-width: none;
          margin: 0 auto;
          transform-origin: top center;
        }
        .graph-media-figure img {
          display: block;
          max-width: none;
          max-height: none;
          background: #fff;
          border-radius: 6px;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
        }
        .graph-media-figure figcaption {
          max-width: 900px;
          margin: 10px auto 0;
          color: #dbe8f7;
          font-size: 12px;
          line-height: 1.45;
        }
        .graph-media-html-shell {
          width: max-content;
          min-width: min(900px, 100%);
          max-width: 1200px;
          margin: 0 auto;
          transform-origin: top center;
        }
        .graph-media-html-shell iframe {
          width: min(1100px, calc(100vw - 92px));
          min-height: calc(100vh - 132px);
          border: 0;
          border-radius: 6px;
          background: #fff;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
        }
        .graph-media-html {
          color: #111827;
          background: #fff;
          border-radius: 6px;
          padding: 18px 22px;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
          font-size: 15px;
          line-height: 1.48;
        }
        .graph-media-html table {
          border-collapse: collapse;
          width: 100%;
          margin: 10px 0;
          font-size: 14px;
        }
        .graph-media-html td,
        .graph-media-html th {
          border: 1px solid #cbd5e1;
          padding: 8px 10px;
          vertical-align: top;
        }
        .graph-media-html .ttl {
          font-size: 18px;
          font-weight: 800;
          margin-bottom: 10px;
        }
        .graph-media-html .subtitle1,
        .graph-media-html .subtitle1_single {
          background: #eef5fb;
          font-weight: 800;
        }
        @keyframes graphMediaSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @media (max-width: 720px) {
          .graph-media-viewer {
            inset: 6px;
            border-radius: 8px;
          }
          .graph-media-viewer-header {
            align-items: flex-start;
            flex-direction: column;
            gap: 8px;
          }
          .graph-media-viewer-controls {
            width: 100%;
            overflow-x: auto;
          }
          .graph-media-viewer-stage {
            padding: 12px;
          }
          .graph-media-html-shell iframe {
            width: calc(100vw - 36px);
          }
        }
      `}</style>
    </>
  );
}

export function graphMediaDescriptor({
  item,
  base,
  title,
  source,
  rendersHtml,
  htmlTable,
}: {
  item: MediaItem;
  base: string;
  title: string;
  source: string;
  rendersHtml: boolean;
  htmlTable: HTMLTableElement | null;
}): Readonly<MediaDescriptor> {
  const graphicId = item.source === "utd" ? utdGraphicId(item) : null;
  const stableUrl = graphicId
    ? `${base}/utd/graphic/${graphicId}`
    : mediaUrl(base, item.href);
  if (rendersHtml) {
    const htmlUrl = graphicId ? `${stableUrl}/html` : stableUrl;
    if (htmlTable) {
      return Object.freeze({
        kind: "table",
        title,
        source,
        sourceUrl: htmlUrl,
        element: htmlTable,
      });
    }
    return Object.freeze({ kind: "document", title, source, sourceUrl: htmlUrl });
  }
  return Object.freeze({
    kind: item.media_type === "exhibit" ? "document" : "image",
    title,
    source,
    sourceUrl: stableUrl,
  });
}
