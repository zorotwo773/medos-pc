"use client";

import { useEffect, useRef, useState } from "react";
import type React from "react";
import { AlertTriangle, Check, Hand, Keyboard, Laptop, LoaderCircle, Moon, RefreshCw, Rows3, Settings, ShieldCheck, Sun, SunDim, Type, Wifi, X } from "lucide-react";
import {
  changeNetworkAccess,
  DEFAULT_NETWORK_ACCESS_STATE,
  loadNetworkAccess,
  NETWORK_ACCESS_ENDPOINT,
  networkAccessControlModel,
  networkAccessGuidance,
  networkAccessPlatformGuidance,
  type NetworkAccessState,
} from "@/lib/networkAccess";
import { useModalA11y } from "@/lib/useModalA11y";
import { zIndex } from "@/lib/zIndex";
import { renameDevice, syncNow, toggleSync, useSyncStatus } from "@/lib/sync";

const STORE_KEY = "medos.settings.v1";

type Theme = "light" | "dark" | "yellow";
type TextSize = "small" | "normal" | "large" | "xlarge";
type Density = "comfortable" | "compact";
type StudyStep = "1" | "2" | "3";

interface SettingsState {
  theme: Theme;
  textSize: TextSize;
  density: Density;
  studyStep: StudyStep;
  reducedMotion: boolean;
  gestures: boolean;
}

const DEFAULT_SETTINGS: SettingsState = {
  theme: "light",
  textSize: "normal",
  density: "comfortable",
  studyStep: "2",
  reducedMotion: false,
  gestures: true,
};

