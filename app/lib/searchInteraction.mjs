export function buildPreviewSearchParams(query, scopes) {
  return new URLSearchParams({
    q: String(query),
    scopes: String(scopes),
    grouped: "false",
    fast: "true",
    limit: "24",
  });
}

export function createSearchInteractionState() {
  return { selectionMovedByKeyboard: false };
}

export function reduceSearchInteraction(state, event) {
  if (event === "query-reset") return createSearchInteractionState();
  if (event === "ArrowDown" || event === "ArrowUp") {
    return { selectionMovedByKeyboard: true };
  }
  return state;
}

export function resolveSearchEnter(query, state) {
  const q = String(query).trim();
  if (!q) return { kind: "none" };
  if (state.selectionMovedByKeyboard) return { kind: "selected-result" };
  return { kind: "full-search", href: `/search?q=${encodeURIComponent(q)}` };
}
