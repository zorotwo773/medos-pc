"use client";
/* PathwayPlayer — loads one pathway graph, hosts the Interactive Algorithm view
   (Flowchart + Panel), and mounts the shared resource overlay. */

import { useEffect, useState, useCallback } from "react";
import { getBackendUrl } from "@/lib/api";
import { recordRecent } from "@/lib/useRecent";
import type { PathwayDetail, PathwayResource } from "@/lib/pathways/types";
import { specialtyVisual, resourceAction } from "@/lib/pathways/resources";
import { M, Pill } from "./ui";
import { useResourceOverlays } from "./Teaching";
import PathwayFlow from "./PathwayFlow";
import PathwayPanel from "./PathwayPanel";
import { GripVertical, PanelRightOpen, BookOpen, X, ExternalLink } from "lucide-react";

export default function PathwayPlayer({ pathwayId, onBack }: { pathwayId: number; onBack: () => void }) {
  const [detail, setDetail] = useState<PathwayDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [toolOpen, setToolOpen] = useState(false);
  const [toolWidth, setToolWidth] = useState(400);
  const [flowWidth, setFlowWidth] = useState(55); // percentage width for flowchart
  const [articleResource, setArticleResource] = useState<PathwayResource | null>(null);

  const { openResource, overlay } = useResourceOverlays();

  // The active path through the decision tree
  const [path, setPath] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    setDetail(null); setErr(null); setPath([]);
    (async () => {
      try {
        const r = await fetch(`${getBackendUrl()}/pathways/${pathwayId}`);
        if (!r.ok) throw new Error(`pathway ${r.status}`);
        const d: PathwayDetail = await r.json();
        if (!alive) return;
        setDetail(d);
        setPath([d.graph.rootId]);
        recordRecent({ tag: "Pathway", label: d.meta.title, href: `/pathways?p=${pathwayId}` });
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "failed to load");
      }
    })();
    return () => { alive = false; };
  }, [pathwayId]);

  const handleResourceClick = useCallback((r: PathwayResource | undefined) => {
    if (!r) return;
    const act = resourceAction(r);
    if ((act.kind === "route" && r.type !== "pathway") || act.kind === "external") {
      setArticleResource(r);
      setToolOpen(true);
    } else {
      openResource(r);
    }
  }, [openResource]);

  const resizeTool = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = toolWidth;
    const onMove = (me: PointerEvent) => {
      let w = startW - (me.clientX - startX);
      if (w < 300) w = 300;
      if (w > window.innerWidth * 0.6) w = window.innerWidth * 0.6;
      setToolWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [toolWidth]);

  const resizeFlow = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startPct = flowWidth;
    const container = (e.target as HTMLElement).closest("main");
    const containerWidth = container ? container.getBoundingClientRect().width : window.innerWidth;

    const onMove = (me: PointerEvent) => {
      const deltaPx = me.clientX - startX;
      const deltaPct = (deltaPx / containerWidth) * 100;
      let w = startPct + deltaPct;
      if (w < 20) w = 20;
      if (w > 80) w = 80;
      setFlowWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [flowWidth]);

  if (err) return <div style={{ padding: 30, color: "var(--red)" }}>Could not load this pathway: {err}</div>;
  if (!detail || path.length === 0) return (
    <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)" }}>
      <M name="progress_activity" size={28} /><div style={{ marginTop: 10 }}>Loading pathway…</div>
    </div>
  );

  const { meta, graph } = detail;
  const vis = specialtyVisual(meta.specialty);
  const accent = vis.color;

  const handleChoose = (to: string) => {
    setPath((p) => [...p, to]);
  };

  const handleJump = (id: string) => {
    const i = path.indexOf(id);
    if (i >= 0) setPath(path.slice(0, i + 1));
  };

  return (
    <>
      <div className={`qbank-tutor-layout ${toolOpen ? "has-tool" : "is-rail"}`} style={{ display: "grid", gridTemplateColumns: toolOpen ? `minmax(0, 1fr) ${toolWidth}px` : "minmax(0, 1fr) 48px", height: "100%", minHeight: 0 }}>

      <main style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
        {/* Header */}
        <div style={{ padding: "14px 22px 12px", borderBottom: "1px solid var(--border)", background: "var(--chrome-bg)" }}>
          <button type="button" onClick={onBack} className="pw-btn" style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", padding: 0, marginBottom: 8 }}>
            <M name="arrow_back" size={15} /> All pathways
          </button>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
            <span style={{ width: 40, height: 40, borderRadius: 11, overflow: "hidden", display: "inline-flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${accent} 15%, var(--bg-card))`, color: accent, flexShrink: 0 }}>
              <M name={vis.glyph} size={23} fill />
            </span>
            <div style={{ flex: 1, minWidth: 220 }}>
              <h1 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 21, fontWeight: 640, lineHeight: 1.2, color: "var(--text-primary)" }}>{meta.title}</h1>
              <div style={{ display: "flex", gap: 8, marginTop: 7, flexWrap: "wrap" }}>
                {meta.specialty && <Pill icon={vis.glyph} color={accent}>{meta.specialty}</Pill>}
                <Pill icon="help">{meta.num_decisions} decisions</Pill>
                <Pill icon="flag">{meta.num_outcomes} outcomes</Pill>
                <Pill icon="timer">~{meta.est_minutes} min</Pill>
              </div>
            </div>
          </div>
        </div>

        {/* Body: Split View */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* Left: Flowchart */}
          <div style={{ flex: `0 0 ${flowWidth}%`, minWidth: 0, position: "relative" }}>
            <PathwayFlow
              graph={graph}
              path={path}
              accent={accent}
              onNodeClick={handleJump}
            />
          </div>

          {/* Center Resizer */}
          <div
            onPointerDown={resizeFlow}
            style={{
              width: 6,
              background: "var(--border)",
              cursor: "col-resize",
              zIndex: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 0.15s"
            }}
            onMouseEnter={e => (e.currentTarget.style.background = accent)}
            onMouseLeave={e => (e.currentTarget.style.background = "var(--border)")}
          >
            <div style={{ width: 2, height: 20, background: "var(--bg-base)", borderRadius: 2 }} />
          </div>

          {/* Right: Q&A Panel */}
          <div style={{ flex: "1 1 0%", minWidth: 0, background: "var(--bg-base)", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>
              <PathwayPanel
                graph={graph}
                path={path}
                accent={accent}
                resources={graph.resources}
                openResource={handleResourceClick}
                onChoose={handleChoose}
                onJump={handleJump}
              />
            </div>
          </div>
        </div>
      </main>

        <aside className="qbank-tool-shell qbank-tool-shell-article">
          {toolOpen ? (
            <>
              <div className="qbank-tool-resizer" onPointerDown={resizeTool} title="Drag to resize sidebar">
                <GripVertical size={16} />
              </div>
              <div className="qbank-tool-header">
                <button className="btn-ghost" onClick={() => setToolOpen(false)} title="Collapse panel" style={{ padding: 6 }}><PanelRightOpen size={15} /></button>
                <button className="btn-primary" title="Article viewer"><BookOpen size={14} /></button>
              </div>
              <div className="qbank-tool-body qbank-tool-body-article">
                {articleResource ? (
                  <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                    <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
                      <span className={`qbank-article-source is-${articleResource.type}`} style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".04em" }}>
                        {articleResource.type === "topic" ? "UpToDate" : articleResource.type === "drug" ? "Lexicomp" : "REF"}
                      </span>
                      <h4 style={{ margin: 0, flex: 1, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {articleResource.label}
                      </h4>
                      <a href={articleResource.route || ""} target="_blank" rel="noreferrer" className="btn-ghost" title="Open in new tab" style={{ padding: 6 }}>
                        <ExternalLink size={14} />
                      </a>
                      <button type="button" className="btn-ghost" onClick={() => setArticleResource(null)} title="Close article" style={{ padding: 6 }}>
                        <X size={14} />
                      </button>
                    </div>
                    {(() => {
                      let frameUrl = articleResource.route || "";
                      if (articleResource.route && articleResource.route.includes("uptodate?t=")) {
                        const tMatch = articleResource.route.match(/t=([^&]+)/);
                        if (tMatch) frameUrl = `${getBackendUrl()}/utd/topic/${tMatch[1]}/html`;
                      } else if (articleResource.route && articleResource.route.includes("lexi?doc=")) {
                        const tMatch = articleResource.route.match(/doc=([^&]+)/);
                        if (tMatch) frameUrl = `${getBackendUrl()}/lexi/doc/${tMatch[1]}/html`;
                      }

                      return (
                        <iframe
                          src={frameUrl}
                          style={{ flex: 1, width: "100%", border: "none", background: "#fff" }}
                          title={articleResource.label}
                        />
                      );
                    })()}
                  </div>
                ) : (
                  <div style={{ padding: "24px 26px", overflowY: "auto", display: "flex", flexDirection: "column", height: "100%", background: "#fff" }}>
                    <h3 style={{ fontSize: 18, margin: "0 0 24px", fontWeight: 600, color: "var(--text-primary)" }}>Related Content</h3>

                    {(() => {
                      const resources = Object.values(graph.resources);
                      const profTopics = resources.filter(r => (r.type === "topic" || r.type === "drug") && !r.label.startsWith("Patient education:"));
                      const guidelines = resources.filter(r => r.type === "guideline");
                      const patientEd = resources.filter(r => r.type === "topic" && r.label.startsWith("Patient education:"));

                      const renderList = (items: PathwayResource[]) => (
                        <ul style={{ margin: 0, paddingLeft: 24, display: "flex", flexDirection: "column", gap: 14 }}>
                          {items.map((r, i) => (
                            <li key={i} style={{ color: "var(--text-primary)" }}>
                              <a href="#" onClick={(e) => { e.preventDefault(); handleResourceClick(r); }} style={{ color: "var(--primary)", textDecoration: "underline", fontSize: 14 }}>
                                {r.label}
                              </a>
                            </li>
                          ))}
                        </ul>
                      );

                      if (profTopics.length === 0 && guidelines.length === 0 && patientEd.length === 0) {
                        return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>No related articles for this pathway.</p>;
                      }

                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
                          {profTopics.length > 0 && (
                            <div>
                              <h4 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Professional Topics</h4>
                              {renderList(profTopics)}
                            </div>
                          )}

                          {guidelines.length > 0 && (
                            <div>
                              <h4 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Society Guideline Links</h4>
                              {renderList(guidelines)}
                            </div>
                          )}

                          {patientEd.length > 0 && (
                            <div>
                              <h4 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Patient Education</h4>
                              <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>Basics</div>
                              {renderList(patientEd)}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="qbank-tool-rail">
              <button className="qbank-tool-rail-btn" onClick={() => setToolOpen(true)} title="Expand related content">
                <PanelRightOpen size={16} />
              </button>
            </div>
          )}
        </aside>
      </div>
      {overlay}
    </>
  );
}
