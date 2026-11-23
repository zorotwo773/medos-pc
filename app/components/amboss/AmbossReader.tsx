"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { Search, ChevronRight, ChevronDown, X, BookOpen, ArrowLeft, Menu } from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import { useSearchParams } from "next/navigation";
import { recordRecent } from "@/lib/useRecent";
import { saveScroll, loadScroll } from "@/lib/activity";
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

type ReaderPanelTab = "contents" | "outline" | "images" | "related";
const AMBOSS_READER_TAB_KEY = "medos.reader.amboss.panelTab";

function storedAmbossPanelTab(fallback: ReaderPanelTab): ReaderPanelTab {
  if (typeof window === "undefined") return fallback;
  const value = window.sessionStorage.getItem(AMBOSS_READER_TAB_KEY);
  return value === "contents" || value === "outline" || value === "images" || value === "related"
    ? value
    : fallback;
}

function openMedosTab(href: string, title?: string) {
  if (!href || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("TabBar:open", {
    detail: {
      href,
      title,
    },
  }));
}

interface TocNode {
  id: number;
  name: string;
  docId: number;
  section: string;
  leaf: number;
}

interface Article {
  id: number;
  title: string;
  umls?: UmlsContext | null;
}
interface UmlsCode {
  code: string;
  term?: string;
}
interface UmlsContext {
  cui: string;
  preferred_name: string;
  semantic_group?: string;
  definition?: string;
  href?: string;
  icd10cm_codes?: UmlsCode[];
}

// ─── TOC Tree ─────────────────────────────────────────────────────────────────

