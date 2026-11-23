"use client";

import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, RefreshCw, Search } from "lucide-react";
import SearchFilters from "./SearchFilters";
import SearchResultCard from "./SearchResultCard";
import { getBackendUrl } from "@/lib/api";
import { buildPreviewSearchParams } from "@/lib/searchInteraction.mjs";
import {
  beginSearchRequest,
  applySearchPage,
  buildSearchHref,
  buildSearchPageParams,
  canAutoLoadSearchResults,
  createSearchResultsState,
  failSearchRequest,
  firstReturnedCui,
  parseSearchResultsUrl,
  searchRequestKey,
} from "@/lib/searchResultsState.mjs";
import type { SearchFilters as Filters, SearchPagePayload, SearchResultsState } from "@/lib/searchResultsState";
import type { RelatedMediaSummary } from "./SearchMediaSection";

interface ResolvedConcept {
  cui: string;
  preferred_name: string;
  semantic_group?: string;
  href?: string;
}

interface AutocompleteResult {
  title?: string;
}

interface AutocompletePayload {
  suggestions?: string[];
  results?: AutocompleteResult[];
}

const LazySearchConceptGraph = dynamic(() => import("./SearchConceptGraph"), {
  ssr: false,
  loading: () => <div className="search-enrichment-placeholder" role="status">Preparing concept view…</div>,
});
const LazySearchMediaSection = dynamic(() => import("./SearchMediaSection"), {
  ssr: false,
  loading: () => <div className="search-enrichment-placeholder" role="status">Preparing media view…</div>,
});

function useVisibilityGate(rootMargin = "500px 0px") {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin, visible]);
  return { ref, visible };
}

