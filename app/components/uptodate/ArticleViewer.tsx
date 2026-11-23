"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain, Copy, Check, ChevronLeft, ChevronRight, Send, X,
  FileText, Link2, Image as ImageIcon, Search, List, Layers,
} from "lucide-react";
import type { UTDTopic, RelatedTopic, RelatedGraphic } from "./UpToDateReader";
import { getBackendUrl } from "@/lib/api";
import { saveScroll, loadScroll } from "@/lib/activity";
import { useDarkMode } from "@/components/common/useDarkMode";
import ArticlePrintButton, { openArticlePrint } from "@/components/reader/ArticlePrintButton";
import RelatedRail from "@/components/reader/RelatedRail";
import ReaderFrameMediaViewer from "@/components/reader/ReaderFrameMediaViewer";
import AnnotationLayer from "@/components/custom/AnnotationLayer";
import SaveToLibraryButton from "@/components/custom/SaveToLibraryButton";
import EditCopyButton from "@/components/custom/EditCopyButton";
import {
  buildUtdReaderHaloCommands,
  registerArticleReaderHaloCommands,
} from "@/components/reader/articleReaderHalo";
import { useTouchInteraction } from "@/components/touch/TouchInteractionProvider";
import TOCPanel from "./TOCPanel";
import { isEditableTouchTarget, useMultiTouchSwipe } from "@/lib/useTouchGestures";

interface AiMsg {
  role: "user" | "assistant";
  content: string;
}

type SideTab = "topics" | "outline" | "related" | "libraries" | "ai";
const UTD_READER_TAB_KEY = "medos.reader.uptodate.sideTab";
const UTD_READER_FIND_KEY = "medos.reader.uptodate.findQ";

function storedUtdSideTab(fallback: SideTab): SideTab {
  if (typeof window === "undefined") return fallback;
  const value = window.sessionStorage.getItem(UTD_READER_TAB_KEY);
  return value === "topics" || value === "outline" || value === "related" || value === "libraries" || value === "ai"
    ? value
    : fallback;
}

function storedUtdFindQuery() {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(UTD_READER_FIND_KEY) || "";
}

