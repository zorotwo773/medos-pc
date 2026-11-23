const SCOPE_ORDER = [
  "uptodate",
  "amboss",
  "uworld",
  "firstaid",
  "books",
  "umls",
  "qbank",
  "sanford",
  "utdddx",
  "drugs",
  "calc",
];

const SCOPE_ALIASES = new Map([
  ["uptodate", "uptodate"], ["utd", "uptodate"],
  ["amboss", "amboss"],
  ["uworld", "uworld"], ["uworld-library", "uworld"], ["uworldlib", "uworld"], ["uwlib", "uworld"],
  ["firstaid", "firstaid"], ["first-aid", "firstaid"], ["fa", "firstaid"],
  ["books", "books"], ["book", "books"], ["library", "books"],
  ["umls", "umls"], ["concept", "umls"], ["concepts", "umls"],
  ["qbank", "qbank"], ["q-bank", "qbank"],
  ["sanford", "sanford"], ["sanfordguide", "sanford"],
  ["utdddx", "utdddx"], ["ddx", "utdddx"],
  ["drugs", "drugs"], ["drug", "drugs"], ["meds", "drugs"], ["medications", "drugs"],
  ["calc", "calc"], ["calculator", "calc"], ["calculators", "calc"],
]);

const KIND_ORDER = [
  "articles",
  "books",
  "images",
  "tables",
  "concepts",
  "drugs",
  "questions",
  "calculator",
];

const KIND_ALIASES = new Map([
  ["article", "articles"], ["articles", "articles"], ["topic", "articles"],
  ["book", "books"], ["books", "books"], ["chapter", "books"], ["pdf", "books"], ["pdfs", "books"],
  ["image", "images"], ["images", "images"], ["clinic_image", "images"],
  ["table", "tables"], ["tables", "tables"], ["uworld_table", "tables"],
  ["concept", "concepts"], ["concepts", "concepts"], ["disease", "concepts"], ["finding", "concepts"], ["pathology", "concepts"],
  ["drug", "drugs"], ["drugs", "drugs"],
  ["question", "questions"], ["questions", "questions"],
  ["calculator", "calculator"], ["calculators", "calculator"], ["calc", "calculator"],
]);

function compactQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function valuesFrom(value) {
  if (Array.isArray(value)) return value;
  return String(value || "").split(",");
}

function canonicalValues(value, aliases, order) {
  const found = new Set();
  for (const raw of valuesFrom(value)) {
    const normalized = String(raw || "").trim().toLowerCase();
    if (!normalized || normalized === "all") continue;
    const canonical = aliases.get(normalized);
    if (canonical) found.add(canonical);
  }
  return order.filter((entry) => found.has(entry));
}

export function normalizeSearchFilters(filters = {}) {
  return {
    query: compactQuery(filters.query),
    scopes: canonicalValues(filters.scopes, SCOPE_ALIASES, SCOPE_ORDER),
    kinds: canonicalValues(filters.kinds, KIND_ALIASES, KIND_ORDER),
  };
}

export function parseSearchResultsUrl(input = "") {
  const params = input instanceof URLSearchParams
    ? input
    : new URLSearchParams(String(input).replace(/^\?/, ""));
  return normalizeSearchFilters({
    query: params.get("q") || "",
    scopes: params.get("scopes") || "",
    kinds: params.get("kinds") || "",
  });
}

export function buildSearchHref(filters) {
  const normalized = normalizeSearchFilters(filters);
  const params = new URLSearchParams();
  if (normalized.query) params.set("q", normalized.query);
  if (normalized.scopes.length) params.set("scopes", normalized.scopes.join(","));
  if (normalized.kinds.length) params.set("kinds", normalized.kinds.join(","));
  const query = params.toString();
  return query ? `/search?${query}` : "/search";
}

export function searchRequestKey(filters) {
  const normalized = normalizeSearchFilters(filters);
  return JSON.stringify([normalized.query.toLowerCase(), normalized.scopes, normalized.kinds]);
}

