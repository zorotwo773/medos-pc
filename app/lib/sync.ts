"use client";
/**
 * LAN auto-sync client.
 *
 * Talks to the backend /sync/* router (via the /api proxy). The backend runs a
 * UDP discovery + pull-merge loop on its own; this layer is purely for the
 * Settings UI to show status and to nudge an immediate sync.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const API = "/api/sync";

export interface SyncPeer {
  node_id: string;
  name: string;
  ip: string;
  port: number;
  user?: string | null;
  paired: boolean;
  last_seen_ago: number;
  last_sync_at?: string | null;
  last_synced?: number | null;
}

export interface SyncRoundResult {
  enabled: boolean;
  at?: string;
  peers: number;
  added: number;
  results?: Array<{ name?: string; upToDate?: boolean; usedAdded?: number; markedAdded?: number }>;
}

export interface SyncStatus {
  enabled: boolean;
  available: boolean;
  node_id: string;
  device_name: string;
  owner: string;
  http_port: number;
  discovery_port: number;
  token_required: boolean;
  lan_ip: string;
  peers: SyncPeer[];
  last_sync_at?: string | null;
  last_result?: SyncRoundResult | null;
  history: Array<{ at: string; peers: number; added: number }>;
}

async function getJSON<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { credentials: "include" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function postJSON<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function syncNow(): Promise<SyncRoundResult | null> {
  return postJSON<SyncRoundResult>("/now");
}

export function toggleSync(enabled: boolean): Promise<{ enabled: boolean } | null> {
  return postJSON("/toggle", { enabled });
}

export function renameDevice(name: string): Promise<{ device_name: string } | null> {
  return postJSON("/rename", { name });
}

export function useSyncStatus(pollMs = 8000) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const s = await getJSON<SyncStatus>("/status");
    setStatus(s);
    setLoading(false);
    return s;
  }, []);

  useEffect(() => {
    let alive = true;
    void refresh();
    timer.current = setInterval(() => {
      if (alive) void refresh();
    }, pollMs);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, [pollMs, refresh]);

  return { status, loading, refresh };
}
