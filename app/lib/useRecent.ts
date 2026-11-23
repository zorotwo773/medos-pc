"use client";
import { useEffect, useState } from "react";
import { postEvent } from "@/lib/activity";

export interface RecentEntry {
  tag: string;
  label: string;
  href: string;
  ts: number;
  source?: string;
  kind?: string;
  detail?: string;
}

const KEY = "medos:recent";
const EVENT = "medos:recent-changed";
const MAX = 60;

function sourceFromEntry(entry: Pick<RecentEntry, "tag" | "href" | "source">) {
  if (entry.source) return entry.source;
  const tag = entry.tag.toLowerCase();
  if (tag === "utd") return "uptodate";
  if (tag === "amb") return "amboss";
  if (tag === "qb" || tag === "qbank" || tag === "uw") return "qbank";
  if (tag === "dis") return "diseases";
  if (tag === "book") return "library";
  if (tag === "drug" || tag === "drg") return "drugs";
  if (tag === "calc" || tag === "lexi") return "calculators";
  if (tag === "anat") return "anatomy";
  if (tag === "ortho") return "ortho";
  if (entry.href.startsWith("/uptodate")) return "uptodate";
  if (entry.href.startsWith("/amboss")) return "amboss";
  if (entry.href.startsWith("/qbank")) return "qbank";
  if (entry.href.startsWith("/diseases")) return "diseases";
  if (entry.href.startsWith("/library")) return "library";
  if (entry.href.startsWith("/drugs")) return "drugs";
  if (entry.href.startsWith("/calculators") || entry.href.startsWith("/lexi")) return "calculators";
  if (entry.href.startsWith("/anatomy")) return "anatomy";
  return tag || "app";
}

function readRecent(): RecentEntry[] {
  const raw = localStorage.getItem(KEY);
  const parsed = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is RecentEntry => Boolean(item?.href && item?.label && item?.tag))
    .map(item => ({ ...item, source: sourceFromEntry(item) }));
}

export function useRecent(): RecentEntry[] {
  const [items, setItems] = useState<RecentEntry[]>([]);

  useEffect(() => {
    function sync() {
      try {
        setItems(readRecent());
      } catch {
        // ignore
      }
    }
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return items;
}

export function recordRecent(entry: Omit<RecentEntry, "ts">) {
  if (typeof window === "undefined") return;
  try {
    const existing = readRecent();
    const source = sourceFromEntry(entry);
    const filtered = existing.filter(e => e.href !== entry.href);
    const updated = [{ ...entry, source, ts: Date.now() }, ...filtered].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(updated));
    window.dispatchEvent(new Event(EVENT));
    // Mirror to the durable backend activity ledger. Reading surfaces become
    // the resume pointer; module/nav tiles are logged but never resumed.
    postEvent({
      kind: entry.kind || "page_open",
      source,
      title: entry.label,
      href: entry.href,
      detail: entry.detail,
      resumable: entry.kind !== "module" && Boolean(entry.href),
    });
  } catch {
    // ignore
  }
}
