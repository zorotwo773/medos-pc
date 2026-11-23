export interface SearchInteractionState {
  selectionMovedByKeyboard: boolean;
}

export type SearchInteractionEvent =
  | "ArrowDown"
  | "ArrowUp"
  | "pointer-hover"
  | "query-reset";

export type SearchEnterIntent =
  | { kind: "none" }
  | { kind: "selected-result" }
  | { kind: "full-search"; href: string };

export function buildPreviewSearchParams(query: string, scopes: string): URLSearchParams;
export function createSearchInteractionState(): SearchInteractionState;
export function reduceSearchInteraction(
  state: SearchInteractionState,
  event: SearchInteractionEvent,
): SearchInteractionState;
export function resolveSearchEnter(
  query: string,
  state: SearchInteractionState,
): SearchEnterIntent;
