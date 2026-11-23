"use client";

import { useEffect, useState } from "react";

export const DARK_MODE_STORAGE_KEY = "medos.theme";

type Theme = "light" | "dark";

function isDarkValue(value: string | null): boolean {
  if (!value) return false;
  return value.toLowerCase() === "dark";
}

export function readDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  // The <html data-theme> attribute is the single source of truth — it is set by
  // both the SettingsPanel and setDarkMode() below, and by the pre-hydration
  // init script in layout.tsx. Prefer it over the raw localStorage value so a
  // theme change made through *any* of those paths is reflected here.
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr) return isDarkValue(attr);
  return isDarkValue(window.localStorage.getItem(DARK_MODE_STORAGE_KEY));
}

export function setDarkMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  const next: Theme = enabled ? "dark" : "light";
  window.localStorage.setItem(DARK_MODE_STORAGE_KEY, next);
  document.documentElement.setAttribute("data-theme", next);
  window.dispatchEvent(new CustomEvent("medos:theme-changed", { detail: { dark: enabled } }));
}

export function useDarkMode(): [boolean, (next: boolean) => void] {
  const [dark, setDark] = useState(() => readDarkMode());

  useEffect(() => {
    setDark(readDarkMode());
    const sync = (event?: Event) => {
      if (event instanceof StorageEvent && event.key && event.key !== DARK_MODE_STORAGE_KEY) return;
      const detail = (event as CustomEvent<{ dark?: boolean }> | undefined)?.detail;
      setDark(typeof detail?.dark === "boolean" ? detail.dark : readDarkMode());
    };
    window.addEventListener("storage", sync);
    window.addEventListener("medos:theme-changed", sync);
    // The SettingsPanel (the primary theme control) flips data-theme and fires
    // "medos:settings-changed" — NOT "medos:theme-changed" — and the same-tab
    // "storage" event never fires for the writer. Without this, an already-open
    // reader iframe kept dark after the app switched to light. Observe the
    // authoritative data-theme attribute so every theme path propagates live.
    window.addEventListener("medos:settings-changed", sync);
    const observer = new MutationObserver(() => setDark(readDarkMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("medos:theme-changed", sync);
      window.removeEventListener("medos:settings-changed", sync);
      observer.disconnect();
    };
  }, []);

  const toggle = (next: boolean) => setDarkMode(next);
  return [dark, toggle];
}