export default function SearchResultsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseSearchResultsUrl(searchParams.toString()) as Filters, [searchParams]);
  const filterKey = useMemo(() => searchRequestKey(filters), [filters]);
  const [draft, setDraft] = useState(filters.query);
  const [autocompleteItems, setAutocompleteItems] = useState<string[]>([]);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(-1);
  const [state, setState] = useState<SearchResultsState>(() => createSearchResultsState(filters) as SearchResultsState);
  const [queryConcept, setQueryConcept] = useState<ResolvedConcept | null>(null);
  const [relatedMedia, setRelatedMedia] = useState<RelatedMediaSummary>({ images: 0, tables: 0, total: 0 });
  const stateRef = useRef(state);
  const searchAbortRef = useRef<AbortController | null>(null);
  const conceptAbortRef = useRef<AbortController | null>(null);
  const autocompleteAbortRef = useRef<AbortController | null>(null);
  const loadMoreSentinel = useRef<HTMLDivElement | null>(null);
  const { ref: graphRef, visible: graphVisible } = useVisibilityGate();

  const publishState = useCallback((next: SearchResultsState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const fetchPage = useCallback(async (nextFilters: Filters, requestedOffset: number) => {
    const request = beginSearchRequest(stateRef.current, nextFilters, requestedOffset);
    publishState(request.state);
    if (!nextFilters.query) return;

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const requestUrl = `${getBackendUrl()}/search/page?${buildSearchPageParams(nextFilters, request.offset, 20)}`;
    try {
      const response = await fetch(requestUrl, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(problem?.detail || `Search request failed (${response.status})`);
      }
      const payload = await response.json() as SearchPagePayload;
      publishState(applySearchPage(stateRef.current, request.token, payload));
    } catch (error) {
      if (controller.signal.aborted) return;
      publishState(failSearchRequest(
        stateRef.current,
        request.token,
        error instanceof Error ? error.message : "Search is unavailable.",
      ));
    }
  }, [publishState]);

  useEffect(() => {
    setDraft(filters.query);
    if (!filters.query) {
      searchAbortRef.current?.abort();
      publishState(createSearchResultsState(filters) as SearchResultsState);
      return;
    }
    void fetchPage(filters, 0);
    return () => searchAbortRef.current?.abort();
  }, [fetchPage, filterKey, filters, publishState]);

  useEffect(() => {
    autocompleteAbortRef.current?.abort();
    const query = draft.trim();
    if (!autocompleteOpen || query.length < 1) {
      setAutocompleteItems([]);
      setAutocompleteIndex(-1);
      return;
    }

    const controller = new AbortController();
    autocompleteAbortRef.current = controller;
    const timer = window.setTimeout(async () => {
      const scopes = filters.scopes.length ? filters.scopes.join(",") : "all";
      const params = buildPreviewSearchParams(query, scopes);
      try {
        const response = await fetch(`${getBackendUrl()}/search?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Autocomplete failed (${response.status})`);
        const payload = await response.json() as AutocompletePayload;
        const candidates = [
          ...(Array.isArray(payload.suggestions) ? payload.suggestions : []),
          ...(Array.isArray(payload.results) ? payload.results.map((item) => item.title || "") : []),
        ];
        const seen = new Set<string>();
        const next = candidates.filter((candidate) => {
          const key = String(candidate || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (!key || key === query.toLowerCase() || seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 8);
        if (!controller.signal.aborted) {
          setAutocompleteItems(next);
          setAutocompleteIndex(next.length ? 0 : -1);
        }
      } catch {
        if (!controller.signal.aborted) {
          setAutocompleteItems([]);
          setAutocompleteIndex(-1);
        }
      }
    }, 120);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [autocompleteOpen, draft, filterKey, filters.scopes]);

  useEffect(() => {
    conceptAbortRef.current?.abort();
    setQueryConcept(null);
    setRelatedMedia({ images: 0, tables: 0, total: 0 });
    if (!filters.query) return;
    const controller = new AbortController();
    conceptAbortRef.current = controller;
    fetch(`${getBackendUrl()}/search/concept?q=${encodeURIComponent(filters.query)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => response.ok ? await response.json() as { concept?: ResolvedConcept } : null)
      .then((payload) => {
        if (!controller.signal.aborted) setQueryConcept(payload?.concept || null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [filters.query]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (!current.hasMore || current.status === "loading-more" || current.status === "loading") return;
    void fetchPage(current.filters, current.nextOffset);
  }, [fetchPage]);

  useEffect(() => {
    const element = loadMoreSentinel.current;
    if (!element || !canAutoLoadSearchResults(state.status, state.hasMore) || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      const current = stateRef.current;
      if (entries.some((entry) => entry.isIntersecting) && canAutoLoadSearchResults(current.status, current.hasMore)) loadMore();
    }, { rootMargin: "180px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loadMore, state.hasMore, state.status]);

  function submitQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAutocompleteOpen(false);
    router.push(buildSearchHref({ ...filters, query: draft }));
  }

  function chooseAutocomplete(item: string, navigate = true) {
    setDraft(item);
    setAutocompleteItems([]);
    setAutocompleteIndex(-1);
    setAutocompleteOpen(false);
    if (navigate) router.push(buildSearchHref({ ...filters, query: item }));
  }

  const cui = queryConcept?.cui || firstReturnedCui(state.items);
  const conceptName = queryConcept?.preferred_name || filters.query;
  const mediaKindSelected = filters.kinds.length === 0
    || filters.kinds.includes("images")
    || filters.kinds.includes("tables");
  const initialLoading = state.status === "loading" && state.items.length === 0;
  const loadedCopy = `${state.items.length} loaded${state.hasMore ? " · more available" : ""}`;

  return (
    <main className="search-results-page">
      <div className="search-results-shell">
        <header className="search-results-header">
          <div>
            <span className="search-results-eyebrow">CLINICAL SEARCH</span>
            <h1>Search Results</h1>
            <p>Priority-ranked references with bounded, progressive context.</p>
          </div>
          <form
            className="search-results-query"
            role="search"
            onSubmit={submitQuery}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAutocompleteOpen(false);
            }}
          >
            <Search size={19} aria-hidden="true" />
            <label htmlFor="search-results-query">Search MedOS</label>
            <input
              id="search-results-query"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setAutocompleteOpen(true); }}
              onFocus={() => setAutocompleteOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && autocompleteItems.length) {
                  event.preventDefault();
                  setAutocompleteOpen(true);
                  setAutocompleteIndex((index) => Math.min(index + 1, autocompleteItems.length - 1));
                } else if (event.key === "ArrowUp" && autocompleteItems.length) {
                  event.preventDefault();
                  setAutocompleteOpen(true);
                  setAutocompleteIndex((index) => Math.max(index - 1, 0));
                } else if (event.key === "Enter" && autocompleteOpen && autocompleteIndex >= 0) {
                  event.preventDefault();
                  chooseAutocomplete(autocompleteItems[autocompleteIndex]);
                } else if (event.key === "Tab" && autocompleteOpen && autocompleteIndex >= 0) {
                  chooseAutocomplete(autocompleteItems[autocompleteIndex], false);
                } else if (event.key === "Escape") {
                  setAutocompleteOpen(false);
                }
              }}
              placeholder="Search clinical references"
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={autocompleteOpen && autocompleteItems.length > 0}
              aria-controls="search-results-autocomplete"
              aria-activedescendant={autocompleteOpen && autocompleteIndex >= 0 ? `search-results-suggestion-${autocompleteIndex}` : undefined}
            />
            <button type="submit">Search</button>
            {autocompleteOpen && autocompleteItems.length > 0 && (
              <div id="search-results-autocomplete" className="search-results-autocomplete" role="listbox" aria-label="Suggested searches">
                {autocompleteItems.map((item, index) => (
                  <button
                    id={`search-results-suggestion-${index}`}
                    key={item}
                    type="button"
                    role="option"
                    aria-selected={index === autocompleteIndex}
                    className={index === autocompleteIndex ? "is-active" : undefined}
                    onMouseEnter={() => setAutocompleteIndex(index)}
                    onClick={() => chooseAutocomplete(item)}
                  >
                    <Search size={15} aria-hidden="true" />
                    <span>{item}</span>
                  </button>
                ))}
              </div>
            )}
          </form>
        </header>

        {!filters.query ? (
          <section className="search-results-empty">
            <Search size={28} aria-hidden="true" />
            <h2>Search across your MedOS references</h2>
            <p>Enter a clinical topic, abbreviation, book, drug, or question.</p>
          </section>
        ) : (
          <>
            <div className="search-results-summary" role="status" aria-live="polite">
              <strong>“{filters.query}”</strong>
              <span>{initialLoading ? "Loading first page…" : loadedCopy}</span>
            </div>
            <div className="search-results-layout">
              <SearchFilters filters={filters} facets={state.facets} relatedMedia={relatedMedia} />
              <section className="search-results-primary" aria-label="Primary search results">
                {initialLoading && Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="search-results-skeleton is-card" />
                ))}
                {state.status === "error" && (
                  <div className="search-results-error" role="alert">
                    <AlertCircle size={22} />
                    <span>{state.error}</span>
                    <button type="button" onClick={() => void fetchPage(filters, 0)}><RefreshCw size={15} /> Retry</button>
                  </div>
                )}
                {!initialLoading && state.status !== "error" && state.items.length === 0 && (
                  <div className="search-results-empty is-inline">
                    <Search size={24} />
                    <h2>No results in this bounded view</h2>
                    <p>Try removing a filter or using a broader clinical phrase.</p>
                  </div>
                )}
                <div className="search-results-list">
                  {state.items.map((item, index) => (
                    <SearchResultCard key={`${item.scope}:${item.kind}:${item.id ?? item.href ?? item.title}:${index}`} item={item} index={index} />
                  ))}
                </div>
                {state.status === "error-more" && (
                  <div className="search-results-more-error" role="alert">
                    <span>{state.error} Loaded results remain available.</span>
                    <button type="button" onClick={loadMore}><RefreshCw size={15} /> Retry</button>
                  </div>
                )}
                {state.hasMore && <button type="button" className="search-results-load-more" onClick={loadMore} disabled={state.status === "loading-more"} aria-busy={state.status === "loading-more"}>Load more</button>}
                {state.hasMore && <div ref={loadMoreSentinel} className="search-results-load-sentinel" aria-hidden="true" />}
                {cui && mediaKindSelected && (
                  <LazySearchMediaSection
                    cui={cui}
                    conceptName={conceptName}
                    allowedKinds={filters.kinds}
                    onSummary={setRelatedMedia}
                  />
                )}
              </section>
            </div>

            {cui && (
              <div className="search-results-enrichment" aria-label="Progressive concept context">
                <div ref={graphRef} className="search-enrichment-gate">
                  {graphVisible && <LazySearchConceptGraph cui={cui} />}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
