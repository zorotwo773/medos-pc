"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Search, ChevronRight, ChevronDown, X, BookOpen, ArrowLeft, Menu } from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import { useSearchParams } from "next/navigation";
import { recordRecent } from "@/lib/useRecent";
import { useDarkMode } from "@/components/common/useDarkMode";
import ArticleOutline, { type OutlineItem } from "@/components/reader/ArticleOutline";
import ArticlePrintButton, { openArticlePrint } from "@/components/reader/ArticlePrintButton";
import ReaderImageRail, { type ReaderImageItem } from "@/components/reader/ReaderImageRail";
import ReaderFrameMediaViewer from "@/components/reader/ReaderFrameMediaViewer";
import RelatedRail from "@/components/reader/RelatedRail";
import AnnotationLayer from "@/components/custom/AnnotationLayer";
import SaveToLibraryButton from "@/components/custom/SaveToLibraryButton";
import EditCopyButton from "@/components/custom/EditCopyButton";
import {
  buildLibraryReaderHaloCommands,
  createDeferredFocusController,
  registerArticleReaderHaloCommands,
} from "@/components/reader/articleReaderHalo";
import { useTouchInteraction } from "@/components/touch/TouchInteractionProvider";
import { useMultiTouchSwipe } from "@/lib/useTouchGestures";
import { loadScroll, saveScroll } from "@/lib/activity";

type ReaderPanelTab = "contents" | "outline" | "images" | "related";
type LibraryView = "specialty" | "topics";
const UWORLD_READER_TAB_KEY = "medos.reader.uworld.panelTab";
const UWORLD_LIBRARY_VIEW_KEY = "medos.reader.uworld.libraryView";

function storedUworldPanelTab(fallback: ReaderPanelTab): ReaderPanelTab {
  if (typeof window === "undefined") return fallback;
  const value = window.sessionStorage.getItem(UWORLD_READER_TAB_KEY);
  return value === "contents" || value === "outline" || value === "images" || value === "related"
    ? value
    : fallback;
}

function storedUworldLibraryView(): LibraryView {
  if (typeof window === "undefined") return "specialty";
  return localStorage.getItem(UWORLD_LIBRARY_VIEW_KEY) === "topics" ? "topics" : "specialty";
}

// The UWorld library shares the AMBOSS reader's chrome (same `amboss-*` CSS
// classes in globals.css) — only the data source, TOC model, and branding
// differ. TOC nodes come pre-classified by the backend: specialty roots are
// folders (isArticle=false); their children are articles (isArticle=true).
interface TocNode {
  id: number;
  name: string;
  docId: number;
  isArticle: boolean;
}

interface Article {
  id: number;
  title: string;
}

const ACCENT = "#1f7ec4"; // UWorld blue

