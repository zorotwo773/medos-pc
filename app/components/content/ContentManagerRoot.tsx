"use client";

/**
 * Content Manager — pack status, hierarchical data sync rooms (live-folder
 * torrent), content-folder import, UpToDate prepare, companions, app update.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getBackendUrl } from "@/lib/api";
import TransferPanel from "@/components/content/TransferPanel";

function M({ name, size = 20, fill = false, color, style }: { name: string; size?: number; fill?: boolean; color?: string; style?: React.CSSProperties }) {
  return (
    <span
      className="material-symbols-outlined"
      aria-hidden="true"
      style={{ fontSize: size, color, lineHeight: 1, flexShrink: 0, fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 340, 'GRAD' 0, 'opsz' ${size}`, ...style }}
    >
      {name}
    </span>
  );
}

type PackState = "grey" | "yellow" | "green" | "red";
type Pack = {
  id: string;
  name: string;
  description: string;
  approx_size_gb: number;
  required: boolean;
  installed: boolean;
  state: PackState;
  detail: string;
  version: string | null;
  search_sources: string[];
  warning: string | null;
  checked_at: number;
};

type SyncChild = { id: string; label: string; path: string; size_on_disk: number; present: boolean };
type SyncEntry = {
  id: string;
  pack_id: string;
  label: string;
  description: string;
  required: boolean;
  state: string;
  detail: string;
  paths: string[];
  size_on_disk: number;
  size_approx: number;
  present_ratio: number;
  torrent_progress: number;
  torrent_selected: boolean;
  torrent_complete: boolean;
  torrent_downloaded: number;
  torrent_size: number;
  local_only?: boolean;
  children: SyncChild[];
};
type SyncRoom = {
  id: string;
  label: string;
  glyph: string;
  size_on_disk: number;
  size_approx: number;
  entries: SyncEntry[];
};
type SyncOverview = {
  magnet: string | null;
  torrent_url: string | null;
  hint?: string;
  save_path_hint: string;
  size_on_disk: number;
  size_approx: number;
  rooms: SyncRoom[];
  torrent?: {
    mode?: string;
    state?: string;
    progress?: number;
    download_rate_kbps?: number;
    upload_rate_kbps?: number;
    num_seeds?: number;
    num_peers?: number;
    total_seeds?: number;
    total_peers?: number;
    eta_seconds?: number | null;
    has_metadata?: boolean;
    error?: string;
    save_path?: string;
    paused?: boolean;
    is_seeding?: boolean;
    health?: number;
    ratio?: number;
    availability?: number;
    uploaded_bytes?: number;
    downloaded_bytes?: number;
    pieces_have?: number;
    pieces_total?: number;
    incomplete_count?: number;
    skipped_count?: number;
    stuck_at_end?: boolean;
    incomplete_files?: Array<{
      path: string;
      size: number;
      downloaded: number;
      progress: number;
      priority: number;
      skipped: boolean;
      pack_id?: string | null;
    }>;
    seed_after_download?: boolean;
    auto_seed_on_start?: boolean;
    background_tray?: boolean;
    upload_limit_kbps?: number;
    list_peers?: number;
    list_seeds?: number;
  };
};

type TorrentState = {
  provider_uri: string;
  embedded_magnet?: string;
  seed_after_download: boolean;
  auto_seed_on_start?: boolean;
  background_tray?: boolean;
  background_tray_running?: boolean;
  upload_limit_kbps: number;
  selected_packs: string[];
  mode: string;
  have_libtorrent: boolean;
  seven_zip_available: boolean;
};

type Detection = {
  id: string;
  label: string;
  kind: string;
  config_key: string;
  value: string;
  newer: boolean | null;
  incomplete?: boolean;
  count_hint?: number;
};

const STATE_META: Record<PackState, { color: string; glow: string; label: string; glyph: string }> = {
  grey: { color: "var(--text-muted)", glow: "transparent", label: "Not installed", glyph: "radio_button_unchecked" },
  yellow: { color: "var(--amber)", glow: "var(--amber-glow)", label: "Verifying…", glyph: "hourglass_top" },
  green: { color: "var(--green)", glow: "var(--green-glow)", label: "Verified", glyph: "check_circle" },
  red: { color: "var(--red)", glow: "var(--red-glow)", label: "Failed", glyph: "error" },
};

function fmtSize(gb: number): string {
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`;
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtRate(kbps: number | undefined): string {
  const v = kbps ?? 0;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} MB/s`;
  return `${Math.round(v)} KB/s`;
}

function fmtEta(seconds: number | null | undefined): string {
  if (seconds == null) return "∞";
  if (seconds <= 0) return "done";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.round((seconds % 86400) / 3600)}h`;
}

function healthColor(h: number | undefined): string {
  const v = h ?? 0;
  if (v >= 70) return "var(--green)";
  if (v >= 40) return "var(--amber)";
  return "var(--red)";
}

function healthLabel(h: number | undefined): string {
  const v = h ?? 0;
  if (v >= 70) return "Healthy";
  if (v >= 40) return "Fair";
  if (v > 0) return "Weak";
  return "Idle";
}

function ProgressBar({ value, color, height = 6 }: { value: number; color?: string; height?: number }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  return (
    <div style={{ height, borderRadius: 999, background: "var(--bg-base)", border: "1px solid var(--border)", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color || "var(--accent)", transition: "width .4s ease" }} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-elevated, transparent)" }}>
      <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 650, fontSize: 13, color: "var(--text-primary)" }}>{value}</div>
    </div>
  );
}

export default function ContentManagerRoot() {
  const base = getBackendUrl();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const [torrentState, setTorrentState] = useState<TorrentState | null>(null);
  const [sync, setSync] = useState<SyncOverview | null>(null);
  const [providerInput, setProviderInput] = useState("");
  const [selectedPacks, setSelectedPacks] = useState<Set<string>>(new Set());
  const [expandedRooms, setExpandedRooms] = useState<Set<string>>(new Set(["qbanks", "databases", "books"]));

  const [folderPath, setFolderPath] = useState("");
  const [detections, setDetections] = useState<Detection[] | null>(null);
  const [detectMessage, setDetectMessage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const [prepareLog, setPrepareLog] = useState<string[]>([]);
  const [prepareRunning, setPrepareRunning] = useState(false);
  const prepareLogRef = useRef<HTMLDivElement>(null);
  const [chromeGuideOpen, setChromeGuideOpen] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [fetchBusy, setFetchBusy] = useState(false);
  const [torrentPaused, setTorrentPaused] = useState(false);
  const [appUpdate, setAppUpdate] = useState<{
    available: boolean;
    file: string | null;
    size_bytes: number;
    url: string | null;
    hint?: string;
  } | null>(null);

  const loadPacks = useCallback(async () => {
    try {
      const r = await fetch(`${base}/content/packs`);
      const d = await r.json();
      setPacks(d.packs || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [base]);

  const loadTorrentState = useCallback(async () => {
    try {
      const r = await fetch(`${base}/content/torrent/state`);
      const d = await r.json();
      setTorrentState(d);
      const link = (d.provider_uri || d.embedded_magnet || "").trim();
      if (link) setProviderInput(link);
      setSelectedPacks(new Set(d.selected_packs || []));
    } catch {
      /* ignore */
    }
  }, [base]);

  const loadSync = useCallback(async () => {
    try {
      const r = await fetch(`${base}/content/sync`);
      const d = await r.json();
      setSync(d);
      if (d.magnet) setProviderInput((prev) => prev.trim() || d.magnet);
    } catch {
      /* ignore */
    }
  }, [base]);

  const loadAppUpdate = useCallback(async () => {
    try {
      const r = await fetch(`${base}/content/app-update/info`);
      setAppUpdate(await r.json());
    } catch {
      /* ignore */
    }
  }, [base]);

  useEffect(() => {
    loadPacks();
    loadTorrentState();
    loadSync();
    loadAppUpdate();
    const packsTimer = setInterval(loadPacks, 15000);
    return () => clearInterval(packsTimer);
  }, [loadPacks, loadTorrentState, loadSync, loadAppUpdate]);

  useEffect(() => {
    loadSync();
    const t = setInterval(loadSync, 3000);
    return () => clearInterval(t);
  }, [loadSync]);

  useEffect(() => {
    if (typeof sync?.torrent?.paused === "boolean") {
      setTorrentPaused(!!sync.torrent.paused);
    }
  }, [sync?.torrent?.paused]);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const r = await fetch(`${base}/content/prepare-utd/status`);
        const d = await r.json();
        if (stop) return;
        setPrepareLog(d.log || []);
        setPrepareRunning(!!d.running);
        if (d.running) setTimeout(poll, 1500);
        else if (d.finished_at) loadPacks();
      } catch {
        /* ignore */
      }
    }
    poll();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    prepareLogRef.current?.scrollTo({ top: prepareLogRef.current.scrollHeight });
  }, [prepareLog]);

  const refreshPack = useCallback(async (id: string) => {
    setRefreshing(id);
    try {
      await fetch(`${base}/content/packs/${id}/refresh`, { method: "POST" });
      await loadPacks();
      await loadSync();
    } finally {
      setRefreshing(null);
    }
  }, [base, loadPacks, loadSync]);

  const saveProvider = useCallback(async (uri?: string) => {
    const link = (uri ?? providerInput).trim();
    if (!link) {
      setFetchMsg({ tone: "err", text: "Paste a magnet or .torrent link first." });
      return false;
    }
    const r = await fetch(`${base}/content/torrent/provider`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: link }),
    });
    if (!r.ok) {
      setFetchMsg({ tone: "err", text: "Could not save the torrent link." });
      return false;
    }
    setProviderInput(link);
    await loadTorrentState();
    return true;
  }, [base, providerInput, loadTorrentState]);

  const startFetch = useCallback(async () => {
    setFetchBusy(true);
    setFetchMsg(null);
    try {
      const link = providerInput.trim() || sync?.magnet || "";
      if (!link) {
        setFetchMsg({
          tone: "err",
          text: "No magnet set. Build one with MAKE_MEDOS_TORRENT.ps1 so the app embeds it, or paste a magnet above.",
        });
        return;
      }
      if (!(await saveProvider(link))) return;
      const packList = Array.from(selectedPacks);
      if (packList.length === 0) {
        setFetchMsg({ tone: "info", text: "No rooms ticked — syncing the full torrent. Tick rooms below for selective fetch." });
      }
      const r = await fetch(`${base}/content/torrent/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packs: packList }),
      });
      const d = await r.json().catch(() => ({}));
      await loadTorrentState();
      await loadSync();
      if (!r.ok || d.ok === false) {
        setFetchMsg({ tone: "err", text: d.detail || d.error || "Start fetch failed." });
        return;
      }
      setFetchMsg({ tone: "ok", text: d.detail || "Sync started." });
    } catch {
      setFetchMsg({ tone: "err", text: "Could not reach the backend to start sync." });
    } finally {
      setFetchBusy(false);
    }
  }, [base, providerInput, sync, selectedPacks, saveProvider, loadTorrentState, loadSync]);

  const toggleSeed = useCallback(async (enabled: boolean) => {
    await fetch(`${base}/content/torrent/seed`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await loadTorrentState();
  }, [base, loadTorrentState]);

  const toggleAutoSeed = useCallback(async (enabled: boolean) => {
    await fetch(`${base}/content/torrent/auto-seed`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await loadTorrentState();
  }, [base, loadTorrentState]);

  const toggleTray = useCallback(async (enabled: boolean) => {
    const r = await fetch(`${base}/content/torrent/tray`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const d = await r.json().catch(() => ({}));
    setFetchMsg({
      tone: d.ok ? "ok" : "err",
      text: d.detail || (enabled ? "Background tray seeder toggled." : "Background seeder off."),
    });
    await loadTorrentState();
  }, [base, loadTorrentState]);

  const setUploadCap = useCallback(async (kbps: number) => {
    await fetch(`${base}/content/torrent/upload-limit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kbps }),
    });
    await loadTorrentState();
  }, [base, loadTorrentState]);

  const recheckTorrent = useCallback(async () => {
    const r = await fetch(`${base}/content/torrent/recheck`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setFetchMsg({ tone: d.ok ? "ok" : "err", text: d.detail || "Re-check requested." });
    void loadSync();
  }, [base, loadSync]);

  const announceTorrent = useCallback(async () => {
    const r = await fetch(`${base}/content/torrent/announce`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setFetchMsg({ tone: d.ok ? "ok" : "err", text: d.detail || "Announced." });
  }, [base]);

  const clearSkips = useCallback(async () => {
    const r = await fetch(`${base}/content/torrent/clear-skips`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setFetchMsg({
      tone: d.ok ? "ok" : "err",
      text: d.detail || "Cleared skips — remaining files will download.",
    });
    void loadSync();
  }, [base, loadSync]);

  const pauseResume = useCallback(async () => {
    const action = torrentPaused ? "resume" : "pause";
    const r = await fetch(`${base}/content/torrent/${action}`, { method: "POST" });
    const d = await r.json();
    if (d.ok) setTorrentPaused(!torrentPaused);
  }, [base, torrentPaused]);

  const applySelectionLive = useCallback(async (next: Set<string>) => {
    await fetch(`${base}/content/torrent/selection`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packs: Array.from(next) }),
    });
  }, [base]);

  const togglePack = useCallback((packId: string, checked: boolean) => {
    setSelectedPacks((prev) => {
      const next = new Set(prev);
      if (checked) next.add(packId); else next.delete(packId);
      if (sync?.torrent?.mode === "libtorrent") void applySelectionLive(next);
      return next;
    });
  }, [sync, applySelectionLive]);

  const scanFolder = useCallback(async () => {
    if (!folderPath.trim()) return;
    setScanning(true);
    setDetections(null);
    setDetectMessage(null);
    try {
      const r = await fetch(`${base}/content/import-folder`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folderPath.trim() }),
      });
      const d = await r.json();
      if (r.ok) {
        setDetections(d.detected || []);
        if (!d.detected?.length) setDetectMessage(d.message || "Nothing recognized in this folder.");
      } else {
        setDetectMessage(d.detail || "Scan failed.");
      }
    } catch {
      setDetectMessage("Could not reach the backend.");
    } finally {
      setScanning(false);
    }
  }, [base, folderPath]);

  const applyDetection = useCallback(async (configKey: string) => {
    const r = await fetch(`${base}/content/import-folder`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath.trim(), confirm_key: configKey }),
    });
    const d = await r.json();
    if (r.ok) {
      setDetectMessage(`Applied ${d.applied?.label || configKey}. Rebuilding search index in the background…`);
      setTimeout(() => { void loadPacks(); void loadSync(); }, 4000);
    }
  }, [base, folderPath, loadPacks, loadSync]);

  const runPrepareUtd = useCallback(async () => {
    setPrepareRunning(true);
    setPrepareLog([]);
    await fetch(`${base}/content/prepare-utd`, { method: "POST" });
  }, [base]);

  const cleanupPack = useCallback(async (id: string) => {
    const r = await fetch(`${base}/content/cleanup/${id}`, { method: "POST" });
    const d = await r.json();
    const freed = (d.removed || []).reduce((sum: number, x: { freed_bytes?: number }) => sum + (x.freed_bytes || 0), 0);
    setDetectMessage(freed > 0 ? `Freed ${fmtBytes(freed)} of superseded build files.` : "Nothing to clean up.");
  }, [base]);

  const utdPack = packs.find((p) => p.id === "uptodate");
  const t = sync?.torrent;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "28px 32px 60px", maxWidth: 1080, margin: "0 auto", width: "100%" }}>
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)", margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
          <M name="deployed_code" size={24} color="var(--accent)" />
          Content Manager
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 6, maxWidth: 720 }}>
          Sync content from the self-contained MedOS torrent, seed to peers while the app is open
          (or via the optional background tray), verify packs, and update the app without replacing your data.
        </p>
      </header>

      {/* ── Transfer & backup (personal data + content archives) ── */}
      <TransferPanel
        onChanged={() => {
          void loadPacks();
          void loadSync();
          void loadTorrentState();
        }}
      />

      {/* ── App update (one file) ── */}
      <section style={{ marginBottom: 28 }}>
        <SectionTitle glyph="system_update" label="Update app (keep data)" />
        <div style={cardStyle}>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "0 0 10px" }}>
            Send users one <code>MedOS-core-*.7z</code>. They extract it over their existing MedOS folder —
            data, progress, and packs stay; only the app/runtime updates.
          </p>
          {appUpdate?.available && appUpdate.url ? (
            <a href={`${base}${appUpdate.url}`} download={appUpdate.file || undefined} style={{ ...primaryBtn, textDecoration: "none", display: "inline-flex" }}>
              <M name="download" size={16} /> Download {appUpdate.file} ({fmtBytes(appUpdate.size_bytes)})
            </a>
          ) : (
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
              No core update package on this machine yet. Build with <code>PACK_APP_UPDATE.ps1 -Execute</code>.
            </p>
          )}
        </div>
      </section>

      {/* ── Hierarchical sync rooms ── */}
      <section style={{ marginBottom: 32 }}>
        <SectionTitle glyph="cloud_sync" label="Swarm sync & seeding" />
        <div style={cardStyle}>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "0 0 10px" }}>
            Self-contained live MedOS torrent. While the app is open, seeding starts automatically.
            Tick rooms for selective download, or leave empty for the full tree.
            Save path for any external client: <code>{sync?.save_path_hint || "parent of MedOS"}</code>.
          </p>

          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input
              value={providerInput}
              onChange={(e) => setProviderInput(e.target.value)}
              placeholder="magnet:?xt=urn:btih:… (auto-filled from embedded sync link when available)"
              style={inputStyle}
            />
            <button type="button" onClick={() => { void saveProvider(); }} style={smallBtn}>Save link</button>
            {sync?.magnet && (
              <button
                type="button"
                style={smallBtn}
                onClick={() => {
                  navigator.clipboard?.writeText(sync.magnet || "");
                  setProviderInput(sync.magnet || "");
                }}
              >
                <M name="content_copy" size={14} /> Copy
              </button>
            )}
          </div>

          {sync?.torrent_url && (
            <a href={`${base}${sync.torrent_url}`} style={{ fontSize: 12, color: "var(--accent)", display: "inline-block", marginBottom: 10 }} download>
              Download .torrent for any client
            </a>
          )}

          {fetchMsg && (
            <p style={{
              fontSize: 12, marginBottom: 10, display: "flex", gap: 6, alignItems: "flex-start",
              color: fetchMsg.tone === "err" ? "var(--red)" : fetchMsg.tone === "ok" ? "var(--green)" : "var(--amber-dim)",
            }}>
              <M name={fetchMsg.tone === "err" ? "error" : fetchMsg.tone === "ok" ? "check_circle" : "info"} size={14} />
              {fetchMsg.text}
            </p>
          )}

          {!torrentState?.have_libtorrent && (
            <p style={{ fontSize: 11.5, color: "var(--amber-dim)", display: "flex", gap: 6, marginBottom: 10 }}>
              <M name="info" size={14} color="var(--amber)" />
              In-app libtorrent is unavailable — open the magnet in qBittorrent/Transmission with download
              location set to the parent of your MedOS folder.
            </p>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <button type="button" onClick={() => { void startFetch(); }} disabled={fetchBusy} style={primaryBtn}>
              <M name="download" size={16} /> {fetchBusy ? "Starting…" : "Sync / Seed now"}
            </button>
            {(t?.mode === "libtorrent" || torrentState?.mode === "libtorrent") && (
              <>
                <button type="button" onClick={() => { void pauseResume(); }} style={smallBtn}>
                  <M name={torrentPaused || t?.paused ? "play_arrow" : "pause"} size={14} />
                  {torrentPaused || t?.paused ? "Resume" : "Pause"}
                </button>
                <button type="button" onClick={() => { void recheckTorrent(); }} style={smallBtn}>
                  <M name="verified" size={14} /> Force re-check
                </button>
                <button type="button" onClick={() => { void announceTorrent(); }} style={smallBtn}>
                  <M name="cell_tower" size={14} /> Announce
                </button>
                <button type="button" onClick={() => { void clearSkips(); }} style={smallBtn}>
                  <M name="playlist_add_check" size={14} /> Un-skip all files
                </button>
              </>
            )}
            {sync && (
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", marginLeft: "auto" }}>
                On disk {fmtBytes(sync.size_on_disk)}
                {sync.size_approx > 0 ? ` / ~${fmtBytes(sync.size_approx)}` : ""}
              </span>
            )}
          </div>

          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 14,
          }}>
            <label style={optLabel}>
              <input type="checkbox" checked={torrentState?.auto_seed_on_start ?? true} onChange={(e) => toggleAutoSeed(e.target.checked)} />
              Seed while MedOS is open (default)
            </label>
            <label style={optLabel}>
              <input type="checkbox" checked={torrentState?.seed_after_download ?? true} onChange={(e) => toggleSeed(e.target.checked)} />
              Keep seeding after download finishes
            </label>
            <label style={optLabel}>
              <input
                type="checkbox"
                checked={!!(torrentState?.background_tray || torrentState?.background_tray_running)}
                onChange={(e) => toggleTray(e.target.checked)}
              />
              Seed in background (tray) — even when app is closed
              {torrentState?.background_tray_running ? " · running" : ""}
            </label>
            <label style={{ ...optLabel, gap: 8 }}>
              Upload cap
              <select
                value={String(torrentState?.upload_limit_kbps ?? 0)}
                onChange={(e) => void setUploadCap(Number(e.target.value))}
                style={{ ...inputStyle, width: "auto", padding: "4px 8px" }}
              >
                <option value="0">Unlimited</option>
                <option value="256">256 KB/s</option>
                <option value="512">512 KB/s</option>
                <option value="1024">1 MB/s</option>
                <option value="2048">2 MB/s</option>
                <option value="5120">5 MB/s</option>
              </select>
            </label>
          </div>

          <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "0 0 12px" }}>
            Power users: open the same magnet in uTorrent/qBittorrent with save path{" "}
            <code>{sync?.save_path_hint || "parent of MedOS"}</code>
            {" "}(must be the parent folder — e.g. <code>C:\</code> not <code>C:\MedOS</code>).
            Do not run two clients on the same folder at once — close uTorrent while seeding in-app.
          </p>

          {t && t.mode !== "idle" && (
            <div style={{ marginBottom: 14, padding: 14, borderRadius: 12, background: "var(--bg-base)", border: "1px solid var(--border)" }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8,
                  background: "var(--bg-elevated, var(--bg-base))", border: `1px solid ${healthColor(t.health)}`,
                }}>
                  <M name="monitor_heart" size={18} color={healthColor(t.health)} fill />
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Swarm health</div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: healthColor(t.health) }}>
                      {t.health ?? 0}/100 · {healthLabel(t.health)}
                    </div>
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <strong style={{ textTransform: "capitalize" }}>
                      {t.is_seeding ? "Seeding" : String(t.state || t.mode).replace(/_/g, " ")}
                      {t.paused ? " (paused)" : ""}
                    </strong>
                    <span>{((t.progress || 0) * 100).toFixed(1)}%</span>
                  </div>
                  <ProgressBar value={t.progress || 0} color={t.is_seeding ? "var(--green)" : "var(--accent)"} height={8} />
                </div>
              </div>

              <div style={{
                display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, fontSize: 12,
              }}>
                <Stat label="Download" value={`↓ ${fmtRate(t.download_rate_kbps)}`} />
                <Stat label="Upload" value={`↑ ${fmtRate(t.upload_rate_kbps)}`} />
                <Stat label="Peers" value={`${t.num_peers ?? 0}`} />
                <Stat label="Seeds" value={`${t.num_seeds ?? 0}`} />
                <Stat label="Availability" value={t.availability != null && t.availability >= 0 ? t.availability.toFixed(2) : "—"} />
                <Stat label="Share ratio" value={t.ratio != null ? t.ratio.toFixed(2) : "—"} />
                <Stat label="Uploaded" value={fmtBytes(t.uploaded_bytes || 0)} />
                <Stat label="Downloaded" value={fmtBytes(t.downloaded_bytes || 0)} />
                <Stat label="ETA" value={fmtEta(t.eta_seconds)} />
                <Stat
                  label="Pieces"
                  value={t.pieces_total ? `${t.pieces_have ?? 0}/${t.pieces_total}` : "—"}
                />
              </div>

              {t.stuck_at_end && (
                <div style={{
                  marginTop: 12, padding: 10, borderRadius: 8, border: "1px solid var(--amber)",
                  background: "color-mix(in srgb, var(--amber) 8%, transparent)",
                }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: "var(--amber-dim)" }}>
                    <M name="warning" size={16} color="var(--amber)" />
                    <div>
                      Stuck near 100% — usually from <strong>skipped</strong> files (APK / README) in an external client,
                      or a few unfinished pieces. Click <strong>Un-skip all files</strong>, then <strong>Force re-check</strong>.
                      {(t.skipped_count || 0) > 0 && <> ({t.skipped_count} skipped, {t.incomplete_count} incomplete)</>}
                    </div>
                  </div>
                </div>
              )}

              {(t.state === "downloading_metadata" || (!(t.num_peers || 0) && !(t.num_seeds || 0) && (t.progress || 0) < 0.01)) && (
                <p style={{ fontSize: 11.5, color: "var(--amber-dim)", margin: "10px 0 0" }}>
                  Waiting for peers. You are likely the first seeder — Force re-check so local files hash-match and you start seeding.
                </p>
              )}

              {(t.incomplete_files?.length || 0) > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
                    Incomplete / skipped files
                  </div>
                  <div style={{ maxHeight: 160, overflowY: "auto", fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
                    {t.incomplete_files!.map((f) => (
                      <div key={f.path} style={{
                        display: "flex", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--border)",
                        color: f.skipped ? "var(--amber-dim)" : "var(--text-muted)",
                      }}>
                        <span style={{ width: 52, flexShrink: 0 }}>{f.skipped ? "skip" : `${(f.progress * 100).toFixed(0)}%`}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path.replace(/^MedOS\//, "")}</span>
                        <span style={{ marginLeft: "auto", flexShrink: 0 }}>{fmtBytes(f.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {t.error && <p style={{ color: "var(--red)", marginTop: 8, fontSize: 12 }}>{t.error}</p>}
            </div>
          )}

          {!sync?.rooms?.length && (
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading sync rooms…</p>
          )}

          {sync?.rooms?.map((room) => {
            const open = expandedRooms.has(room.id);
            return (
              <div key={room.id} style={{ marginBottom: 10, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                <button
                  type="button"
                  onClick={() => setExpandedRooms((prev) => {
                    const next = new Set(prev);
                    if (next.has(room.id)) next.delete(room.id); else next.add(room.id);
                    return next;
                  })}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
                    background: "var(--bg-base)", border: "none", cursor: "pointer", color: "var(--text-primary)",
                  }}
                >
                  <M name={open ? "expand_more" : "chevron_right"} size={18} />
                  <M name={room.glyph || "folder"} size={18} color="var(--accent)" />
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{room.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>
                    {fmtBytes(room.size_on_disk)}
                    {room.size_approx > 0 ? ` / ~${fmtBytes(room.size_approx)}` : ""}
                  </span>
                </button>
                {open && room.entries.map((entry) => {
                  const meta = STATE_META[(entry.state as PackState)] || STATE_META.grey;
                  const bar = entry.torrent_selected && entry.torrent_size > 0
                    ? entry.torrent_progress
                    : entry.present_ratio;
                  const barColor = entry.torrent_complete || entry.state === "green" ? "var(--green)" : "var(--accent)";
                  return (
                    <div key={entry.id} style={{ padding: "12px 14px", borderTop: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        {!entry.required && !entry.local_only && (
                          <input
                            type="checkbox"
                            checked={selectedPacks.has(entry.pack_id)}
                            onChange={(e) => togglePack(entry.pack_id, e.target.checked)}
                            style={{ marginTop: 3 }}
                          />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>
                              {entry.label}
                              {entry.local_only ? (
                                <span
                                  style={{
                                    marginLeft: 7,
                                    padding: "1px 7px",
                                    borderRadius: 999,
                                    border: "1px solid var(--border)",
                                    fontSize: 10,
                                    fontWeight: 600,
                                    color: "var(--text-muted)",
                                    verticalAlign: "middle",
                                  }}
                                >
                                  local
                                </span>
                              ) : null}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: meta.color }}>
                              <M name={meta.glyph} size={14} fill color={meta.color} />
                              {meta.label}
                            </div>
                          </div>
                          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                            {fmtBytes(entry.size_on_disk)} on disk
                            {!entry.local_only && entry.size_approx > 0 ? ` · ~${fmtBytes(entry.size_approx)} expected` : ""}
                            {entry.torrent_selected && entry.torrent_size > 0 && (
                              <> · sync {fmtBytes(entry.torrent_downloaded)} / {fmtBytes(entry.torrent_size)}</>
                            )}
                          </div>
                          {entry.description && (
                            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "6px 0 8px" }}>{entry.description}</p>
                          )}
                          <ProgressBar value={bar} color={barColor} />
                          {entry.children?.length > 0 && (
                            <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                              {entry.children.map((c) => (
                                <div key={c.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-muted)", paddingLeft: 4 }}>
                                  <span>{c.present ? "●" : "○"} {c.label}</span>
                                  <span>{fmtBytes(c.size_on_disk)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {entry.pack_id === "books" && <BookIndexPanel base={base} />}
                          {!entry.local_only && (
                            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                              <button type="button" onClick={() => refreshPack(entry.pack_id)} disabled={refreshing === entry.pack_id} style={smallBtn}>
                                <M name="refresh" size={14} /> {refreshing === entry.pack_id ? "Verifying…" : "Re-verify"}
                              </button>
                              {entry.pack_id === "uptodate" && (
                                <button type="button" onClick={() => cleanupPack(entry.pack_id)} style={smallBtn}>
                                  <M name="mop" size={14} /> Cleanup
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Pack status grid (compact) ── */}
      <section style={{ marginBottom: 32 }}>
        <SectionTitle glyph="inventory_2" label="Pack status" />
        {loading ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
            {packs.map((p) => {
              const meta = STATE_META[p.state] ?? STATE_META.grey;
              return (
                <div key={p.id} style={{ ...cardStyle, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                    <span style={{ fontSize: 10.5, color: meta.color, fontWeight: 700 }}>{meta.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{fmtSize(p.approx_size_gb)}</div>
                  <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0" }}>{p.detail}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {utdPack && utdPack.installed && (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle glyph="lock_open" label="Prepare UpToDate" />
          <div style={cardStyle}>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "0 0 10px" }}>
              One-time local decrypt of the UpToDate bundle into a fast article cache
              (~2–10 minutes, CPU only, no network).
            </p>
            <button type="button" onClick={runPrepareUtd} disabled={prepareRunning} style={primaryBtn}>
              <M name="play_arrow" size={16} /> {prepareRunning ? "Preparing…" : "Prepare UpToDate"}
            </button>
            {prepareLog.length > 0 && (
              <div ref={prepareLogRef} style={logBox}>
                {prepareLog.map((line, i) => <div key={i}>{line}</div>)}
              </div>
            )}
          </div>
        </section>
      )}

      <section style={{ marginBottom: 32 }}>
        <SectionTitle glyph="folder_open" label="Add a content folder" />
        <div style={cardStyle}>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "0 0 10px" }}>
            Point at any content export — UpToDate, Sanford, AMBOSS, Micromedex/Lexicomp,
            a UWorld/AMBOSS/NBME/Mehlman qbank folder, or a plain folder of PDFs — and MedOS will detect
            and wire it in without copying files.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="C:\content\uptodate-2026-09 or C:\MedOS\data\mehlman-2-2025" style={inputStyle} />
            <button type="button" onClick={scanFolder} disabled={scanning} style={smallBtn}>
              <M name="search" size={14} /> {scanning ? "Scanning…" : "Scan"}
            </button>
          </div>
          {detectMessage && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{detectMessage}</p>}
          {detections?.map((d) => (
            <div key={`${d.id}-${d.config_key}-${d.value}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 10px", borderRadius: 8, background: "var(--bg-base)", border: "1px solid var(--border)", marginBottom: 6, opacity: d.incomplete ? 0.75 : 1 }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: d.incomplete ? "var(--amber-dim)" : "var(--text-primary)" }}>{d.label}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {d.value}
                  {d.incomplete && <span style={{ color: "var(--amber-dim)" }}> · incomplete — needs the question .db inside the folder</span>}
                  {!d.incomplete && d.newer === true && <span style={{ color: "var(--amber-dim)" }}> · newer than what you have</span>}
                  {!d.incomplete && d.newer === false && <span> · same or older than what you have</span>}
                </div>
              </div>
              {d.incomplete ? (
                <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>Can&apos;t apply</span>
              ) : (
                <button type="button" onClick={() => applyDetection(d.config_key)} style={smallBtn}>
                  {d.newer ? "Replace / update" : "Use this"}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 32 }}>
        <SectionTitle glyph="devices" label="Companion apps" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          <button type="button" onClick={() => setChromeGuideOpen((v) => !v)} style={{ ...cardStyle, textAlign: "left", cursor: "pointer", width: "100%" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <M name="extension" size={18} color="var(--accent)" /> Chrome extension
            </div>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
              Click to download a zip + see install steps (Load unpacked).
            </p>
            {chromeGuideOpen && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--text-secondary)" }}>
                <ol style={{ margin: "0 0 10px", paddingLeft: 18, lineHeight: 1.55 }}>
                  <li>Download the zip below and unzip it.</li>
                  <li>Open <code>chrome://extensions</code> in Chrome/Edge.</li>
                  <li>Turn on <strong>Developer mode</strong> (top-right).</li>
                  <li>Click <strong>Load unpacked</strong> and pick the <code>medos-reference-sidebar</code> folder.</li>
                </ol>
                <a href={`${base}/content/chrome-extension`} download="medos-chrome-extension.zip" onClick={(e) => e.stopPropagation()} style={{ ...smallBtn, display: "inline-flex", textDecoration: "none" }}>
                  <M name="download" size={14} /> Download extension zip
                </a>
              </div>
            )}
          </button>

          <a href={`${base}/content/apk`} download="MedOS.apk" style={{ ...cardStyle, textDecoration: "none", color: "inherit", display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <M name="smartphone" size={18} color="var(--accent)" /> Android app
            </div>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
              Click to download <code>MedOS.apk</code>, then install / sideload on your phone.
            </p>
          </a>

          <a href="https://t.me/MedicalOperatingSystem" target="_blank" rel="noopener noreferrer" style={{ ...cardStyle, textDecoration: "none", color: "inherit", display: "block" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <M name="send" size={18} color="var(--accent)" /> Telegram
            </div>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
              Join <code>t.me/MedicalOperatingSystem</code> for updates and pack links.
            </p>
          </a>
        </div>
      </section>
    </div>
  );
}

type BookIndexBook = {
  id: string;
  title: string;
  folder: string;
  size: number;
  state: "ok" | "missing" | "empty" | "failed" | "stale";
  headings: number;
  pages: number;
  error: string;
};
type BookIndexShelf = { name: string; count: number; size: number; books: BookIndexBook[] };
type BookIndexPayload = {
  library: string;
  counts: Record<string, number>;
  shelves: BookIndexShelf[];
  indexing: { status?: string; processed?: number; total?: number; current?: string; error?: string };
};

const BOOK_INDEX_META: Record<string, { color: string; label: string; glyph: string }> = {
  ok: { color: "var(--green)", label: "Indexed", glyph: "check_circle" },
  missing: { color: "var(--amber)", label: "Not indexed", glyph: "radio_button_unchecked" },
  stale: { color: "var(--amber)", label: "Changed", glyph: "update" },
  empty: { color: "var(--text-muted)", label: "No outline", glyph: "remove_circle" },
  failed: { color: "var(--red)", label: "Failed", glyph: "error" },
};

/** Per-book chapter/search index list for the Books pack. */
function BookIndexPanel({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BookIndexPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [onlyUnindexed, setOnlyUnindexed] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/library/index/books`);
      if (!r.ok) throw new Error(`index status failed (${r.status})`);
      const d = (await r.json()) as BookIndexPayload;
      if (alive.current) setData(d);
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: e instanceof Error ? e.message : "could not read book index" });
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [open, load]);

  const indexBook = useCallback(async (book: BookIndexBook) => {
    setPending(book.id);
    setNotice(null);
    try {
      const r = await fetch(`${base}/library/index/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: book.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(String(d?.detail || `request failed (${r.status})`));
      if (d?.status === "busy") {
        setNotice({ tone: "info", text: "Another index build is running - try again when it finishes." });
      } else {
        setNotice({ tone: "ok", text: `Indexing "${book.title}"...` });
      }
      load();
    } catch (e) {
      setNotice({ tone: "err", text: e instanceof Error ? e.message : "index request failed" });
    } finally {
      setPending(null);
    }
  }, [base, load]);

  const counts = data?.counts ?? {};
  const indexingNow = data?.indexing?.status === "indexing_chapters" || data?.indexing?.status === "indexing_search";
  const noticeColor = notice?.tone === "err" ? "var(--red)" : notice?.tone === "ok" ? "var(--green)" : "var(--text-muted)";

  return (
    <div style={{ marginTop: 10, borderTop: "1px dashed var(--border)", paddingTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ ...smallBtn, width: "100%", justifyContent: "space-between" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <M name={open ? "expand_more" : "chevron_right"} size={16} />
          <M name="library_books" size={16} color="var(--accent)" />
          Books in library
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {data ? `${counts.indexed ?? 0}/${counts.total ?? 0} indexed${indexingNow ? " - indexing..." : ""}` : open ? "loading..." : ""}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          {notice && <p style={{ fontSize: 11.5, color: noticeColor, margin: "0 0 6px" }}>{notice.text}</p>}
          {!data && loading && <p style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Loading books...</p>}
          {data && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
                <span>{counts.indexed ?? 0} indexed</span>
                <span>{counts.missing ?? 0} not indexed</span>
                <span>{counts.empty ?? 0} no outline</span>
                <span>{counts.failed ?? 0} failed</span>
                {(counts.stale ?? 0) > 0 && <span>{counts.stale} changed</span>}
                <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                  <input type="checkbox" checked={onlyUnindexed} onChange={(e) => setOnlyUnindexed(e.target.checked)} />
                  Only unindexed
                </label>
              </div>

              {indexingNow && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 3 }}>
                    {data.indexing.current ? `Indexing ${data.indexing.current}` : "Indexing..."}
                    {data.indexing.total ? ` (${data.indexing.processed ?? 0}/${data.indexing.total})` : ""}
                  </div>
                  <ProgressBar
                    value={data.indexing.total ? (data.indexing.processed ?? 0) / data.indexing.total : 0.02}
                    color="var(--accent)"
                  />
                </div>
              )}

              <div style={{ maxHeight: 340, overflowY: "auto", display: "grid", gap: 6, paddingRight: 4 }}>
                {data.shelves.map((shelf) => {
                  const books = onlyUnindexed
                    ? shelf.books.filter((b) => b.state === "missing" || b.state === "stale")
                    : shelf.books;
                  if (!books.length) return null;
                  return (
                    <div key={shelf.name}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", margin: "4px 0 2px" }}>
                        {shelf.name}{" "}
                        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>- {books.length}</span>
                      </div>
                      {books.map((book) => {
                        const meta = BOOK_INDEX_META[book.state] ?? BOOK_INDEX_META.missing;
                        const disabled = pending === book.id || indexingNow;
                        return (
                          <div
                            key={book.id}
                            style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 11.5 }}
                          >
                            <M name={meta.glyph} size={13} fill color={meta.color} />
                            <span
                              title={book.id}
                              style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-secondary)" }}
                            >
                              {book.title}
                            </span>
                            <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{fmtBytes(book.size)}</span>
                            <span style={{ color: meta.color, minWidth: 72, textAlign: "right" }}>{meta.label}</span>
                            <button
                              type="button"
                              onClick={() => indexBook(book)}
                              disabled={disabled}
                              title={book.state === "empty" ? "This PDF has no bookmarks; re-indexing will not add headings" : `Index ${book.title}`}
                              style={{ ...smallBtn, padding: "3px 8px", fontSize: 11, opacity: disabled ? 0.5 : 1, cursor: disabled ? "default" : "pointer" }}
                            >
                              <M name={pending === book.id ? "hourglass_top" : "manage_search"} size={12} />
                              {pending === book.id ? "..." : book.state === "ok" ? "Re-index" : "Index"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ glyph, label }: { glyph: string; label: string }) {
  return (
    <h2 style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      <M name={glyph} size={18} color="var(--accent)" />
      {label}
    </h2>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 14,
};

const smallBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600,
  padding: "6px 10px", borderRadius: 7, border: "1px solid var(--border)",
  background: "var(--bg-base)", color: "var(--text-secondary)", cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700,
  padding: "8px 14px", borderRadius: 8, border: "none",
  background: "var(--accent)", color: "#fff", cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  flex: 1, fontSize: 12.5, padding: "8px 10px", borderRadius: 8,
  border: "1px solid var(--border)", background: "var(--bg-base)", color: "var(--text-primary)",
};

const optLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-secondary)",
  fontSize: 12,
};

const logBox: React.CSSProperties = {
  marginTop: 10, maxHeight: 160, overflowY: "auto", fontFamily: "var(--font-mono)",
  fontSize: 11, background: "var(--bg-base)", border: "1px solid var(--border)",
  borderRadius: 8, padding: 8, color: "var(--text-muted)",
};