function readSettings(): SettingsState {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORE_KEY) || "null") as Partial<SettingsState> | null;
    const storedTheme = window.localStorage.getItem("medos.theme");
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      theme: stored?.theme === "dark" || stored?.theme === "yellow"
        ? stored.theme
        : storedTheme === "dark" || storedTheme === "yellow"
          ? storedTheme
          : "light",
      textSize: stored?.textSize === "small" || stored?.textSize === "large" || stored?.textSize === "xlarge"
        ? stored.textSize
        : DEFAULT_SETTINGS.textSize,
      density: stored?.density === "compact" ? "compact" : DEFAULT_SETTINGS.density,
      studyStep: stored?.studyStep === "1" || stored?.studyStep === "2" || stored?.studyStep === "3" ? stored.studyStep : DEFAULT_SETTINGS.studyStep,
      reducedMotion: Boolean(stored?.reducedMotion),
      gestures: stored?.gestures !== false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsState>(() => readSettings());
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, () => setOpen(false), open);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("medos:open-settings", handler);
    return () => window.removeEventListener("medos:open-settings", handler);
  }, []);

  // The top-bar icon buttons request theme/font changes through this event.
  // Settings stays the single owner of persistence, DOM attributes and the
  // "medos:settings-changed" broadcast, so every screen reacts identically.
  useEffect(() => {
    const apply = (patch: { theme?: Theme; textSize?: TextSize }) => {
      setSettings(current => {
        const theme = patch.theme && patch.theme !== current.theme ? patch.theme : current.theme;
        const textSize = patch.textSize && patch.textSize !== current.textSize ? patch.textSize : current.textSize;
        return theme === current.theme && textSize === current.textSize
          ? current
          : { ...current, theme, textSize };
      });
    };
    const appearanceHandler = (event: Event) => {
      apply((event as CustomEvent<{ theme?: Theme; textSize?: TextSize }>).detail || {});
    };
    const externalThemeHandler = () => {
      const attr = document.documentElement.getAttribute("data-theme");
      apply({ theme: attr === "dark" || attr === "yellow" ? attr : "light" });
    };
    window.addEventListener("medos:appearance-change", appearanceHandler);
    // The command center and other tabs can also change data-theme directly.
    window.addEventListener("medos:theme-changed", externalThemeHandler);
    window.addEventListener("storage", externalThemeHandler);
    return () => {
      window.removeEventListener("medos:appearance-change", appearanceHandler);
      window.removeEventListener("medos:theme-changed", externalThemeHandler);
      window.removeEventListener("storage", externalThemeHandler);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", settings.theme);
    root.setAttribute("data-text-size", settings.textSize);
    root.setAttribute("data-density", settings.density);
    root.setAttribute("data-reduced-motion", settings.reducedMotion ? "1" : "0");
    root.setAttribute("data-gestures", settings.gestures ? "1" : "0");
    try {
      window.localStorage.setItem("medos.theme", settings.theme);
      window.localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch {
      /* private mode or quota */
    }
    window.dispatchEvent(new CustomEvent("medos:settings-changed", { detail: settings }));
  }, [settings]);

  const update = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings(current => ({ ...current, [key]: value }));
  };

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: zIndex.modalOverlay,
        display: "flex",
        justifyContent: "flex-end",
        background: "rgba(15,23,42,.36)",
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        tabIndex={-1}
        style={{
          width: "min(420px, 100vw)",
          height: "100%",
          overflowY: "auto",
          background: "var(--bg-card)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-24px 0 60px rgba(15,23,42,.22)",
          color: "var(--text-primary)",
          zIndex: zIndex.modalPanel,
        }}
      >
        <header style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--border)", background: "var(--bg-card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Settings size={18} />
            <h2 id="settings-panel-title" style={{ margin: 0, fontSize: 15, fontWeight: 850 }}>Settings</h2>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close settings" title="Close settings" style={iconButtonStyle}>
            <X size={16} />
          </button>
        </header>

        <div style={{ padding: 18, display: "grid", gap: 18 }}>
          <SettingGroup icon={<Sun size={16} />} title="Theme">
            <Segmented
              options={[
                { value: "light", label: "Light", icon: <Sun size={14} /> },
                { value: "dark", label: "Dark", icon: <Moon size={14} /> },
                { value: "yellow", label: "Yellow", icon: <SunDim size={14} /> },
              ]}
              value={settings.theme}
              onChange={value => update("theme", value as Theme)}
            />
          </SettingGroup>

          <SettingGroup icon={<Type size={16} />} title="Text Size">
            <Segmented
              options={[
                { value: "small", label: "S" },
                { value: "normal", label: "M" },
                { value: "large", label: "L" },
                { value: "xlarge", label: "XL" },
              ]}
              value={settings.textSize}
              onChange={value => update("textSize", value as TextSize)}
            />
          </SettingGroup>

          <SettingGroup icon={<Rows3 size={16} />} title="Density">
            <Segmented
              options={[
                { value: "comfortable", label: "Comfort" },
                { value: "compact", label: "Compact" },
              ]}
              value={settings.density}
              onChange={value => update("density", value as Density)}
            />
          </SettingGroup>

          <SettingGroup icon={<Rows3 size={16} />} title="USMLE Step Focus">
            <Segmented
              options={[
                { value: "1", label: "Step 1" },
                { value: "2", label: "Step 2" },
                { value: "3", label: "Step 3" },
              ]}
              value={settings.studyStep}
              onChange={value => update("studyStep", value as StudyStep)}
            />
          </SettingGroup>

          <SettingGroup icon={<Hand size={16} />} title="Gestures">
            <Toggle
              checked={settings.gestures}
              label={settings.gestures ? "Touch and trackpad gestures on" : "Gestures off"}
              onChange={value => update("gestures", value)}
            />
          </SettingGroup>

          <SettingGroup icon={<Keyboard size={16} />} title="Motion">
            <Toggle
              checked={settings.reducedMotion}
              label={settings.reducedMotion ? "Reduced motion on" : "Standard motion"}
              onChange={value => update("reducedMotion", value)}
            />
          </SettingGroup>

          <SyncSection />
          <NetworkAccessSection />

          <section style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <h3 style={sectionTitleStyle}>Shortcuts</h3>
            <div style={{ display: "grid", gap: 8 }}>
              {[
                ["/", "Search"],
                ["g s", "Settings"],
                ["g k", "Command center"],
                ["g i", "Library"],
                ["g o", "Content Manager"],
                ["g t", "Media Tray"],
                ["?", "Shortcut help"],
                ["1-8 / A-H", "Choose QBank answer"],
                ["← / →", "Previous or next question"],
                ["Ctrl+PageUp / Ctrl+PageDown", "Cycle tabs"],
              ].map(([keys, label]) => (
                <div key={keys} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 12 }}>
                  <kbd style={kbdStyle}>{keys}</kbd>
                  <span style={{ color: "var(--text-secondary)", textAlign: "right" }}>{label}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function publishNetworkAccessState(state: NetworkAccessState) {
  window.dispatchEvent(new CustomEvent("medos:network-access-state", { detail: state }));
}

function NetworkAccessSection() {
  const [state, setState] = useState<NetworkAccessState>(DEFAULT_NETWORK_ACCESS_STATE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const endpoint = NETWORK_ACCESS_ENDPOINT;

  useEffect(() => {
    mountedRef.current = true;
    const request = ++requestRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void loadNetworkAccess(fetch, endpoint, controller.signal)
      .then(next => {
        if (!mountedRef.current || requestRef.current !== request) return;
        setState(next);
        setError(null);
        setUnavailable(false);
        publishNetworkAccessState(next);
      })
      .catch(() => {
        if (!mountedRef.current || requestRef.current !== request || controller.signal.aborted) return;
        setUnavailable(true);
        setError("Network access unavailable. Retry from this laptop.");
      })
      .finally(() => {
        if (mountedRef.current && requestRef.current === request) setLoading(false);
      });

    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      controller.abort();
    };
  }, [endpoint, reloadGeneration]);

  const onToggle = async (allowPublic: boolean) => {
    const request = ++requestRef.current;
    const result = await changeNetworkAccess({
      allowPublic,
      confirmPublic: message => window.confirm(message),
      current: state,
      endpoint,
      fetcher: fetch,
      onBusy: value => {
        if (mountedRef.current && requestRef.current === request) setBusy(value);
      },
    });
    if (!mountedRef.current || requestRef.current !== request || result.cancelled) return;
    setState(result.state);
    setError(result.error);
    setUnavailable(result.unavailable);
    if (!result.unavailable) publishNetworkAccessState(result.state);
  };

  const model = networkAccessControlModel(state, { loading, busy, error, unavailable });
  const hostOnlyMessage = model.showHostOnlyGuidance
    ? networkAccessGuidance("host-only network setting", state.platform, false)
    : null;
  const platformGuidance = networkAccessPlatformGuidance(state);

  return (
    <section className="network-access-section">
      <h3 style={sectionTitleStyle}>
        <span style={{ display: "inline-flex", color: "var(--accent)" }}><ShieldCheck size={16} /></span>
        Network access
      </h3>
      <p className="network-access-intro">
        MedOS is available to devices on your private network by default. Public-network access is an explicit host setting.
      </p>

      <label className="network-access-control" data-kind={model.statusKind}>
        <span className="network-access-copy">
          <strong id="network-access-switch-label">Allow access on public networks</strong>
          <span id="network-access-switch-description">{model.description}</span>
        </span>
        <input
          className="network-access-switch"
          type="checkbox"
          role="switch"
          aria-checked={model.checked}
          aria-labelledby="network-access-switch-label"
          aria-describedby="network-access-switch-description network-access-live-status"
          checked={model.checked}
          disabled={model.disabled}
          onChange={event => void onToggle(event.target.checked)}
        />
      </label>

      <p
        id="network-access-live-status"
        className="network-access-status"
        data-kind={model.statusKind}
        role="status"
        aria-live="polite"
        aria-busy={busy}
      >
        {busy && <LoaderCircle className="network-access-spinner" size={14} aria-hidden="true" />}
        {loading ? "Checking effective network access…" : busy ? "Applying and verifying network access…" : model.status}
      </p>

      {hostOnlyMessage && <p className="network-access-guidance">{hostOnlyMessage}</p>}
      {platformGuidance && <p className="network-access-guidance">{platformGuidance}</p>}
      {error && (
        <p className="network-access-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          {error}
        </p>
      )}
      {model.showRetry && (
        <button
          type="button"
          className="network-access-retry"
          onClick={() => setReloadGeneration(value => value + 1)}
        >Retry</button>
      )}
    </section>
  );
}

function relativeTime(iso?: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function SyncSection() {
  const { status, refresh } = useSyncStatus(8000);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);

  const onSyncNow = async () => {
    setBusy(true);
    const res = await syncNow();
    setBusy(false);
    if (res) {
      setFlash(
        res.peers === 0
          ? "No other devices found on this network"
          : res.added > 0
            ? `Synced ${res.added} item${res.added === 1 ? "" : "s"} from ${res.peers} device${res.peers === 1 ? "" : "s"}`
            : `Up to date with ${res.peers} device${res.peers === 1 ? "" : "s"}`,
      );
      void refresh();
      setTimeout(() => setFlash(null), 4000);
    }
  };

  const onToggle = async (on: boolean) => {
    await toggleSync(on);
    void refresh();
  };

  const onSaveName = async () => {
    if (editingName && editingName.trim()) {
      await renameDevice(editingName.trim());
      void refresh();
    }
    setEditingName(null);
  };

  const enabled = status?.enabled ?? true;
  const peers = status?.peers ?? [];

  return (
    <section style={{ display: "grid", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <h3 style={sectionTitleStyle}>
        <span style={{ display: "inline-flex", color: "var(--accent)" }}><Wifi size={16} /></span>
        LAN Sync
      </h3>
      <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
        Automatically keeps your Q-Bank progress in sync with your other MedOS devices on the same Wi-Fi — no export needed.
      </p>

      <Toggle
        checked={enabled}
        label={enabled ? "Auto-sync on this network" : "Sync paused"}
        onChange={onToggle}
      />

      {/* This device */}
      <div style={syncRowStyle}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700 }}>
          <Laptop size={14} style={{ color: "var(--accent)" }} />
          This device
        </span>
        {editingName !== null ? (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <input
              autoFocus
              value={editingName}
              onChange={e => setEditingName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void onSaveName(); if (e.key === "Escape") setEditingName(null); }}
              style={{ fontSize: 12, padding: "3px 6px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text-primary)", width: 130 }}
            />
            <button type="button" onClick={onSaveName} style={syncMiniBtnStyle}>Save</button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setEditingName(status?.device_name ?? "")}
            title="Rename this device"
            style={{ ...syncMiniBtnStyle, fontWeight: 700 }}
          >
            {status?.device_name ?? "…"}
          </button>
        )}
      </div>

      {/* Peers */}
      <div style={{ display: "grid", gap: 6 }}>
        {peers.length === 0 ? (
          <div style={{ ...syncRowStyle, color: "var(--text-secondary)", fontSize: 11.5 }}>
            {enabled ? "Searching for nearby devices…" : "Sync is paused"}
          </div>
        ) : (
          peers.map(p => (
            <div key={p.node_id} style={syncRowStyle}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--success, #16a34a)", display: "inline-block" }} />
                {p.name}
              </span>
              <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                {p.last_sync_at ? `synced ${relativeTime(p.last_sync_at)}` : `seen ${Math.round(p.last_seen_ago)}s ago`}
              </span>
            </div>
          ))
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          {flash ?? (status?.last_sync_at ? `Last sync ${relativeTime(status.last_sync_at)}` : "Not synced yet")}
        </span>
        <button type="button" onClick={onSyncNow} disabled={busy || !enabled} style={syncSyncBtnStyle(busy || !enabled)}>
          <RefreshCw size={13} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
          Sync now
        </button>
      </div>
    </section>
  );
}

const syncRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 11px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-subtle)",
};

