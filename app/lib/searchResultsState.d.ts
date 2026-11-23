export interface SearchFilters {
  query: string;
  scopes: string[];
  kinds: string[];
}

export interface SearchResultItem {
  id?: string | number;
  title?: string;
  subtitle?: string;
  href?: string;
  scope?: string;
  kind?: string;
  preview?: { type?: string; url?: string; html?: string; title?: string; caption?: string; source?: string };
  firstaid_refs?: Array<{ heading_id: number; title?: string; page?: number; hierarchy?: string }>;
  umls?: { cui?: string; preferred_name?: string; semantic_group?: string; href?: string };
}

export interface SearchFacets {
  sources: Record<string, number>;
  kinds: Record<string, number>;
}

export interface SearchPagePayload {
  query?: string;
  offset: number;
  limit: number;
  results: SearchResultItem[];
  has_more: boolean;
  facets?: Partial<SearchFacets>;
}

export type SearchResultsStatus = "empty-query" | "idle" | "loading" | "loading-more" | "ready" | "error" | "error-more";

export interface SearchResultsState {
  filters: SearchFilters;
  key: string;
  items: SearchResultItem[];
  facets: SearchFacets;
  hasMore: boolean;
  nextOffset: number;
  status: SearchResultsStatus;
  error: string | null;
  requestToken: number;
  activeToken: number;
  activeOffset: number;
}

export const SEARCH_SCOPE_VALUES: readonly string[];
export const SEARCH_KIND_VALUES: readonly string[];
export function normalizeSearchFilters(filters?: Partial<SearchFilters>): SearchFilters;
export function parseSearchResultsUrl(input?: string | Pick<URLSearchParams, "get">): SearchFilters;
export function buildSearchHref(filters: Partial<SearchFilters>): string;
export function searchRequestKey(filters: Partial<SearchFilters>): string;
export function buildSearchPageParams(filters: Partial<SearchFilters>, offset?: number, limit?: number): URLSearchParams;
export function mergeSearchPages(existing?: SearchResultItem[], incoming?: SearchResultItem[]): SearchResultItem[];
export function createSearchResultsState(filters?: Partial<SearchFilters>): SearchResultsState;
export function beginSearchRequest(state: SearchResultsState, filters: Partial<SearchFilters>, requestedOffset?: number): { token: number; offset: number; state: SearchResultsState };
export function applySearchPage(state: SearchResultsState, token: number, page: SearchPagePayload): SearchResultsState;
export function failSearchRequest(state: SearchResultsState, token: number, message: string): SearchResultsState;
export function canAutoLoadSearchResults(status: SearchResultsStatus, hasMore: boolean): boolean;
export function firstReturnedCui(items?: SearchResultItem[]): string | null;
