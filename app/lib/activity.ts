"use client";
/**
 * Unified client activity layer.
 *
 * Talks to the backend /activity/* router (via the /api proxy) which persists
 * everything into qbank_state.sqlite3 — the single portable "progression file".
 * localStorage caches keep the UX instant and offline-safe (the "laptop
 * switches off" case): we write the cache synchronously and flush to the
 * backend best-effort, including a sendBeacon flush on pagehide.
 *
 * No import of useRecent here — useRecent.recordRecent() imports `postEvent`
 * from this module instead, so existing recent call sites mirror to the backend
 * for free without a circular import.
 */
import { useEffect, useState, useCallback } from "react";

const API = "/api/activity";
const SCROLL_CACHE_KEY = "medos:scroll";          // { [href]: { y, anchor, ts } }
const AUTOJUMP_KEY = "medos.resume.autoJump";     // "1" | "0"
const EXAM_RUN_KEY = "medos.qbank.examRun.v1";    // owned by QuizEngine

export interface ActivityEvent {
  kind: string;                 // page_open | read | search | qbank_block | exam | popup …
  source?: string;
  ref_id?: string | number;
  title?: string;
  href?: string;
  detail?: string;
  meta?: Record<string, unknown>;
  scroll_y?: number;
  resumable?: boolean;
}

export interface ResumeTarget {
  href: string;
  title?: string | null;
  source?: string | null;
  kind?: string | null;
  ref_id?: string | null;
  scroll_y?: number;
  meta?: Record<string, unknown>;
  updated_at?: string;
}

/* ── low-level POST (best-effort, never throws) ──────────────────────────── */

function post(path: string, body: unknown, keepalive = false): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    keepalive,
    body: JSON.stringify(body),
  })
    .then(() => undefined)
    .catch(() => undefined);
}

/* ── events ──────────────────────────────────────────────────────────────── */

/** Mirror a recent/activity event to the backend. Called by recordRecent and
 *  directly for non-recent event kinds (exam, qbank_block). */
export function postEvent(event: ActivityEvent): void {
  if (typeof window === "undefined") return;
  void post("/event", event);
}

/* ── search history ──────────────────────────────────────────────────────── */

export function recordSearch(query: string, scopes?: string, resultsCount?: number): void {
  const q = (query || "").trim();
  if (!q || q.length < 2) return;
  void post("/search", { query: q, scopes: scopes ?? null, results_count: resultsCount ?? null });
}

/* ── scroll positions ────────────────────────────────────────────────────── */

type ScrollCache = Record<string, { y: number; anchor?: string; ts: number }>;