function TocNode({
  node,
  selectedId,
  onSelect,
}: {
  node: TocNode;
  selectedId: number | null;
  onSelect: (docId: number, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TocNode[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // leaf=0 means it IS an article (has docId), leaf=1 means folder/category
  const isLeaf = node.leaf === 0 && node.docId > 0;
  const isSelected = isLeaf && node.docId === selectedId;

  async function toggle() {
    if (isLeaf) {
      onSelect(node.docId, node.name);
      return;
    }
    if (!open) {
      if (!children) {
        try {
          const res = await fetch(`${getBackendUrl()}/amboss/toc/${node.id}`);
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
          padding: "10px 12px",
          borderRadius: 8,
          background: isSelected ? "rgba(13,191,143,0.12)" : "transparent",
          color: isSelected ? "#0DBF8F" : "var(--text-secondary)",
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 15, lineHeight: 1.4,
          transition: "background 0.15s",
        }}
      >
        {isLeaf ? (
          <BookOpen size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
        ) : open ? (
          <ChevronDown size={14} style={{ flexShrink: 0 }} />
        ) : (
          <ChevronRight size={14} style={{ flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, lineHeight: 1.4 }}>{node.name}</span>
      </button>
      {open && children && (
        <div style={{ paddingLeft: 16 }}>
          {children.map(ch => (
            <TocNode key={ch.id} node={ch} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
      {loadError && <div style={{ padding: "4px 12px 6px", fontSize: 11, color: "var(--red)" }}>Could not load this section. Select it to retry.</div>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AmbossReader() {
  const touch = useTouchInteraction();
  const { addToTray, registerContextCommand } = touch;
  const searchParams = useSearchParams();
  const [specialties, setSpecialties] = useState<TocNode[]>([]);
  const [search, setSearch]           = useState("");
  const [suggestions, setSuggestions] = useState<{ id: number; title: string }[]>([]);
  const [showSuggestions, setShowSuggestions]  = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [article, setArticle]         = useState<Article | null>(null);
  // Same article in the UWorld reference library (exact title match), if any.
  const [counterpart, setCounterpart] = useState<{ href: string; label: string; title: string } | null>(null);
  const [outline, setOutline]         = useState<OutlineItem[]>([]);
  const [articleImages, setArticleImages] = useState<ReaderImageItem[]>([]);
  const [loading, setLoading]         = useState(false);
  const [readerError, setReaderError] = useState("");
  const [articleCount, setArticleCount] = useState<number | null>(null);
  const [tocOpen, setTocOpen]         = useState(false);
  const [panelTab, setPanelTab]       = useState<ReaderPanelTab>(() => storedAmbossPanelTab("contents"));
  const [darkModeOn]                  = useDarkMode();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readerShellRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tocPanelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFocusControllerRef = useRef<ReturnType<typeof createDeferredFocusController> | null>(null);
  // ── Scroll restore: persist the iframe's scroll per article, replay on load ──
  const scrollKeyRef = useRef<string | null>(null);
  scrollKeyRef.current = article ? `amboss:${article.id}` : null;
  const restoreYRef = useRef<number | null>(null);
  const readyRef = useRef(false);
  const tryRestoreScroll = useCallback(() => {
    if (!readyRef.current) return;
    const y = restoreYRef.current;
    if (y == null) return;
    restoreYRef.current = null;   // one-shot
    if (y > 0) {
      iframeRef.current?.contentWindow?.postMessage({ type: "amboss_scroll", y }, "*");
    }
  }, []);
  const routeDocParam = searchParams.get("doc") || "";
  // Ref-based mutex: prevents stale-closure race where searchParams update (from
  // history state changes intercepted by Next.js App Router) fires the effect
  // with the old article.id before setArticle commits, causing the article to revert.
  const activeDocIdRef = useRef<number | null>(null);

  const loadArticle = useCallback((docId: number, title: string, historyMode: "push" | "replace" | "none" = "push") => {
    if (!docId) return;
    activeDocIdRef.current = docId;
    setReaderError("");
    setLoading(true);
    setShowSuggestions(false);
    setTocOpen(false); // close drawer on mobile after selecting
    setPanelTab(storedAmbossPanelTab("outline"));
    const art: Article = { id: docId, title };
    setArticle(art);
    setOutline([]);
    setArticleImages([]);
    fetch(`${getBackendUrl()}/amboss/article/${docId}/meta`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(meta => {
        if (!meta || activeDocIdRef.current !== docId) return;
        setArticle(prev => prev?.id === docId ? {
          ...prev,
          title: meta.title || prev.title,
          umls: meta.umls || null,
        } : prev);
      })
      .catch(() => setReaderError("This article's metadata could not be loaded. The local backend may still be starting."));
    recordRecent({
      tag: "AMB",
      label: title || `AMBOSS article #${docId}`,
      href: `/amboss?doc=${docId}`,
      source: "amboss",
      kind: "article",
    });
    if (historyMode === "push") {
      window.history.pushState({ docId }, title || "", `/amboss?doc=${docId}`);
    } else if (historyMode === "replace") {
      window.history.replaceState({ docId }, title || "", `/amboss?doc=${docId}`);
    }
  }, []);

  const jumpTo = useCallback((id: string) => {
    iframeRef.current?.contentWindow?.postMessage({ type: "medos_scrollto", id }, "*");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = () => fetch(`${getBackendUrl()}/amboss/specialties`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) { setSpecialties(data); setReaderError(""); } })
      .catch(() => { if (!cancelled) { setReaderError("Could not reach the local AMBOSS library. Retrying…"); retry = setTimeout(load, 3000); } });
    load();
    fetch(`${getBackendUrl()}/amboss/articles?limit=1`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled && Number.isFinite(Number(data?.total))) setArticleCount(Number(data.total)); })
      .catch(() => {});
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, []);

  // Resolve the same article in the UWorld library (exact title match).
  useEffect(() => {
    const id = article?.id;
    if (!id) { setCounterpart(null); return; }
    let alive = true;
    setCounterpart(null);
    fetch(`/api/search/counterpart?source=amboss&id=${encodeURIComponent(id)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setCounterpart(d?.counterpart ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [article?.id]);

  useEffect(() => {
    try { sessionStorage.setItem(AMBOSS_READER_TAB_KEY, panelTab); } catch { /* ignore */ }
  }, [panelTab]);

  // Report current article to backend so the extension syncs automatically
  useEffect(() => {
    if (!article?.title) return;
    fetch(`${getBackendUrl()}/session/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_term: article.title,
        current_source: "amboss",
        current_id: String(article.id),
        current_title: article.title,
        qbank_active: false,
      }),
    }).catch(() => {});
  }, [article?.id, article?.title]);

  // Listen for iframe navigation messages from decrypted articles.
  // Two shapes are accepted:
  //   { type:'amboss_navigate', id:<docId> }           — legacy/explicit
  //   { type:'amboss_navigate', lcid:'xo0EVS' }        — new, resolved via backend
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "amboss_scroll" && typeof d.y === "number") {
        if (scrollKeyRef.current) saveScroll(scrollKeyRef.current, d.y);
        return;
      }
      if (d.type === "amboss_ready") {
        readyRef.current = true;
        tryRestoreScroll();
        return;
      }
      if (d.type === "medos_outline" && Array.isArray(d.items)) {
        setOutline(d.items as OutlineItem[]);
        return;
      }
      if (d.type === "medos_article_images" && Array.isArray(d.items)) {
        setArticleImages(d.items as ReaderImageItem[]);
        return;
      }
      if (d.type !== "amboss_navigate") return;
      if (d.id) {
        loadArticle(Number(d.id), "");
        return;
      }
      if (d.lcid) {
        try {
          const r = await fetch(`${getBackendUrl()}/amboss/resolve/${encodeURIComponent(d.lcid)}`);
          if (!r.ok) return;
          const j = await r.json();
          if (j?.id) loadArticle(Number(j.id), j.title || "");
        } catch { /* no-op */ }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [loadArticle, tryRestoreScroll]);

  // On article change, arm the saved scroll position; tryRestoreScroll fires it
  // once the iframe reports "amboss_ready".
  useEffect(() => {
    readyRef.current = false;
    restoreYRef.current = null;
    const articleId = article?.id ?? null;
    const key = articleId ? `amboss:${articleId}` : null;
    if (!key) return;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    loadScroll(key).then(saved => {
      restoreYRef.current = saved?.y ?? 0;
      tryRestoreScroll();
      fallbackTimer = setTimeout(() => {
        readyRef.current = true;
        tryRestoreScroll();
      }, 1200);
    });
    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [article?.id, tryRestoreScroll]);

  // Keep the reader synced with in-app navigation. The ref guard prevents
  // user-driven history updates from immediately re-loading the same doc.
  useEffect(() => {
    const docId = Number(routeDocParam || "");
    if (docId) {
      if (activeDocIdRef.current !== docId) loadArticle(docId, "", "none");
      return;
    }
    if (activeDocIdRef.current !== null) {
      activeDocIdRef.current = null;
      setArticle(null);
      setOutline([]);
      setArticleImages([]);
      setLoading(false);
    }
  }, [loadArticle, routeDocParam]);

  // Close TOC when clicking outside on mobile
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
        const r = await fetch(`${getBackendUrl()}/amboss/autocomplete?q=${encodeURIComponent(v)}`);
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

  // Keyboard navigation for the autocomplete dropdown: Arrow keys move a
  // highlight, Enter loads the highlighted article (else falls through to the
  // form's full-text search), Escape dismisses. Mirrors the dashboard command
  // center and the UpToDate navigator so every search box behaves the same.
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
      const r = await fetch(`${getBackendUrl()}/amboss/search?q=${encodeURIComponent(search)}`);
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

  // Go back: clear article, show TOC (on mobile this re-shows the list view)
  function handleBack() {
    activeDocIdRef.current = null;
    setArticle(null);
    setOutline([]);
    setArticleImages([]);
    setLoading(false);
    window.history.replaceState(null, "", "/amboss");
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
      source: "amboss",
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
      openPrint: () => { openArticlePrint("amboss", article.id, article.title); },
    });
    const unregister = registerArticleReaderHaloCommands(commands, registerContextCommand);
    return () => {
      searchFocusControllerRef.current?.cancel();
      unregister();
    };
  }, [addToTray, article, articleImages.length, focusArticleSearch, registerContextCommand]);

  return (
    <div ref={readerShellRef} className="amboss-reader-shell reader-nav-right touch-gesture-surface">
      {/* ── Backdrop overlay when TOC drawer is open on mobile ── */}
      <div
        className={`amboss-toc-backdrop ${tocOpen ? "amboss-toc-backdrop-open" : ""}`}
        onClick={() => setTocOpen(false)}
      />

      {/* ── Left panel: TOC + Search ───────────────────────────── */}
      <div
        ref={tocPanelRef}
        className={`amboss-toc-panel ${tocOpen ? "amboss-toc-panel-open" : ""} ${article ? "amboss-toc-panel-has-article" : ""}`}
      >
        {/* Header */}
        <div className="amboss-toc-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div className="amboss-toc-icon">
              <BookOpen size={15} color="#0DBF8F" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>AMBOSS</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{articleCount == null ? "Offline clinical library" : `${articleCount.toLocaleString()} clinical articles`}</div>
            </div>
            {/* Close button visible on mobile */}
            <button
              className="amboss-toc-close"
              onClick={() => setTocOpen(false)}
              aria-label="Close navigation"
            >
              <X size={18} />
            </button>
          </div>

          {/* Search box */}
          <form onSubmit={handleSearch} style={{ position: "relative" }}>
            <Search size={15} color="var(--text-muted)" style={{
              position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
            }} />
            <input
              ref={searchInputRef}
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              placeholder="Search articles..."
              role="combobox"
              aria-expanded={showSuggestions && suggestions.length > 0}
              aria-controls="amboss-autocomplete-list"
              aria-activedescendant={suggestIndex >= 0 ? `amboss-suggestion-${suggestIndex}` : undefined}
              className="amboss-search-input"
            />
            {search && (
              <button type="button" onClick={() => { setSearch(""); setSuggestions([]); setShowSuggestions(false); }}
                style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}>
                <X size={14} />
              </button>
            )}

            {/* Autocomplete dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="amboss-autocomplete-dropdown" id="amboss-autocomplete-list" role="listbox">
                {suggestions.map((s, i) => (
                  <button
                    key={s.id}
                    id={`amboss-suggestion-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === suggestIndex}
                    onMouseEnter={() => setSuggestIndex(i)}
                    onClick={() => { setSearch(s.title); setShowSuggestions(false); setSuggestIndex(-1); loadArticle(s.id, s.title); }}
                    className="amboss-autocomplete-item"
                    style={i === suggestIndex ? { background: "var(--bg-card-hover)" } : undefined}
                  >
                    <BookOpen size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
                    {s.title}
                  </button>
                ))}
              </div>
            )}
          </form>
        </div>

        {/* Contents / Outline / Related tabs */}
        {article && (
          <div style={{ display: "flex", padding: "0 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            {(["contents", "outline", "images", "related"] as const).map(t => (
              <button key={t} type="button" onClick={() => setPanelTab(t)}
                style={{
                  flex: 1, padding: "8px 4px", fontSize: 11, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: "0.04em",
                  background: "none", border: "none", cursor: "pointer",
                  color: panelTab === t ? "#0DBF8F" : "var(--text-muted)",
                  borderBottom: panelTab === t ? "2px solid #0DBF8F" : "2px solid transparent",
                }}>
                {t === "contents" ? "Library" : t === "outline" ? "Outline" : t === "images" ? "Images" : "Related"}
              </button>
            ))}
          </div>
        )}

        {/* Library / outline / cross-source related */}
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
            <RelatedRail source="amboss" id={article.id} embedded />
          </div>
        ) : panelTab === "images" && article ? (
          <div className="amboss-toc-tree">
            <div className="reader-nav-section">Images</div>
            <ReaderImageRail
              images={articleImages}
              sourceHref={`/amboss?doc=${article.id}`}
              sourceTitle="Open AMBOSS article in MedOS tab"
            />
          </div>
        ) : (
          <div className="amboss-toc-tree">
            {article && <div className="reader-nav-section">Library</div>}
            {specialties.map(sp => (
              <TocNode
                key={sp.id} node={sp}
                selectedId={article?.id ?? null}
                onSelect={(docId, title) => loadArticle(docId, title)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Article viewer ──────────────────────────────────────────── */}
      <div className="amboss-article-main">
        {readerError && <div role="status" className="reader-load-error">{readerError}</div>}
        {loading && (
          <div className="amboss-loading-bar" />
        )}

        {article ? (
          <>
            {/* Article toolbar */}
            <div className="amboss-article-toolbar">
              <button
                className="amboss-toolbar-btn amboss-back-btn"
                onClick={handleBack}
                aria-label="Back to articles"
              >
                <ArrowLeft size={18} />
              </button>
              <span className="amboss-toolbar-title">
                {article.title}
              </span>
              {article.umls && (
                <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, overflow: "hidden", flexShrink: 1 }}>
                  <a
                    href={article.umls.href || `/umls?cui=${article.umls.cui}`}
                    target={(article.umls.href || "").startsWith("http") ? "_blank" : undefined}
                    rel="noreferrer"
                    title={article.umls.definition || article.umls.preferred_name}
                    onClick={event => {
                      const href = article.umls?.href || `/umls?cui=${article.umls?.cui}`;
                      if (!href || href.startsWith("http")) return;
                      event.preventDefault();
                      openMedosTab(href, `UMLS · ${article.umls?.preferred_name || article.umls?.cui}`);
                    }}
                    style={{ fontSize: 10.5, color: "#0f766e", textDecoration: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 190, fontWeight: 800 }}
                  >
                    {article.umls.preferred_name}
                  </a>
                  {(article.umls.icd10cm_codes || []).slice(0, 4).map(code => (
                    <span key={code.code} title={code.term || "ICD-10-CM"} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 9, color: "#0f766e", background: "rgba(20,184,166,0.12)", border: "1px solid rgba(20,184,166,0.28)", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      ICD {code.code}
                    </span>
                  ))}
                </div>
              )}
              <span className="amboss-toolbar-badge">
                AMBOSS
              </span>
              {counterpart && (
                <button
                  type="button"
                  className="amboss-toolbar-btn"
                  onClick={() => openMedosTab(counterpart.href, `${counterpart.title} · ${counterpart.label}`)}
                  title={`Open "${counterpart.title}" in ${counterpart.label}`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
                    fontSize: 11, fontWeight: 800, padding: "3px 9px", borderRadius: 999,
                    border: "1px solid color-mix(in srgb, var(--mod-uworld, #1f7ec4) 45%, transparent)", color: "var(--mod-uworld, #1f7ec4)",
                    background: "color-mix(in srgb, var(--mod-uworld, #1f7ec4) 12%, transparent)",
                  }}
                >
                  Also in {counterpart.label}
                  <ArrowLeft size={13} style={{ transform: "rotate(180deg)" }} />
                </button>
              )}
              <ArticlePrintButton
                source="amboss"
                articleId={article.id}
                title={article.title}
                frameRef={iframeRef}
                className="amboss-toolbar-btn"
              />
              <SaveToLibraryButton
                source="amboss"
                refId={article.id}
                title={article.title}
                href={`/amboss?doc=${article.id}`}
                className="amboss-toolbar-btn"
              />
              <EditCopyButton
                source="amboss"
                refId={article.id}
                title={article.title}
                className="amboss-toolbar-btn"
              />
              {/* TOC toggle button — visible on mobile only */}
              <button
                className="amboss-toolbar-btn amboss-toc-toggle"
                onClick={() => setTocOpen(!tocOpen)}
                aria-label="Toggle navigation"
              >
                <Menu size={18} />
              </button>
            </div>

            <div className="amboss-article-content">
              <iframe
                key={`${article.id}-${articleTheme}`}
                ref={iframeRef}
                // Load from the backend so relative URLs inside the decrypted
                // article (images/fonts/late base64-decoded assets) resolve
                // against localhost:8000 rather than about:srcdoc.
                src={`${getBackendUrl()}/amboss/article/${article.id}?theme=${articleTheme}`}
                sandbox="allow-scripts allow-same-origin"
                onLoad={() => setLoading(false)}
                onError={() => { setLoading(false); setReaderError("This article could not be loaded. Check the local backend and try again."); }}
                className="amboss-article-iframe"
                style={{ background: darkModeOn ? "#0f172a" : "#ffffff" }}
                title={article.title}
              />
            </div>
            <ReaderFrameMediaViewer frameRef={iframeRef} />
            <AnnotationLayer source="amboss" refId={article.id} iframeRef={iframeRef} />
          </>
        ) : (
          /* List / Welcome state — on mobile this is the primary view */
          <div className="amboss-welcome-state">
            {/* Mobile header with search */}
            <div className="amboss-mobile-header">
              <div className="amboss-toc-icon" style={{ width: 36, height: 36, borderRadius: 10 }}>
                <BookOpen size={18} color="#0DBF8F" />
              </div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}>AMBOSS</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{articleCount == null ? "Offline clinical library" : `${articleCount.toLocaleString()} clinical articles`}</div>
              </div>
            </div>

            {/* Mobile search bar */}
            <div className="amboss-mobile-search">
              <form onSubmit={handleSearch} style={{ position: "relative" }}>
                <Search size={16} color="var(--text-muted)" style={{
                  position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
                }} />
                <input
                  value={search}
                  onChange={e => handleSearchChange(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                  placeholder="Search articles..."
                  role="combobox"
                  aria-expanded={showSuggestions && suggestions.length > 0}
                  aria-controls="amboss-autocomplete-list-mobile"
                  aria-activedescendant={suggestIndex >= 0 ? `amboss-m-suggestion-${suggestIndex}` : undefined}
                  className="amboss-search-input amboss-search-input-mobile"
                />
                {search && (
                  <button type="button" onClick={() => { setSearch(""); setSuggestions([]); setShowSuggestions(false); }}
                    style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}>
                    <X size={16} />
                  </button>
                )}
                {showSuggestions && suggestions.length > 0 && (
                  <div className="amboss-autocomplete-dropdown" id="amboss-autocomplete-list-mobile" role="listbox">
                    {suggestions.map((s, i) => (
                      <button
                        key={s.id}
                        id={`amboss-m-suggestion-${i}`}
                        type="button"
                        role="option"
                        aria-selected={i === suggestIndex}
                        onMouseEnter={() => setSuggestIndex(i)}
                        onClick={() => { setSearch(s.title); setShowSuggestions(false); setSuggestIndex(-1); loadArticle(s.id, s.title); }}
                        className="amboss-autocomplete-item"
                        style={i === suggestIndex ? { background: "var(--bg-card-hover)" } : undefined}
                      >
                        <BookOpen size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
                        {s.title}
                      </button>
                    ))}
                  </div>
                )}
              </form>
            </div>

            {/* Mobile: browsable specialty list */}
            <div className="amboss-mobile-toc">
              {specialties.map(sp => (
                <TocNode
                  key={sp.id} node={sp}
                  selectedId={null}
                  onSelect={(docId, title) => loadArticle(docId, title)}
                />
              ))}
            </div>

            {/* Desktop: centered welcome */}
            <div className="amboss-welcome-center">
              <div className="amboss-welcome-icon">
                <BookOpen size={32} color="#0DBF8F" />
              </div>
              <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
                  AMBOSS Clinical Knowledge
                </p>
                <p style={{ fontSize: 14, color: "var(--text-muted)" }}>Search or browse the TOC to open an article</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes amboss-progress {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100vw); }
        }
        @keyframes amboss-slide-in {
          from { transform: translateX(-100%); }
          to   { transform: translateX(0); }
        }
        @keyframes amboss-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
