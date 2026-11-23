export const PDF_NAVIGATION_ACTIVATION_EVENT = "medos:pdf-navigation-activate";

const PDF_NAVIGATION_SOURCES = new Set([
  "outline",
  "index",
  "search",
  "recent",
  "toolbar",
  "route",
]);

let nextRequestId = 0;

export function parsePdfPage(value, maxPage = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const page = Number(text);
  if (!Number.isSafeInteger(page)) return null;
  const maximum = Number.isSafeInteger(maxPage) && maxPage >= 1
    ? maxPage
    : Number.MAX_SAFE_INTEGER;
  return Math.min(maximum, Math.max(1, page));
}

export function createPdfNavigationRequest(page, source, optionalDestination, maxPage) {
  const parsedPage = parsePdfPage(page, maxPage);
  if (parsedPage === null || !PDF_NAVIGATION_SOURCES.has(source)) return null;
  nextRequestId += 1;
  return {
    page: parsedPage,
    requestId: nextRequestId,
    source,
    ...(optionalDestination === undefined ? {} : { optionalDestination }),
  };
}

export function isUnseenPdfNavigationRequest(lastRequestId, request) {
  return Boolean(
    request
    && Number.isSafeInteger(request.requestId)
    && request.requestId > lastRequestId,
  );
}

export function parseLibraryPdfHref(href, baseHref = "https://medos.local/") {
  if (typeof href !== "string" || !href.trim()) return null;
  try {
    const base = new URL(baseHref, "https://medos.local/");
    const url = new URL(href, base);
    if (url.origin !== base.origin || url.pathname !== "/library") return null;
    const path = url.searchParams.get("path")?.replaceAll("\\", "/");
    const page = parsePdfPage(url.searchParams.get("page"));
    if (!path || page === null) return null;
    return { path, page };
  } catch {
    return null;
  }
}

export function calculatePdfTargetScroll({
  scrollTop,
  containerTop,
  targetTop,
  paddingTop = 0,
  stickyOffset = 0,
}) {
  const next = scrollTop + targetTop - containerTop - paddingTop - stickyOffset;
  return Math.max(0, Number.isFinite(next) ? next : 0);
}

export function createPdfJumpState() {
  return { requestId: 0, page: null, settling: false };
}

export function beginPdfJump(state, request) {
  if (!isUnseenPdfNavigationRequest(state.requestId, request)) return state;
  return { requestId: request.requestId, page: request.page, settling: true };
}

export function settlePdfJump(state, requestId) {
  if (!state.settling || state.requestId !== requestId) return state;
  return { ...state, settling: false };
}

export function reconcileObservedPdfPage(state, observedPage) {
  return state.settling && state.page !== null ? state.page : observedPage;
}

export function dispatchLibraryPdfActivation(href, source = "search", target = globalThis.window) {
  if (!target?.location?.href || typeof target.dispatchEvent !== "function") return false;
  if (!PDF_NAVIGATION_SOURCES.has(source)) return false;
  const current = parseLibraryPdfHref(target.location.href, target.location.href);
  const destination = parseLibraryPdfHref(href, target.location.href);
  if (
    !current
    || !destination
    || current.path !== destination.path
    || current.page !== destination.page
  ) {
    return false;
  }

  const detail = { href, source };
  const EventCtor = target.CustomEvent ?? globalThis.CustomEvent;
  const event = typeof EventCtor === "function"
    ? new EventCtor(PDF_NAVIGATION_ACTIVATION_EVENT, { detail })
    : { type: PDF_NAVIGATION_ACTIVATION_EVENT, detail };
  target.dispatchEvent(event);
  return true;
}

export function requestFromLibraryPdfActivation(detail, activeBookPath, maxPage) {
  if (!detail || typeof detail !== "object" || typeof activeBookPath !== "string") return null;
  const destination = parseLibraryPdfHref(detail.href);
  const normalizedBookPath = activeBookPath.replaceAll("\\", "/");
  if (!destination || destination.path !== normalizedBookPath) return null;
  return createPdfNavigationRequest(
    destination.page,
    detail.source,
    detail.optionalDestination,
    maxPage,
  );
}