function readScrollCache(): ScrollCache {
  try {
    const raw = localStorage.getItem(SCROLL_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeScrollCache(cache: ScrollCache) {
  try {
    // Bound the cache so it can't grow without limit.
    const entries = Object.entries(cache);
    if (entries.length > 400) {
      entries.sort((a, b) => b[1].ts - a[1].ts);
      cache = Object.fromEntries(entries.slice(0, 400));
    }
    localStorage.setItem(SCROLL_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

const _scrollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _scrollDirty = new Map<string, { y: number; anchor?: string }>();
let _beaconWired = false;

function wireBeacon() {
  if (_beaconWired || typeof window === "undefined") return;
  _beaconWired = true;
  const flush = () => {
    for (const [href, { y, anchor }] of _scrollDirty.entries()) {
      try {
        const blob = new Blob(
          [JSON.stringify({ href, scroll_y: y, anchor: anchor ?? null })],
          { type: "application/json" },
        );
        navigator.sendBeacon?.(`${API}/scroll`, blob);
      } catch {
        /* ignore */
      }
    }
    _scrollDirty.clear();
  };
  window.addEventListener("pagehide", flush);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

/** Save a page's scroll position. Cache is written immediately; the backend
 *  POST is debounced (~500ms) and also flushed via sendBeacon on pagehide. */
export function saveScroll(href: string, y: number, anchor?: string): void {
  if (typeof window === "undefined" || !href) return;
  wireBeacon();
  const cache = readScrollCache();
  cache[href] = { y, anchor, ts: Date.now() };
  writeScrollCache(cache);

  _scrollDirty.set(href, { y, anchor });
  const existing = _scrollTimers.get(href);
  if (existing) clearTimeout(existing);
  _scrollTimers.set(
    href,
    setTimeout(() => {
      _scrollTimers.delete(href);
      const pending = _scrollDirty.get(href);
      if (!pending) return;
      _scrollDirty.delete(href);
      void post("/scroll", { href, scroll_y: pending.y, anchor: pending.anchor ?? null });
    }, 500),
  );
}

/** Resolve a saved scroll position — cache first (instant), backend fallback
 *  (durable across reinstalls / devices). Returns null if none known. */
export async function loadScroll(href: string): Promise<{ y: number; anchor?: string } | null> {
  if (typeof window === "undefined" || !href) return null;
  const cache = readScrollCache();
  if (cache[href]) return { y: cache[href].y, anchor: cache[href].anchor };
  try {
    const res = await fetch(`${API}/scroll?href=${encodeURIComponent(href)}`, { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.scroll && typeof data.scroll.scroll_y === "number") {
      return { y: data.scroll.scroll_y, anchor: data.scroll.anchor ?? undefined };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Normalized key for the current page (pathname + search). */
export function currentScrollKey(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname + window.location.search;
}

/* ── resume / auto-jump ──────────────────────────────────────────────────── */

export function getAutoJump(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(AUTOJUMP_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoJump(on: boolean): void {
  try {
    localStorage.setItem(AUTOJUMP_KEY, on ? "1" : "0");
    window.dispatchEvent(new Event("medos:autojump-changed"));
  } catch {
    /* ignore */
  }
}

/** Read the in-progress exam straight from QuizEngine's localStorage so the
 *  resume prompt can prioritize "you have an exam running". */
function readExamInProgress(): { label: string; href: string } | null {
  try {
    const raw = localStorage.getItem(EXAM_RUN_KEY);
    if (!raw) return null;
    const run = JSON.parse(raw);
    if (run && run.phase && run.phase !== "done") {
      const label = run.label || "USMLE exam";
      const block = typeof run.currentBlock === "number" ? run.currentBlock + 1 : null;
      return {
        label: block ? `${label} · Block ${block}` : label,
        href: "/qbank",
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export interface ResumeState {
  loading: boolean;
  resume: ResumeTarget | null;       // last reading location (backend)
  examInProgress: { label: string; href: string } | null;
  /** The single best place to send the user back to (exam beats reading). */
  target: (ResumeTarget & { isExam?: boolean }) | null;
  refresh: () => void;
}

export function useResume(): ResumeState {
  const [resume, setResume] = useState<ResumeTarget | null>(null);
  const [exam, setExam] = useState<{ label: string; href: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setExam(readExamInProgress());
    fetch(`${API}/resume`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!alive) return;
        setResume(data?.resume ?? null);
        setLoading(false);
      })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tick]);

  const target: (ResumeTarget & { isExam?: boolean }) | null = exam
    ? { href: exam.href, title: exam.label, kind: "exam", source: "qbank", isExam: true }
    : resume;

  return {
    loading,
    resume,
    examInProgress: exam,
    target,
    refresh: useCallback(() => setTick(t => t + 1), []),
  };
}

/* ── search-history + progression hooks ──────────────────────────────────── */

export interface SearchHistory {
  recent: Array<{ query: string; scopes?: string; results_count?: number; ts: string }>;
  top: Array<{ query: string; count: number; last_ts: string }>;
}

export function useSearchHistory(limit = 20): SearchHistory | null {
  const [data, setData] = useState<SearchHistory | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API}/searches?limit=${limit}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d) setData(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [limit]);
  return data;
}

export interface ProgressionBank {
  key: string;
  label: string;
  category: string;
  step: number | null;
  form: string | null;
  subject: string | null;
  total: number;
  used: number;
  marked: number;
}

export interface Progression {
  banks: ProgressionBank[];
  anki: { seen: number; mature: number; due: number } | null;
  searches: Array<{ query: string; count: number; last_ts: string }>;
  generated_at: string;
}

export function useProgression(reloadKey: unknown = 0): Progression | null {
  const [data, setData] = useState<Progression | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API}/progression`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d) setData(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [reloadKey]);
  return data;
}

/* ── export / import (version-to-version sync) ───────────────────────────── */

export async function exportProgression(): Promise<unknown> {
  const res = await fetch(`${API}/export`, { credentials: "include" });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  return res.json();
}

export interface ImportSummary {
  ok: boolean;
  mode: string;
  banksTouched: number;
  usedAdded: number;
  markedAdded: number;
  banks: Record<string, { usedAdded: number; markedAdded: number; usedTotal: number; markedTotal: number }>;
  searchesImported: number;
}

export async function importProgression(payload: unknown, mode: "merge" | "replace" = "merge"): Promise<ImportSummary> {
  const res = await fetch(`${API}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ mode, payload }),
  });
  if (!res.ok) throw new Error(`Import failed (${res.status})`);
  return res.json();
}
