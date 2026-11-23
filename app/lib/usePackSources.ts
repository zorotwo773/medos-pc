"use client";

/**
 * usePackSources — the frontend's read side of app/backend/packs.py.
 *
 * Fetches GET /content/packs once (then on a slow poll) and exposes the
 * union of `search_sources` for every GREEN pack, plus per-pack install
 * state. Sidebar.tsx and GlobalCommandCenter.tsx use this ONLY to decide
 * what to grey out / hide — never to re-rank or filter search results
 * client-side (the backend already does that at the one seam in
 * routers/search.py, see docs/ADDING_A_DATABASE.md).
 */
import { useEffect, useState } from "react";
import { getBackendUrl } from "@/lib/api";

export type PackSummary = {
  id: string;
  name: string;
  state: "grey" | "yellow" | "green" | "red";
  search_sources: string[];
};

type PackSourcesState = {
  loaded: boolean;
  sources: Set<string>;
  packs: PackSummary[];
};

let cache: PackSourcesState | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<(s: PackSourcesState) => void>();

async function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/content/packs`, { cache: "no-store" });
      const data = await res.json();
      const packs: PackSummary[] = data.packs || [];
      const sources = new Set<string>();
      for (const p of packs) {
        if (p.state === "green") for (const s of p.search_sources || []) sources.add(s);
      }
      cache = { loaded: true, sources, packs };
      listeners.forEach((fn) => fn(cache!));
    } catch {
      // Backend unreachable — keep whatever we had (or stay "not loaded", which
      // callers treat as "show everything" so a slow boot never hides modules).
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Map a frontend search-scope token to the backend's `entries.source` key. */
export function scopeToPackSource(scope: string): string {
  return scope === "uptodate" ? "utd" : scope;
}

export function usePackSources(pollMs = 30000): PackSourcesState {
  const [state, setState] = useState<PackSourcesState>(cache ?? { loaded: false, sources: new Set(), packs: [] });

  useEffect(() => {
    listeners.add(setState);
    if (!cache) refresh();
    const t = setInterval(refresh, pollMs);
    return () => {
      listeners.delete(setState);
      clearInterval(t);
    };
  }, [pollMs]);

  return state;
}

/** True when we don't yet know (fail open) or the source's pack is green. */
export function sourceAvailable(state: PackSourcesState, scope: string): boolean {
  if (!state.loaded) return true;
  return state.sources.has(scopeToPackSource(scope));
}

/** True when we don't yet know (fail open) or the given pack id (see packs.py PACKS) is green. */
export function packAvailable(state: PackSourcesState, packId?: string): boolean {
  if (!packId || !state.loaded) return true;
  const pack = state.packs.find((p) => p.id === packId);
  return pack ? pack.state === "green" : true;
}