function TocNode({
  node,
  selectedId,
  onSelect,
  depth = 0,
}: {
  node: TocNode;
  selectedId: number | null;
  onSelect: (docId: number, title: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TocNode[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const isSelected = node.isArticle && node.docId === selectedId;
  // Top-level specialties read as topic section headers.
  const isTopic = !node.isArticle && depth === 0;

  async function toggle() {
    if (node.isArticle) {
      onSelect(node.docId, node.name);
      return;
    }
    if (!open) {
      if (!children) {
        try {
          const res = await fetch(`${getBackendUrl()}/uworld-library/toc/${node.id}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data: TocNode[] = await res.json();
          setChildren(data);
          setLoadError(false);
        } catch {
          setLoadError(true);
          return;
        }
      }
      setOpen(true);
    } else {
      setOpen(false);
    }
  }

  return (
    <div>
      <button
        onClick={toggle}
        className="amboss-toc-node"
        style={{
          width: "100%", textAlign: "left",
          border: "none", cursor: "pointer",
          padding: isTopic ? "9px 10px" : "10px 12px",
          marginTop: isTopic ? 6 : 0,
          borderTop: isTopic ? "1px solid var(--border)" : "none",
          borderRadius: 8,
          background: isSelected ? "rgba(31,126,196,0.12)" : "transparent",
          color: isSelected ? ACCENT : isTopic ? "var(--text-primary)" : "var(--text-secondary)",
          display: "flex", alignItems: "center", gap: 8,
          fontSize: isTopic ? 12 : 15,
          fontWeight: isTopic ? 800 : 400,
          letterSpacing: isTopic ? "0.04em" : "normal",
          textTransform: isTopic ? "uppercase" : "none",
          lineHeight: 1.4,
          transition: "background 0.15s",
        }}
      >
        {node.isArticle ? (
          <BookOpen size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
        ) : open ? (
          <ChevronDown size={isTopic ? 13 : 14} style={{ flexShrink: 0 }} />
        ) : (
          <ChevronRight size={isTopic ? 13 : 14} style={{ flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, lineHeight: 1.4 }}>{node.name}</span>
      </button>
      {open && children && (
        <div style={{ paddingLeft: depth === 0 ? 8 : 16 }}>
          {children.map(ch => (
            <TocNode key={ch.id} node={ch} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
          ))}
        </div>
      )}
      {loadError && <div style={{ padding: "4px 12px 6px", fontSize: 11, color: "var(--red)" }}>Could not load this section. Select it to retry.</div>}
    </div>
  );
}

// ─── "Topics organized" browsing ───────────────────────────────────────────
// UWorld's own TOC is flat (specialty → articles). The backend also exposes a
// discipline tree (category → main topic → article) generated once and stored
// beside the library bundle, so the same 1,529 articles can be browsed by
// subject instead of only by specialty. Existing links are left untouched.

interface OrganizedArticle {
  docId: number;
  title: string;
  position?: number;
}
interface OrganizedTopic {
  name: string;
  articleCount: number;
  articles: OrganizedArticle[];
}
interface OrganizedCategory {
  name: string;
  articleCount: number;
  topics: OrganizedTopic[];
}

function OrganizedLibraryTree({
  selectedId,
  onSelect,
}: {
  selectedId: number | null;
  onSelect: (docId: number, title: string) => void;
}) {
  const [categories, setCategories] = useState<OrganizedCategory[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  const [openTopics, setOpenTopics] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`${getBackendUrl()}/uworld-library/organized`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { categories?: OrganizedCategory[] }) => {
        if (cancelled) return;
        setCategories(Array.isArray(d?.categories) ? d.categories : []);
        setLoadError("");
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load the organized topics. The local backend may still be starting.");
      });
    return () => { cancelled = true; };
  }, []);

  const query = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!categories) return [];
    if (!query) return categories;
    const out: OrganizedCategory[] = [];
    for (const cat of categories) {
      const topics: OrganizedTopic[] = [];
      for (const topic of cat.topics) {
        const articles = topic.articles.filter(a => a.title.toLowerCase().includes(query));
        if (topic.name.toLowerCase().includes(query)) {
          topics.push(topic);
        } else if (articles.length > 0) {
          topics.push({ ...topic, articles });
        }
      }
      if (topics.length > 0) out.push({ ...cat, topics });
    }
    return out;
  }, [categories, query]);

  const forceOpen = query.length > 0;

  if (loadError) {
    return <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.45, padding: "8px 12px" }}>{loadError}</p>;
  }
  if (!categories) {
    return <p style={{ color: "var(--text-muted)", fontSize: 13, padding: "8px 12px" }}>Organizing topics…</p>;
  }

  const total = categories.reduce((n, c) => n + c.articleCount, 0);

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "0 12px 8px" }}>
        {total.toLocaleString()} articles in {categories.length} categories
      </div>
      <div style={{ padding: "0 8px 8px" }}>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter topics or articles…"
          aria-label="Filter organized topics"
          style={{
            width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: 8,
            border: "1px solid var(--border)", background: "var(--bg-card, transparent)",
            color: "var(--text-primary)", fontSize: 13, outline: "none",
          }}
        />
      </div>

      {visible.length === 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: 13, padding: "4px 12px 10px" }}>
          No topic or article matches “{filter.trim()}”.
        </p>
      )}

      {visible.map((cat, ci) => {
        const catKey = `${ci}:${cat.name}`;
        const catOpen = forceOpen || !!openCats[catKey];
        return (
          <div key={catKey}>
            <button
              type="button"
              onClick={() => setOpenCats(prev => ({ ...prev, [catKey]: !prev[catKey] }))}
              aria-expanded={catOpen}
              className="amboss-toc-node"
              style={{
                width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8,
                padding: "9px 10px", marginTop: 6, border: "none", cursor: "pointer",
                borderTop: ci === 0 ? "none" : "1px solid var(--border)", borderRadius: 8,
                background: "transparent", color: "var(--text-primary)",
                fontSize: 12, fontWeight: 800, letterSpacing: "0.04em", lineHeight: 1.4,
              }}
            >
              {catOpen ? <ChevronDown size={13} style={{ flexShrink: 0 }} /> : <ChevronRight size={13} style={{ flexShrink: 0 }} />}
              <span style={{ flex: 1 }}>{cat.name}</span>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)" }}>{cat.articleCount}</span>
            </button>

            {catOpen && (
              <div style={{ paddingLeft: 8 }}>
                {cat.topics.map((topic, ti) => {
                  const topicKey = `${catKey}|${ti}:${topic.name}`;
                  const topicOpen = forceOpen || !!openTopics[topicKey];
                  return (
                    <div key={topicKey}>
                      <button
                        type="button"
                        onClick={() => setOpenTopics(prev => ({ ...prev, [topicKey]: !prev[topicKey] }))}
                        aria-expanded={topicOpen}
                        className="amboss-toc-node"
                        style={{
                          width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 7,
                          padding: "7px 10px", border: "none", cursor: "pointer", borderRadius: 8,
                          background: "transparent", color: "var(--text-secondary)",
                          fontSize: 13.5, fontWeight: 600, lineHeight: 1.4,
                        }}
                      >
                        {topicOpen ? <ChevronDown size={13} style={{ flexShrink: 0, opacity: 0.7 }} /> : <ChevronRight size={13} style={{ flexShrink: 0, opacity: 0.7 }} />}
                        <span style={{ flex: 1 }}>{topic.name}</span>
                        <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--text-muted)" }}>{topic.articleCount}</span>
                      </button>

                      {topicOpen && (
                        <div style={{ paddingLeft: 22 }}>
                          {topic.articles.map(a => {
                            const isSelected = a.docId === selectedId;
                            return (
                              <button
                                key={a.docId}
                                type="button"
                                onClick={() => onSelect(a.docId, a.title)}
                                className="amboss-toc-node"
                                style={{
                                  width: "100%", textAlign: "left", display: "flex", alignItems: "flex-start", gap: 7,
                                  padding: "6px 10px", border: "none", cursor: "pointer", borderRadius: 7,
                                  background: isSelected ? "rgba(31,126,196,0.12)" : "transparent",
                                  color: isSelected ? ACCENT : "var(--text-secondary)",
                                  fontSize: 13, lineHeight: 1.4,
                                }}
                              >
                                <BookOpen size={12} style={{ flexShrink: 0, marginTop: 3, opacity: 0.55 }} />
                                <span style={{ flex: 1 }}>
                                  {a.position ? `${a.position}) ` : ""}
                                  {a.title}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function openMedosTab(href: string, title?: string) {
  if (!href || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href, title } }));
}

export default function UWorldLibraryReader() {
  const touch = useTouchInteraction();
  const { addToTray, registerContextCommand } = touch;
  const searchParams = useSearchParams();
  const [specialties, setSpecialties] = useState<TocNode[]>([]);
  const [search, setSearch]           = useState("");
  const [suggestions, setSuggestions] = useState<{ id: number; title: string }[]>([]);
  const [showSuggestions, setShowSuggestions]  = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [article, setArticle]         = useState<Article | null>(null);
  // Same article in the AMBOSS library (exact title match), if any.
  const [counterpart, setCounterpart] = useState<{ href: string; label: string; title: string } | null>(null);
  const [outline, setOutline]         = useState<OutlineItem[]>([]);
  const [articleImages, setArticleImages] = useState<ReaderImageItem[]>([]);
  const [loading, setLoading]         = useState(false);
  const [readerError, setReaderError] = useState("");
  const [articleCount, setArticleCount] = useState<number | null>(null);
  const [tocOpen, setTocOpen]         = useState(false);
  const [panelTab, setPanelTab]       = useState<ReaderPanelTab>(() => storedUworldPanelTab("contents"));
  const [libraryView, setLibraryView] = useState<LibraryView>(() => storedUworldLibraryView());
  const [darkModeOn]                  = useDarkMode();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readerShellRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tocPanelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFocusControllerRef = useRef<ReturnType<typeof createDeferredFocusController> | null>(null);
  const routeDocParam = searchParams.get("doc") || "";
  const activeDocIdRef = useRef<number | null>(null);
  const scrollKeyRef = useRef<string | null>(null);
  scrollKeyRef.current = article ? `uworld:${article.id}` : null;
  const restoreYRef = useRef<number | null>(null);
  const readyRef = useRef(false);
  const tryRestoreScroll = useCallback(() => {
    if (!readyRef.current || restoreYRef.current == null) return;
    const y = restoreYRef.current;
    restoreYRef.current = null;
    iframeRef.current?.contentWindow?.postMessage({ type: "medos_restore_scroll", y }, "*");
  }, []);

  const loadArticle = useCallback((docId: number, title: string, historyMode: "push" | "replace" | "none" = "push") => {
    if (!docId && docId !== 0) return;
    activeDocIdRef.current = docId;
    setReaderError("");
    setLoading(true);
    setShowSuggestions(false);
    setTocOpen(false);
    setPanelTab(storedUworldPanelTab("outline"));
    const art: Article = { id: docId, title };
    setArticle(art);
    setOutline([]);
    setArticleImages([]);
    fetch(`${getBackendUrl()}/uworld-library/article/${docId}/meta`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(meta => {
        if (!meta || activeDocIdRef.current !== docId) return;
        setArticle(prev => prev?.id === docId ? { ...prev, title: meta.title || prev.title } : prev);
      })
      .catch(() => setReaderError("This article's metadata could not be loaded. The local backend may still be starting."));
    recordRecent({
      tag: "UWL",
      label: title || `UWorld article #${docId}`,
      href: `/library/uworld?doc=${docId}`,
      source: "uworld-library",
      kind: "article",
    });
    if (historyMode === "push") {
      window.history.pushState({ docId }, title || "", `/library/uworld?doc=${docId}`);
    } else if (historyMode === "replace") {
      window.history.replaceState({ docId }, title || "", `/library/uworld?doc=${docId}`);
    }
  }, []);

  // Receive the article's heading outline from the (cross-origin) iframe via
  // postMessage, powering the "On this page" navigator.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const d = e.data;
      if (d && d.type === "medos_outline" && Array.isArray(d.items)) setOutline(d.items as OutlineItem[]);
      if (d && d.type === "medos_article_images" && Array.isArray(d.items)) setArticleImages(d.items as ReaderImageItem[]);
      if (d && d.type === "medos_reader_scroll" && d.source === "uworld-library" && Number.isFinite(Number(d.y)) && scrollKeyRef.current) {
        saveScroll(scrollKeyRef.current, Number(d.y));
      }
      if (d && d.type === "medos_reader_ready" && d.source === "uworld-library") {
        readyRef.current = true;
        tryRestoreScroll();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tryRestoreScroll]);

  const jumpTo = useCallback((id: string) => {
    iframeRef.current?.contentWindow?.postMessage({ type: "medos_scrollto", id }, "*");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = () => fetch(`${getBackendUrl()}/uworld-library/specialties`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) { setSpecialties(data); setReaderError(""); } })
      .catch(() => { if (!cancelled) { setReaderError("Could not reach the local library. Retrying…"); retry = setTimeout(load, 3000); } });
    load();
    fetch(`${getBackendUrl()}/uworld-library/articles?limit=1`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled && Number.isFinite(Number(data?.total))) setArticleCount(Number(data.total)); })
      .catch(() => {});
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, []);

  useEffect(() => {
    readyRef.current = false;
    restoreYRef.current = null;
    const key = article?.id ? `uworld:${article.id}` : null;
    if (!key) return;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    loadScroll(key).then(saved => {
      restoreYRef.current = saved?.y ?? 0;
      tryRestoreScroll();
      fallback = setTimeout(() => { readyRef.current = true; tryRestoreScroll(); }, 1200);
    });
    return () => { if (fallback) clearTimeout(fallback); };
  }, [article?.id, darkModeOn, tryRestoreScroll]);

  // Resolve the same article in the AMBOSS library (exact title match).
  useEffect(() => {
    const id = article?.id;
    if (!id) { setCounterpart(null); return; }
    let alive = true;
    setCounterpart(null);
    fetch(`/api/search/counterpart?source=uworld&id=${encodeURIComponent(id)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setCounterpart(d?.counterpart ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [article?.id]);

  useEffect(() => {
    try { sessionStorage.setItem(UWORLD_READER_TAB_KEY, panelTab); } catch { /* ignore */ }
  }, [panelTab]);

  useEffect(() => {
    try { localStorage.setItem(UWORLD_LIBRARY_VIEW_KEY, libraryView); } catch { /* ignore */ }
  }, [libraryView]);

  useEffect(() => {
    if (!article?.title) return;
    fetch(`${getBackendUrl()}/session/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_term: article.title,
        current_source: "uworld-library",
        current_id: String(article.id),
        current_title: article.title,
        qbank_active: false,
      }),
    }).catch(() => {});
  }, [article?.id, article?.title]);

  // Keep the reader synced with in-app navigation (the ?doc= query param).
  useEffect(() => {
    if (routeDocParam === "") {
      if (activeDocIdRef.current !== null) {
        activeDocIdRef.current = null;
        setArticle(null);
        setOutline([]);
        setArticleImages([]);
        setLoading(false);
      }
      return;
    }
    const docId = Number(routeDocParam);
    if (Number.isFinite(docId) && activeDocIdRef.current !== docId) loadArticle(docId, "", "none");
  }, [loadArticle, routeDocParam]);

  useEffect(() => {
    if (!tocOpen) return;
    function handleClickOutside(e: MouseEvent | TouchEvent) {
      if (tocPanelRef.current && !tocPanelRef.current.contains(e.target as Node)) {
        setTocOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [tocOpen]);

  useEffect(() => {
    const openReaderTools = () => {
      setTocOpen(prev => {
        if (!prev) setPanelTab(tab => article ? (tab === "contents" ? "outline" : tab) : "contents");
        return !prev;
      });
    };
    window.addEventListener("medos:reader-tools-toggle", openReaderTools);
    return () => window.removeEventListener("medos:reader-tools-toggle", openReaderTools);
  }, [article]);

  function handleSearchChange(v: string) {
    setSearch(v);
    setSuggestIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!v.trim()) { setSuggestions([]); setShowSuggestions(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`${getBackendUrl()}/uworld-library/autocomplete?q=${encodeURIComponent(v)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        setSuggestions(d);
        setSuggestIndex(-1);
        setShowSuggestions(true);
        setReaderError("");
      } catch {
        setReaderError("Search is unavailable while the local backend starts. Try again shortly.");
      }
    }, 200);
  }

  // Arrow keys move a highlight, Enter loads the highlighted article (else the
  // form's full-text search runs), Escape dismisses — same as AMBOSS / UpToDate.
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === "Escape") setShowSuggestions(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestIndex(i => Math.min(suggestions.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestIndex(i => Math.max(-1, i - 1));
    } else if (e.key === "Enter" && suggestIndex >= 0 && suggestIndex < suggestions.length) {
      e.preventDefault();
      const s = suggestions[suggestIndex];
      setSearch(s.title);
      setShowSuggestions(false);
      setSuggestIndex(-1);
      loadArticle(s.id, s.title);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setSuggestIndex(-1);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!search.trim()) return;
    try {
      const r = await fetch(`${getBackendUrl()}/uworld-library/search?q=${encodeURIComponent(search)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setSuggestions(d);
      setSuggestIndex(-1);
      setShowSuggestions(true);
      setReaderError("");
    } catch {
      setReaderError("Search could not reach the local backend. Try again shortly.");
    }
  }

  function handleBack() {
    activeDocIdRef.current = null;
    setArticle(null);
    setOutline([]);
    setArticleImages([]);
    setLoading(false);
    window.history.replaceState(null, "", "/library/uworld");
  }

  const articleTheme = darkModeOn ? "dark" : "light";

  useMultiTouchSwipe(readerShellRef, {
    fingers: 2,
    disabled: tocOpen,
    ignoreSelector: ".amboss-toc-panel, .amboss-article-toolbar, iframe",
    onSwipeLeft: () => window.history.forward(),
    onSwipeRight: () => window.history.back(),
    onSwipeUp: () => window.dispatchEvent(new CustomEvent("medos:reader-tools-toggle")),
  });

  useMultiTouchSwipe(readerShellRef, {
    fingers: 3,
    disabled: tocOpen,
    ignoreSelector: ".amboss-toc-panel, .amboss-article-toolbar, iframe",
    onSwipeLeft: () => window.history.forward(),
    onSwipeRight: () => window.history.back(),
    onSwipeUp: () => window.dispatchEvent(new CustomEvent("medos:open-command-center")),
  });

  const focusArticleSearch = useCallback(() => {
    if (!searchFocusControllerRef.current) {
      searchFocusControllerRef.current = createDeferredFocusController(
        callback => window.requestAnimationFrame(callback),
        frameId => window.cancelAnimationFrame(frameId),
      );
    }
    searchFocusControllerRef.current.schedule(() => searchInputRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!article) {
      searchFocusControllerRef.current?.cancel();
      return;
    }
    const commands = buildLibraryReaderHaloCommands({
      source: "uworld",
      articleId: article.id,
      title: article.title,
      hasImages: articleImages.length > 0,
      openPanel: tab => {
        setPanelTab(tab);
        setTocOpen(true);
      },
      focusSearch: focusArticleSearch,
      returnToReading: () => {
        searchFocusControllerRef.current?.cancel();
        setTocOpen(false);
      },
      addToTray: descriptor => { addToTray(descriptor); },
      openPrint: () => { openArticlePrint("uworld", article.id, article.title); },
    });
    const unregister = registerArticleReaderHaloCommands(commands, registerContextCommand);
    return () => {
      searchFocusControllerRef.current?.cancel();
      unregister();
    };
  }, [addToTray, article, articleImages.length, focusArticleSearch, registerContextCommand]);

  return (
    <div ref={readerShellRef} className="amboss-reader-shell reader-nav-right touch-gesture-surface">
      <div
        className={`amboss-toc-backdrop ${tocOpen ? "amboss-toc-backdrop-open" : ""}`}
        onClick={() => setTocOpen(false)}
      />

      <div
        ref={tocPanelRef}
        className={`amboss-toc-panel ${tocOpen ? "amboss-toc-panel-open" : ""} ${article ? "amboss-toc-panel-has-article" : ""}`}
      >
        <div className="amboss-toc-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div className="amboss-toc-icon">
              <BookOpen size={15} color={ACCENT} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>UWorld Library</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{articleCount == null ? "Offline reference library" : `${articleCount.toLocaleString()} reference articles`}</div>
            </div>
            <button className="amboss-toc-close" onClick={() => setTocOpen(false)} aria-label="Close navigation">
              <X size={18} />
            </button>
          </div>

          <form onSubmit={handleSearch} style={{ position: "relative" }}>
            <Search size={15} color="var(--text-muted)" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }} />
            <input
              ref={searchInputRef}
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              placeholder="Search articles..."
              role="combobox"
              aria-expanded={showSuggestions && suggestions.length > 0}
              aria-controls="uworld-autocomplete-list"
              aria-activedescendant={suggestIndex >= 0 ? `uworld-suggestion-${suggestIndex}` : undefined}
              className="amboss-search-input"
            />
            {search && (
              <button type="button" onClick={() => { setSearch(""); setSuggestions([]); setShowSuggestions(false); }}
                style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}>
                <X size={14} />
              </button>
            )}
            {showSuggestions && suggestions.length > 0 && (
              <div className="amboss-autocomplete-dropdown" id="uworld-autocomplete-list" role="listbox">
                {suggestions.map((s, i) => (
                  <button key={s.id} id={`uworld-suggestion-${i}`} type="button" role="option" aria-selected={i === suggestIndex}
                    onMouseEnter={() => setSuggestIndex(i)}
                    onClick={() => { setSearch(s.title); setShowSuggestions(false); setSuggestIndex(-1); loadArticle(s.id, s.title); }}
                    className="amboss-autocomplete-item"
                    style={i === suggestIndex ? { background: "var(--bg-card-hover)" } : undefined}>
                    <BookOpen size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
                    {s.title}
                  </button>
                ))}
              </div>
            )}
          </form>
        </div>

        {article && (
          <div style={{ display: "flex", padding: "0 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            {(["contents", "outline", "images", "related"] as const).map(t => (
              <button key={t} type="button" onClick={() => setPanelTab(t)}
                style={{
                  flex: 1, padding: "8px 4px", fontSize: 11, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: "0.04em",
                  background: "none", border: "none", cursor: "pointer",
                  color: panelTab === t ? ACCENT : "var(--text-muted)",
                  borderBottom: panelTab === t ? `2px solid ${ACCENT}` : "2px solid transparent",
                }}>
                {t === "contents" ? "Library" : t === "outline" ? "Outline" : t === "images" ? "Images" : "Related"}
              </button>
            ))}
          </div>
        )}

        {panelTab === "outline" && article ? (
          <div className="amboss-toc-tree">
            {outline.length > 0 ? (
              <>
                <div className="reader-nav-section">On this page</div>
                <ArticleOutline items={outline} onJump={jumpTo} />
              </>
            ) : (
              <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.45, padding: "8px 12px" }}>
                Outline will appear after the article finishes loading.
              </p>
            )}
          </div>
        ) : panelTab === "related" && article ? (
          <div className="amboss-toc-tree">
            <RelatedRail source="uworld" id={article.id} embedded />
          </div>
        ) : panelTab === "images" && article ? (
          <div className="amboss-toc-tree">
            <div className="reader-nav-section">Images</div>
            <ReaderImageRail
              images={articleImages}
              sourceHref={`/library/uworld?doc=${article.id}`}
              sourceTitle="Open UWorld article in MedOS tab"
            />
          </div>
        ) : (
          <div className="amboss-toc-tree">
            {article && <div className="reader-nav-section">Library</div>}
            <div role="tablist" aria-label="Library organization" style={{ display: "flex", gap: 4, padding: "2px 4px 8px" }}>
              {(["specialty", "topics"] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={libraryView === v}
                  onClick={() => setLibraryView(v)}
                  style={{
                    flex: 1, padding: "7px 8px", borderRadius: 7, cursor: "pointer",
                    fontSize: 11.5, fontWeight: 700, letterSpacing: "0.02em", lineHeight: 1.2,
                    border: `1px solid ${libraryView === v ? ACCENT : "var(--border)"}`,
                    background: libraryView === v ? "rgba(31,126,196,0.12)" : "transparent",
                    color: libraryView === v ? ACCENT : "var(--text-muted)",
                  }}
                >
                  {v === "specialty" ? "By specialty" : "Topics organized"}
                </button>
              ))}
            </div>
            {libraryView === "topics" ? (
              <OrganizedLibraryTree
                selectedId={article?.id ?? null}
                onSelect={(docId, title) => loadArticle(docId, title)}
              />
            ) : (
              specialties.map(sp => (
                <TocNode key={sp.id} node={sp} selectedId={article?.id ?? null} onSelect={(docId, title) => loadArticle(docId, title)} />
              ))
            )}
          </div>
        )}
      </div>

      <div className="amboss-article-main">
        {readerError && <div role="status" className="reader-load-error">{readerError}</div>}
        {loading && <div className="amboss-loading-bar" />}

        {article ? (
          <>
            <div className="amboss-article-toolbar">
              <button className="amboss-toolbar-btn amboss-back-btn" onClick={handleBack} aria-label="Back to articles">
                <ArrowLeft size={18} />
              </button>
              <span className="amboss-toolbar-title">{article.title}</span>
              <span className="amboss-toolbar-badge" style={{ background: "rgba(31,126,196,0.14)", color: ACCENT }}>UWORLD</span>
              {counterpart && (
                <button
                  type="button"
                  className="amboss-toolbar-btn"
                  onClick={() => openMedosTab(counterpart.href, `${counterpart.title} · ${counterpart.label}`)}
                  title={`Open "${counterpart.title}" in ${counterpart.label}`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
                    fontSize: 11, fontWeight: 800, padding: "3px 9px", borderRadius: 999,
                    border: "1px solid rgba(13,191,143,0.45)", color: "var(--mod-amboss, #0DBF8F)",
                    background: "color-mix(in srgb, var(--mod-amboss, #0DBF8F) 12%, transparent)",
                  }}
                >
                  Also in {counterpart.label}
                  <ArrowLeft size={13} style={{ transform: "rotate(180deg)" }} />
                </button>
              )}
              <ArticlePrintButton
                source="uworld"
                articleId={article.id}
                title={article.title}
                frameRef={iframeRef}
                className="amboss-toolbar-btn"
              />
              <SaveToLibraryButton
                source="uworld"
                refId={article.id}
                title={article.title}
                href={`/library/uworld?doc=${article.id}`}
                className="amboss-toolbar-btn"
              />
              <EditCopyButton
                source="uworld"
                refId={article.id}
                title={article.title}
                className="amboss-toolbar-btn"
              />
              <button className="amboss-toolbar-btn amboss-toc-toggle" onClick={() => setTocOpen(!tocOpen)} aria-label="Toggle navigation">
                <Menu size={18} />
              </button>
            </div>

            <div className="amboss-article-content">
              <iframe
                key={`${article.id}-${articleTheme}`}
                ref={iframeRef}
                src={`${getBackendUrl()}/uworld-library/article/${article.id}?theme=${articleTheme}`}
                sandbox="allow-scripts allow-same-origin"
                onLoad={() => setLoading(false)}
                onError={() => { setLoading(false); setReaderError("This article could not be loaded. Check the local backend and try again."); }}
                className="amboss-article-iframe"
                style={{ background: darkModeOn ? "#0f172a" : "#ffffff" }}
                title={article.title}
              />
            </div>
            <ReaderFrameMediaViewer frameRef={iframeRef} />
            <AnnotationLayer source="uworld" refId={article.id} iframeRef={iframeRef} />
          </>
        ) : (
          <div className="amboss-welcome-state">
            <div className="amboss-mobile-header">
              <div className="amboss-toc-icon" style={{ width: 36, height: 36, borderRadius: 10 }}>
                <BookOpen size={18} color={ACCENT} />
              </div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}>UWorld Library</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{articleCount == null ? "Offline reference library" : `${articleCount.toLocaleString()} reference articles`}</div>
              </div>
            </div>

            <div className="amboss-mobile-search">
              <form onSubmit={handleSearch} style={{ position: "relative" }}>
                <Search size={16} color="var(--text-muted)" style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }} />
                <input
                  value={search}
                  onChange={e => handleSearchChange(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                  placeholder="Search articles..."
                  role="combobox"
                  aria-expanded={showSuggestions && suggestions.length > 0}
                  aria-controls="uworld-autocomplete-list-mobile"
                  aria-activedescendant={suggestIndex >= 0 ? `uworld-m-suggestion-${suggestIndex}` : undefined}
                  className="amboss-search-input amboss-search-input-mobile"
                />
                {search && (
                  <button type="button" onClick={() => { setSearch(""); setSuggestions([]); setShowSuggestions(false); }}
                    style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}>
                    <X size={16} />
                  </button>
                )}
                {showSuggestions && suggestions.length > 0 && (
                  <div className="amboss-autocomplete-dropdown" id="uworld-autocomplete-list-mobile" role="listbox">
                    {suggestions.map((s, i) => (
                      <button key={s.id} id={`uworld-m-suggestion-${i}`} type="button" role="option" aria-selected={i === suggestIndex}
                        onMouseEnter={() => setSuggestIndex(i)}
                        onClick={() => { setSearch(s.title); setShowSuggestions(false); setSuggestIndex(-1); loadArticle(s.id, s.title); }}
                        className="amboss-autocomplete-item"
                        style={i === suggestIndex ? { background: "var(--bg-card-hover)" } : undefined}>
                        <BookOpen size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
                        {s.title}
                      </button>
                    ))}
                  </div>
                )}
              </form>
            </div>

            <div className="amboss-mobile-toc">
              {specialties.map(sp => (
                <TocNode key={sp.id} node={sp} selectedId={null} onSelect={(docId, title) => loadArticle(docId, title)} />
              ))}
            </div>

            <div className="amboss-welcome-center">
              <div className="amboss-welcome-icon">
                <BookOpen size={32} color={ACCENT} />
              </div>
              <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
                  UWorld Reference Library
                </p>
                <p style={{ fontSize: 14, color: "var(--text-muted)" }}>Search or browse the TOC to open an article</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
