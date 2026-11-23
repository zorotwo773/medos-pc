"use client";

/**
 * Transfer & backup — two actions at the top of the Content Manager:
 *
 *   Export   personal data and/or content as a RAR/7z (optionally split into
 *            volumes), plus a tiny JSON content list for sharing.
 *   Import   one window for personal data, content archives, and a partner's
 *            content list.
 *
 * Every archive carries `medos-export.json`, so any other MedOS install can
 * inspect it and import exactly the items selected.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBackendUrl } from "@/lib/api";

type ToolInfo = {
  rar: string | null;
  seven_zip: string | null;
  can_export: boolean;
  can_import: boolean;
  preferred: string | null;
};

type PersonalItem = {
  id: string;
  label: string;
  mode: string;
  rel: string;
  size: number;
  exists: boolean;
};

type BookItem = {
  rel: string;
  id: string;
  name: string;
  shelf: string;
  size: number;
};

type ContentItem = {
  id: string;
  pack_id: string | null;
  room_id: string | null;
  room: string;
  label: string;
  description: string;
  size: number;
  present: boolean;
  paths: string[];
  books?: BookItem[];
  children: { label: string; size: number; present: boolean }[];
};

type Inventory = {
  personal: PersonalItem[];
  content: ContentItem[];
  personal_total: number;
  content_total: number;
  app_build: string;
  machine: string;
  tools: ToolInfo;
  defaults: { destination: string; name: string; max_part_mb: number };
  free_bytes: number;
  root: string;
};

type StorageBucket = { id: string; label: string; bytes: number; files: number };

type StorageInfo = {
  root: string;
  total_bytes: number;
  data_bytes: number;
  data_files: number;
  content_total: number;
  content_items: number;
  personal_total: number;
  machine_local_bytes: number;
  unmapped_bytes: number;
  unmapped_files: number;
  unmapped: { group: string; bytes: number; files: number }[];
  buckets: StorageBucket[];
  reconciled_bytes: number;
  gap_bytes: number;
  checked_at: string;
};

type ExportVolume = { name: string; path: string; size: number };

type ExportResult = {
  kind: "export";
  name: string;
  destination: string;
  volumes: ExportVolume[];
  bytes: number;
  split_mb: number;
  personal: string[];
  content: string[];
  warning: string | null;
};

type PreviewPersonal = { id: string; label: string; size: number; stored: string | null };
type PreviewContent = {
  id: string;
  pack_id: string | null;
  room: string | null;
  label: string;
  size: number;
  roots: { rel: string | null; stored: string; size: number }[];
  children: { label: string; size: number; present: boolean }[];
};

type Preview = {
  format: string;
  version: number;
  kind: string;
  name: string;
  created_at: string;
  machine: string;
  app_build: string;
  split_bytes: number;
  personal: PreviewPersonal[];
  content: PreviewContent[];
  personal_total: number;
  content_total: number;
  package_root: string;
};

type ImportResult = {
  kind: "import";
  stamp: string;
  personal: { id: string; label: string; path?: string; error?: string }[];
  content: {
    id: string;
    pack_id?: string | null;
    label: string;
    size?: number;
    roots?: { rel: string; path: string; copied: number; skipped: number; bytes: number }[];
    applied?: string[];
    detected?: { label: string; config_key: string; incomplete: boolean }[];
    warnings?: string[];
    error?: string;
  }[];
  package: string;
  backups: string | null;
  source_machine: string | null;
  source_build: string | null;
};

type Job = {
  running: boolean;
  action: string | null;
  stage: string;
  percent: number | null;
  log: string[];
  error: string | null;
  result: ExportResult | ImportResult | { kind: "inspect" } | null;
  preview: Preview | null;
  token: string | null;
  started_at: number | null;
  finished_at: number | null;
};

type ListDiff = {
  format: string;
  created_at: string | null;
  machine: string | null;
  app_build: string | null;
  have: { id: string; label: string; size: number; room: string; local_size?: number }[];
  missing: { id: string; label: string; size: number; room: string }[];
  listed_count: number;
  local_count: number;
  listed_bytes: number;
};

const EMPTY_JOB: Job = {
  running: false,
  action: null,
  stage: "",
  percent: null,
  log: [],
  error: null,
  result: null,
  preview: null,
  token: null,
  started_at: null,
  finished_at: null,
};

function fmtBytes(n: number | undefined | null): string {
  const v = Number(n || 0);
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

function partLabel(mb: number): string {
  if (!mb) return "Single archive (no split)";
  if (Number.isInteger(mb) && mb >= 1024) return `${mb / 1024} GB per volume`;
  const text = Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
  return `${Number(text).toLocaleString("en-US")} MB per volume`;
}

const PART_CHOICES = [
  { value: "0", label: "No split — one archive" },
  { value: "1024", label: "1 GB per volume" },
  { value: "1945.5", label: "1,945.5 MB per volume" },
  { value: "2048", label: "2 GB per volume" },
  { value: "4096", label: "4 GB per volume" },
  { value: "8192", label: "8 GB per volume" },
  { value: "16384", label: "16 GB per volume" },
  { value: "custom", label: "Custom size…" },
];

async function readError(r: Response): Promise<string> {
  try {
    const d = await r.json();
    if (typeof d?.detail === "string") return d.detail;
    if (Array.isArray(d?.detail)) return d.detail.map((x: { msg?: string }) => x.msg || "").join("; ");
  } catch {
    /* ignore */
  }
  return `Request failed (HTTP ${r.status}).`;
}

