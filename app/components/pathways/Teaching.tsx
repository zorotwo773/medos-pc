"use client";
/* Teaching-HTML renderer + resource chips + the overlay host (graphic drawer,
   inline info popover, sibling-pathway navigation) for the Pathways module. */

import { useCallback, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import GraphicDrawer from "@/components/uptodate/GraphicDrawer";
import type { PathwayResource } from "@/lib/pathways/types";
import { resourceAction, RES_META } from "@/lib/pathways/resources";
import { M } from "./ui";

type ResMap = Record<string, PathwayResource>;

/* ── Overlay host: one hook the Player mounts once. ──────────────────────── */
export function useResourceOverlays() {
  const router = useRouter();
  const [graphicId, setGraphicId] = useState<number | null>(null);
  const [info, setInfo] = useState<{ label: string; html: string } | null>(null);

  const openResource = useCallback((res: PathwayResource | undefined) => {
    if (!res) return;
    const act = resourceAction(res);
    switch (act.kind) {
      case "graphic":
        setGraphicId(act.graphicId); break;
      case "inline":
        setInfo({ label: res.label || "Note", html: res.inlineHtml || "" }); break;
      case "external":
        window.open(act.href, "_blank", "noopener"); break;
      case "route":
        if (res.type === "pathway") router.push(act.href);        // stay in-module
        else window.open(act.href, "_blank", "noopener");          // topic/drug → new tab, keep the pathway
        break;
      default:
        break;
    }
  }, [router]);

  const overlay = (
    <>
      {graphicId != null && <GraphicDrawer graphicId={graphicId} onClose={() => setGraphicId(null)} />}
      {info && <InfoPopover label={info.label} html={info.html} onClose={() => setInfo(null)} />}
    </>
  );

  return { openResource, overlay };
}

/* ── Teaching HTML: renders the "why", delegates pw-res anchor clicks. ────── */
export function TeachingHtml({ html, resources, onOpen, style }: {
  html: string; resources: ResMap; onOpen: (r: PathwayResource | undefined) => void; style?: React.CSSProperties;
}) {
  const onClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a.pw-res") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const key = a.getAttribute("data-res");
    if (key) onOpen(resources[key]);
  }, [resources, onOpen]);

  if (!html) return null;
  return (
    <div
      className="pw-teach"
      onClick={onClick}
      style={{ fontSize: 13.5, lineHeight: 1.62, color: "var(--text-secondary)", ...style }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/* ── Resource chip + rail ─────────────────────────────────────────────────── */
export function ResourceChip({ res, onOpen }: { res: PathwayResource; onOpen: (r: PathwayResource) => void }) {
  const meta = RES_META[res.type] || RES_META.ref;
  const clickable = resourceAction(res).kind !== "none";
  return (
    <button
      type="button"
      className="pw-chip"
      disabled={!clickable}
      onClick={() => clickable && onOpen(res)}
      title={res.label}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 260,
        padding: "5px 10px", borderRadius: 999, fontSize: 12, fontWeight: 500,
        background: "var(--bg-card)", border: "1px solid var(--border)",
        color: clickable ? "var(--text-secondary)" : "var(--text-muted)",
        cursor: clickable ? "pointer" : "default", textAlign: "left",
      }}
    >
      <M name={meta.glyph} size={14} style={{ color: "var(--mod-pathways)", flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{res.label || meta.tag}</span>
    </button>
  );
}

export function ResourceRail({ keys, resources, onOpen, max = 10 }: {
  keys: string[]; resources: ResMap; onOpen: (r: PathwayResource) => void; max?: number;
}) {
  const seen = new Set<string>();
  const items = keys
    .map((k) => ({ k, r: resources[k] }))
    .filter(({ k, r }) => {
      if (!r) return false;
      const sig = `${r.type}:${r.label}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    })
    .slice(0, max);
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
      {items.map(({ k, r }) => <ResourceChip key={k} res={r} onOpen={onOpen} />)}
    </div>
  );
}

/* ── Inline info popover (infoPopup / authors) ────────────────────────────── */
function InfoPopover({ label, html, onClose }: { label: string; html: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1200, background: "rgba(15,23,42,.42)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        className="pw-pop"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14,
          maxWidth: 520, width: "100%", maxHeight: "76vh", overflowY: "auto",
          boxShadow: "0 24px 60px -20px rgba(15,23,42,.5)", padding: "18px 20px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>{label}</strong>
          <button type="button" onClick={onClose} className="pw-btn" style={{ background: "transparent", border: "none", color: "var(--text-muted)", display: "flex" }}>
            <M name="close" size={20} />
          </button>
        </div>
        <div className="pw-teach" style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text-secondary)" }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
