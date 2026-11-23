"use client";
/**
 * GroupedResults — source-grouped search result list.
 *
 * Renders results from /search?grouped=true as vertical source sections:
 *   UpToDate (5)
 *     • Title 1
 *   AMBOSS (3)
 *     • Title 2
 *   …
 *
 * Each title is a clickable link; middle-click or Ctrl+click opens in a new
 * tab via the TabBar system (posts a custom event TabBar:open).
 */
import Link from "next/link";
import type { MouseEvent } from "react";
import { isCalculatorResult, openCalculatorResult } from "@/lib/calculatorLaunch";

export interface ResultItem {
  id:           string | number;
  title:        string;
  subtitle?:    string;
  href:         string;
  kind?:        string;
  score?:       number;
  has_black_box?: boolean;
  dose_snippet?:  string;
  brand_names?:   string;
  drug_class?:    string;
}

export interface GroupedResultData {
  firstaid?: ResultItem[];
  utd?:    ResultItem[];
  amboss?: ResultItem[];
  uworld?: ResultItem[];
  books?:  ResultItem[];
  calc?:   ResultItem[];
  lexi?:   ResultItem[];
  anatomy?: ResultItem[];
  diseases?: ResultItem[];
  qbank?:  ResultItem[];
  abbrev?: ResultItem[];
  drugs?:  ResultItem[];
}

export interface GlossaryDef {
  term:       string;
  expansion:  string;
  definition: string;
  source:     string;
  source_id?: string;
}

interface Props {
  query:      string;
  groups:     GroupedResultData;
  definition?: GlossaryDef | null;
  suggestion?: string | null;
  onSuggest?: (s: string) => void;
  onNavigate?: (href: string) => void;
}

const SOURCE_META: Record<string, { label: string; color: string }> = {
  firstaid: { label: "First Aid",     color: "#c6362a" },
  utd:    { label: "UpToDate",      color: "#0ea5e9" },
  amboss: { label: "AMBOSS",        color: "#8b5cf6" },
  uworld: { label: "UWorld",        color: "#db2777" },
  books:  { label: "Book chapters", color: "#d97706" },
  calc:   { label: "Calculators",   color: "#059669" },
  lexi:   { label: "Lexicomp",      color: "#0891b2" },
  anatomy:{ label: "Anatomy",       color: "#a855f7" },
  diseases:{ label: "Diseases",     color: "#10b981" },
  qbank:  { label: "Q-Bank",        color: "#db2777" },
  abbrev: { label: "Abbreviations", color: "#14b8a6" },
  drugs:  { label: "Drug Ref",      color: "#f43f5e" },
};

function openTab(href: string, e: MouseEvent) {
  if (e.ctrlKey || e.metaKey || e.button === 1) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href } }));
  }
}

function openFirstAidResult(item: ResultItem) {
  const raw = String(item.id || item.href || "");
  const fromHref = item.href?.match(/firstaid-(\d+)/)?.[1] || item.href?.match(/heading_id=(\d+)/)?.[1];
  const headingId = Number(fromHref || raw.replace(/\D+/g, ""));
  if (!Number.isFinite(headingId) || headingId <= 0) return false;
  window.dispatchEvent(new CustomEvent("medos:open-firstaid", { detail: { heading_id: headingId, query: item.title } }));
  return true;
}