export default function TransferPanel({ onChanged }: { onChanged?: () => void }) {
  const base = getBackendUrl();

  const [inv, setInv] = useState<Inventory | null>(null);
  const [invError, setInvError] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [job, setJob] = useState<Job>(EMPTY_JOB);
  const [toast, setToast] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [dest, setDest] = useState("");
  const [archiveName, setArchiveName] = useState("");
  const [partChoice, setPartChoice] = useState("0");
  const [customMb, setCustomMb] = useState("2048");
  const [selPersonal, setSelPersonal] = useState<Set<string>>(new Set());
  const [selContent, setSelContent] = useState<Set<string>>(new Set());
  const [freeInfo, setFreeInfo] = useState<{ free: number; path: string } | null>(null);
  const [pickBusy, setPickBusy] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [impPersonal, setImpPersonal] = useState<Set<string>>(new Set());
  const [impContent, setImpContent] = useState<Set<string>>(new Set());
  const [leftoversOpen, setLeftoversOpen] = useState(false);
  const [nonMedosOpen, setNonMedosOpen] = useState(false);
  const [bookFilter, setBookFilter] = useState("");

  const [listBusy, setListBusy] = useState(false);
  const [diff, setDiff] = useState<ListDiff | null>(null);
  const [diffName, setDiffName] = useState<string>("");
  const [diffError, setDiffError] = useState<string | null>(null);
  const listInputRef = useRef<HTMLInputElement>(null);
  const pollSeq = useRef(0);

  const loadInventory = useCallback(async (forceStorage = false) => {
    try {
      const [r, s] = await Promise.all([
        fetch(`${base}/content/transfer/inventory`),
        fetch(`${base}/content/transfer/storage${forceStorage ? "?force=true" : ""}`).catch(() => null),
      ]);
      if (!r.ok) throw new Error(await readError(r));
      const d: Inventory = await r.json();
      setInv(d);
      setInvError(null);
      setDest((prev) => prev || d.defaults.destination);
      setArchiveName((prev) => prev || d.defaults.name);
      if (s && s.ok) {
        setStorage((await s.json()) as StorageInfo);
      }
    } catch (e) {
      setInvError(e instanceof Error ? e.message : "Could not read the transfer inventory.");
    }
  }, [base]);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  const pollUntilDone = useCallback(async () => {
    const seq = ++pollSeq.current;
    for (;;) {
      try {
        const r = await fetch(`${base}/content/transfer/status`);
        const d: Job = await r.json();
        if (pollSeq.current !== seq) return;
        setJob(d);
        if (!d.running) {
          if (d.error) setToast({ tone: "err", text: d.error });
          if (d.action === "import" && d.result && "kind" in d.result && d.result.kind === "import") {
            void loadInventory(true);
            onChanged?.();
          }
          return;
        }
      } catch {
        if (pollSeq.current !== seq) return;
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }
      await new Promise((res) => setTimeout(res, 1200));
    }
  }, [base, loadInventory, onChanged]);

  const startPolling = useCallback(() => {
    setJob({ ...EMPTY_JOB, running: true, stage: "Starting…" });
    void pollUntilDone();
  }, [pollUntilDone]);

  // ── free-space probe for the export destination ─────────────────────────
  useEffect(() => {
    if (!exportOpen) return;
    const handle = setTimeout(() => {
      if (!dest.trim()) {
        setFreeInfo(null);
        return;
      }
      void fetch(`${base}/content/transfer/free`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dest.trim() }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && typeof d.free === "number") setFreeInfo({ free: d.free, path: d.probe || dest });
        })
        .catch(() => setFreeInfo(null));
    }, 450);
    return () => clearTimeout(handle);
  }, [base, dest, exportOpen]);

  const partMb = useMemo(() => {
    if (partChoice === "custom") {
      const n = parseFloat(customMb);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 1024 * 1024) : 0;
    }
    return parseFloat(partChoice) || 0;
  }, [partChoice, customMb]);

  const selectedPersonal = useMemo(
    () => (inv?.personal || []).filter((p) => selPersonal.has(p.id)),
    [inv, selPersonal],
  );
  const selectedContent = useMemo(
    () => (inv?.content || []).filter((c) => selContent.has(c.id)),
    [inv, selContent],
  );
  const allBooks = useMemo(
    () => (inv?.content || []).flatMap((c) => c.books || []),
    [inv],
  );
  const selectedBooks = useMemo(
    () => allBooks.filter((b) => selContent.has(b.id)),
    [allBooks, selContent],
  );
  const selectedBytes =
    selectedPersonal.reduce((s, p) => s + p.size, 0) +
    selectedContent.reduce((s, c) => s + c.size, 0) +
    selectedBooks.reduce((s, b) => s + b.size, 0);
  const selectedCount = selectedPersonal.length + selectedContent.length + selectedBooks.length;
  const volumeCount = partMb > 0 && selectedBytes > 0 ? Math.ceil(selectedBytes / (partMb * 1024 * 1024)) : 1;

  const contentByRoom = useMemo(() => {
    const groups = new Map<string, ContentItem[]>();
    for (const item of inv?.content || []) {
      const key = item.room || "Content";
      const list = groups.get(key) || [];
      list.push(item);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  }, [inv]);

  // ── actions ─────────────────────────────────────────────────────────────
  const openExport = useCallback(
    (preset: "personal" | "everything") => {
      const personal = new Set((inv?.personal || []).filter((p) => p.exists).map((p) => p.id));
      const content = new Set(preset === "everything" ? (inv?.content || []).map((c) => c.id) : []);
      setSelPersonal(personal);
      setSelContent(content);
      setPartChoice("0");
      setJob((prev) => (prev.running ? prev : EMPTY_JOB));
      setExportOpen(true);
      void loadInventory();
    },
    [inv, loadInventory],
  );

  const toggleIn = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickPath = useCallback(
    async (kind: "destination" | "archive" | "folder", initial: string, apply: (p: string) => void) => {
      setPickBusy(true);
      try {
        const r = await fetch(`${base}/content/transfer/pick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, initial }),
        });
        if (!r.ok) throw new Error(await readError(r));
        const d = await r.json();
        if (d.cancelled) return;
        if (d.path) apply(String(d.path));
      } catch (e) {
        setToast({ tone: "err", text: e instanceof Error ? e.message : "Could not open the picker." });
      } finally {
        setPickBusy(false);
      }
    },
    [base],
  );

  const startQuickImport = useCallback(async (pathText: string) => {
    const path = pathText.trim();
    if (!path) {
      setToast({ tone: "err", text: "No archive was chosen." });
      return;
    }
    setImportPath(path);
    setImportOpen(false);
    setPreview(null);
    try {
      const r = await fetch(`${base}/content/transfer/import-quick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) throw new Error(await readError(r));
      startPolling();
    } catch (e) {
      setToast({ tone: "err", text: e instanceof Error ? e.message : "Could not start the import." });
    }
  }, [base, startPolling]);

  const chooseQuickArchive = useCallback(() => {
    void pickPath("archive", importPath, (path) => { void startQuickImport(path); });
  }, [importPath, pickPath, startQuickImport]);

  const startExport = useCallback(async () => {
    if (!selectedPersonal.length && !selectedContent.length) {
      setToast({ tone: "err", text: "Select at least one item to export." });
      return;
    }
    if (!dest.trim()) {
      setToast({ tone: "err", text: "Choose a destination folder." });
      return;
    }
    try {
      const r = await fetch(`${base}/content/transfer/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destination: dest.trim(),
          name: archiveName.trim(),
          personal: Array.from(selPersonal),
          content: Array.from(selContent),
          max_part_mb: partMb,
        }),
      });
      if (!r.ok) throw new Error(await readError(r));
      startPolling();
    } catch (e) {
      setToast({ tone: "err", text: e instanceof Error ? e.message : "Could not start the export." });
    }
  }, [archiveName, base, dest, partMb, selContent, selPersonal, selectedContent.length, selectedPersonal.length, startPolling]);

  const openImport = useCallback(() => {
    setImportOpen(true);
    setPreview(null);
    setImportPath("");
    setDiff(null);
    setDiffName("");
    setDiffError(null);
    setJob((prev) => (prev.running ? prev : EMPTY_JOB));
    void loadInventory();
  }, [loadInventory]);

  const startInspect = useCallback(async () => {
    if (!importPath.trim()) {
      setToast({ tone: "err", text: "Choose an export archive or folder first." });
      return;
    }
    setPreview(null);
    try {
      const r = await fetch(`${base}/content/transfer/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: importPath.trim() }),
      });
      if (!r.ok) throw new Error(await readError(r));
      startPolling();
    } catch (e) {
      setToast({ tone: "err", text: e instanceof Error ? e.message : "Could not inspect that package." });
    }
  }, [base, importPath, startPolling]);

  const applyPreview = useCallback((p: Preview) => {
    setPreview(p);
    setImpPersonal(new Set((p.personal || []).map((x) => String(x.id))));
    setImpContent(new Set((p.content || []).map((x) => String(x.id))));
  }, []);

  const applyImportPreset = useCallback(
    (mode: "all" | "personal" | "content") => {
      if (!preview) return;
      setImpPersonal(
        new Set(mode === "content" ? [] : (preview.personal || []).map((p) => String(p.id))),
      );
      setImpContent(
        new Set(mode === "personal" ? [] : (preview.content || []).map((c) => String(c.id))),
      );
    },
    [preview],
  );

  // The inspect job returns its preview with the job payload.
  useEffect(() => {
    if (!job.running && !job.error && job.action === "inspect") {
      const result = job.result as { kind?: string; preview?: Preview } | null;
      const p = result?.preview || job.preview;
      if (p) applyPreview(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.running, job.action, job.finished_at]);

  const startImport = useCallback(async () => {
    if (!preview) return;
    if (!impPersonal.size && !impContent.size) {
      setToast({ tone: "err", text: "Select at least one item to import." });
      return;
    }
    try {
      const r = await fetch(`${base}/content/transfer/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: job.token || "",
          path: importPath.trim(),
          personal: Array.from(impPersonal),
          content: Array.from(impContent),
        }),
      });
      if (!r.ok) throw new Error(await readError(r));
      startPolling();
    } catch (e) {
      setToast({ tone: "err", text: e instanceof Error ? e.message : "Could not start the import." });
    }
  }, [base, impContent, impPersonal, importPath, job.token, preview, startPolling]);

  const exportContentList = useCallback(async () => {
    setListBusy(true);
    try {
      const r = await fetch(`${base}/content/transfer/content-list`);
      if (!r.ok) throw new Error(await readError(r));
      const text = await r.text();
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `MedOS-content-list-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setToast({ tone: "ok", text: "Content list saved — send it to your partner." });
    } catch (e) {
      setToast({ tone: "err", text: e instanceof Error ? e.message : "Could not export the content list." });
    } finally {
      setListBusy(false);
    }
  }, [base]);

  const importContentList = useCallback(
    async (file: File) => {
      setListBusy(true);
      setDiffError(null);
      setDiff(null);
      try {
        let payload: unknown;
        try {
          payload = JSON.parse(await file.text());
        } catch {
          throw new Error("That file is not valid JSON.");
        }
        const r = await fetch(`${base}/content/transfer/parse-list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ list: payload }),
        });
        if (!r.ok) throw new Error(await readError(r));
        const d: ListDiff = await r.json();
        setDiff(d);
        setDiffName(file.name);
      } catch (e) {
        setDiffError(e instanceof Error ? e.message : "Could not read that content list.");
      } finally {
        setListBusy(false);
      }
    },
    [base],
  );

  const revealFolder = useCallback(
    async (path: string) => {
      try {
        const r = await fetch(`${base}/content/transfer/reveal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!r.ok) throw new Error(await readError(r));
      } catch (e) {
        setToast({ tone: "err", text: e instanceof Error ? e.message : "Could not open the folder." });
      }
    },
    [base],
  );

  const busy = job.running;
  const exportResult =
    job.result && "kind" in job.result && job.result.kind === "export" ? (job.result as ExportResult) : null;
  const importResult =
    job.result && "kind" in job.result && job.result.kind === "import" ? (job.result as ImportResult) : null;

  return (
    <section style={{ marginBottom: 30 }}>
      <h2 style={sectionTitle}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18, color: "var(--accent)" }}>
          swap_horiz
        </span>
        Transfer &amp; backup
      </h2>

      <div style={card}>
        <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "0 0 12px" }}>
          Move your MedOS setup between machines. Exports are ordinary WinRAR/7-Zip archives but always carry a
          <code style={code}> medos-export.json </code>
          manifest, so any other MedOS can open them here and import exactly what you share.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(255px, 1fr))", gap: 10 }}>
          <ActionCard
            icon="folder_zip"
            title="Import content RAR / ZIP / 7z"
            hint="Choose an archive — MedOS extracts it and wires in AMBOSS, UWorld, books and other content automatically. Personal data is left alone."
            onClick={chooseQuickArchive}
            disabled={busy || pickBusy}
          />
          <ActionCard
            icon="archive"
            title="Export"
            hint="Package personal data, content packs, or a shareable content list."
            onClick={() => openExport("personal")}
            disabled={!inv || busy}
          />
          <ActionCard
            icon="unarchive"
            title="Import (advanced)"
            hint="Inspect an archive first, restore personal data, or open a partner's content list."
            onClick={openImport}
            disabled={busy}
          />
        </div>

        {!importOpen && job.action === "import" && (job.running || job.result) ? (
          <div style={{ ...panel, marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
              <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>
                {job.running ? "Importing content archive…" : "Content archive import"}
              </strong>
              {!job.running ? (
                <button type="button" style={linkBtn} onClick={() => setJob(EMPTY_JOB)}>
                  Dismiss
                </button>
              ) : null}
            </div>
            <JobView job={job} result={importResult ?? undefined} onReveal={revealFolder} />
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
          <ActionCard
            icon="delete_sweep"
            title="Delete leftover exported RAR files"
            hint="Review old MedOS export/backup archives still on this disk, choose the volumes to remove, and free the space."
            onClick={() => setLeftoversOpen(true)}
            disabled={!inv}
          />
          <ActionCard
            icon="upload_file"
            title="Import non-MedOS files"
            hint="Add a book PDF to a shelf, or turn a Q-Bank PDF into a native bank with questions, choices, answers, images and explanations."
            onClick={() => setNonMedosOpen(true)}
            disabled={!inv}
          />
        </div>

        {invError ? (
          <p style={{ ...note, color: "var(--danger, #e5484d)" }}>{invError}</p>
        ) : inv ? (
          <p style={{ ...note, marginBottom: 0 }}>
            {inv.machine} · personal {fmtBytes(inv.personal_total)} · content {fmtBytes(inv.content_total)} ·{" "}
            {inv.tools.can_export ? `${inv.tools.preferred === "rar" ? "WinRAR" : "7-Zip"} detected` : "no archiver detected"}
          </p>
        ) : (
          <p style={{ ...note, marginBottom: 0 }}>Reading this machine's data…</p>
        )}

        <StorageBreakdown storage={storage} />

        {toast ? (
          <div
            style={{
              ...note,
              marginTop: 10,
              marginBottom: 0,
              color:
                toast.tone === "err"
                  ? "var(--danger, #e5484d)"
                  : toast.tone === "ok"
                    ? "var(--ok, #30a46c)"
                    : "var(--text-secondary)",
            }}
          >
            {toast.text}
          </div>
        ) : null}
      </div>

      {/* ── export modal ── */}
      {exportOpen ? (
        <Modal
          title="Export from this machine"
          subtitle="Choose what to include, where to save it, and how to split the archive."
          onClose={() => { if (!busy) setExportOpen(false); }}
          closable={!busy}
          footer={
            <>
              <span style={{ ...note, margin: 0, marginRight: "auto" }}>
                {selectedCount} item(s) selected · {fmtBytes(selectedBytes)}
                {partMb ? ` · ≈ ${volumeCount} volume(s) of up to ${partLabel(partMb).replace(" per volume", "")}` : ""}
              </span>
              <button type="button" style={ghostBtn} onClick={() => setExportOpen(false)} disabled={busy}>
                Close
              </button>
              {exportResult && !busy ? (
                <button type="button" style={primaryBtn} onClick={() => setJob(EMPTY_JOB)}>
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>add</span>
                  New export
                </button>
              ) : (
                <button
                  type="button"
                  style={{ ...primaryBtn, opacity: busy || !selectedBytes ? 0.6 : 1 }}
                  onClick={() => { void startExport(); }}
                  disabled={busy || !selectedBytes || !inv?.tools.can_export}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>package_2</span>
                  {busy && job.action === "export" ? "Exporting…" : "Start export"}
                </button>
              )}
            </>
          }
        >
          {job.running || exportResult || job.error ? (
            <JobView job={job} result={exportResult} onReveal={revealFolder} />
          ) : (
            <>
              {toast ? (
                <div
                  style={{
                    ...note,
                    marginTop: 0,
                    marginBottom: 10,
                    color:
                      toast.tone === "err"
                        ? "var(--danger, #e5484d)"
                        : toast.tone === "ok"
                          ? "var(--ok, #30a46c)"
                          : "var(--text-secondary)",
                  }}
                >
                  {toast.text}
                </div>
              ) : null}

              <div style={{ ...panel, marginTop: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>Content list (JSON)</strong>
                  <button
                    type="button"
                    style={ghostBtn}
                    onClick={() => { void exportContentList(); }}
                    disabled={listBusy}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>list_alt</span>
                    {listBusy ? "Preparing…" : "Export content list"}
                  </button>
                </div>
                <p style={{ ...note, marginTop: 6, marginBottom: 0 }}>
                  A tiny list of the packs installed here. Send it to a partner so they can see what they are missing —
                  no archive needed.
                </p>
              </div>

              <Field label="Save to folder">
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={dest}
                    onChange={(e) => setDest(e.target.value)}
                    placeholder="C:\Users\you\Downloads"
                    style={input}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    style={ghostBtn}
                    disabled={pickBusy}
                    onClick={() => { void pickPath("destination", dest, setDest); }}
                  >
                    {pickBusy ? "…" : "Browse…"}
                  </button>
                </div>
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 10 }}>
                <Field label="Archive name">
                  <input
                    value={archiveName}
                    onChange={(e) => setArchiveName(e.target.value)}
                    placeholder="MedOS-export"
                    style={input}
                    spellCheck={false}
                  />
                </Field>
                <Field label="Split into volumes">
                  <select value={partChoice} onChange={(e) => setPartChoice(e.target.value)} style={input}>
                    {PART_CHOICES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </Field>
              </div>

              {partChoice === "custom" ? (
                <Field label="Custom volume size (MB)">
                  <input
                    type="number"
                    min={1}
                    value={customMb}
                    onChange={(e) => setCustomMb(e.target.value)}
                    style={{ ...input, maxWidth: 180 }}
                  />
                </Field>
              ) : null}

              <div style={summaryRow}>
                <span>{fmtBytes(selectedBytes)} selected</span>
                <span>{partMb ? `≈ ${volumeCount} volume(s) · ${partLabel(partMb)}` : "One archive"}</span>
                {freeInfo ? (
                  <span style={{ color: freeInfo.free < selectedBytes ? "var(--danger, #e5484d)" : "var(--text-muted)" }}>
                    {fmtBytes(freeInfo.free)} free at destination
                  </span>
                ) : null}
              </div>

              {freeInfo && selectedBytes > freeInfo.free ? (
                <p style={{ ...note, color: "var(--danger, #e5484d)" }}>
                  Not enough free space at {freeInfo.path} — free up {fmtBytes(selectedBytes - freeInfo.free)} or choose another folder.
                </p>
              ) : null}

              <div style={{ display: "flex", gap: 8, margin: "14px 0 8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={ghostBtn}
                  onClick={() => {
                    setSelPersonal(new Set((inv?.personal || []).filter((p) => p.exists).map((p) => p.id)));
                    setSelContent(new Set((inv?.content || []).map((c) => c.id)));
                  }}
                >
                  Select all
                </button>
                <button
                  type="button"
                  style={ghostBtn}
                  onClick={() => {
                    setSelPersonal(new Set());
                    setSelContent(new Set());
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  style={ghostBtn}
                  onClick={() => {
                    setSelPersonal(new Set((inv?.personal || []).filter((p) => p.exists).map((p) => p.id)));
                    setSelContent(new Set());
                  }}
                >
                  Personal only
                </button>
              </div>

              <GroupHead
                label="Personal data"
                hint="Excludes accounts and passwords"
                count={selectedPersonal.length}
                total={inv?.personal.filter((p) => p.exists).length || 0}
              />
              <div style={listBox}>
                {(inv?.personal || []).map((p) => (
                  <CheckRow
                    key={p.id}
                    checked={selPersonal.has(p.id)}
                    disabled={!p.exists}
                    onChange={() => toggleIn(setSelPersonal, p.id)}
                    label={p.label}
                    detail={p.exists ? fmtBytes(p.size) : "not created yet"}
                  />
                ))}
                {!inv?.personal.length ? <Empty>No personal data yet.</Empty> : null}
              </div>

              {contentByRoom.map(([room, items]) => (
                <div key={room}>
                  <GroupHead
                    label={room}
                    count={items.filter((i) => selContent.has(i.id)).length}
                    total={items.length}
                    onToggleAll={() => {
                      const selectable = items.filter((i) => i.size > 0);
                      const all = selectable.every((i) => selContent.has(i.id));
                      setSelContent((prev) => {
                        const next = new Set(prev);
                        for (const i of selectable) {
                          if (all) next.delete(i.id);
                          else next.add(i.id);
                        }
                        return next;
                      });
                    }}
                  />
                  <div style={listBox}>
                    {items.map((c) => {
                      const books = c.books || [];
                      const shown = books.filter((b) =>
                        !bookFilter.trim() ||
                        b.name.toLowerCase().includes(bookFilter.trim().toLowerCase()) ||
                        b.shelf.toLowerCase().includes(bookFilter.trim().toLowerCase()),
                      );
                      return (
                        <div key={c.id}>
                          <CheckRow
                            checked={selContent.has(c.id)}
                            onChange={() => toggleIn(setSelContent, c.id)}
                            label={c.label}
                            detail={c.size > 0 ? fmtBytes(c.size) : "not built yet"}
                            sub={c.size > 0 ? c.description || undefined : "Build this pack first — there is nothing to transfer yet."}
                            disabled={c.size <= 0}
                          />
                          {books.length ? (
                            <div style={{ padding: "2px 9px 10px 30px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-muted)" }}>
                                  Individual books · {selectedBooks.length}/{books.length} selected
                                </span>
                                <button
                                  type="button"
                                  style={linkBtn}
                                  onClick={() => {
                                    setSelContent((prev) => {
                                      const next = new Set(prev);
                                      const all = shown.every((b) => next.has(b.id));
                                      for (const b of shown) {
                                        if (all) next.delete(b.id);
                                        else next.add(b.id);
                                      }
                                      return next;
                                    });
                                  }}
                                >
                                  {shown.every((b) => selContent.has(b.id)) ? "Clear shown" : "Select shown"}
                                </button>
                              </div>
                              <input
                                value={bookFilter}
                                onChange={(e) => setBookFilter(e.target.value)}
                                placeholder="Filter books by title or shelf…"
                                style={{ ...input, marginBottom: 6 }}
                                spellCheck={false}
                              />
                              <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                                {shown.map((b) => (
                                  <CheckRow
                                    key={b.id}
                                    checked={selContent.has(b.id)}
                                    onChange={() => toggleIn(setSelContent, b.id)}
                                    label={b.name}
                                    sub={b.shelf || "bookshelf root"}
                                    detail={fmtBytes(b.size)}
                                  />
                                ))}
                                {!shown.length ? <Empty>No books match that filter.</Empty> : null}
                              </div>
                              <p style={{ ...note, marginTop: 6, marginBottom: 0 }}>
                                Book rows export just that PDF (plus a manifest entry) so the other MedOS can drop it on
                                the same shelf without replacing the whole Books pack.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!inv?.content.length ? <Empty>No content packs detected on this machine.</Empty> : null}
            </>
          )}
        </Modal>
      ) : null}

      {/* ── import modal ── */}
      {importOpen ? (
        <Modal
          title="Import into this machine"
          subtitle="Restore personal data, add content packs, or open a partner's content list — all in one place."
          onClose={() => { if (!busy) setImportOpen(false); }}
          closable={!busy}
          footer={
            <>
              <span style={{ ...note, margin: 0, marginRight: "auto" }}>
                {preview
                  ? `${impPersonal.size} personal · ${impContent.size} content selected`
                  : "Nothing inspected yet"}
              </span>
              <button type="button" style={ghostBtn} onClick={() => setImportOpen(false)} disabled={busy}>
                Close
              </button>
              {importResult ? null : preview ? (
                <button
                  type="button"
                  style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
                  onClick={() => { void startImport(); }}
                  disabled={busy || (!impPersonal.size && !impContent.size)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>download_done</span>
                  {busy && job.action === "import" ? "Importing…" : "Import selected"}
                </button>
              ) : (
                <button
                  type="button"
                  style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
                  onClick={() => { void startInspect(); }}
                  disabled={busy || !importPath.trim()}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17 }}>search</span>
                  {busy && job.action === "inspect" ? "Inspecting…" : "Inspect"}
                </button>
              )}
            </>
          }
        >
          {job.running && (job.action === "inspect" || job.action === "import") ? (
            <JobView job={job} onReveal={revealFolder} />
          ) : importResult ? (
            <>
              <JobView job={job} result={importResult} onReveal={revealFolder} />
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button type="button" style={ghostBtn} onClick={() => { setPreview(null); setImportPath(""); setDiff(null); setDiffError(null); setDiffName(""); setJob(EMPTY_JOB); }}>
                  Import another
                </button>
                <button type="button" style={primaryBtn} onClick={() => setImportOpen(false)}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              {toast ? (
                <div
                  style={{
                    ...note,
                    marginTop: 0,
                    marginBottom: 10,
                    color:
                      toast.tone === "err"
                        ? "var(--danger, #e5484d)"
                        : toast.tone === "ok"
                          ? "var(--ok, #30a46c)"
                          : "var(--text-secondary)",
                  }}
                >
                  {toast.text}
                </div>
              ) : null}

              <div style={{ ...panel, marginTop: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>Partner content list (JSON)</strong>
                  <button
                    type="button"
                    style={ghostBtn}
                    onClick={() => listInputRef.current?.click()}
                    disabled={listBusy}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>list_alt</span>
                    {listBusy ? "Reading…" : "Choose JSON…"}
                  </button>
                </div>
                <p style={{ ...note, marginTop: 6, marginBottom: diff ? 6 : 0 }}>
                  Compare what a partner has installed with this machine. Their list is the small JSON file saved from
                  the Export window — no archive needed.
                </p>

                {diff ? (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
                        List{diffName ? ` · ${diffName}` : ""}
                      </strong>
                      <button type="button" style={linkBtn} onClick={() => { setDiff(null); setDiffError(null); }}>
                        Dismiss
                      </button>
                    </div>
                    <p style={{ ...note, marginTop: 4 }}>
                      {diff.machine ? `${diff.machine} · ` : ""}
                      {diff.listed_count} item(s), {fmtBytes(diff.listed_bytes)} total · you have {diff.local_count} item(s) on this machine.
                    </p>
                    {diff.missing.length === 0 ? (
                      <p style={{ ...note, color: "var(--ok, #30a46c)", marginBottom: 0 }}>
                        You already have everything on their list.
                      </p>
                    ) : (
                      <>
                        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", margin: "6px 0 4px" }}>
                          They have {diff.missing.length} item(s) you don't:
                        </p>
                        <ul style={ul}>
                          {diff.missing.map((m) => (
                            <li key={m.id} style={li}>
                              <span style={{ color: "var(--text-primary)" }}>{m.label}</span>
                              <span style={muted}>{m.room ? `${m.room} · ` : ""}{fmtBytes(m.size)}</span>
                            </li>
                          ))}
                        </ul>
                        <p style={{ ...note, marginBottom: 0 }}>
                          Ask them to <strong>Export</strong> these items, then import the archive below.
                        </p>
                      </>
                    )}
                  </div>
                ) : null}
                {diffError ? <p style={{ ...note, color: "var(--danger, #e5484d)", marginBottom: 0 }}>{diffError}</p> : null}
              </div>

              <input
                ref={listInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = "";
                  if (file) void importContentList(file);
                }}
              />

              <div style={{ ...groupTitle, marginTop: 16, marginBottom: 8 }}>
                Personal data &amp; content archive
              </div>
              <Field label="Content archive or folder">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                    placeholder="C:\Users\you\Downloads\amboss.rar  (or .zip / .7z / a folder)"
                    style={input}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    style={ghostBtn}
                    disabled={pickBusy}
                    onClick={() => { void pickPath("archive", importPath, setImportPath); }}
                  >
                    Archive…
                  </button>
                  <button
                    type="button"
                    style={ghostBtn}
                    disabled={pickBusy}
                    onClick={() => { void pickPath("folder", importPath, setImportPath); }}
                  >
                    Folder…
                  </button>
                </div>
              </Field>
              <p style={{ ...note, marginTop: 0 }}>
                Split archives: choose the <strong>first volume</strong> (<code style={code}>.part1.rar</code>,{" "}
                <code style={code}>.part01.rar</code> or <code style={code}>.7z.001</code>) — the rest are picked up
                automatically.
              </p>

              {job.error ? <p style={{ ...note, color: "var(--danger, #e5484d)" }}>{job.error}</p> : null}

              {preview ? (
                <div style={panel}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>{preview.name}</strong>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {preview.machine} · {preview.kind} · {preview.created_at?.replace("T", " ")}
                    </span>
                  </div>
                  <p style={{ ...note, marginTop: 6 }}>
                    Personal {fmtBytes(preview.personal_total)} · content {fmtBytes(preview.content_total)} ·{" "}
                    {preview.personal.length + preview.content.length} item(s)
                  </p>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    <button type="button" style={ghostBtn} onClick={() => applyImportPreset("all")}>
                      Import all
                    </button>
                    <button type="button" style={ghostBtn} onClick={() => applyImportPreset("personal")}>
                      Personal data only
                    </button>
                    <button type="button" style={ghostBtn} onClick={() => applyImportPreset("content")}>
                      Content only
                    </button>
                  </div>

                  <p style={{ ...note, color: "var(--warning, #f5a524)" }}>
                    Importing personal data replaces this machine's My Library, Q-Bank progress, flashcards and
                    preferences. A copy of each replaced file is kept under{" "}
                    <code style={code}>data\backups\transfers</code>, then restart MedOS.
                  </p>

                  {preview.personal.length ? (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                        <span style={groupTitle}>Personal data</span>
                        <button
                          type="button"
                          style={linkBtn}
                          onClick={() =>
                            setImpPersonal((prev) =>
                              prev.size ? new Set() : new Set(preview.personal.map((p) => String(p.id))),
                            )
                          }
                        >
                          {impPersonal.size ? "Clear" : "Select all"}
                        </button>
                      </div>
                      <div style={listBox}>
                        {preview.personal.map((p) => (
                          <CheckRow
                            key={String(p.id)}
                            checked={impPersonal.has(String(p.id))}
                            onChange={() => toggleIn(setImpPersonal, String(p.id))}
                            label={p.label}
                            detail={fmtBytes(p.size)}
                          />
                        ))}
                      </div>
                      <p style={{ ...note, color: "var(--text-muted)" }}>
                        Restoring personal data replaces this machine's current files. A copy of each replaced file is
                        kept under <code style={code}>data\backups\transfers</code>.
                      </p>
                    </>
                  ) : null}

                  {preview.content.length ? (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                        <span style={groupTitle}>Content</span>
                        <button
                          type="button"
                          style={linkBtn}
                          onClick={() =>
                            setImpContent((prev) =>
                              prev.size ? new Set() : new Set(preview.content.map((c) => String(c.id))),
                            )
                          }
                        >
                          {impContent.size ? "Clear" : "Select all"}
                        </button>
                      </div>
                      <div style={listBox}>
                        {preview.content.map((c) => (
                          <CheckRow
                            key={String(c.id)}
                            checked={impContent.has(String(c.id))}
                            onChange={() => toggleIn(setImpContent, String(c.id))}
                            label={c.label}
                            detail={fmtBytes(c.size)}
                            sub={[c.room, c.roots.length ? `${c.roots.length} folder(s)` : ""].filter(Boolean).join(" · ")}
                          />
                        ))}
                      </div>
                      <p style={{ ...note, color: "var(--text-muted)" }}>
                        Content is merged into this MedOS's data folders so the readers find it. Existing files are
                        never overwritten — anything already present is kept.
                      </p>
                    </>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </Modal>
      ) : null}

      {leftoversOpen ? (
        <LeftoverModal base={base} onClose={() => setLeftoversOpen(false)} />
      ) : null}

      {nonMedosOpen ? (
        <NonMedosModal
          base={base}
          onClose={() => setNonMedosOpen(false)}
          onChanged={() => {
            void loadInventory(true);
            onChanged?.();
          }}
        />
      ) : null}
    </section>
  );
}

// ── leftover exported archives ──────────────────────────────────────────────

type LeftoverVolume = { name: string; path: string; size: number; modified_at: string };
type LeftoverArchive = {
  key: string;
  name: string;
  folder: string;
  size: number;
  created_at: string;
  volumes: LeftoverVolume[];
};
type LeftoverData = {
  archives: LeftoverArchive[];
  count: number;
  total_bytes: number;
  scan_dirs: string[];
};
type LeftoverDeleteResult = {
  removed: { path: string; name: string; size: number }[];
  errors: { path: string; error: string }[];
  freed_bytes: number;
  remaining: LeftoverData;
};

function LeftoverModal({ base, onClose }: { base: string; onClose: () => void }) {
  const [data, setData] = useState<LeftoverData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LeftoverDeleteResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${base}/content/exports/leftovers`);
      if (!r.ok) throw new Error(await readError(r));
      const d: LeftoverData = await r.json();
      setData(d);
      const present = new Set(d.archives.flatMap((a) => a.volumes.map((v) => v.path)));
      setSelected((prev) => new Set(Array.from(prev).filter((p) => present.has(p))));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not scan for leftover archives.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedVolumes = useMemo(
    () =>
      (data?.archives || []).flatMap((a) =>
        a.volumes.filter((v) => selected.has(v.path)),
      ),
    [data, selected],
  );
  const selectedBytes = selectedVolumes.reduce((s, v) => s + v.size, 0);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setConfirming(false);
  };

  const toggleArchive = (archive: LeftoverArchive) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const all = archive.volumes.every((v) => next.has(v.path));
      for (const volume of archive.volumes) {
        if (all) next.delete(volume.path);
        else next.add(volume.path);
      }
      return next;
    });
    setConfirming(false);
  };

  const runDelete = useCallback(async () => {
    if (!selectedVolumes.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${base}/content/exports/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: selectedVolumes.map((v) => v.path) }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const d: LeftoverDeleteResult = await r.json();
      setResult(d);
      setData(d.remaining);
      setSelected(new Set());
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete those files.");
    } finally {
      setBusy(false);
    }
  }, [base, selectedVolumes]);

  return (
    <Modal
      title="Delete leftover exported archives"
      subtitle="Only MedOS export/backup archives (RAR, 7z, ZIP) found in Downloads, exports folders and previous destinations are listed."
      onClose={() => { if (!busy) onClose(); }}
      closable={!busy}
      footer={
        <>
          <span style={{ ...note, margin: 0, marginRight: "auto" }}>
            {selectedVolumes.length
              ? `${selectedVolumes.length} file(s) · ${fmtBytes(selectedBytes)} selected`
              : "Nothing selected"}
          </span>
          <button type="button" style={ghostBtn} onClick={() => { void load(); }} disabled={busy || loading}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
            {loading ? "Scanning…" : "Rescan"}
          </button>
          <button type="button" style={ghostBtn} onClick={onClose} disabled={busy}>
            Close
          </button>
          {confirming ? (
            <button
              type="button"
              style={{ ...primaryBtn, background: "var(--danger, #e5484d)" }}
              onClick={() => { void runDelete(); }}
              disabled={busy}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>delete_forever</span>
              {busy ? "Deleting…" : `Confirm delete ${selectedVolumes.length}`}
            </button>
          ) : (
            <button
              type="button"
              style={{ ...primaryBtn, opacity: selectedVolumes.length ? 1 : 0.55 }}
              onClick={() => setConfirming(true)}
              disabled={busy || !selectedVolumes.length}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>delete</span>
              Delete selected
            </button>
          )}
        </>
      }
    >
      {error ? <p style={{ ...note, color: "var(--danger, #e5484d)" }}>{error}</p> : null}

      {result ? (
        <div style={{ ...panel, marginTop: 0, borderColor: "var(--ok, #30a46c)" }}>
          <strong style={{ fontSize: 13, color: "var(--ok, #30a46c)" }}>
            Deleted {result.removed.length} file(s) · freed {fmtBytes(result.freed_bytes)}
          </strong>
          {result.errors.length ? (
            <ul style={ul}>
              {result.errors.map((e) => (
                <li key={e.path} style={{ ...li, color: "var(--danger, #e5484d)" }}>
                  {e.path}: {e.error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <p style={{ ...note, color: "var(--warning, #f5a524)", marginBottom: 10 }}>
          This permanently removes {selectedVolumes.length} selected archive file(s) from disk. Files are not moved to
          the Recycle Bin.
        </p>
      ) : null}

      {data && !data.archives.length ? (
        <Empty>
          No leftover export archives found. Scanned: {data.scan_dirs.join(" · ") || "no folders"}.
        </Empty>
      ) : null}

      {!data && loading ? <Empty>Scanning for leftover archives…</Empty> : null}

      {(data?.archives || []).map((archive) => {
        const all = archive.volumes.every((v) => selected.has(v.path));
        return (
          <div key={archive.key} style={panel}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <strong style={{ fontSize: 13, color: "var(--text-primary)", wordBreak: "break-all" }}>
                  {archive.name}
                </strong>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, wordBreak: "break-all" }}>
                  {archive.folder}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {archive.volumes.length} file(s) · {fmtBytes(archive.size)}
                  {archive.created_at ? ` · ${archive.created_at.replace("T", " ")}` : ""}
                </div>
              </div>
              <button type="button" style={linkBtn} onClick={() => toggleArchive(archive)}>
                {all ? "Clear all" : "Select all"}
              </button>
            </div>
            <div style={{ ...listBox, marginTop: 8 }}>
              {archive.volumes.map((volume) => (
                <CheckRow
                  key={volume.path}
                  checked={selected.has(volume.path)}
                  onChange={() => toggle(volume.path)}
                  label={volume.name}
                  detail={fmtBytes(volume.size)}
                  sub={volume.modified_at ? volume.modified_at.replace("T", " ") : undefined}
                />
              ))}
            </div>
          </div>
        );
      })}
    </Modal>
  );
}

// ── import non-MedOS files (book PDF / Q-Bank PDF) ──────────────────────────

type ShelfItem = { rel: string; label: string; count: number; depth: number };

type BookImportResult = {
  rel: string;
  path: string;
  shelf: string;
  name: string;
  size: number;
  indexed: boolean;
  search_indexing: boolean;
};

type QbankStats = {
  pages: number;
  questions: number;
  skipped_blocks: number;
  choices: number;
  with_explanations: number;
  with_answers: number;
  assumed_answers: number;
  images: number;
  answer_key_entries: number;
  subjects: number;
  systems: number;
  avg_choices: number;
};

type QbankSample = {
  number: number;
  source_id: string;
  title: string;
  stem: string;
  choices: { letter: string; text: string; correct: boolean }[];
  correct: number;
  explanation: string;
  subject: string;
  system: string;
  images: number;
};

type QbankAnalysis = {
  analysis_id: string;
  name: string;
  source: string;
  pages: number;
  stats: QbankStats;
  warnings: string[];
  samples: QbankSample[];
  cached: boolean;
};

type QbankBuildResult = {
  bank_key: string;
  label: string;
  folder: string;
  db: string;
  questions: number;
  choices: number;
  images: number;
  image_bytes: number;
  assumed_answers: number;
  skipped: number;
  subjects: number;
  systems: number;
  size: number;
  warnings: string[];
};

type QbankJobState = {
  running: boolean;
  mode: string | null;
  stage: string;
  percent: number;
  error: string | null;
  result: QbankAnalysis | QbankBuildResult | null;
};

function StatChip({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 5,
        padding: "4px 9px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: "var(--bg-base)",
        fontSize: 11.5,
        color: "var(--text-secondary)",
      }}
    >
      <strong style={{ color: tone || "var(--text-primary)", fontSize: 12 }}>{value}</strong>
      {label}
    </span>
  );
}

function NonMedosModal({
  base,
  onClose,
  onChanged,
}: {
  base: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "book" | "qbank">("choose");
  const [pickBusy, setPickBusy] = useState(false);

  // book branch
  const [bookPath, setBookPath] = useState("");
  const [bookName, setBookName] = useState("");
  const [bookShelf, setBookShelf] = useState("");
  const [bookIndex, setBookIndex] = useState(true);
  const [bookOverwrite, setBookOverwrite] = useState(false);
  const [shelves, setShelves] = useState<ShelfItem[] | null>(null);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const [bookBusy, setBookBusy] = useState(false);
  const [bookResult, setBookResult] = useState<BookImportResult | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);

  // qbank branch
  const [qPath, setQPath] = useState("");
  const [qName, setQName] = useState("");
  const [qOverwrite, setQOverwrite] = useState(false);
  const [qBusy, setQBusy] = useState(false);
  const [qJob, setQJob] = useState<QbankJobState | null>(null);
  const [analysis, setAnalysis] = useState<QbankAnalysis | null>(null);
  const [buildResult, setBuildResult] = useState<QbankBuildResult | null>(null);
  const [qError, setQError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // load shelf list when the book branch opens
  useEffect(() => {
    if (mode !== "book" || shelves) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`${base}/content/library/shelves`);
        if (!r.ok) throw new Error(await readError(r));
        const d = await r.json();
        if (cancelled) return;
        setShelves(Array.isArray(d.shelves) ? d.shelves : []);
        setShelfError(null);
      } catch (e) {
        if (cancelled) return;
        setShelfError(e instanceof Error ? e.message : "Could not read the bookshelf.");
        setShelves([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, mode, shelves]);

  const pickPdf = useCallback(
    async (initial: string, apply: (p: string) => void) => {
      setPickBusy(true);
      try {
        const r = await fetch(`${base}/content/transfer/pick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "pdf", initial }),
        });
        if (!r.ok) throw new Error(await readError(r));
        const d = await r.json();
        if (d.cancelled) return;
        if (d.path) apply(String(d.path));
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not open the file picker.";
        if (mode === "qbank") setQError(message);
        else setBookError(message);
      } finally {
        setPickBusy(false);
      }
    },
    [base, mode],
  );

  const importBook = useCallback(async () => {
    if (!bookPath.trim()) {
      setBookError("Choose a PDF first.");
      return;
    }
    setBookBusy(true);
    setBookError(null);
    setBookResult(null);
    try {
      const r = await fetch(`${base}/content/import/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: bookPath.trim(),
          shelf: bookShelf,
          name: bookName.trim(),
          index: bookIndex,
          overwrite: bookOverwrite,
        }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const d: BookImportResult = await r.json();
      setBookResult(d);
      onChanged();
    } catch (e) {
      setBookError(e instanceof Error ? e.message : "Could not import that book.");
    } finally {
      setBookBusy(false);
    }
  }, [base, bookIndex, bookName, bookOverwrite, bookPath, bookShelf, onChanged]);

  const pollQbank = useCallback(async () => {
    for (;;) {
      const r = await fetch(`${base}/content/import/qbank/status`);
      if (!r.ok) throw new Error(await readError(r));
      const d: QbankJobState = await r.json();
      if (!alive.current) return d;
      setQJob(d);
      if (!d.running) return d;
      await new Promise((res) => setTimeout(res, 900));
    }
  }, [base]);

  const analyzeQbank = useCallback(async () => {
    if (!qPath.trim()) {
      setQError("Choose a Q-Bank PDF first.");
      return;
    }
    setQBusy(true);
    setQError(null);
    setAnalysis(null);
    setBuildResult(null);
    setQJob({ running: true, mode: "analyze", stage: "Starting…", percent: 0, error: null, result: null });
    try {
      const r = await fetch(`${base}/content/import/qbank/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: qPath.trim(), name: qName.trim() }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const done = await pollQbank();
      if (!alive.current) return;
      if (done.error) throw new Error(done.error);
      const preview = done.result as QbankAnalysis | null;
      if (!preview || !preview.stats) throw new Error("The scan finished without a preview.");
      setAnalysis(preview);
      setQName((prev) => prev || preview.name || "");
    } catch (e) {
      setQError(e instanceof Error ? e.message : "Could not scan that PDF.");
    } finally {
      if (alive.current) setQBusy(false);
    }
  }, [base, pollQbank, qName, qPath]);

  const buildQbank = useCallback(async () => {
    if (!analysis) return;
    setQBusy(true);
    setQError(null);
    setBuildResult(null);
    setQJob({ running: true, mode: "build", stage: "Starting…", percent: 0, error: null, result: null });
    try {
      const r = await fetch(`${base}/content/import/qbank/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysis_id: analysis.analysis_id, name: qName.trim(), overwrite: qOverwrite }),
      });
      if (!r.ok) throw new Error(await readError(r));
      const done = await pollQbank();
      if (!alive.current) return;
      if (done.error) throw new Error(done.error);
      const built = done.result as QbankBuildResult | null;
      if (!built || !built.bank_key) throw new Error("The build finished without a bank.");
      setBuildResult(built);
      onChanged();
    } catch (e) {
      setQError(e instanceof Error ? e.message : "Could not build that Q-Bank.");
    } finally {
      if (alive.current) setQBusy(false);
    }
  }, [analysis, base, onChanged, pollQbank, qName, qOverwrite]);

  const busy = bookBusy || qBusy;
  const qProgress = qJob?.running ? Math.max(0, Math.min(100, qJob.percent || 0)) : 0;

  return (
    <Modal
      title="Import non-MedOS files"
      subtitle="Add a book to your shelf, or convert a Q-Bank PDF into a native bank."
      onClose={() => { if (!busy) onClose(); }}
      closable={!busy}
      footer={
        <>
          {mode === "choose" ? (
            <span style={{ ...note, margin: 0, marginRight: "auto" }}>
              Pick what kind of PDF you are adding.
            </span>
          ) : (
            <button type="button" style={ghostBtn} onClick={() => setMode("choose")} disabled={busy}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
              Back
            </button>
          )}
          <button type="button" style={ghostBtn} onClick={onClose} disabled={busy}>
            {buildResult || bookResult ? "Done" : "Cancel"}
          </button>
          {mode === "book" ? (
            <button
              type="button"
              style={{ ...primaryBtn, opacity: bookBusy || !bookPath.trim() ? 0.6 : 1 }}
              onClick={() => { void importBook(); }}
              disabled={bookBusy || !bookPath.trim()}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>library_add</span>
              {bookBusy ? "Adding…" : "Add to shelf"}
            </button>
          ) : null}
          {mode === "qbank" ? (
            analysis && !buildResult ? (
              <button
                type="button"
                style={{ ...primaryBtn, opacity: qBusy ? 0.6 : 1 }}
                onClick={() => { void buildQbank(); }}
                disabled={qBusy}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 17 }}>database</span>
                {qBusy ? "Building…" : "Build Q-Bank"}
              </button>
            ) : (
              <button
                type="button"
                style={{ ...primaryBtn, opacity: qBusy || !qPath.trim() ? 0.6 : 1 }}
                onClick={() => { void analyzeQbank(); }}
                disabled={qBusy || !qPath.trim()}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 17 }}>document_scanner</span>
                {qBusy ? "Scanning…" : analysis ? "Scan again" : "Scan PDF"}
              </button>
            )
          ) : null}
        </>
      }
    >
      {mode === "choose" ? (
        <>
          <p style={{ ...note, marginTop: 0 }}>
            A <strong>book PDF</strong> is a textbook or chapter you want in the Books room. A <strong>Q-Bank PDF</strong>{" "}
            is a question bank — MedOS scans each question, its choices, the correct answer, explanation, tags and every
            figure, then builds a bank that behaves like the shipped ones.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10 }}>
            <ActionCard
              icon="menu_book"
              title="Book PDF"
              hint="Choose a shelf, optionally generate the chapter index and search index right away."
              onClick={() => setMode("book")}
            />
            <ActionCard
              icon="quiz"
              title="Q-Bank PDF"
              hint="Scan the PDF, review what was understood, then build a new bank under Imported Q-Banks."
              onClick={() => setMode("qbank")}
            />
          </div>
          <p style={{ ...note, marginBottom: 0 }}>
            Imported Q-Banks appear in the Q-Bank catalog as <code style={code}>Imported Q-Banks (PDF)</code>. Nothing
            is written to the live catalog until you press <strong>Build Q-Bank</strong>.
          </p>
        </>
      ) : null}

      {mode === "book" ? (
        <>
          {bookResult ? (
            <div style={{ ...panel, marginTop: 0, borderColor: "var(--ok, #30a46c)" }}>
              <strong style={{ fontSize: 13, color: "var(--ok, #30a46c)" }}>
                Added “{bookResult.name}” · {fmtBytes(bookResult.size)}
              </strong>
              <p style={{ ...note, marginBottom: 0 }}>
                Shelf: <code style={code}>{bookResult.shelf || "bookshelf root"}</code> · path{" "}
                <code style={code}>{bookResult.rel}</code>
                {bookResult.indexed
                  ? " · chapter + search index queued for this book."
                  : " · library reindex queued; run the per-book index from the Books room when ready."}
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={ghostBtn}
                  onClick={() => {
                    setBookResult(null);
                    setBookPath("");
                    setBookName("");
                    setBookOverwrite(false);
                  }}
                >
                  Import another book
                </button>
              </div>
            </div>
          ) : (
            <>
              <Field label="Book PDF">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    value={bookPath}
                    onChange={(e) => setBookPath(e.target.value)}
                    placeholder="C:\Users\you\Books\Some Textbook.pdf"
                    style={input}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    style={ghostBtn}
                    disabled={pickBusy}
                    onClick={() => {
                      void pickPdf(bookPath, (p) => {
                        setBookPath(p);
                        const base = p.split(/[\\/]/).pop() || "";
                        setBookName(base.replace(/\.pdf$/i, ""));
                      });
                    }}
                  >
                    {pickBusy ? "…" : "Browse…"}
                  </button>
                </div>
              </Field>

              <Field label="Add to shelf">
                <select value={bookShelf} onChange={(e) => setBookShelf(e.target.value)} style={input}>
                  {(shelves || []).map((s) => (
                    <option key={s.rel || "__root"} value={s.rel}>
                      {s.depth ? `— ${s.label}` : s.label} ({s.count})
                    </option>
                  ))}
                  {bookShelf && !(shelves || []).some((s) => s.rel === bookShelf) ? (
                    <option value={bookShelf}>{bookShelf}</option>
                  ) : null}
                </select>
              </Field>
              <p style={{ ...note, marginTop: -4 }}>
                Shelves mirror the folder tree in the Books room. Pick the root to add a top-level book.
                {shelfError ? <span style={{ color: "var(--danger, #e5484d)" }}> {shelfError}</span> : null}
              </p>

              <Field label="File name (optional)">
                <input
                  value={bookName}
                  onChange={(e) => setBookName(e.target.value)}
                  placeholder="Keep the original PDF name"
                  style={input}
                  spellCheck={false}
                />
              </Field>

              <div style={{ ...listBox, marginBottom: 10 }}>
                <CheckRow
                  checked={bookIndex}
                  onChange={() => setBookIndex((v) => !v)}
                  label="Generate the search index now"
                  sub="Builds this book's chapter index and adds it to global search in the background."
                />
                <CheckRow
                  checked={bookOverwrite}
                  onChange={() => setBookOverwrite((v) => !v)}
                  label="Replace an existing file with the same name"
                  sub="Off by default, so a same-named PDF on that shelf is never silently overwritten."
                />
              </div>

              {bookError ? <p style={{ ...note, color: "var(--danger, #e5484d)" }}>{bookError}</p> : null}
            </>
          )}
        </>
      ) : null}

      {mode === "qbank" ? (
        <>
          {buildResult ? (
            <div style={{ ...panel, marginTop: 0, borderColor: "var(--ok, #30a46c)" }}>
              <strong style={{ fontSize: 13, color: "var(--ok, #30a46c)" }}>
                Built “{buildResult.label}” · {buildResult.questions.toLocaleString("en-US")} questions
              </strong>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <StatChip label="choices" value={buildResult.choices.toLocaleString("en-US")} />
                <StatChip label="images" value={buildResult.images.toLocaleString("en-US")} />
                <StatChip label="subjects" value={buildResult.subjects} />
                <StatChip label="systems" value={buildResult.systems} />
                <StatChip label="size" value={fmtBytes(buildResult.size)} />
                {buildResult.assumed_answers ? (
                  <StatChip label="assumed answers" value={buildResult.assumed_answers} tone="var(--warning, #f5a524)" />
                ) : null}
              </div>
              <p style={{ ...note, marginBottom: 0 }}>
                Registered as <code style={code}>{buildResult.bank_key}</code>. Open the Q-Bank tab and choose{" "}
                <strong>Imported Q-Banks (PDF)</strong> to start practising.
              </p>
              {buildResult.warnings?.length ? (
                <ul style={ul}>
                  {buildResult.warnings.slice(0, 8).map((w) => (
                    <li key={w} style={li}>{w}</li>
                  ))}
                </ul>
              ) : null}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={ghostBtn}
                  onClick={() => {
                    setBuildResult(null);
                    setAnalysis(null);
                    setQPath("");
                    setQName("");
                    setQOverwrite(false);
                    setQJob(null);
                  }}
                >
                  Import another Q-Bank
                </button>
              </div>
            </div>
          ) : (
            <>
              <Field label="Q-Bank PDF">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    value={qPath}
                    onChange={(e) => setQPath(e.target.value)}
                    placeholder="C:\Users\you\Qbanks\Some Question Bank.pdf"
                    style={input}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    style={ghostBtn}
                    disabled={pickBusy || qBusy}
                    onClick={() => {
                      void pickPdf(qPath, (p) => {
                        setQPath(p);
                        const base = p.split(/[\\/]/).pop() || "";
                        setQName(base.replace(/\.pdf$/i, ""));
                        setAnalysis(null);
                        setQJob(null);
                      });
                    }}
                  >
                    {pickBusy ? "…" : "Browse…"}
                  </button>
                </div>
              </Field>

              <Field label="Bank name">
                <input
                  value={qName}
                  onChange={(e) => setQName(e.target.value)}
                  placeholder="Shown in the Q-Bank catalog"
                  style={input}
                  spellCheck={false}
                />
              </Field>

              {qBusy || qJob?.running ? (
                <div style={{ ...panel, marginTop: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                      {qJob?.stage || "Working…"}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      {qJob?.mode === "analyze" ? "Scanning" : "Building"} · {Math.round(qProgress)}%
                    </span>
                  </div>
                  <div style={progressTrack}>
                    <div
                      style={{
                        height: "100%",
                        width: `${qProgress}%`,
                        background: "var(--accent)",
                        transition: "width .3s ease",
                      }}
                    />
                  </div>
                  <p style={{ ...note, marginBottom: 0 }}>
                    You can keep this window open. Large PDFs take a few minutes to scan once; the preview is cached so
                    building is fast.
                  </p>
                </div>
              ) : null}

              {qError ? <p style={{ ...note, color: "var(--danger, #e5484d)" }}>{qError}</p> : null}

              {analysis ? (
                <>
                  <div style={{ ...panel, marginTop: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>
                        Scan preview · {analysis.name}
                      </strong>
                      <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                        {analysis.pages.toLocaleString("en-US")} page(s){analysis.cached ? " · cached" : ""}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      <StatChip label="questions" value={analysis.stats.questions.toLocaleString("en-US")} />
                      <StatChip label="choices" value={analysis.stats.choices.toLocaleString("en-US")} />
                      <StatChip label="answers" value={analysis.stats.with_answers.toLocaleString("en-US")} />
                      <StatChip label="explanations" value={analysis.stats.with_explanations.toLocaleString("en-US")} />
                      <StatChip label="images" value={analysis.stats.images.toLocaleString("en-US")} />
                      <StatChip label="avg choices" value={analysis.stats.avg_choices} />
                      <StatChip label="subjects" value={analysis.stats.subjects} />
                      <StatChip label="systems" value={analysis.stats.systems} />
                      {analysis.stats.assumed_answers ? (
                        <StatChip
                          label="assumed answers"
                          value={analysis.stats.assumed_answers}
                          tone="var(--warning, #f5a524)"
                        />
                      ) : null}
                    </div>
                    {analysis.stats.skipped_blocks ? (
                      <p style={{ ...note, marginBottom: 0 }}>
                        {analysis.stats.skipped_blocks} numbered block(s) had fewer than two choices and will be skipped.
                      </p>
                    ) : null}
                    {analysis.warnings?.length ? (
                      <ul style={{ ...ul, marginBottom: 0 }}>
                        {analysis.warnings.slice(0, 8).map((w) => (
                          <li key={w} style={{ ...li, color: "var(--warning, #f5a524)" }}>{w}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <div style={{ ...listBox, marginTop: 8 }}>
                    <CheckRow
                      checked={qOverwrite}
                      onChange={() => setQOverwrite((v) => !v)}
                      label="Replace an existing imported bank with the same name"
                      sub="Off by default. The old bank folder is deleted only when this is on."
                    />
                  </div>

                  <div style={{ ...groupTitle, marginTop: 14, marginBottom: 6 }}>
                    Sample questions ({Math.min(analysis.samples.length, 5)} of {analysis.stats.questions})
                  </div>
                  {analysis.samples.slice(0, 5).map((sample) => (
                    <div key={`${sample.number}-${sample.source_id}`} style={panel}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                        <strong style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
                          {sample.number}. {sample.title || "Question"}
                        </strong>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          id {sample.source_id}
                          {sample.system ? ` · ${sample.system}` : ""}
                          {sample.images ? ` · ${sample.images} image(s)` : ""}
                        </span>
                      </div>
                      <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, margin: "6px 0" }}>
                        {sample.stem || "(no stem text recognised)"}
                      </p>
                      <ul style={ul}>
                        {sample.choices.map((choice) => (
                          <li
                            key={choice.letter}
                            style={{
                              ...li,
                              color: choice.correct ? "var(--ok, #30a46c)" : "var(--text-secondary)",
                              fontWeight: choice.correct ? 700 : 400,
                            }}
                          >
                            <strong>{choice.letter}.</strong> {choice.text || "(empty)"}
                            {choice.correct ? " ✓" : ""}
                          </li>
                        ))}
                      </ul>
                      {sample.explanation ? (
                        <p style={{ ...note, marginBottom: 0 }}>{sample.explanation}</p>
                      ) : null}
                    </div>
                  ))}
                </>
              ) : null}

              {!analysis && !qBusy ? (
                <p style={{ ...note, marginBottom: 0 }}>
                  Scanning reads the PDF layout, finds numbered questions, their choices, the correct answer,
                  explanation, ids and tags. Nothing is written until the build step.
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </Modal>
  );
}

// ── small building blocks ───────────────────────────────────────────────────

/**
 * Reconciles the Content list with the folder size Explorer reports. Content
 * Manager rows only cover transferable content; the remainder is the MedOS
 * program, portable tools, downloaded updates and machine-local caches.
 */
function StorageBreakdown({ storage }: { storage: StorageInfo | null }) {
  if (!storage) return null;
  const chips: { id: string; label: string; bytes: number; accent?: boolean }[] = [
    { id: "content", label: "Content (transferable)", bytes: storage.content_total, accent: true },
    { id: "personal", label: "Personal data", bytes: storage.personal_total },
    { id: "machine", label: "Machine-local caches", bytes: storage.machine_local_bytes },
    ...storage.buckets.map((b) => ({ id: b.id, label: b.label, bytes: b.bytes })),
  ].filter((c) => c.bytes > 0);
  const outsideContent = Math.max(0, storage.total_bytes - storage.content_total);
  const warn = storage.unmapped_bytes > 20 * 1024 * 1024;
  return (
    <div style={{ ...panel, marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12.5, color: "var(--text-primary)" }}>Storage on this disk</strong>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>
          {fmtBytes(storage.total_bytes)} total
        </span>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--text-secondary)", margin: "6px 0 10px", lineHeight: 1.55 }}>
        The content list covers <strong>{fmtBytes(storage.content_total)}</strong> in {storage.content_items} transferable
        item(s). The other <strong>{fmtBytes(outsideContent)}</strong> is the MedOS program, portable Python &amp; Node,
        downloaded update packages and machine-local caches — installed automatically, not part of an export.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {chips.map((c) => (
          <span key={c.id} style={c.accent ? chipAccent : chip}>
            {c.label} · {fmtBytes(c.bytes)}
          </span>
        ))}
      </div>
      {warn ? (
        <p style={{ ...note, margin: "10px 0 0", color: "var(--amber, #f5a623)" }}>
          {fmtBytes(storage.unmapped_bytes)} under data/ is not shown yet:{" "}
          {storage.unmapped.slice(0, 4).map((u) => `${u.group} (${fmtBytes(u.bytes)})`).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

function ActionCard({
  icon,
  title,
  hint,
  onClick,
  busy,
  disabled,
}: {
  icon: string;
  title: string;
  hint: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...actionCard,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20, color: "var(--accent)" }}>
          {busy ? "progress_activity" : icon}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{title}</span>
      </span>
      <span style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45, textAlign: "left" }}>{hint}</span>
    </button>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  closable = true,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  closable?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closable) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closable, onClose]);

  return (
    <div
      style={overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && closable) onClose();
      }}
    >
      <div style={modal}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>{title}</h3>
            {subtitle ? (
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!closable}
            style={{ ...iconBtn, opacity: closable ? 1 : 0.4 }}
            aria-label="Close"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 19 }}>close</span>
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>{children}</div>
        {footer ? <div style={footerBar}>{footer}</div> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--text-muted)", marginBottom: 5 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function GroupHead({
  label,
  hint,
  count,
  total,
  onToggleAll,
}: {
  label: string;
  hint?: string;
  count: number;
  total: number;
  onToggleAll?: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, marginBottom: 6 }}>
      <span style={groupTitle}>
        {label}
        {hint ? <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> · {hint}</span> : null}
        <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> · {count}/{total}</span>
      </span>
      {onToggleAll ? (
        <button type="button" style={linkBtn} onClick={onToggleAll}>
          Toggle all
        </button>
      ) : null}
    </div>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  detail,
  sub,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  detail?: string;
  sub?: string;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        padding: "7px 9px",
        borderRadius: 8,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        style={{ marginTop: 2, accentColor: "var(--accent)" }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.4 }}>{label}</span>
        {sub ? (
          <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{sub}</span>
        ) : null}
      </span>
      {detail ? (
        <span style={{ fontSize: 11.5, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{detail}</span>
      ) : null}
    </label>
  );
}

function JobView({
  job,
  result,
  onReveal,
}: {
  job: Job;
  result?: ExportResult | ImportResult | null;
  onReveal?: (path: string) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--accent)" }}>
          {job.error ? "error" : job.running ? "progress_activity" : "check_circle"}
        </span>
        <span style={{ flex: 1, fontSize: 12.5, color: "var(--text-secondary)" }}>
          {job.error || job.stage || "Working…"}
        </span>
        {job.percent != null && job.running ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{Math.round(job.percent)}%</span>
        ) : null}
      </div>

      {job.percent != null ? (
        <div style={progressTrack}>
          <div
            style={{
              width: `${Math.max(2, Math.min(100, job.percent))}%`,
              height: "100%",
              background: job.error ? "var(--danger, #e5484d)" : "var(--accent)",
              transition: "width .3s ease",
            }}
          />
        </div>
      ) : null}

      {job.log?.length ? (
        <div style={logBox}>
          {job.log.slice(-10).map((line, i) => (
            <div key={`${i}-${line}`}>{line}</div>
          ))}
        </div>
      ) : null}

      {job.error ? <p style={{ ...note, color: "var(--danger, #e5484d)" }}>{job.error}</p> : null}

      {result && "kind" in result && result.kind === "export" ? (
        <div style={{ ...panel, marginTop: 12 }}>
          <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>Export complete</strong>
          <p style={{ ...note, marginTop: 4 }}>
            {result.volumes.length} file(s) · {fmtBytes(result.bytes)} ·{" "}
            {result.split_mb ? partLabel(result.split_mb) : "single archive"}
          </p>
          <ul style={ul}>
            {result.volumes.map((v) => (
              <li key={v.path} style={li}>
                <span style={{ color: "var(--text-primary)", wordBreak: "break-all" }}>{v.name}</span>
                <span style={muted}>{fmtBytes(v.size)}</span>
              </li>
            ))}
          </ul>
          {result.warning ? <p style={{ ...note, color: "var(--danger, #e5484d)" }}>{result.warning}</p> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <button type="button" style={ghostBtn} onClick={() => onReveal?.(result.destination)}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>folder_open</span>
              Open folder
            </button>
            <code style={{ ...code, alignSelf: "center", wordBreak: "break-all" }}>{result.destination}</code>
          </div>
          <p style={{ ...note, marginBottom: 0 }}>
            Share the <strong>first volume</strong> plus the rest of the set. On the other machine:
            Content Manager → Import → Inspect → Import.
          </p>
        </div>
      ) : null}

      {result && "kind" in result && result.kind === "import" ? (
        <div style={{ ...panel, marginTop: 12 }}>
          <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>Import complete</strong>
          <p style={{ ...note, marginTop: 4 }}>
            {result.personal.length} personal item(s) · {result.content.length} content item(s)
            {result.source_machine ? ` · from ${result.source_machine}` : ""}
          </p>
          {result.personal.length ? (
            <ul style={ul}>
              {result.personal.map((p) => (
                <li key={`p-${p.id}`} style={li}>
                  <span style={{ color: p.error ? "var(--danger, #e5484d)" : "var(--text-primary)" }}>{p.label}</span>
                  <span style={muted}>{p.error || "restored"}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {result.content.length ? (
            <ul style={ul}>
              {result.content.map((c) => {
                const copied = (c.roots || []).reduce((s, r) => s + r.copied, 0);
                const skipped = (c.roots || []).reduce((s, r) => s + r.skipped, 0);
                const note = c.error
                  ? c.error
                  : c.applied?.length
                    ? `wired: ${c.applied.join(", ")}`
                    : copied > 0
                      ? `${copied} file(s) installed${skipped ? ` · ${skipped} already present` : ""}`
                      : skipped > 0
                        ? "already present — kept existing files"
                        : "nothing to copy";
                return (
                  <li key={`c-${c.id}`} style={li}>
                    <span style={{ color: c.error ? "var(--danger, #e5484d)" : "var(--text-primary)" }}>{c.label}</span>
                    <span style={muted}>{note}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {result.backups ? (
            <p style={{ ...note, marginBottom: 0 }}>
              Previous personal files were backed up to <code style={code}>{result.backups}</code>.
            </p>
          ) : null}
          {result.personal.length ? (
            <p style={{ ...note, color: "var(--warning, #f5a524)", marginBottom: 0 }}>
              <strong>Restart MedOS</strong> so restored databases are reopened cleanly.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, padding: "8px 2px", fontSize: 12, color: "var(--text-muted)" }}>{children}</p>;
}

// ── styles ──────────────────────────────────────────────────────────────────

const sectionTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 12,
};

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 14,
};

const actionCard: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  textAlign: "left",
  padding: "11px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  cursor: "pointer",
};

const note: React.CSSProperties = {
  fontSize: 11.5,
  color: "var(--text-muted)",
  margin: "10px 0",
  lineHeight: 1.5,
};

const chip: React.CSSProperties = {
  fontSize: 11,
  padding: "3px 8px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};

const chipAccent: React.CSSProperties = {
  ...chip,
  borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))",
  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
  color: "var(--text-primary)",
  fontWeight: 600,
};

const panel: React.CSSProperties = {
  marginTop: 12,
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 12,
  background: "var(--bg-base)",
};

const code: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "1px 4px",
};

const input: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-primary)",
};

const summaryRow: React.CSSProperties = {
  display: "flex",
  gap: 14,
  flexWrap: "wrap",
  fontSize: 11.5,
  color: "var(--text-secondary)",
  padding: "8px 10px",
  borderRadius: 8,
  background: "var(--bg-base)",
  border: "1px solid var(--border)",
};

const listBox: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 9,
  background: "var(--bg-base)",
  maxHeight: 220,
  overflowY: "auto",
};

const groupTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text-secondary)",
};

const linkBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--accent)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
};

const ghostBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 12,
  fontWeight: 600,
  padding: "7px 11px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12.5,
  fontWeight: 700,
  padding: "8px 14px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
};

const iconBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1200,
  background: "rgba(0,0,0,.55)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
};

const modal: React.CSSProperties = {
  width: "min(820px, 94vw)",
  maxHeight: "88vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 18,
  boxShadow: "0 24px 60px rgba(0,0,0,.45)",
};

const footerBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  paddingTop: 12,
  marginTop: 12,
  borderTop: "1px solid var(--border)",
};

const progressTrack: React.CSSProperties = {
  height: 6,
  borderRadius: 999,
  background: "var(--bg-base)",
  border: "1px solid var(--border)",
  overflow: "hidden",
};

const logBox: React.CSSProperties = {
  marginTop: 10,
  maxHeight: 140,
  overflowY: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  background: "var(--bg-base)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 8,
  color: "var(--text-muted)",
};

const ul: React.CSSProperties = {
  listStyle: "none",
  margin: "6px 0",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const li: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 12,
  lineHeight: 1.45,
};

const muted: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11.5,
  textAlign: "right",
  flexShrink: 0,
};

