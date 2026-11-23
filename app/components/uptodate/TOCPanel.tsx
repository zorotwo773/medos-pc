"use client";
import { useState, useEffect, useRef } from "react";
import { Search, ChevronRight, ChevronDown, Clock, BookOpen, X } from "lucide-react";
import { getBackendUrl } from "@/lib/api";

interface TocNode {
  id: number;
  title: string;
  leaf: number;
  section: string;
  topicId: number | null;
}

interface HistoryItem {
  id: number;
  title: string;
}

interface Props {
  onSelectTopic: (topicId: number) => void;
  currentTopicId: number | null;
  onClose?: () => void;
}

export default function TOCPanel({ onSelectTopic, currentTopicId, onClose }: Props) {
  const [specialties, setSpecialties] = useState<TocNode[]>([]);
  const [expanded, setExpanded] = useState<Record<number, TocNode[] | "loading">>({});
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<{ topic_id: number; title: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeTab, setActiveTab] = useState<"toc" | "history">("toc");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = () => fetch(`${getBackendUrl()}/utd/specialties`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) { setSpecialties(data); setLoadError(""); } })
      .catch(() => { if (!cancelled) { setLoadError("Could not load topics. Retrying…"); retry = setTimeout(load, 3000); } });
    load();

    const h: HistoryItem[] = JSON.parse(localStorage.getItem("utd_history") || "[]");
    setHistory(h);
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, []);

  // Refresh history when a topic is selected
  useEffect(() => {
    const h: HistoryItem[] = JSON.parse(localStorage.getItem("utd_history") || "[]");
    setHistory(h);
  }, [currentTopicId]);

  function doSearch(q: string) {
    setSearchQ(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) { setSearchResults(null); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`${getBackendUrl()}/utd/search?q=${encodeURIComponent(q.trim())}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setSearchResults(await r.json());
        setLoadError("");
      } catch {
        setLoadError("Search could not reach the local backend.");
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  async function toggleNode(node: TocNode) {
    if (node.leaf === 1 && node.topicId != null) {
      onSelectTopic(node.topicId);
      return;
    }
    if (expanded[node.id]) {
      setExpanded(p => { const n = { ...p }; delete n[node.id]; return n; });
      return;
    }
    setExpanded(p => ({ ...p, [node.id]: "loading" }));
    try {
      const r = await fetch(`${getBackendUrl()}/utd/toc/${node.id}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const children: TocNode[] = await r.json();
      setExpanded(p => ({ ...p, [node.id]: children }));
      setLoadError("");
    } catch {
      setExpanded(p => { const n = { ...p }; delete n[node.id]; return n; });
      setLoadError("Could not load that topic section. Select it to retry.");
    }
  }

  function clearHistory() {
    localStorage.removeItem("utd_history");
    setHistory([]);
  }

  function renderNode(node: TocNode, depth = 0): React.ReactNode {
    const isOpen = !!expanded[node.id];
    const isLeaf = node.leaf === 1;
    const isActive = isLeaf && node.topicId === currentTopicId;
    const children = expanded[node.id];

    return (
      <div key={node.id}>
        <button
          type="button"
          data-toc-row
          onClick={() => toggleNode(node)}
          aria-expanded={isLeaf ? undefined : isOpen}
          aria-current={isActive ? "true" : undefined}
          title={node.title}
          style={{
            width: "100%", textAlign: "left", font: "inherit", border: "none",
            display: "flex", alignItems: "center", gap: 5,
            padding: `5px ${8 + depth * 14}px 5px ${8 + depth * 14}px`,
            cursor: "pointer", borderRadius: 5,
            background: isActive ? "var(--accent-glow)" : "transparent",
            color: isActive ? "var(--accent)" : "var(--text-secondary)",
          }}
          onMouseEnter={e => {
            if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--bg-card-hover)";
          }}
          onMouseLeave={e => {
            if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
        >
          {!isLeaf && (
            <span style={{ flexShrink: 0, color: "var(--text-muted)" }}>
              {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          )}
          {isLeaf && <span style={{ width: 11, flexShrink: 0 }} />}
          <span style={{
            fontSize: 12, lineHeight: 1.4,
            fontWeight: isLeaf ? 400 : 600,
            overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          }}>
            {node.title}
          </span>
        </button>

        {children === "loading" && (
          <div style={{ padding: `4px ${8 + (depth + 1) * 14}px`, fontSize: 11, color: "var(--text-muted)" }}>
            Loading…
          </div>
        )}
        {Array.isArray(children) && children.map(c => renderNode(c, depth + 1))}
      </div>
    );
  }

  return (
    <div className="utd-toc-panel" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "10px 12px 0", flexShrink: 0 }}>
        {loadError && <div role="status" style={{ marginBottom: 8, color: "var(--red)", fontSize: 11, lineHeight: 1.4 }}>{loadError}</div>}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
          <BookOpen size={13} color="var(--accent)" />
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.7px", flex: 1 }}>
            UpToDate
          </span>
          {onClose && (
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 6 }}>
              <X size={18} />
            </button>
          )}
        </div>

        {/* Search */}
        <div style={{ position: "relative", marginBottom: 8 }}>
          <Search size={11} color="var(--text-muted)" style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)" }} />
          <input
            value={searchQ}
            onChange={e => doSearch(e.target.value)}
            placeholder="Search topics…"
            style={{ width: "100%", padding: "6px 8px 6px 24px", fontSize: 11, boxSizing: "border-box" }}
          />
          {searchQ && (
            <button onClick={() => { setSearchQ(""); setSearchResults(null); }}
              style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0 }}>
              <X size={11} />
            </button>
          )}
        </div>

        {/* Tabs */}
        {!searchQ && (
          <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
            {(["toc", "history"] as const).map(t => (
              <button key={t} onClick={() => setActiveTab(t)} style={{
                flex: 1, padding: "5px 4px", fontSize: 11, fontWeight: 500,
                background: "none", border: "none", cursor: "pointer",
                color: activeTab === t ? "var(--accent)" : "var(--text-muted)",
                borderBottom: activeTab === t ? "2px solid var(--accent)" : "2px solid transparent",
              }}>
                {t === "toc" ? "Browse" : "History"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div
        style={{ flex: 1, overflow: "auto", padding: "4px 6px 12px" }}
        onKeyDown={(e) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
          const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-toc-row]"));
          if (!rows.length) return;
          e.preventDefault();
          const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            e.key === "ArrowDown" ? (idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1))
            : e.key === "ArrowUp" ? (idx < 0 ? rows.length - 1 : Math.max(0, idx - 1))
            : e.key === "Home" ? 0
            : rows.length - 1;
          rows[next]?.focus();
        }}
      >

        {/* Search results */}
        {searchQ && (
          <div>
            {searching && (
              <p style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 6px" }}>Searching…</p>
            )}
            {searchResults && searchResults.length === 0 && (
              <p style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 6px" }}>No results for &quot;{searchQ}&quot;</p>
            )}
            {searchResults && searchResults.map(r => (
              <button key={r.topic_id} type="button" data-toc-row
                onClick={() => onSelectTopic(r.topic_id)}
                aria-current={r.topic_id === currentTopicId ? "true" : undefined}
                style={{
                  width: "100%", textAlign: "left", font: "inherit", border: "none", display: "block",
                  padding: "6px 8px", cursor: "pointer", borderRadius: 5,
                  fontSize: 12, color: r.topic_id === currentTopicId ? "var(--accent)" : "var(--text-secondary)",
                  background: r.topic_id === currentTopicId ? "var(--accent-glow)" : "transparent",
                  lineHeight: 1.4,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-card-hover)"; }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background =
                    r.topic_id === currentTopicId ? "var(--accent-glow)" : "transparent";
                }}
              >
                {r.title}
              </button>
            ))}
          </div>
        )}

        {/* TOC tree */}
        {!searchQ && activeTab === "toc" && specialties.map(s => renderNode(s))}

        {/* History */}
        {!searchQ && activeTab === "history" && (
          <div>
            {history.length === 0 ? (
              <p style={{ fontSize: 11, color: "var(--text-muted)", padding: "8px 6px" }}>No reading history yet.</p>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 6px 6px" }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.6px" }}>
                    <Clock size={9} style={{ display: "inline", marginRight: 3 }} />Recent
                  </span>
                  <button onClick={clearHistory} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "var(--text-muted)" }}>
                    Clear
                  </button>
                </div>
                {history.map(h => (
                  <button key={h.id} type="button" data-toc-row
                    onClick={() => onSelectTopic(h.id)}
                    aria-current={h.id === currentTopicId ? "true" : undefined}
                    style={{
                      width: "100%", textAlign: "left", font: "inherit", border: "none", display: "block",
                      padding: "5px 8px", cursor: "pointer", borderRadius: 5,
                      fontSize: 12, color: h.id === currentTopicId ? "var(--accent)" : "var(--text-secondary)",
                      background: h.id === currentTopicId ? "var(--accent-glow)" : "transparent",
                      lineHeight: 1.4,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-card-hover)"; }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.background =
                        h.id === currentTopicId ? "var(--accent-glow)" : "transparent";
                    }}
                  >
                    {h.title}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
