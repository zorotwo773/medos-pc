"use client";
/* ──────────────────────────────────────────────────────────────
   Poster view — the real AHA/AAP reference chart image for an
   algorithm, shown alongside the interactive Walk/Map screens.
   Not every algorithm has one yet; callers check availability via
   usePosterAvailable before offering the tab.
   ────────────────────────────────────────────────────────────── */

import { useEffect, useState } from "react";
import { getBackendUrl } from "@/lib/api";
import { M } from "./ui";

export function posterUrl(algoId: string): string {
  return `${getBackendUrl()}/acls/image/${algoId}`;
}

/**
 * Probes whether a poster image exists for this algorithm. Uses an Image()
 * load probe rather than fetch(HEAD) — some environments (corporate proxies,
 * browser extensions) interfere with cross-origin HEAD/fetch to a local
 * backend port in ways that don't affect plain <img> loading.
 */
export function usePosterAvailable(algoId: string): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAvailable(false);
    const img = new Image();
    img.onload = () => { if (!cancelled) setAvailable(true); };
    img.onerror = () => { if (!cancelled) setAvailable(false); };
    img.src = posterUrl(algoId);
    return () => { cancelled = true; img.onload = null; img.onerror = null; };
  }, [algoId]);
  return available;
}

export default function AclsPoster({ algoId, title }: { algoId: string; title: string }) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, maxWidth: 900, margin: "0 auto", width: "100%" }}>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)", padding: 6, cursor: "zoom-in", width: "100%" }}
        title="Tap to view full-screen"
      >
        <img src={posterUrl(algoId)} alt={`${title} — reference chart`} style={{ width: "100%", height: "auto", borderRadius: 8, display: "block" }} />
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-muted)" }}>
        <M name="zoom_in" size={14} /> Tap the chart to zoom · official AHA/AAP reference
      </div>

      {zoomed && (
        <div
          onClick={() => setZoomed(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(15,23,42,0.85)", zIndex: 200,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out",
            overflow: "auto",
          }}
        >
          <img
            src={posterUrl(algoId)}
            alt={`${title} — reference chart`}
            style={{ maxWidth: "min(1100px, 96vw)", width: "100%", height: "auto", borderRadius: 6, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          />
        </div>
      )}
    </div>
  );
}
