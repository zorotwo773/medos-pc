"use client";
/**
 * TabBar — persistent multi-tab reader navigation.
 *
 * Features:
 * - Ctrl+T opens a new empty tab; Ctrl+W closes the current one.
 * - Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PageUp / Ctrl+PageDown cycle tabs.
 * - Each reader view (/uptodate/:id, /amboss/:id, /library?path=…, /qbank/:qid)
 *   can be opened in a tab by dispatching: window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href, title } }))
 * - Tab state is persisted in IndexedDB via Dexie so it survives page refreshes.
 * - Tabs can be dragged to reorder (HTML5 drag & drop, no library needed).
 *
 * Place in app/layout.tsx above <main> to make it available on every reader page.
 */
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { upsertWorkspaceTab } from "@/lib/qbankWorkspaceState";

interface Tab {
  id:      string;
  href:    string;
  title:   string;
  created: number;
  tabKey?: string;
}

/* ── Dexie-lite persistence via direct IndexedDB API ──────────────────────── */

const DB_NAME    = "medos_tabs";
const STORE_NAME = "tabs";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function loadTabs(): Promise<Tab[]> {
  try {
    const db   = await openDB();
    const tx   = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(
        (req.result as Tab[]).sort((a, b) => a.created - b.created)
      );
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function saveTabs(tabs: Tab[]): Promise<void> {
  try {
    const db    = await openDB();
    const tx    = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tabs.forEach(t => store.put(t));
  } catch {
    // IDB not available (SSR / private mode) — silently skip
  }
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function labelFromHref(href: string): string {
  try {
    const url = new URL(href, "http://x");
    if (url.pathname.startsWith("/uptodate")) return "UpToDate topic";
    if (url.pathname.startsWith("/amboss"))   return "AMBOSS article";
    if (url.pathname.startsWith("/library/uworld")) return "UWorld article";
    if (url.pathname.startsWith("/library"))  {
      const path = url.searchParams.get("path") || "";
      const name = path.split("/").pop() || "";
      return name.replace(/\.pdf$/i, "") || "PDF";
    }
    if (url.pathname.startsWith("/qbank"))    return "Q-Bank";
    if (url.pathname.startsWith("/calc"))     return "Calculator";
    if (url.pathname.startsWith("/umls")) {
      const cui = url.searchParams.get("cui");
      return cui ? `UMLS · ${cui}` : "UMLS";
    }
    if (url.pathname.startsWith("/differential")) return "Differential";
    if (url.pathname.startsWith("/labs"))         return "Lab Panels";
    if (url.pathname.startsWith("/graph")) {
      const cui = url.searchParams.get("cui");
      return cui ? `Graph · ${cui}` : "Concept Graph";
    }
    return url.pathname.slice(1) || "Page";
  } catch {
    return href;
  }
}

function pathnameFromHref(href: string): string {
  try {
    return new URL(href, "http://x").pathname;
  } catch {
    return href.split("?")[0] || href;
  }
}

function tabForPath(pathname: string): Pick<Tab, "href" | "title"> | null {
  if (pathname === "/calculators")  return { href: "/calculators",  title: "Calculators" };
  if (pathname === "/drugs")        return { href: "/drugs",        title: "Drug Ref" };
  if (pathname === "/umls")         return { href: "/umls",         title: "UMLS" };
  if (pathname === "/differential") return { href: "/differential", title: "Differential" };
  if (pathname === "/labs")         return { href: "/labs",         title: "Lab Panels" };
  if (pathname === "/graph")        return { href: "/graph",        title: "Concept Graph" };
  return null;
}

/* ── Component ────────────────────────────────────────────────────────────── */

export default function TabBar() {
  const [tabs,        setTabs]        = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [dragSrc,     setDragSrc]     = useState<string | null>(null);
  const [visible,     setVisible]     = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const pathname = usePathname();
  const router   = useRouter();

  // Load from IndexedDB on mount
  useEffect(() => {
    loadTabs().then(saved => {
      if (saved.length > 0) {
        setTabs(prev => {
          const merged = [...saved];
          for (const tab of prev) {
            if (!merged.some(item => item.href === tab.href)) merged.push(tab);
          }
          return merged.sort((a, b) => a.created - b.created);
        });
        setVisible(true);
      }
    });
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarsePointer(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Persist whenever tabs change
  useEffect(() => {
    saveTabs(tabs);
  }, [tabs]);

  useEffect(() => {
    const routeTab = tabForPath(pathname);
    setTabs(prev => {
      let next = prev;
      const existing = routeTab ? prev.find(t => t.href === routeTab.href) : undefined;
      if (routeTab && !existing) {
        next = [...prev, { id: genId(), ...routeTab, created: Date.now() }];
      }
      const active = next.find(t => pathnameFromHref(t.href) === pathname);
      setActiveTabId(active?.id ?? null);
      if (next.length > 0) setVisible(true);
      return next;
    });
  }, [pathname]);

  // Listen for TabBar:open events from reader views / result clicks
  useEffect(() => {
    const handler = (e: Event) => {
      const { href, title, navigate = true, tabKey } = (e as CustomEvent<{ href: string; title?: string; navigate?: boolean; tabKey?: string }>).detail;
      if (!href) return;
      setTabs(prev => {
        if (tabKey) {
          const existing = prev.find(t => t.tabKey === tabKey);
          const tab: Tab = {
            id: existing?.id || genId(),
            tabKey,
            href,
            title: title || labelFromHref(href),
            created: existing?.created || Date.now(),
          };
          setVisible(true);
          return upsertWorkspaceTab(prev, tab);
        }
        const existing = prev.find(t => t.href === href);
        if (existing) return prev;
        const tab: Tab = { id: genId(), href, title: title || labelFromHref(href), created: Date.now() };
        setVisible(true);
        return [...prev, tab];
      });
      if (navigate) router.push(href);
    };
    window.addEventListener("TabBar:open", handler);
    return () => window.removeEventListener("TabBar:open", handler);
  }, [router]);

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const filtered = prev.filter(t => t.id !== id);
      if (filtered.length === 0) setVisible(false);
      if (activeTabId === id && filtered.length > 0) {
        const idx = Math.min(prev.findIndex(t => t.id === id), filtered.length - 1);
        setActiveTabId(filtered[idx]?.id ?? null);
        router.push(filtered[idx]?.href ?? pathname);
      }
      return filtered;
    });
  }, [activeTabId, router, pathname]);

  const cycleTab = useCallback((delta: number) => {
    if (tabs.length < 2) return;
    const currentIndex = Math.max(0, tabs.findIndex(tab => tab.id === activeTabId || pathnameFromHref(tab.href) === pathname));
    const next = tabs[(currentIndex + delta + tabs.length) % tabs.length];
    setActiveTabId(next.id);
    setVisible(true);
    router.push(next.href);
  }, [activeTabId, pathname, router, tabs]);

  // Keyboard: Ctrl+T -> new tab, Ctrl+W -> close, Ctrl+PageDown -> next tab.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "PageDown") {
        e.preventDefault();
        cycleTab(1);
        return;
      }
      if (e.key === "PageUp") {
        e.preventDefault();
        cycleTab(-1);
        return;
      }
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        const tab: Tab = { id: genId(), href: pathname, title: labelFromHref(pathname), created: Date.now() };
        setTabs(prev => [...prev, tab]);
        setActiveTabId(tab.id);
        setVisible(true);
      }
      if ((e.key === "w" || e.key === "W") && activeTabId) {
        e.preventDefault();
        closeTab(activeTabId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pathname, activeTabId, closeTab, cycleTab]);

  // Drag to reorder
  const onDragStart = (id: string) => {
    if (coarsePointer) return;
    setDragSrc(id);
  };
  const onDragOver  = (e: React.DragEvent, id: string) => {
    if (coarsePointer) return;
    e.preventDefault();
    if (!dragSrc || dragSrc === id) return;
    setTabs(prev => {
      const copy = [...prev];
      const fromIdx = copy.findIndex(t => t.id === dragSrc);
      const toIdx   = copy.findIndex(t => t.id === id);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const [moved] = copy.splice(fromIdx, 1);
      copy.splice(toIdx, 0, moved);
      return copy;
    });
  };

  if (!visible || tabs.length === 0) return null;

  return (
    <div className="app-tabbar" style={{
      display: "flex", alignItems: "stretch",
      borderBottom: "1px solid var(--border)",
      background: "var(--chrome-bg)",
      backdropFilter: "blur(8px)",
      overflowX: "auto",
      height: 44,
      flexShrink: 0,
      zIndex: 8,
    }}>
      {tabs.map(tab => {
        const isActive = activeTabId === tab.id || tab.href === pathname;
        return (
          <div
            key={tab.id}
            className="app-tabbar-tab"
            draggable={!coarsePointer}
            onDragStart={() => onDragStart(tab.id)}
            onDragOver={e => onDragOver(e, tab.id)}
            onDragEnd={() => setDragSrc(null)}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "0 10px 0 12px",
              minHeight: 44,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg-card)" : "transparent",
              borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              cursor: "pointer", flexShrink: 0, maxWidth: 180,
              transition: "background .12s",
            }}
          >
            <Link
              href={tab.href}
              onClick={() => setActiveTabId(tab.id)}
              style={{
                fontSize: 11, color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                textDecoration: "none", whiteSpace: "nowrap",
                overflow: "hidden", textOverflow: "ellipsis",
                maxWidth: 140, fontWeight: isActive ? 500 : 400,
              }}
              title={tab.title}
            >
              {tab.title}
            </Link>
            <button
              className="app-tabbar-close"
              type="button"
              onClick={e => { e.preventDefault(); closeTab(tab.id); }}
              title="Close tab (Ctrl+W)"
              style={{
                background: "none", border: "none", cursor: "pointer",
                width: 44, height: 44, padding: 0, color: "var(--text-muted)", lineHeight: 1,
                borderRadius: 3, flexShrink: 0,
                transition: "background .1s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-subtle)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "none"; }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
        );
      })}

      {/* New tab button */}
      <button
        className="app-tabbar-new"
        type="button"
        onClick={() => {
          const tab: Tab = { id: genId(), href: pathname, title: labelFromHref(pathname), created: Date.now() };
          setTabs(prev => [...prev, tab]);
          setActiveTabId(tab.id);
        }}
        title="New tab (Ctrl+T)"
        style={{
          background: "none", border: "none", cursor: "pointer",
          width: 44, minHeight: 44, padding: 0, color: "var(--text-muted)", fontSize: 16, lineHeight: 1,
          flexShrink: 0,
        }}
      >+</button>
    </div>
  );
}
