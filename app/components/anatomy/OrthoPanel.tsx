"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { getBackendUrl } from "@/lib/api";
import { getMeshesForRegion } from "./orthoMeshMap";
import { ChevronDown, ChevronRight, X, ZoomIn, Maximize2, Minimize2, AlertTriangle } from "lucide-react";
import { ReadingModeBanner } from "./BonePanelShared";

// ── Types ────────────────────────────────────────────────────────────────────

interface AoSection {
  id: string;
  heading: string;
  html: string;
  figures: { file: string; caption: string }[];
}

interface AoPage {
  title: string;
  breadcrumbs: string[];
  sections: AoSection[];
  links: { slug: string; label: string }[];
}

interface TreeNode {
  label: string;
  slug: string;
  children: TreeNode[];
}

interface OrthoPanelProps {
  initialSlug?: string;
  selectedMesh: string | null;
  onFocusMesh: (name: string) => void;
  onClose: () => void;
  fullscreen?: boolean;
  onFullscreen?: () => void;
  onExitFullscreen?: () => void;
}

// ── Module-level tree/manifest cache ─────────────────────────────────────────
let _treeCache: TreeNode | null = null;

async function fetchTree(): Promise<TreeNode | null> {
  if (_treeCache) return _treeCache;
  try {
    const r = await fetch(`${getBackendUrl()}/ao/tree`);
    if (!r.ok) return null;
    _treeCache = await r.json();
    return _treeCache;
  } catch {
    return null;
  }
}

interface Manifest { stale?: boolean; age_days?: number; scraped_at?: string; }
let _manifestCache: Manifest | null = null;