function isUsableSideTab(tab: SideTab, topic: UTDTopic | null) {
  if (!topic) return tab === "topics";
  if (tab === "outline") return !!topic.outline_html;
  if (tab === "related") return (topic.related_topics?.length ?? 0) + (topic.related_graphics?.length ?? 0) > 0;
  return true;
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

interface Props {
  topic: UTDTopic | null;
  loading: boolean;
  onTopicLink: (topicId: number) => void;
  onGraphicLink: (graphicId: number) => void;
}

export default function ArticleViewer({ topic, loading, onTopicLink, onGraphicLink }: Props) {
  const touch = useTouchInteraction();
  const { addToTray, registerContextCommand } = touch;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const articleShellRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [offlineNotice, setOfflineNotice] = useState("");
  const lastY = useRef(0);
  // ── Scroll restore: persist the iframe's scroll per topic, replay on load ──
  const scrollKeyRef = useRef<string | null>(null);
  scrollKeyRef.current = topic ? `utd:${topic.topic_id}` : null;
  const restoreYRef = useRef<number | null>(null);   // null = not yet resolved
  const readyRef = useRef(false);
  const tryRestoreScroll = useCallback(() => {
    if (!readyRef.current) return;
    const y = restoreYRef.current;
    if (y == null) return;
    restoreYRef.current = null;   // one-shot
    if (y > 0) {
      iframeRef.current?.contentWindow?.postMessage({ type: "utd-scroll", y }, "*");
    }
  }, []);
  const [sideTab, setSideTab] = useState<SideTab>(() => storedUtdSideTab("outline"));
  const [sideOpen, setSideOpen] = useState(false);
  const [aiChat, setAiChat] = useState<AiMsg[]>([]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [isPhone, setIsPhone] = useState(false);
  const [outlineSheet, setOutlineSheet] = useState(false);
  const [findBar, setFindBar] = useState(false);
  const [findQ, setFindQ] = useState(storedUtdFindQuery);
  const [darkModeOn] = useDarkMode();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [ddxLinks, setDdxLinks] = useState<any[]>([]);

  const showOfflineNotice = useCallback((message = "This link is not available in the offline reader.") => {
    setOfflineNotice(message);
    window.setTimeout(() => setOfflineNotice(""), 5000);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const sync = () => setIsPhone(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Open sidebar & switch to outline when a new topic loads
  useEffect(() => {
    if (topic?.topic_id) {
      setSideOpen(!isPhone);
      const fallback = topic.outline_html ? "outline" : "topics";
      const saved = storedUtdSideTab(fallback);
      setSideTab(isUsableSideTab(saved, topic) ? saved : fallback);
      setAiChat([]);

      // Fetch bidirectional DDx links
      fetch(`${getBackendUrl()}/utdddx/by-utd?utd_id=${topic.topic_id}`)
        .then(r => r.json())
        .then(d => setDdxLinks(d.topics || []))
        .catch(() => setDdxLinks([]));
    } else {
      setDdxLinks([]);
    }
  }, [topic?.topic_id, isPhone]);

  useEffect(() => {
    try { sessionStorage.setItem(UTD_READER_TAB_KEY, sideTab); } catch { /* ignore */ }
  }, [sideTab]);

  useEffect(() => {
    try { sessionStorage.setItem(UTD_READER_FIND_KEY, findQ); } catch { /* ignore */ }
  }, [findQ]);

  useEffect(() => {
    const openReaderTools = () => {
      if (!topic) return;
      setSideOpen(prev => {
        if (!prev) {
          setOutlineSheet(false);
          setSideTab(topic.outline_html ? "outline" : "topics");
        }
        return !prev;
      });
    };
    window.addEventListener("medos:reader-tools-toggle", openReaderTools);
    return () => window.removeEventListener("medos:reader-tools-toggle", openReaderTools);
  }, [topic]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl/Cmd+F opens MedOS find-in-topic instead of the browser page find.
      if ((!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "f" || isEditableTouchTarget(event.target)) return;
      if (!topic) return;
      event.preventDefault();
      setFindBar(true);
      setOutlineSheet(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [topic]);

  useMultiTouchSwipe(articleShellRef, {
    fingers: 2,
    disabled: !topic || sideOpen || outlineSheet,
    ignoreSelector: ".utd-article-toolbar, .utd-side-panel, .utd-find-bar, iframe",
    onSwipeLeft: () => window.history.forward(),
    onSwipeRight: () => window.history.back(),
    onSwipeUp: () => setSideOpen(true),
  });

  useMultiTouchSwipe(articleShellRef, {
    fingers: 3,
    disabled: !topic || outlineSheet,
    ignoreSelector: ".utd-article-toolbar, .utd-side-panel, .utd-find-bar, iframe",
    onSwipeLeft: () => window.history.forward(),
    onSwipeRight: () => window.history.back(),
    onSwipeUp: () => window.dispatchEvent(new CustomEvent("medos:open-command-center")),
  });

  useEffect(() => {
    if (!topic) return;
    const hasImages = (topic.related_graphics?.length ?? 0) > 0;
    const hasRelated = hasImages || (topic.related_topics?.length ?? 0) > 0;
    const openRelatedPanel = () => {
      setSideOpen(true);
      setSideTab("related");
      setOutlineSheet(false);
    };
    const commands = buildUtdReaderHaloCommands({
      articleId: topic.topic_id,
      title: topic.title,
      hasOutline: !!topic.outline_html,
      hasImages,
      hasRelated,
      openContents: tab => {
        setSideOpen(true);
        setSideTab(tab);
        setOutlineSheet(false);
      },
      openFind: () => {
        setFindBar(true);
        setOutlineSheet(false);
      },
      openImages: openRelatedPanel,
      openRelated: openRelatedPanel,
      returnToReading: () => {
        setSideOpen(false);
        setOutlineSheet(false);
        setFindBar(false);
      },
      addToTray: descriptor => { addToTray(descriptor); },
      openPrint: () => { openArticlePrint("utd", topic.topic_id, topic.title); },
    });
    return registerArticleReaderHaloCommands(commands, registerContextCommand);
  }, [addToTray, registerContextCommand, topic]);

  // Scroll AI chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [aiChat]);

  // On topic change, arm the saved scroll position; tryRestoreScroll fires it
  // once the iframe reports "utd-ready" (so the document is tall enough).
  useEffect(() => {
    readyRef.current = false;
    restoreYRef.current = null;
    const topicId = topic?.topic_id ?? null;
    const key = topicId ? `utd:${topicId}` : null;
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
  }, [topic?.topic_id, tryRestoreScroll]);

  // The iframe remounts when the theme changes. Preserve the live position and
  // replay it after the replacement document reports ready.
  useEffect(() => {
    if (!topic?.topic_id) return;
    restoreYRef.current = lastY.current;
    readyRef.current = false;
  }, [darkModeOn, topic?.topic_id]);

  // postMessage bridge from iframe
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      switch (d.type) {
        case "utd-app": {
          const meta = d.data?.meta ?? {};
          const entries = Array.isArray(d.data?.data) ? d.data.data : [];
          const first = entries[0] ?? {};

          if (meta.assetType === "graphic") {
            const gid = Number(meta.graphicId ?? first.id);
            if (gid) onGraphicLink(gid);
            break;
          }

          if (meta.assetType === "topic" || meta.assetType === "abstract") {
            const tid = Number(meta.topicId ?? first.id);
            if (tid) onTopicLink(tid);
            break;
          }

          if (first.type === "external" && first.url) {
            showOfflineNotice("External UpToDate links are not available in the offline reader.");
          }
          break;
        }
        case "utd-resource":
          showOfflineNotice("Contributors and disclosure pages are not included in the offline library.");
          break;
        case "utd-web":
          showOfflineNotice("This UpToDate web action is not available in the offline reader.");
          break;
        case "utd-external":
          showOfflineNotice("External links are not opened from the offline reader.");
          break;
        case "utd-ready": {
          readyRef.current = true;
          tryRestoreScroll();
          break;
        }
        case "utd-scroll": {
          const y = Number(d.y);
          if (Number.isFinite(y)) {
            if (y > 60 && y > lastY.current + 15) setIsScrolled(true);
            else if (y < lastY.current - 15 || y < 60) setIsScrolled(false);
            lastY.current = y;
            if (scrollKeyRef.current) saveScroll(scrollKeyRef.current, y);
          }
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onTopicLink, onGraphicLink, showOfflineNotice, tryRestoreScroll]);

  function scrollIframeTo(sectionId: string) {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "utd-scroll", section: sectionId }, "*"
    );
  }

  function handleOutlineClick(e: React.MouseEvent<HTMLDivElement>) {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";

    // appAction call in the href
    const m = href.match(/appAction\((.+)\)/);
    if (m) {
      try {
        const decoded = m[1].replace(/&quot;/g, '"');
        const action = JSON.parse(decoded);
        const section = action?.meta?.section;
        if (section) scrollIframeTo(section);
      } catch {}
      return;
    }
    // plain hash anchor
    if (href.startsWith("#")) {
      scrollIframeTo(href.slice(1));
    }
  }

  async function sendAiQuestion() {
    if (!aiInput.trim() || !topic) return;
    const q = aiInput.trim();
    setAiInput("");
    setAiChat(p => [...p, { role: "user", content: q }]);
    setAiLoading(true);
    try {
      const r = await fetch(`${getBackendUrl()}/ai/tutor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, context: topic.title, chapter_title: topic.title }),
      });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setAiChat(p => [...p, { role: "assistant", content: d.answer }]);
    } catch (e) {
      setAiChat(p => [...p, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
    } finally {
      setAiLoading(false);
    }
  }

  function copyCitation() {
    if (!topic) return;
    const citation = `${topic.title}. UpToDate. Accessed ${new Date().toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric",
    })}.`;
    navigator.clipboard.writeText(citation);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Loading skeleton
  if (loading) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ flex: 1, padding: "28px 40px", overflow: "auto" }}>
          {[180, 80, 220, 60, 200, 90, 160, 70].map((w, i) => (
            <div key={i} style={{
              height: i % 3 === 0 ? 22 : 14,
              width: `${w}px`, maxWidth: "100%",
              background: "var(--border)", borderRadius: 4,
              marginBottom: i % 3 === 0 ? 18 : 10,
              opacity: 0.6,
              animation: "pulse 1.5s ease-in-out infinite",
            }} />
          ))}
        </div>
      </div>
    );
  }

  // Empty state — the topic browser IS the single side panel here, so browsing
  // still works now that the separate left drawer is gone.
  if (!topic) {
    return (
      <div className="utd-article-shell" style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {!isPhone && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            color: "var(--text-muted)", gap: 14,
          }}>
            <div style={{
              width: 64, height: 64, borderRadius: 16,
              background: "rgba(0,133,124,0.08)",
              border: "1px solid rgba(0,133,124,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <Brain size={28} color="#00857c" />
            </div>
            <div style={{ textAlign: "center" }}>
              <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-secondary)", margin: "0 0 6px" }}>
                Select a topic to read
              </p>
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                Browse or search topics in the panel
              </p>
            </div>
          </div>
        )}
        <div className="utd-article-sidepanel" style={{
          width: isPhone ? "100%" : 300,
          borderLeft: isPhone ? "none" : "1px solid var(--border)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-sidebar)", flexShrink: 0,
        }}>
          <TOCPanel onSelectTopic={onTopicLink} currentTopicId={null} />
        </div>
      </div>
    );
  }

  const hasOutline = !!topic.outline_html;
  const hasRelated = (topic.related_topics?.length ?? 0) + (topic.related_graphics?.length ?? 0) > 0;

  const SIDE_W = 280;
  const themedContentUrl = `${topic.content_url}${topic.content_url.includes("?") ? "&" : "?"}theme=${darkModeOn ? "dark" : "light"}`;

  return (
    <div ref={articleShellRef} className="utd-article-shell touch-gesture-surface" style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {offlineNotice && (
        <div role="status" aria-live="polite" style={{
          position: "absolute", top: 52, left: "50%", transform: "translateX(-50%)",
          zIndex: 30, maxWidth: "min(520px, calc(100% - 32px))", padding: "10px 14px",
          borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-card)",
          boxShadow: "var(--shadow-lg)", color: "var(--text-secondary)", fontSize: 12,
        }}>
          {offlineNotice}
        </div>
      )}

      {/* ── Article body ── */}
      <div className="utd-article-main" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Toolbar */}
        <div className={`utd-article-toolbar ${isPhone && isScrolled ? "is-hidden" : ""}`} style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "5px 14px", borderBottom: "1px solid var(--border)",
          background: "var(--bg-base)", flexShrink: 0, overflowX: "auto",
          transition: "margin-top 0.3s ease",
          marginTop: isPhone && isScrolled ? "-56px" : "0",
        }}>
          <button className="utd-history-button" onClick={() => window.history.back()} title="Back"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "3px 5px", display: "flex", flexShrink: 0 }}>
            <ChevronLeft size={15} />
          </button>
          <button className="utd-history-button" onClick={() => window.history.forward()} title="Forward"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "3px 5px", display: "flex", flexShrink: 0 }}>
            <ChevronRight size={15} />
          </button>

          <div className="utd-mobile-article-title" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "40vw", flexShrink: 0 }}>{topic.title}</div>
          {topic.umls && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, flexShrink: 1, overflow: "hidden" }}>
              <a
                href={topic.umls.href || `/umls?cui=${topic.umls.cui}`}
                target={(topic.umls.href || "").startsWith("http") ? "_blank" : undefined}
                rel="noreferrer"
                title={topic.umls.definition || topic.umls.preferred_name}
                onClick={event => {
                  const href = topic.umls?.href || `/umls?cui=${topic.umls?.cui}`;
                  if (!href || href.startsWith("http")) return;
                  event.preventDefault();
                  openMedosTab(href, `UMLS · ${topic.umls?.preferred_name || topic.umls?.cui}`);
                }}
                style={{ fontSize: 10.5, color: "#0f766e", textDecoration: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180, fontWeight: 700 }}
              >
                {topic.umls.preferred_name}
              </a>
              {(topic.umls.icd10cm_codes || []).slice(0, 4).map(code => (
                <span key={code.code} title={code.term || "ICD-10-CM"} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 9, color: "#0f766e", background: "rgba(20,184,166,0.12)", border: "1px solid rgba(20,184,166,0.28)", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
                  ICD {code.code}
                </span>
              ))}
            </div>
          )}
          {ddxLinks.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: 8 }}>
              {ddxLinks.map(dx => (
                <button
                  key={dx.id}
                  onClick={() => openMedosTab(dx.href, `DDx: ${dx.title}`)}
                  style={{
                    display: "flex", alignItems: "center", gap: 4, padding: "2px 8px",
                    background: "rgba(124, 58, 237, 0.1)", color: "#7c3aed",
                    border: "1px solid rgba(124, 58, 237, 0.3)", borderRadius: 4,
                    fontSize: 10, fontWeight: 700, cursor: "pointer", textTransform: "uppercase"
                  }}
                  title={`View Differential Diagnosis: ${dx.title}`}
                >
                  <Layers size={10} />
                  DDX
                </button>
              ))}
            </div>
          )}
          <div className="utd-article-toolbar-spacer" style={{ flex: 1 }} />

          {/* Sidebar tab toggles (desktop only — mobile uses bottom bar) */}
          {!isPhone && <>
          <SaveToLibraryButton
            source="utd"
            refId={topic.topic_id}
            title={topic.title}
            href={`/uptodate?t=${topic.topic_id}`}
          />
          <EditCopyButton
            source="utd"
            refId={topic.topic_id}
            title={topic.title}
          />
          <ArticlePrintButton
            source="utd"
            articleId={topic.topic_id}
            title={topic.title}
            frameRef={iframeRef}
          />
          {[
            { tab: "topics" as SideTab, icon: <List size={11} />, label: "Topics", show: true },
            { tab: "outline" as SideTab, icon: <FileText size={11} />, label: "Outline", show: hasOutline },
            { tab: "related" as SideTab, icon: <Link2 size={11} />, label: "Related", show: hasRelated },
            { tab: "libraries" as SideTab, icon: <Layers size={11} />, label: "Libraries", show: true },
            { tab: "ai" as SideTab, icon: <Brain size={11} />, label: "AI Ask", show: true },
          ].filter(t => t.show).map(({ tab, icon, label }) => {
            const active = sideOpen && sideTab === tab;
            return (
              <button key={tab}
                onClick={() => { if (sideOpen && sideTab === tab) setSideOpen(false); else { setSideOpen(true); setSideTab(tab); } }}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "4px 9px", fontSize: 11,
                  background: active ? "rgba(0,133,124,0.1)" : "var(--bg-card)",
                  border: `1px solid ${active ? "rgba(0,133,124,0.3)" : "var(--border)"}`,
                  borderRadius: 5, cursor: "pointer",
                  color: active ? "#00857c" : "var(--text-secondary)",
                }}
              >
                {icon}<span>{label}</span>
              </button>
            );
          })}

          <button onClick={copyCitation} title="Copy citation"
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 9px", fontSize: 11,
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 5, cursor: "pointer",
              color: copied ? "#00857c" : "var(--text-secondary)",
            }}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? "Copied!" : "Cite"}</span>
          </button>
          </>}
        </div>

        {/* Find-in-topic bar (mobile) */}
        {findBar && (
          <div className="utd-find-bar">
            <Search size={14} color="var(--text-muted)" />
            <input
              autoFocus
              value={findQ}
              onChange={e => setFindQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && findQ.trim()) {
                  iframeRef.current?.contentWindow?.postMessage(
                    { type: "utd-find", query: findQ.trim() }, "*"
                  );
                }
              }}
              placeholder="Find in topic…"
            />
            <button onClick={() => { setFindBar(false); }}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}>
              <X size={16} />
            </button>
          </div>
        )}

        {/* iframe */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden", WebkitOverflowScrolling: "touch" }}>
          <iframe
            ref={iframeRef}
            key={`${topic.topic_id}-${darkModeOn ? "dark" : "light"}`}
            src={themedContentUrl}
            style={{ position: "absolute", top: 0, left: 0, border: "none", width: "100%", height: "100%", background: darkModeOn ? "#0f172a" : "#fff" }}
            sandbox="allow-scripts allow-same-origin"
            title={topic.title}
          />
        </div>
        <ReaderFrameMediaViewer frameRef={iframeRef} />
        <AnnotationLayer source="utd" refId={topic.topic_id} iframeRef={iframeRef} />

        {/* ── Mobile bottom action bar (matches UTD APK) ── */}
        {isPhone && (
          <div className="utd-mobile-bottom-bar">
            <button onClick={() => { setSideOpen(true); setSideTab("topics"); setOutlineSheet(false); }}>
              <List size={18} />
              <span>Topics</span>
            </button>
            {hasOutline && (
              <button onClick={() => { setOutlineSheet(v => !v); setSideOpen(false); }}
                className={outlineSheet ? "is-active" : ""}>
                <FileText size={18} />
                <span>Outline</span>
              </button>
            )}
            <button onClick={() => { setFindBar(v => !v); setOutlineSheet(false); }}>
              <Search size={18} />
              <span>Find</span>
            </button>
            {hasRelated && (
              <button onClick={() => { setSideOpen(true); setSideTab("related"); setOutlineSheet(false); }}>
                <Link2 size={18} />
                <span>Related</span>
              </button>
            )}
            <button onClick={() => { setSideOpen(true); setSideTab("ai"); setOutlineSheet(false); }}>
              <Brain size={18} />
              <span>AI Ask</span>
            </button>
            <button onClick={copyCitation}
              className={copied ? "is-active" : ""}>
              {copied ? <Check size={18} /> : <Copy size={18} />}
              <span>{copied ? "Copied" : "Cite"}</span>
            </button>
            <ArticlePrintButton
              source="utd"
              articleId={topic.topic_id}
              title={topic.title}
              frameRef={iframeRef}
              compact
            />
          </div>
        )}
      </div>

      {/* ── Right sidebar ── */}
      {sideOpen && (
        <>
        <button
          className="utd-article-side-scrim"
          type="button"
          aria-label="Close article tools"
          onClick={() => setSideOpen(false)}
        />
        <div className={`utd-article-sidepanel${isPhone ? " is-open-mobile" : ""}`} style={{
          width: SIDE_W, borderLeft: "1px solid var(--border)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-sidebar)", flexShrink: 0,
        }}>
          {/* Sidebar header with tabs */}
          <div style={{
            padding: "0 4px",
            borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center",
            flexShrink: 0,
          }}>
            {[
              { tab: "topics" as SideTab, label: "Topics", show: true },
              { tab: "outline" as SideTab, label: "Outline", show: hasOutline },
              { tab: "related" as SideTab, label: "Related", show: hasRelated },
              { tab: "libraries" as SideTab, label: "Libraries", show: true },
              { tab: "ai" as SideTab, label: "AI Ask", show: true },
            ].filter(t => t.show).map(({ tab, label }) => (
              <button key={tab} onClick={() => setSideTab(tab)} style={{
                flex: 1, padding: "9px 4px", fontSize: 11, fontWeight: 500,
                background: "none", border: "none", cursor: "pointer",
                color: sideTab === tab ? "#00857c" : "var(--text-muted)",
                borderBottom: sideTab === tab ? "2px solid #00857c" : "2px solid transparent",
                transition: "color 0.15s",
              }}>
                {label}
              </button>
            ))}
            <button onClick={() => setSideOpen(false)} style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-muted)", padding: "4px 6px", flexShrink: 0,
            }}>
              <X size={13} />
            </button>
          </div>

          {/* ── Topics browser tab (merged-in from the old left drawer) ── */}
          {sideTab === "topics" && (
            <div style={{ flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
              <TOCPanel onSelectTopic={onTopicLink} currentTopicId={topic.topic_id} />
            </div>
          )}

          {/* ── Outline tab ── */}
          {sideTab === "outline" && (
            <div
              onClick={handleOutlineClick}
              style={{ flex: 1, overflow: "auto", padding: "8px 6px" }}
              dangerouslySetInnerHTML={{ __html: topic.outline_html || "" }}
            />
          )}

          {/* ── Related tab ── */}
          {sideTab === "related" && (
            <div style={{ flex: 1, overflow: "auto", padding: "8px 8px 16px" }}>
              {/* Related topics */}
              {(topic.related_topics?.length ?? 0) > 0 && (
                <section style={{ marginBottom: 16 }}>
                  <h4 style={{
                    fontSize: 10, fontWeight: 700, color: "var(--text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.7px",
                    margin: "0 0 6px 2px",
                  }}>
                    Related Topics
                  </h4>
                  {topic.related_topics!.map(rt => (
                    <RelatedTopicRow key={rt.id} topic={rt} onClick={() => onTopicLink(rt.id)} />
                  ))}
                </section>
              )}

              {/* Related graphics */}
              {(topic.related_graphics?.length ?? 0) > 0 && (
                <section>
                  <h4 style={{
                    fontSize: 10, fontWeight: 700, color: "var(--text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.7px",
                    margin: "0 0 8px 2px",
                  }}>
                    Figures &amp; Tables
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {topic.related_graphics!.map(rg => (
                      <GraphicCard key={rg.id} graphic={rg} onClick={() => onGraphicLink(rg.id)} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* ── Across-libraries tab (cross-source concept matches) ── */}
          {sideTab === "libraries" && (
            <div style={{ flex: 1, overflow: "auto", padding: "4px 8px 16px" }}>
              <RelatedRail source="utd" id={topic.topic_id} embedded />
            </div>
          )}

          {/* ── AI Ask tab ── */}
          {sideTab === "ai" && (
            <>
              <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
                {aiChat.length === 0 && (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", marginTop: 20 }}>
                    Ask any question about this article
                  </p>
                )}
                {aiChat.map((m, i) => (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3, textTransform: "uppercase" }}>
                      {m.role}
                    </div>
                    <div style={{
                      padding: "8px 11px", borderRadius: 8,
                      background: m.role === "user" ? "#00857c" : "var(--bg-card)",
                      border: m.role === "assistant" ? "1px solid var(--border)" : "none",
                      fontSize: 13, lineHeight: 1.55,
                      color: m.role === "user" ? "white" : "var(--text-primary)",
                    }}>
                      {m.content}
                    </div>
                  </div>
                ))}
                {aiLoading && (
                  <div style={{ padding: "8px 11px", borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border)", fontSize: 13, color: "var(--text-muted)" }}>
                    Thinking…
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
              <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    value={aiInput}
                    onChange={e => setAiInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") sendAiQuestion(); }}
                    placeholder="Ask about this topic…"
                    style={{ flex: 1, padding: "7px 10px", fontSize: 12 }}
                  />
                  <button
                    onClick={sendAiQuestion}
                    disabled={aiLoading || !aiInput.trim()}
                    className="btn-primary"
                    style={{ padding: "7px 10px" }}
                  >
                    <Send size={12} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        </>
      )}

      {/* ── Mobile outline bottom sheet ── */}
      {isPhone && outlineSheet && hasOutline && (
        <>
          <div onClick={() => setOutlineSheet(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 39 }} />
          <div className={`utd-mobile-outline-sheet${outlineSheet ? " is-open" : ""}`}>
            <div className="sheet-handle" />
            <div className="sheet-header">
              <h3>SUMMARY</h3>
              <button onClick={() => setOutlineSheet(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}>
                <X size={18} />
              </button>
            </div>
            <div className="sheet-body"
              onClick={e => { handleOutlineClick(e); setOutlineSheet(false); }}
              dangerouslySetInnerHTML={{ __html: topic?.outline_html || "" }}
            />
          </div>
        </>
      )}

      <style>{`
        /* Outline styles — scoped to the sidebar */
        .utdTopicOutline { font-size: 12px; line-height: 1.5; }
        .utdTopicOutline h2 { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.7px; margin: 0 0 6px 0; }
        .utdTopicOutline ul { list-style: none; padding: 0; margin: 0; }
        .utdTopicOutline li { margin: 0; }
        .utdTopicOutline a {
          display: block; padding: 6px 10px; border-radius: 5px;
          color: var(--text-secondary); text-decoration: none;
          transition: background 0.1s, color 0.1s;
          font-size: 13px; line-height: 1.5;
          min-height: 36px; display: flex; align-items: center;
        }
        .utdTopicOutline a:hover { background: var(--bg-card-hover); color: var(--text-primary); }
        .utdTopicOutline .sr-button > a { font-weight: 600; font-size: 12px; color: #00857c; text-transform: uppercase; letter-spacing: 0.5px; }
        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50%       { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function RelatedTopicRow({ topic, onClick }: { topic: RelatedTopic; onClick: () => void }) {
  const subtypeLabel: Record<string, string> = {
    medical_review: "Review",
    medical_basics: "Basics",
    medical_society_guidelines: "Guideline",
    medical_calculator: "Calculator",
  };
  const badge = subtypeLabel[topic.subtype] || topic.subtype;

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "flex-start", gap: 7,
        padding: "6px 8px", borderRadius: 6, cursor: "pointer",
        marginBottom: 2,
        transition: "background 0.1s",
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-card-hover)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <FileText size={11} color="var(--accent)" style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>
          {topic.title}
        </div>
        {badge && (
          <span style={{
            fontSize: 9, fontWeight: 600,
            color: "var(--accent)", opacity: 0.7,
            textTransform: "uppercase", letterSpacing: "0.5px",
          }}>
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

function GraphicCard({ graphic, onClick }: { graphic: RelatedGraphic; onClick: () => void }) {
  const base = getBackendUrl();
  const thumbUrl = `${base}/utd/thumb/${graphic.id}`;

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", gap: 9, alignItems: "flex-start",
        padding: "6px 8px", borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--border)",
        background: "var(--bg-card)",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = "var(--accent)";
        e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,133,124,0.1)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <GraphicThumb thumbUrl={thumbUrl} alt={graphic.title} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>
          {graphic.title}
        </div>
        {graphic.label && (
          <span style={{
            fontSize: 10, color: "var(--text-muted)",
            marginTop: 2, display: "block",
          }}>
            {graphic.label}
          </span>
        )}
      </div>
    </div>
  );
}

function GraphicThumb({ thumbUrl, alt }: { thumbUrl: string; alt: string }) {
  const [err, setErr] = useState(false);
  return err ? (
    <div style={{
      width: 44, height: 44, flexShrink: 0, borderRadius: 4,
      background: "var(--bg-base)", border: "1px solid var(--border)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <ImageIcon size={16} color="var(--text-muted)" />
    </div>
  ) : (
    <img
      src={thumbUrl}
      alt={alt}
      onError={() => setErr(true)}
      style={{
        width: 44, height: 44, flexShrink: 0, borderRadius: 4,
        objectFit: "cover", background: "#f5f5f5",
      }}
    />
  );
}