function normalizedArticleTitle(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function pairedArticleRows(groups: GroupedResultData) {
  const ambossItems = groups.amboss || [];
  const uworldItems = groups.uworld || [];
  const uworldByTitle = new Map(uworldItems.map(item => [normalizedArticleTitle(item.title), item]));
  const pairs: { key: string; title: string; amboss: ResultItem; uworld: ResultItem }[] = [];
  for (const amboss of ambossItems) {
    const key = normalizedArticleTitle(amboss.title);
    const uworld = key ? uworldByTitle.get(key) : undefined;
    if (uworld) pairs.push({ key, title: amboss.title, amboss, uworld });
  }
  return pairs;
}

function PairedArticleSection({ pairs }: { pairs: { key: string; title: string; amboss: ResultItem; uworld: ResultItem }[] }) {
  if (!pairs.length) return null;
  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{
          display: "inline-block", width: 6, height: 6, borderRadius: "50%",
          background: "#8b5cf6", flexShrink: 0,
        }} />
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.16em",
          textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600,
        }}>
          Matched articles
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)", opacity: 0.6 }}>
          ({pairs.length})
        </span>
      </div>
      <div>
        {pairs.map(pair => (
          <div
            key={pair.key}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "7px 0", borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              {pair.title}
            </span>
            <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {[
                { item: pair.amboss, label: "AMBOSS", color: "#8b5cf6" },
                { item: pair.uworld, label: "UWORLD", color: "#db2777" },
              ].map(source => (
                <Link
                  key={`${pair.key}:${source.label}`}
                  href={source.item.href}
                  onClick={e => openTab(source.item.href, e as unknown as MouseEvent)}
                  style={{
                    minHeight: 30,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    padding: "5px 9px", borderRadius: 6,
                    border: `1px solid ${source.color}`,
                    color: source.color,
                    background: "var(--bg-card)",
                    fontFamily: "var(--font-mono)", fontSize: 9,
                    fontWeight: 900, letterSpacing: "0.1em",
                    textDecoration: "none",
                  }}
                >
                  {source.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResultRow({ item, sourceKey }: { item: ResultItem; sourceKey?: string }) {
  return (
    <Link
      href={item.href}
      onClick={e => {
        if (sourceKey === "firstaid" || item.href.startsWith("#firstaid-")) {
          e.preventDefault();
          openFirstAidResult(item);
          return;
        }
        if (isCalculatorResult(item)) {
          e.preventDefault();
          openCalculatorResult(item);
          return;
        }
        openTab(item.href, e as unknown as MouseEvent);
      }}
      style={{
        display: "flex", flexDirection: "column", gap: 1,
        padding: "7px 0", borderBottom: "1px solid var(--border)",
        textDecoration: "none", color: "inherit",
        transition: "color .12s",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--accent-strong)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "inherit"; }}
    >
      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
        {item.title}
      </span>
      {item.subtitle && (
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{item.subtitle}</span>
      )}
    </Link>
  );
}

function DrugResultRow({ item }: { item: ResultItem }) {
  return (
    <Link
      href={item.href}
      onClick={e => openTab(item.href, e as unknown as MouseEvent)}
      style={{
        display: "flex", flexDirection: "column", gap: 2,
        padding: "7px 0", borderBottom: "1px solid var(--border)",
        textDecoration: "none", color: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {item.has_black_box && (
          <span style={{
            fontSize: 8, fontWeight: 800, letterSpacing: "0.08em",
            background: "rgba(239,68,68,0.1)", color: "#ef4444",
            padding: "1px 4px", borderRadius: 3, flexShrink: 0,
          }}>BBW</span>
        )}
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          {item.title}
        </span>
        {item.brand_names && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {item.brand_names.split(",")[0]?.trim()}
          </span>
        )}
        {item.drug_class && (
          <span style={{
            fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3,
            background: "rgba(245,158,11,0.1)", color: "#d97706",
          }}>{item.drug_class.split("|")[0].slice(0, 28)}</span>
        )}
      </div>
      {item.dose_snippet && (
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {item.dose_snippet.slice(0, 70)}
        </span>
      )}
    </Link>
  );
}

function SourceSection({ sourceKey, items }: { sourceKey: string; items: ResultItem[] }) {
  if (!items || items.length === 0) return null;
  const meta = SOURCE_META[sourceKey] || { label: sourceKey, color: "#64748b" };

  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
      }}>
        <span style={{
          display: "inline-block", width: 6, height: 6, borderRadius: "50%",
          background: meta.color, flexShrink: 0,
        }} />
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.16em",
          textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600,
        }}>
          {meta.label}
        </span>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)",
          opacity: 0.6,
        }}>
          ({items.length})
        </span>
      </div>
      <div>
        {items.map(item =>
          sourceKey === "drugs"
            ? <DrugResultRow key={`${sourceKey}:${item.id}`} item={item} />
            : <ResultRow     key={`${sourceKey}:${item.id}`} item={item} sourceKey={sourceKey} />
        )}
      </div>
    </section>
  );
}

export default function GroupedResults({ query, groups, definition, suggestion, onSuggest }: Props) {
  const hasResults = Object.values(groups).some(g => g && g.length > 0);
  const articlePairs = pairedArticleRows(groups);
  const pairedKeys = new Set(articlePairs.map(pair => pair.key));
  const visibleGroups: GroupedResultData = {
    ...groups,
    amboss: groups.amboss?.filter(item => !pairedKeys.has(normalizedArticleTitle(item.title))),
    uworld: groups.uworld?.filter(item => !pairedKeys.has(normalizedArticleTitle(item.title))),
  };

  return (
    <div style={{ padding: "20px 0" }}>
      {/* Definition chip */}
      {definition && (
        <div style={{
          marginBottom: 20, padding: "10px 14px",
          background: "var(--accent-glow, rgba(14,165,233,0.06))",
          border: "1px solid rgba(14,165,233,0.2)",
          borderRadius: 8,
          display: "flex", gap: 8, alignItems: "flex-start",
        }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.14em",
            textTransform: "uppercase", color: "var(--accent-strong)",
            border: "1px solid rgba(14,165,233,0.3)",
            background: "rgba(14,165,233,0.1)",
            padding: "2px 6px", borderRadius: 3, flexShrink: 0, marginTop: 1,
          }}>{definition.source}</span>
          <div style={{ minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
              {definition.term}
            </span>
            {definition.expansion && definition.expansion !== definition.term && (
              <span style={{ fontSize: 13, color: "var(--text-secondary)", marginLeft: 6 }}>
                — {definition.expansion}
              </span>
            )}
            {definition.definition && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
                {definition.definition.slice(0, 280)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Spell suggestion */}
      {suggestion && suggestion.toLowerCase() !== query.trim().toLowerCase() && (
        <div style={{ marginBottom: 12, fontSize: 12, color: "var(--text-secondary)" }}>
          Did you mean{" "}
          <button
            type="button"
            onClick={() => onSuggest?.(suggestion)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontWeight: 600, color: "var(--accent-strong)", padding: 0, fontSize: 12,
              textDecoration: "underline",
            }}
          >
            {suggestion}
          </button>
          ?
        </div>
      )}

      {hasResults ? (
        <>
          <PairedArticleSection pairs={articlePairs} />
          {Object.entries(visibleGroups).map(([key, items]) =>
            items && items.length > 0 ? (
              <SourceSection key={key} sourceKey={key} items={items} />
            ) : null
          )}
        </>
      ) : (
        <div style={{ padding: "20px 0", fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>
          No results found for &ldquo;{query}&rdquo;.
        </div>
      )}
    </div>
  );
}