async function fetchManifest(): Promise<Manifest | null> {
  if (_manifestCache) return _manifestCache;
  try {
    const r = await fetch(`${getBackendUrl()}/ao/manifest`);
    if (!r.ok) return null;
    _manifestCache = await r.json();
    return _manifestCache;
  } catch {
    return null;
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function TreeItem({
  node,
  depth,
  currentSlug,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  currentSlug: string;
  onSelect: (slug: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2 || currentSlug.startsWith(node.slug));
  const isLeaf = node.children.length === 0;
  const active = node.slug === currentSlug;

  useEffect(() => {
    if (currentSlug.startsWith(node.slug)) setOpen(true);
  }, [currentSlug, node.slug]);

  return (
    <div>
      <div
        onClick={() => {
          if (isLeaf) onSelect(node.slug);
          else setOpen(o => !o);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: `3px 6px 3px ${8 + depth * 10}px`,
          cursor: "pointer",
          borderRadius: 4,
          background: active ? "rgba(49,130,206,0.15)" : "transparent",
          color: active ? "#3182ce" : "var(--text-secondary)",
          fontSize: 11,
          fontWeight: active ? 600 : 400,
        }}
        onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--bg-card-hover)"; }}
        onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        {!isLeaf && (open ? <ChevronDown size={10} /> : <ChevronRight size={10} />)}
        {isLeaf && <span style={{ width: 10, display: "inline-block" }} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.label}
        </span>
      </div>
      {!isLeaf && open && node.children.map(child => (
        <TreeItem
          key={child.slug}
          node={child}
          depth={depth + 1}
          currentSlug={currentSlug}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function FigureZoom({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.82)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: "90vw", maxHeight: "90vh", textAlign: "center" }}>
        <img src={src} alt={caption} style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 6 }} />
        {caption && <p style={{ color: "#fff", fontSize: 12, marginTop: 8, opacity: 0.8 }}>{caption}</p>}
        <button
          onClick={onClose}
          style={{
            marginTop: 12, padding: "6px 18px", background: "rgba(255,255,255,0.15)",
            border: "1px solid rgba(255,255,255,0.3)", borderRadius: 4,
            color: "#fff", cursor: "pointer", fontSize: 12,
          }}
        >Close</button>
      </div>
    </div>
  );
}

// ── Main Panel ───────────────────────────────────────────────────────────────

export default function OrthoPanel({
  initialSlug,
  selectedMesh,
  onFocusMesh,
  onClose,
  fullscreen = false,
  onFullscreen = () => {},
  onExitFullscreen = () => {},
}: OrthoPanelProps) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [slug, setSlug] = useState<string>(initialSlug ?? "");
  const [page, setPage] = useState<AoPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("");
  const [zoomFig, setZoomFig] = useState<{ src: string; caption: string } | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const prevMesh = useRef<string | null>(null);

  // Load tree + manifest once
  useEffect(() => {
    fetchTree().then(setTree);
    fetchManifest().then(setManifest);
  }, []);

  // Esc exits fullscreen (but stays in ortho mode)
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExitFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, onExitFullscreen]);

  // When selectedMesh changes (from 3D click), navigate to matching AO region
  useEffect(() => {
    if (!selectedMesh || selectedMesh === prevMesh.current) return;
    prevMesh.current = selectedMesh;
    getMeshesForRegion(slug).then(() => {}); // warm reverse cache
    // Use mesh name to find region
    fetch(`${getBackendUrl()}/ao/mesh?name=${encodeURIComponent(selectedMesh)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.slugs?.length) setSlug(data.slugs[0]);
      })
      .catch(() => {});
  }, [selectedMesh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load page when slug changes
  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    fetch(`${getBackendUrl()}/ao/page?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: AoPage | null) => {
        setPage(data);
        if (data?.sections?.length) setActiveTab(data.sections[0].id);
        setLoading(false);
        // Focus 3D camera on matching mesh
        if (data) {
          getMeshesForRegion(slug).then(meshes => {
            if (meshes.length) onFocusMesh(meshes[0]);
          });
        }
      })
      .catch(() => setLoading(false));
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInternalLink = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("/ortho/")) {
      e.preventDefault();
      setSlug(href.replace("/ortho/", ""));
    }
  }, []);

  const figUrl = (figFile: string) =>
    `${getBackendUrl()}/ao/figure?slug=${encodeURIComponent(slug)}&fig=${encodeURIComponent(figFile)}`;

  const currentSection = page?.sections?.find(s => s.id === activeTab);

  const rootStyle: React.CSSProperties = {
    width: "100%",
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-sidebar)",
    flexShrink: 0,
    overflow: "hidden",
    height: "100%",
  };

  return (
    <div style={rootStyle}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-card)", flexShrink: 0,
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {page?.title || "AO Surgery Reference"}
        </span>
        {manifest?.stale && (
          <span title={`AO data is ${manifest.age_days ?? "?"} days old — consider re-scraping`}
            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#d97706" }}>
            <AlertTriangle size={12} /> stale
          </span>
        )}
        <button onClick={() => setTreeOpen(o => !o)} title={treeOpen ? "Hide tree" : "Show tree"}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}>
          {treeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button onClick={() => fullscreen ? onExitFullscreen() : onFullscreen()} title={fullscreen ? "Show 3D model" : "Maximize (Esc to restore)"}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}>
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button onClick={onClose} title="Close"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}>
          <X size={14} />
        </button>
      </div>

      {fullscreen && <ReadingModeBanner onExitFullscreen={onExitFullscreen} />}

      {/* Breadcrumbs */}
      {page?.breadcrumbs && page.breadcrumbs.length > 0 && (
        <div style={{
          padding: "4px 12px", borderBottom: "1px solid var(--border)",
          fontSize: 10, color: "var(--text-muted)", background: "var(--bg-card)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0,
        }}>
          {page.breadcrumbs.join(" › ")}
        </div>
      )}

      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: fullscreen ? "row" : "column",
        overflow: "hidden",
      }}>
        {/* Collapsible tree — left sub-rail in fullscreen, top strip otherwise */}
        {treeOpen && tree && (
          <div style={fullscreen ? {
            width: 280, overflowY: "auto", borderRight: "1px solid var(--border)",
            padding: "8px 6px", flexShrink: 0,
          } : {
            maxHeight: 200, overflowY: "auto", borderBottom: "1px solid var(--border)",
            padding: "4px 4px", flexShrink: 0,
          }}>
            {tree.children.map(node => (
              <TreeItem
                key={node.slug}
                node={node}
                depth={0}
                currentSlug={slug}
                onSelect={setSlug}
              />
            ))}
          </div>
        )}

        {/* In fullscreen, body is its own scrollable column to keep the tree fixed */}
        <div style={fullscreen ? {
          flex: 1, display: "flex", flexDirection: "column", overflow: "hidden",
        } : { display: "contents" }}>
        {/* (children appear in this wrapper when fullscreen, otherwise flow normally) */}

        {/* No data state */}
        {!tree && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            AO data not available — run the scraper first:<br />
            <code style={{ fontSize: 10, background: "var(--bg-base)", padding: "2px 6px", borderRadius: 3, display: "inline-block", marginTop: 6 }}>
              python app/scripts/ao_scrape.py
            </code>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            Loading…
          </div>
        )}

        {/* Tab strip */}
        {page && page.sections.length > 0 && !loading && (
          <div style={{
            display: "flex", gap: 0, overflowX: "auto", flexShrink: 0,
            borderBottom: "1px solid var(--border)", background: "var(--bg-card)",
          }}>
            {page.sections.map(s => (
              <button
                key={s.id}
                onClick={() => setActiveTab(s.id)}
                style={{
                  padding: "6px 10px", fontSize: 10, fontWeight: 600,
                  whiteSpace: "nowrap", cursor: "pointer",
                  background: "transparent", border: "none",
                  borderBottom: activeTab === s.id ? "2px solid #3182ce" : "2px solid transparent",
                  color: activeTab === s.id ? "#3182ce" : "var(--text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.06em",
                }}
              >{s.heading}</button>
            ))}
          </div>
        )}

        {/* Section content */}
        {currentSection && !loading && (
          <div style={fullscreen
            ? { flex: 1, overflowY: "auto" }
            : { flex: 1, overflowY: "auto", padding: "12px 14px" }
          }>
            <div style={fullscreen ? {
              maxWidth: 880, margin: "0 auto", padding: "20px 28px 60px",
            } : undefined}>
            {/* Prose */}
            {currentSection.html && (
              <div
                className="ao-prose"
                style={{
                  fontSize: fullscreen ? 14 : 12,
                  lineHeight: fullscreen ? 1.75 : 1.65,
                  color: "var(--text-primary)",
                }}
                dangerouslySetInnerHTML={{ __html: currentSection.html }}
                onClick={handleInternalLink}
              />
            )}

            {/* Figures */}
            {currentSection.figures.length > 0 && (
              <div style={{ marginTop: 14 }}>
                {currentSection.figures.map((fig, i) => (
                  <div key={i} style={{ marginBottom: 14 }}>
                    <div style={{ position: "relative", display: "inline-block" }}>
                      <img
                        src={figUrl(fig.file)}
                        alt={fig.caption}
                        style={{ maxWidth: "100%", borderRadius: 4, display: "block", cursor: "zoom-in" }}
                        onClick={() => setZoomFig({ src: figUrl(fig.file), caption: fig.caption })}
                      />
                      <button
                        onClick={() => setZoomFig({ src: figUrl(fig.file), caption: fig.caption })}
                        style={{
                          position: "absolute", top: 4, right: 4,
                          background: "rgba(0,0,0,0.5)", border: "none",
                          borderRadius: 3, padding: "2px 4px", cursor: "pointer", color: "#fff",
                          display: "flex",
                        }}
                      ><ZoomIn size={10} /></button>
                    </div>
                    {fig.caption && (
                      <p style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>{fig.caption}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Cross-links */}
            {page?.links && page.links.length > 0 && (
              <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
                  Related
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {page.links.slice(0, 12).map(link => (
                    <button
                      key={link.slug}
                      onClick={() => setSlug(link.slug)}
                      style={{
                        padding: "3px 8px", fontSize: 10, borderRadius: 12,
                        background: "var(--bg-base)", border: "1px solid var(--border)",
                        cursor: "pointer", color: "var(--text-secondary)",
                      }}
                    >{link.label}</button>
                  ))}
                </div>
              </div>
            )}
            </div>{/* /reading column */}
          </div>
        )}

        {/* Empty slug state */}
        {!slug && !loading && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
            Select a region in the tree or click a bone in the 3D viewer.
          </div>
        )}
        </div>{/* /fullscreen body wrapper (display:contents in side mode) */}
      </div>

      {/* Zoom modal */}
      {zoomFig && (
        <FigureZoom src={zoomFig.src} caption={zoomFig.caption} onClose={() => setZoomFig(null)} />
      )}
    </div>
  );
}
