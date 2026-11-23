"use client";

import { useEffect, useState } from "react";

/**
 * Reference-layer mode:
 *   off  — no underlines / hover scan
 *   lite — highlight only each document's precomputed concept list (instant, no
 *          whole-article scan round-trip). Default on low-end devices.
 *   full — lite + a live /reference/scan gap-fill for body-only terms.
 *
 * Back-compat: legacy callers use the boolean enabled API (enabled = mode!=="off")
 * and the `medos:underlines` key / `medos:underlines-changed` event, all of which
 * are kept in sync here.
 */
export type ReferenceMode = "off" | "lite" | "full";

export const REFERENCE_LAYER_STORAGE_KEY = "referenceLayer.enabled";
export const REFERENCE_LAYER_MODE_KEY = "referenceLayer.mode";
export const LEGACY_UNDERLINES_STORAGE_KEY = "medos:underlines";

function parseEnabled(value: string | null) {
  if (value === null) return null;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function parseMode(value: string | null): ReferenceMode | null {
  if (value === "off" || value === "lite" || value === "full") return value;
  return null;
}

/** Default scan mode for users who haven't picked one — throttled down to lite on
 *  low-core / low-memory devices, where the old whole-article live scan crawled. */
function deviceDefaultMode(): Exclude<ReferenceMode, "off"> {
  if (typeof navigator === "undefined") return "full";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency;
  const memory = nav.deviceMemory;
  if (
    (typeof cores === "number" && cores > 0 && cores <= 4) ||
    (typeof memory === "number" && memory > 0 && memory <= 4)
  ) {
    return "lite";
  }
  return "full";
}

function readLegacyEnabled() {
  if (typeof window === "undefined") return true;
  const modern = parseEnabled(window.localStorage.getItem(REFERENCE_LAYER_STORAGE_KEY));
  if (modern !== null) return modern;
  const legacy = parseEnabled(window.localStorage.getItem(LEGACY_UNDERLINES_STORAGE_KEY));
  return legacy ?? true;
}

export function readReferenceLayerMode(): ReferenceMode {
  if (typeof window === "undefined") return "full";
  const explicit = parseMode(window.localStorage.getItem(REFERENCE_LAYER_MODE_KEY));
  if (explicit) return explicit;
  // No explicit mode yet: honour a legacy on/off choice, pick a device-aware
  // default for the "on" case (first-run users land here).
  return readLegacyEnabled() ? deviceDefaultMode() : "off";
}

export function readReferenceLayerEnabled() {
  return readReferenceLayerMode() !== "off";
}

export function setReferenceLayerMode(mode: ReferenceMode) {
  if (typeof window === "undefined") return;
  const enabled = mode !== "off";
  window.localStorage.setItem(REFERENCE_LAYER_MODE_KEY, mode);
  window.localStorage.setItem(REFERENCE_LAYER_STORAGE_KEY, enabled ? "true" : "false");
  window.localStorage.setItem(LEGACY_UNDERLINES_STORAGE_KEY, enabled ? "on" : "off");
  const detail = { enabled, mode };
  window.dispatchEvent(new CustomEvent("medos:reference-mode-changed", { detail }));
  window.dispatchEvent(new CustomEvent("medos:reference-layer-changed", { detail }));
  window.dispatchEvent(new CustomEvent("medos:underlines-changed", { detail }));
}

export function setReferenceLayerEnabled(enabled: boolean) {
  if (!enabled) {
    setReferenceLayerMode("off");
    return;
  }
  // Re-enabling: restore the last explicit lite/full choice, else device default.
  const prev =
    typeof window !== "undefined"
      ? parseMode(window.localStorage.getItem(REFERENCE_LAYER_MODE_KEY))
      : null;
  setReferenceLayerMode(prev && prev !== "off" ? prev : deviceDefaultMode());
}

export function useReferenceLayerMode(): ReferenceMode {
  const [mode, setMode] = useState<ReferenceMode>("full");

  useEffect(() => {
    setMode(readReferenceLayerMode());
    const sync = (event?: Event) => {
      const detail = (event as CustomEvent<{ mode?: ReferenceMode; enabled?: boolean }> | undefined)?.detail;
      if (detail?.mode) setMode(detail.mode);
      else setMode(readReferenceLayerMode());
    };
    window.addEventListener("storage", sync);
    window.addEventListener("medos:reference-mode-changed", sync);
    window.addEventListener("medos:reference-layer-changed", sync);
    window.addEventListener("medos:underlines-changed", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("medos:reference-mode-changed", sync);
      window.removeEventListener("medos:reference-layer-changed", sync);
      window.removeEventListener("medos:underlines-changed", sync);
    };
  }, []);

  return mode;
}

export function useReferenceLayerEnabled() {
  return useReferenceLayerMode() !== "off";
}
