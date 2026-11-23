"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import ArticleViewer from "./ArticleViewer";
import GraphicDrawer from "./GraphicDrawer";
import { getBackendUrl } from "@/lib/api";
import { useSearchParams } from "next/navigation";
import { recordRecent } from "@/lib/useRecent";

export interface RelatedTopic {
  id: number;
  title: string;
  subtype: string;
}

export interface RelatedGraphic {
  id: number;
  title: string;
  label: string;
  subtype: string;
}

export interface UTDTopic {
  topic_id: number;
  title: string;
  toc_path: string[];
  content_url: string;
  outline_html?: string;
  related_topics?: RelatedTopic[];
  related_graphics?: RelatedGraphic[];
  umls?: UmlsContext | null;
}
export interface UmlsCode {
  code: string;
  term?: string;
}
export interface UmlsContext {
  cui: string;
  preferred_name: string;
  semantic_group?: string;
  definition?: string;
  href?: string;
  icd10cm_codes?: UmlsCode[];
}

interface UTDSearchHit {
  topic_id: number;
  title: string;
}

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "in", "of", "or", "the", "to", "with",
  "adult", "adults", "patient", "patients",
]);

const SEARCH_STOP_WORDS = new Set([
  ...QUERY_STOP_WORDS,
  "approach", "diagnosis", "diagnostic", "evaluation", "initial",
  "management", "new", "onset", "workup",
]);

function topicTokens(value: string, stopWords = QUERY_STOP_WORDS) {
  return value
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter(token => token.length > 2 && !stopWords.has(token)) || [];
}

function topicSearchQueries(value: string) {
  const cleaned = value.replace(/[–—:]/g, " ").replace(/\s+/g, " ").trim();
  const keywords = topicTokens(cleaned, SEARCH_STOP_WORDS);
  const queries = [cleaned];
  if (keywords.length) {
    queries.push(keywords.join(" "));
    if (keywords.length > 3) queries.push(keywords.slice(-3).join(" "));
    if (keywords.length > 2) queries.push(keywords.slice(-2).join(" "));
  }
  return Array.from(new Set(queries.filter(q => q.length >= 2)));
}

function scoreTopicHit(query: string, hit: UTDSearchHit) {
  const title = hit.title.toLowerCase();
  const queryLower = query.toLowerCase();
  const tokens = topicTokens(query);
  let score = 0;
  if (title.includes(queryLower)) score += 100;
  for (const token of tokens) {
    if (title.includes(token)) score += 18;
  }
  for (const cue of ["approach", "diagnosis", "evaluation", "initial", "management"]) {
    if (queryLower.includes(cue) && title.includes(cue)) score += 16;
  }
  if (/^calculator:/i.test(hit.title)) score -= 80;
  return score - hit.title.length * 0.02;
}

// Only these known public backend messages may be displayed verbatim. Other
// responses can contain proxy HTML, file paths or exception details.
const PUBLIC_CONTENT_ERRORS = new Set([
  "UpToDate content could not be decrypted or validated. Check UTD_PASSWORD for this content bundle or repair the installed content pack. The content key is separate from the download ZIP password.",
  "Set UTD_PASSWORD to this bundle's content key. The download ZIP password is separate. Thumbnails remain available without it.",
  "UpToDate content is unreadable; repair the installed content pack.",
]);

async function topicFailureMessage(response: Response): Promise<string> {
  if (response.status === 401) return "Your MedOS session has expired or you are signed out. Sign in again, then retry this topic.";
  if (response.status === 403) return "Access to this topic was denied. Sign in with an authorized MedOS account and check the desktop's network access settings.";
  let detail: unknown;
  try {
    detail = (await response.json())?.detail;
  } catch {
    // Error pages and malformed responses use the safe status-based fallback.
  }
  if (response.status === 404) {
    if (detail === "This topic has no article content in the installed UpToDate bundle.") {
      return `${detail} Choose another topic; preparing the same source cannot add missing article text.`;
    }
    return "This topic is not available in the installed UpToDate bundle. Choose another topic, or verify the content pack in Content Manager.";
  }
  if (response.status === 503 && typeof detail === "string" && detail.length <= 500 && PUBLIC_CONTENT_ERRORS.has(detail)) return detail;
  if (response.status === 503) return "UpToDate content is unavailable. Check that MedOS is running, then verify the UpToDate pack in Content Manager and retry.";
  return `The local service could not load this topic (HTTP ${response.status}). Retry; if it persists, save diagnostics from Setup.`;
}

