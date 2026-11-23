"use client";
import { useState, useEffect, useRef } from "react";
import { Moon, Settings, Sun, SunDim, Type } from "lucide-react";
import SignedInChip from "@/components/auth/SignedInChip";
import ExportPdfButton from "@/components/layout/ExportPdfButton";
import { zIndex } from "@/lib/zIndex";

type Theme = "light" | "dark" | "yellow";
type TextSize = "small" | "normal" | "large" | "xlarge";
const TEXT_SIZES: TextSize[] = ["small", "normal", "large", "xlarge"];
const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  small: "S", normal: "M", large: "L", xlarge: "XL",
};

function readAppearance(): { theme: Theme; textSize: TextSize } {
  if (typeof document === "undefined") return { theme: "light", textSize: "normal" };
  const root = document.documentElement;
  const theme = root.getAttribute("data-theme");
  const size = root.getAttribute("data-text-size");
  return {
    theme: theme === "dark" || theme === "yellow" ? theme : "light",
    textSize: size === "small" || size === "large" || size === "xlarge" ? size : "normal",
  };
}

/** Icon-only theme/font controls that drive the same state as Settings. */
export default function TopBar() {
  const [timeStr, setTimeStr] = useState("");
  const [appearance, setAppearance] = useState(readAppearance);
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  const fontMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fmt = () => {
      const d = new Date();
      const day = d.toLocaleDateString("en-US", { weekday: "short" });
      const date = d.toLocaleDateString("en-US", { day: "2-digit", month: "short" });
      const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      return `${day} ${date} · ${time}`;
    };
    setTimeStr(fmt());
    const id = setInterval(() => setTimeStr(fmt()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const sync = () => setAppearance(readAppearance());
    sync();
    const events = ["medos:settings-changed", "medos:theme-changed", "storage"];
    events.forEach(event => window.addEventListener(event, sync));
    // The Settings panel writes <html data-theme/data-text-size>; observing them
    // keeps these icons correct no matter which control changed the appearance.
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-text-size"],
    });
    return () => {
      events.forEach(event => window.removeEventListener(event, sync));
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!fontMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!fontMenuRef.current?.contains(event.target as Node)) setFontMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFontMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fontMenuOpen]);

  const setTheme = (theme: Theme) => {
    window.dispatchEvent(new CustomEvent("medos:appearance-change", { detail: { theme } }));
  };
  const setTextSize = (textSize: TextSize) => {
    window.dispatchEvent(new CustomEvent("medos:appearance-change", { detail: { textSize } }));
  };
  const iconStyle = (active: boolean) => ({
    display: "inline-flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    width: 26,
    height: 26,
    padding: 0,
    borderRadius: 5,
    color: active ? "var(--accent)" : "var(--text-muted)",
    background: active ? "var(--accent-glow)" : "transparent",
    border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
    cursor: "pointer" as const,
    font: "inherit" as const,
  });

  return (
    <div className="app-topbar" style={{
      gridRow: 1,
      gridColumn: 2,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 20px",
      borderBottom: "1px solid var(--border)",
      background: "var(--chrome-bg)",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      letterSpacing: "0.16em",
      textTransform: "uppercase",
      color: "var(--text-muted)",
      zIndex: 9,
    }}>
      <div className="app-topbar-brand">
        <b style={{ color: "var(--text-primary)", fontWeight: 500 }}>MedOS</b>
        <span style={{ margin: "0 10px", color: "var(--text-muted)" }}>·</span>
        workstation
      </div>

      <div className="app-topbar-actions" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ExportPdfButton />
        <SignedInChip />
        <span className="app-topbar-time" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <i style={{
            display: "inline-block",
            width: 5, height: 5,
            borderRadius: "50%",
            background: "var(--accent)",
            flexShrink: 0,
          }} />
          {timeStr}
        </span>
        <button
          type="button"
          className="app-topbar-icon"
          style={iconStyle(appearance.theme === "light")}
          onClick={() => setTheme("light")}
          aria-label="Light mode"
          aria-pressed={appearance.theme === "light"}
          title="Light mode"
        ><Sun size={15} /></button>
        <button
          type="button"
          className="app-topbar-icon"
          style={iconStyle(appearance.theme === "dark")}
          onClick={() => setTheme("dark")}
          aria-label="Dark mode"
          aria-pressed={appearance.theme === "dark"}
          title="Dark mode"
        ><Moon size={15} /></button>
        <button
          type="button"
          className="app-topbar-icon"
          style={iconStyle(appearance.theme === "yellow")}
          onClick={() => setTheme("yellow")}
          aria-label="Yellow mode"
          aria-pressed={appearance.theme === "yellow"}
          title="Yellow mode"
        ><SunDim size={15} /></button>
        <div ref={fontMenuRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="app-topbar-icon"
            style={iconStyle(appearance.textSize !== "normal" || fontMenuOpen)}
            onClick={() => setFontMenuOpen(open => !open)}
            aria-label="Font size"
            aria-haspopup="dialog"
            aria-expanded={fontMenuOpen}
            title={`Font size: ${TEXT_SIZE_LABELS[appearance.textSize]}`}
          ><Type size={15} /></button>
          {fontMenuOpen && (
            <div
              role="dialog"
              aria-label="Font size"
              style={{
                position: "absolute",
                top: "calc(100% + 9px)",
                right: 0,
                width: 196,
                padding: 12,
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "var(--shadow-lg)",
                color: "var(--text-primary)",
                textTransform: "none",
                letterSpacing: "normal",
                fontSize: 11,
                zIndex: zIndex.popover,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <b style={{ fontSize: 11 }}>Text size</b>
                <span style={{ color: "var(--text-muted)" }}>{TEXT_SIZE_LABELS[appearance.textSize]}</span>
              </div>
              <input
                type="range"
                min={0}
                max={TEXT_SIZES.length - 1}
                step={1}
                value={TEXT_SIZES.indexOf(appearance.textSize)}
                onChange={event => setTextSize(TEXT_SIZES[Number(event.target.value)])}
                aria-label="Text size slider"
                style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer" }}
              />
              <div style={{ display: "flex", gap: 5, marginTop: 10 }}>
                {TEXT_SIZES.map(size => {
                  const active = size === appearance.textSize;
                  return (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setTextSize(size)}
                      aria-pressed={active}
                      title={`Text size ${TEXT_SIZE_LABELS[size]}`}
                      style={{
                        flex: 1,
                        padding: "5px 0",
                        borderRadius: 5,
                        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                        background: active ? "var(--accent)" : "var(--bg-subtle)",
                        color: active ? "var(--accent-ink, #ffffff)" : "var(--text-secondary)",
                        font: "inherit",
                        fontWeight: active ? 800 : 500,
                        cursor: "pointer",
                      }}
                    >
                      {TEXT_SIZE_LABELS[size]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          className="app-topbar-icon"
          style={iconStyle(false)}
          onClick={() => window.dispatchEvent(new CustomEvent("medos:open-settings"))}
          aria-label="Settings"
          title="Settings"
        ><Settings size={15} /></button>
        <span className="app-topbar-kbd" title="Open command center with g then k" style={{
          border: "1px solid var(--border)",
          padding: "2px 5px",
          borderRadius: 3,
          background: "var(--bg-card)",
          fontSize: 9,
        }}>g k</span>
      </div>
    </div>
  );
}