const syncMiniBtnStyle: React.CSSProperties = {
  fontSize: 11.5,
  padding: "3px 9px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  cursor: "pointer",
};

function syncSyncBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    fontWeight: 800,
    padding: "7px 13px",
    borderRadius: 7,
    border: "1px solid var(--accent)",
    background: disabled ? "var(--bg-subtle)" : "var(--accent)",
    color: disabled ? "var(--text-secondary)" : "var(--accent-contrast, #fff)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.7 : 1,
  };
}

function SettingGroup({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h3 style={sectionTitleStyle}>
        <span style={{ display: "inline-flex", color: "var(--accent)" }}>{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string; icon?: React.ReactNode }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`, gap: 4, padding: 4, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-subtle)" }}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            style={{
              minHeight: 34,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              border: active ? "1px solid var(--accent)" : "1px solid transparent",
              borderRadius: 6,
              background: active ? "var(--bg-card)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              fontWeight: 800,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {option.icon}
            {option.label}
            {active && <Check size={13} />}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-subtle)", cursor: "pointer" }}>
      <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 700 }}>{label}</span>
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    </label>
  );
}

const sectionTitleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: 0,
  fontSize: 12,
  fontWeight: 850,
  color: "var(--text-primary)",
};

const iconButtonStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  display: "inline-grid",
  placeItems: "center",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg-card)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

const kbdStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  minWidth: 42,
  padding: "4px 7px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  textAlign: "center",
};