export function buildSearchPageParams(filters, offset = 0, limit = 20) {
  const normalized = normalizeSearchFilters(filters);
  const params = new URLSearchParams();
  params.set("q", normalized.query);
  params.set("offset", String(Math.max(0, Math.trunc(Number(offset) || 0))));
  params.set("limit", String(Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)))));
  params.set("scopes", normalized.scopes.length ? normalized.scopes.join(",") : "all");
  params.set("kinds", normalized.kinds.length ? normalized.kinds.join(",") : "all");
  return params;
}

function resultIdentity(item) {
  const scope = String(item?.scope || "").trim().toLowerCase();
  const kind = String(item?.kind || "").trim().toLowerCase();
  const id = String(item?.id ?? "").trim();
  const fallback = String(item?.href || item?.title || "").trim().toLowerCase();
  return `${scope}\u0000${kind}\u0000${id || fallback}`;
}

export function mergeSearchPages(existing = [], incoming = []) {
  const merged = [];
  const seen = new Set();
  for (const item of [...existing, ...incoming]) {
    if (!item || typeof item !== "object") continue;
    const key = resultIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function createSearchResultsState(filters = {}) {
  const normalized = normalizeSearchFilters(filters);
  return {
    filters: normalized,
    key: searchRequestKey(normalized),
    items: [],
    facets: { sources: {}, kinds: {} },
    hasMore: false,
    nextOffset: 0,
    status: normalized.query ? "idle" : "empty-query",
    error: null,
    requestToken: 0,
    activeToken: 0,
    activeOffset: 0,
  };
}

export function beginSearchRequest(state, filters, requestedOffset = 0) {
  const normalized = normalizeSearchFilters(filters);
  const key = searchRequestKey(normalized);
  const changed = key !== state.key;
  const offset = changed ? 0 : Math.max(0, Math.trunc(Number(requestedOffset) || 0));
  const token = state.requestToken + 1;
  const base = changed ? createSearchResultsState(normalized) : state;
  return {
    token,
    offset,
    state: {
      ...base,
      filters: normalized,
      key,
      requestToken: token,
      activeToken: token,
      activeOffset: offset,
      status: offset === 0 ? "loading" : "loading-more",
      error: null,
    },
  };
}

export function applySearchPage(state, token, page) {
  if (token !== state.activeToken) return state;
  const results = Array.isArray(page?.results) ? page.results : [];
  const offset = Math.max(0, Number(page?.offset) || 0);
  const limit = Math.max(1, Number(page?.limit) || 20);
  return {
    ...state,
    items: offset === 0 ? mergeSearchPages([], results) : mergeSearchPages(state.items, results),
    facets: {
      sources: { ...(page?.facets?.sources || {}) },
      kinds: { ...(page?.facets?.kinds || {}) },
    },
    hasMore: Boolean(page?.has_more),
    nextOffset: offset + limit,
    status: "ready",
    error: null,
  };
}

export function failSearchRequest(state, token, message) {
  if (token !== state.activeToken) return state;
  return {
    ...state,
    status: state.activeOffset > 0 ? "error-more" : "error",
    error: compactQuery(message) || "Search is unavailable.",
  };
}

export function canAutoLoadSearchResults(status, hasMore) {
  return status === "ready" && Boolean(hasMore);
}

function validCui(value) {
  const match = String(value || "").toUpperCase().match(/(?:^|[^A-Z0-9])(C\d{7})(?:$|[^A-Z0-9])/);
  return match?.[1] || null;
}

export function firstReturnedCui(items = []) {
  for (const item of items) {
    const metadataCui = validCui(item?.umls?.cui);
    if (metadataCui) return metadataCui;
    if (String(item?.scope || "").toLowerCase() === "umls") {
      const idCui = validCui(item?.id);
      if (idCui) return idCui;
    }
    const hrefCui = validCui(item?.href);
    if (hrefCui) return hrefCui;
  }
  return null;
}

export const SEARCH_SCOPE_VALUES = Object.freeze([...SCOPE_ORDER]);
export const SEARCH_KIND_VALUES = Object.freeze([...KIND_ORDER]);