export default function UpToDateReader() {
  const searchParams = useSearchParams();
  const [currentTopic, setCurrentTopic] = useState<UTDTopic | null>(null);
  const [loading, setLoading] = useState(false);
  const [readerError, setReaderError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const [isPhone, setIsPhone] = useState(false);
  const [graphicId, setGraphicId] = useState<number | null>(null);
  const routeTopicParam = searchParams.get("t") || "";
  const routeGraphicParam = searchParams.get("g") || "";
  const routeQueryParam = (searchParams.get("q") || "").trim();

  // Ref-based mutex: prevents concurrent/duplicate loads regardless of render timing.
  // Using a ref (not state) so guard checks are always against the latest value,
  // even before React commits a new render cycle.
  const activeTopicIdRef = useRef<number | null>(null);
  const activeQueryRef = useRef("");

  const loadTopic = useCallback(async (topicId: number, historyMode: "push" | "replace" | "none" = "push") => {
    if (activeTopicIdRef.current === topicId) return;
    activeTopicIdRef.current = topicId;
    setReaderError("");
    setLoading(true);
    let responseReceived = false;
    try {
      const r = await fetch(`${getBackendUrl()}/utd/topic/${topicId}`);
      responseReceived = true;
      if (!r.ok) {
        activeTopicIdRef.current = null;
        setReaderError(await topicFailureMessage(r));
        return;
      }
      const meta = await r.json();
      const contentUrl = `${getBackendUrl()}${meta.content_url}`;
      const data: UTDTopic = { ...meta, content_url: contentUrl };
      setCurrentTopic(data);
      recordRecent({
        tag: "UTD",
        label: data.title,
        href: `/uptodate?t=${topicId}`,
        source: "uptodate",
        kind: "article",
      });
      try {
        if (historyMode === "push") {
          window.history.pushState({ topicId }, data.title, `/uptodate?t=${topicId}`);
        } else if (historyMode === "replace") {
          window.history.replaceState({ topicId }, data.title, `/uptodate?t=${topicId}`);
        }
      } catch {
        // Browser history is optional; the fetched article is already readable.
      }
      try {
        const key = "utd_history";
        const prev = JSON.parse(localStorage.getItem(key) || "[]");
        const deduped = Array.isArray(prev) ? prev.filter(h => h && h.id !== topicId) : [];
        deduped.unshift({ id: topicId, title: data.title });
        localStorage.setItem(key, JSON.stringify(deduped.slice(0, 20)));
      } catch {
        // Blocked/full storage or old invalid history must not hide the article.
      }
    } catch {
      activeTopicIdRef.current = null;
      setReaderError(responseReceived
        ? "The local service returned an unreadable topic response. Retry; if it persists, save diagnostics from Setup."
        : "Could not reach the local MedOS service. Check that MedOS is running and this device is connected, then retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Report current topic to backend so the extension syncs automatically
  useEffect(() => {
    if (!currentTopic?.title) return;
    fetch(`${getBackendUrl()}/session/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_term: currentTopic.title,
        current_source: "utd",
        current_id: String(currentTopic.topic_id),
        current_title: currentTopic.title,
        qbank_active: false,
      }),
    }).catch(() => {});
  }, [currentTopic?.topic_id, currentTopic?.title]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const sync = () => setIsPhone(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const resolveTopicQuery = useCallback(async (query: string) => {
    const seen = new Set<number>();
    const hits: UTDSearchHit[] = [];
    for (const candidate of topicSearchQueries(query)) {
      const r = await fetch(`${getBackendUrl()}/utd/search?q=${encodeURIComponent(candidate)}&limit=80`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as UTDSearchHit[];
      for (const hit of data) {
        const topicId = Number(hit.topic_id || "");
        if (!topicId || seen.has(topicId)) continue;
        seen.add(topicId);
        hits.push(hit);
      }
      if (hits.length >= 20) break;
    }
    hits.sort((a, b) => scoreTopicHit(query, b) - scoreTopicHit(query, a));
    return Number(hits[0]?.topic_id || "");
  }, []);

  // Keep the reader synced with in-app navigation. The ref guards prevent the
  // replaceState call in loadTopic from immediately re-loading the same topic.
  useEffect(() => {
    const requestedGraphic = Number(routeGraphicParam || "");
    if (requestedGraphic) {
      setGraphicId(current => current === requestedGraphic ? current : requestedGraphic);
    } else {
      setGraphicId(null);
    }

    const requestedTopic = Number(routeTopicParam || "");
    if (requestedTopic) {
      activeQueryRef.current = "";
      if (activeTopicIdRef.current !== requestedTopic) void loadTopic(requestedTopic, "none");
      return;
    }

    if (routeQueryParam.length >= 2) {
      const queryKey = routeQueryParam.toLowerCase();
      if (activeQueryRef.current === queryKey && activeTopicIdRef.current !== null) return;
      activeQueryRef.current = queryKey;
      setLoading(true);
      resolveTopicQuery(routeQueryParam)
        .then(async topicId => {
          if (topicId) await loadTopic(topicId, "replace");
          else setReaderError(`No offline UpToDate topic matched “${routeQueryParam}”.`);
        })
        .catch(e => {
          console.error("Failed to resolve topic query:", e);
          activeTopicIdRef.current = null;
          setReaderError("Topic search could not reach the local backend.");
        })
        .finally(() => setLoading(false));
      return;
    }

    activeQueryRef.current = "";
    if (activeTopicIdRef.current !== null || currentTopic !== null) {
      activeTopicIdRef.current = null;
      setCurrentTopic(null);
      setLoading(false);
    }
  }, [currentTopic, loadTopic, resolveTopicQuery, retryToken, routeGraphicParam, routeQueryParam, routeTopicParam]);

  return (
    <div className="utd-reader-shell" style={{ flex: 1, display: "flex", height: "100%", overflow: "hidden", position: "relative" }}>

      {/* Topic browser now lives as a "Topics" tab inside ArticleViewer's
          unified side panel — no separate left drawer. */}

      {/* Centre: article + sidebar */}
      <div className="utd-reader-content" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Toolbar */}
        <div className="utd-reader-toolbar" style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "7px 14px", borderBottom: "1px solid var(--border)",
          background: "var(--bg-card)", flexShrink: 0,
        }}>
          {currentTopic && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0, overflow: "hidden" }}>
                {currentTopic.toc_path.map((seg, i) => (
                  <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                    {i > 0 && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>/</span>}
                    <span style={{
                      fontSize: 11,
                      color: i === currentTopic.toc_path.length - 1 ? "var(--text-secondary)" : "var(--text-muted)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      maxWidth: 160,
                    }}>{seg}</span>
                  </span>
                ))}
              </div>
            </>
          )}
          {!currentTopic && isPhone && (
            <span className="utd-mobile-toolbar-title">Find a topic</span>
          )}
        </div>

        {readerError && (
          <div role="alert" className="reader-load-error" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span>{readerError}</span>
            <button type="button" className="btn-ghost" onClick={() => setRetryToken(value => value + 1)}>Retry</button>
          </div>
        )}

        <ArticleViewer
          topic={currentTopic}
          loading={loading}
          onTopicLink={loadTopic}
          onGraphicLink={setGraphicId}
        />
      </div>

      {/* Graphic drawer */}
      {graphicId !== null && (
        <GraphicDrawer graphicId={graphicId} onClose={() => setGraphicId(null)} />
      )}
    </div>
  );
}
