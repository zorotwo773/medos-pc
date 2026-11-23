export type TouchInputMode = "desktop-pinned" | "tablet-halo" | "phone-sheet";
export type PrimaryPointer = "fine" | "coarse" | "none";

export interface TouchInputCapabilities {
  viewportWidth: number;
  primaryPointer: PrimaryPointer;
  anyPointerCoarse: boolean;
}

export const PHONE_BREAKPOINT: 640;
export const DESKTOP_PIN_BREAKPOINT: 900;
export function classifyTouchInputMode(capabilities: TouchInputCapabilities): TouchInputMode;
export function supportsPinnedNavigation(mode: TouchInputMode): boolean;
