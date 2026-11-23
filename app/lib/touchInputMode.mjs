export const PHONE_BREAKPOINT = 640;
export const DESKTOP_PIN_BREAKPOINT = 900;

/**
 * Classifies input capabilities without reading browser globals so callers can
 * supply media-query results and tests can exercise the policy directly.
 */
export function classifyTouchInputMode({ viewportWidth, primaryPointer, anyPointerCoarse }) {
  if (viewportWidth <= PHONE_BREAKPOINT) return "phone-sheet";

  if (viewportWidth >= DESKTOP_PIN_BREAKPOINT && primaryPointer === "fine" && !anyPointerCoarse) {
    return "desktop-pinned";
  }

  return "tablet-halo";
}

export function supportsPinnedNavigation(mode) {
  return mode === "desktop-pinned";
}
