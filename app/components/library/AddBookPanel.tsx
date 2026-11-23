"use client";
import { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Upload, Globe, BookMarked, Search, Plus, Loader2, FolderOpen, RefreshCw, CheckCircle, AlertTriangle } from "lucide-react";

interface Book { id: string; title: string; author?: string; pages?: number; systems: System[]; uploadedAt: string; }
interface System { id: string; name: string; chapters: Chapter[]; }
interface Chapter { id: string; title: string; content: string; }

const CATALOGUE = [
  { id: "c1",  title: "Harrison's Principles of Internal Medicine", ed: "21st Ed.", field: "Internal Medicine",  color: "#00658e" },
  { id: "c2",  title: "Bates' Guide to Physical Examination",       ed: "13th Ed.", field: "Physical Diagnosis", color: "#6b5b2e" },
  { id: "c3",  title: "Robbins Basic Pathology",                    ed: "10th Ed.", field: "Pathology",           color: "#065f46" },
  { id: "c4",  title: "Goodman & Gilman's Pharmacology",            ed: "13th Ed.", field: "Pharmacology",        color: "#0f766e" },
  { id: "c5",  title: "Gray's Anatomy",                             ed: "42nd Ed.", field: "Anatomy",             color: "#4338ca" },
  { id: "c6",  title: "Williams Obstetrics",                        ed: "26th Ed.", field: "OBGYN",               color: "#7c3aed" },
  { id: "c7",  title: "Nelson Textbook of Pediatrics",              ed: "21st Ed.", field: "Pediatrics",          color: "#b45309" },
  { id: "c8",  title: "Braunwald's Heart Disease",                  ed: "12th Ed.", field: "Cardiology",          color: "#dc2626" },
  { id: "c9",  title: "Sabiston Textbook of Surgery",               ed: "21st Ed.", field: "Surgery",             color: "#7f1d1d" },
  { id: "c10", title: "Guyton & Hall Medical Physiology",           ed: "14th Ed.", field: "Physiology",          color: "#1e3a5f" },
  { id: "c11", title: "Adams & Victor's Neurology",                 ed: "11th Ed.", field: "Neurology",           color: "#312e81" },
  { id: "c12", title: "First Aid for the USMLE Step 1",             ed: "2025",     field: "USMLE",                color: "#b91c1c" },
];

type AddMode = "upload" | "folder" | "browse" | "web";
type ImportMode = "copy" | "move";

interface FolderImportJob {
  status?: string;
  source_path?: string;
  library_path?: string;
  scanned?: number;
  processed?: number;
  copied?: number;
  moved?: number;
  skipped?: number;
  failed?: number;
  books?: number;
  current_system?: string;
  error?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onBookAdded: (book: Book) => void;
  processFile: (file: File) => Promise<void>;
  processing: boolean;
  importFolder: (sourcePath: string, options: { mode: ImportMode; recursive: boolean; overwrite: boolean }) => Promise<void>;
  folderImportJob: FolderImportJob | null;
  folderImporting: boolean;
  folderImportError: string;
  libraryPath: string;
}

export default function AddBookPanel({
  open,
  onClose,
  onBookAdded,
  processFile,
  processing,
  importFolder,
  folderImportJob,
  folderImporting,
  folderImportError,
  libraryPath,
}: Props) {
  const [mode, setMode] = useState<AddMode>("upload");
  const [dragOver, setDragOver] = useState(false);
  const [webUrl, setWebUrl] = useState("");
  const [search, setSearch] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("copy");
  const [recursive, setRecursive] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const openPicker = () => {
    const el = document.createElement("input");
    el.type = "file"; el.accept = ".pdf";
    el.onchange = e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) processFile(f); };
    el.click();
  };

  const filtered = CATALOGUE.filter(b =>
    b.title.toLowerCase().includes(search.toLowerCase()) ||
    b.field.toLowerCase().includes(search.toLowerCase())
  );

  const tabs: { key: AddMode; label: string; icon: React.ReactNode }[] = [
    { key: "upload", label: "Upload PDF",       icon: <Upload size={13} /> },
    { key: "folder", label: "Folder Rebuild",   icon: <FolderOpen size={13} /> },
    { key: "browse", label: "Browse Catalogue", icon: <BookMarked size={13} /> },
    { key: "web",    label: "Web / URL",         icon: <Globe size={13} /> },
  ];

  const processed = folderImportJob?.processed ?? 0;
  const scanned = folderImportJob?.scanned ?? 0;
  const progress = scanned > 0 ? Math.min(100, Math.round((processed / scanned) * 100)) : 0;
  const importDone = folderImportJob?.status === "completed";
  const importFailed = folderImportJob?.status === "failed";
  void onBookAdded;

  // Close on Escape (the brief: every box/popup must dismiss with Escape).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(15,23,42,0.18)", backdropFilter: "blur(2px)" }}
            onClick={onClose}
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            style={{
              position: "fixed", top: 0, right: 0, bottom: 0,
              width: 420, zIndex: 50,
              background: "var(--bg-base)",
              boxShadow: "-12px 0 40px rgba(27,28,26,0.08)",
              display: "flex", flexDirection: "column",
              overflowY: "auto",
            }}
          >
            {/* Header */}
            <div style={{
              padding: "20px 24px 16px",
              borderBottom: "1px solid rgba(190,200,208,0.4)",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "var(--bg-card)",
            }}>
              <div>
                <h2 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 20, fontWeight: 600, color: "#00658e", lineHeight: 1.2 }}>
                  Add Textbook
                </h2>
                <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-muted)", marginTop: 3 }}>
                  Expand your clinical library
                </p>
              </div>
              <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text-primary)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}>
                <X size={18} />
              </button>
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-card)" }}>
              {tabs.map(t => (
                <button key={t.key} onClick={() => setMode(t.key)} style={{
                  flex: 1, padding: "10px 4px", border: "none", cursor: "pointer",
                  background: "transparent",
                  borderBottom: mode === t.key ? "2px solid #00658e" : "2px solid transparent",
                  color: mode === t.key ? "#00658e" : "var(--text-muted)",
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                  letterSpacing: "0.12em", textTransform: "uppercase",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                  transition: "all 0.15s",
                }}>
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div style={{ flex: 1, padding: "20px 24px" }}>

              {/* ── Upload ── */}
              {mode === "upload" && (
                <div>
                  <div
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    onClick={openPicker}
                    style={{
                      border: `2px dashed ${dragOver ? "#00658e" : "rgba(190,200,208,0.6)"}`,
                      borderRadius: 8, padding: "40px 20px", textAlign: "center",
                      cursor: "pointer",
                      background: dragOver ? "rgba(0,101,142,0.04)" : "transparent",
                      transition: "all 0.2s",
                      marginBottom: 20,
                    }}
                  >
                    {processing ? (
                      <>
                        <Loader2 size={28} color="#00658e" style={{ margin: "0 auto 12px", animation: "spin 1s linear infinite" }} />
                        <p style={{ fontFamily: "'Newsreader', serif", fontSize: 15, color: "var(--text-primary)", marginBottom: 4 }}>Processing with AI…</p>
                        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Extracting chapters and organising by body system</p>
                      </>
                    ) : (
                      <>
                        <Upload size={28} color="#6f7880" style={{ margin: "0 auto 12px" }} />
                        <p style={{ fontFamily: "'Newsreader', serif", fontSize: 16, color: "var(--text-primary)", marginBottom: 6 }}>Drop a PDF here</p>
                        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>or click to browse · AI organises chapters<br />by body system</p>
                      </>
                    )}
                  </div>

                  <div style={{ background: "rgba(0,101,142,0.05)", borderRadius: 6, padding: "12px 14px" }}>
                    <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#00658e", marginBottom: 6 }}>Try uploading:</p>
                    {["First Aid 2025", "Harrison's", "Robbins Pathology", "Guyton Physiology", "Gray's Anatomy"].map(t => (
                      <p key={t} style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 2 }}>· {t}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Folder rebuild ── */}
              {mode === "folder" && (
                <div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 8 }}>
                      Source folder on this computer
                    </label>
                    <div style={{ position: "relative" }}>
                      <FolderOpen size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#6f7880" }} />
                      <input
                        value={sourcePath}
                        onChange={e => setSourcePath(e.target.value)}
                        placeholder="E:\books\MED or D:\Books"
                        style={{
                          width: "100%", padding: "10px 12px 10px 34px",
                          background: "var(--bg-card)",
                          border: "none",
                          borderBottom: "1.5px solid rgba(190,200,208,0.5)",
                          fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                          color: "var(--text-primary)", outline: "none",
                        }}
                      />
                    </div>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 8 }}>
                      Destination: {libraryPath || "data\\books"}
                    </p>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                    <button
                      onClick={() => setImportMode("copy")}
                      style={{
                        padding: "9px 10px", borderRadius: 5,
                        border: importMode === "copy" ? "1px solid #00658e" : "1px solid rgba(190,200,208,0.55)",
                        background: importMode === "copy" ? "rgba(0,101,142,0.08)" : "var(--bg-card)",
                        color: importMode === "copy" ? "#00658e" : "var(--text-secondary)",
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                        letterSpacing: "0.12em", textTransform: "uppercase",
                        cursor: "pointer",
                      }}
                    >
                      Copy
                    </button>
                    <button
                      onClick={() => setImportMode("move")}
                      style={{
                        padding: "9px 10px", borderRadius: 5,
                        border: importMode === "move" ? "1px solid #b45309" : "1px solid rgba(190,200,208,0.55)",
                        background: importMode === "move" ? "rgba(180,83,9,0.08)" : "var(--bg-card)",
                        color: importMode === "move" ? "#b45309" : "var(--text-secondary)",
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                        letterSpacing: "0.12em", textTransform: "uppercase",
                        cursor: "pointer",
                      }}
                    >
                      Move
                    </button>
                  </div>

                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
                    <input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} />
                    Include subfolders
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
                    <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />
                    Replace matching filenames
                  </label>

                  <button
                    onClick={() => importFolder(sourcePath, { mode: importMode, recursive, overwrite })}
                    disabled={!sourcePath.trim() || folderImporting}
                    style={{
                      width: "100%", padding: "10px",
                      background: folderImporting ? "#6f7880" : "#00658e",
                      color: "white", border: "none", borderRadius: 6,
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                      letterSpacing: "0.14em", textTransform: "uppercase",
                      cursor: !sourcePath.trim() || folderImporting ? "default" : "pointer",
                      opacity: !sourcePath.trim() ? 0.55 : 1,
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                    }}
                  >
                    {folderImporting ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={13} />}
                    Rebuild Library
                  </button>

                  {(folderImporting || folderImportJob || folderImportError) && (
                    <div style={{ marginTop: 18, padding: "12px 14px", background: "var(--bg-card)", borderRadius: 6, border: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: importFailed || folderImportError ? "#b91c1c" : importDone ? "#047857" : "#00658e" }}>
                          {folderImportError || folderImportJob?.status || "Running"}
                        </span>
                        {importDone && <CheckCircle size={14} color="#047857" />}
                        {(importFailed || folderImportError) && <AlertTriangle size={14} color="#b91c1c" />}
                      </div>
                      {scanned > 0 && (
                        <>
                          <div style={{ height: 6, borderRadius: 999, background: "rgba(190,200,208,0.35)", overflow: "hidden", marginBottom: 8 }}>
                            <div style={{ height: "100%", width: `${progress}%`, background: importFailed ? "#b91c1c" : "#00658e", transition: "width 250ms" }} />
                          </div>
                          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)" }}>
                            {processed}/{scanned} scanned · copied {folderImportJob?.copied ?? 0} · moved {folderImportJob?.moved ?? 0} · skipped {folderImportJob?.skipped ?? 0}
                          </p>
                        </>
                      )}
                      {folderImportJob?.books !== undefined && (
                        <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)", marginTop: 5 }}>
                          Indexed volumes: {folderImportJob.books}
                        </p>
                      )}
                      {folderImportJob?.error && (
                        <p style={{ fontSize: 11, color: "#b91c1c", marginTop: 8, lineHeight: 1.4 }}>{folderImportJob.error}</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Browse catalogue ── */}
              {mode === "browse" && (
                <div>
                  <div style={{ position: "relative", marginBottom: 14 }}>
                    <Search size={13} style={{ position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)", color: "#6f7880" }} />
                    <input
                      ref={inputRef}
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search textbooks…"
                      style={{
                        width: "100%", background: "transparent", border: "none",
                        borderBottom: "1.5px solid rgba(190,200,208,0.5)",
                        padding: "6px 0 6px 22px",
                        fontFamily: "'Newsreader', serif", fontSize: 14, color: "var(--text-primary)",
                        outline: "none",
                      }}
                      onFocus={e => (e.currentTarget.style.borderColor = "#2f9ad1")}
                      onBlur={e => (e.currentTarget.style.borderColor = "rgba(190,200,208,0.5)")}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {filtered.map(book => (
                      <div key={book.id} style={{
                        display: "flex", alignItems: "center", gap: 12,
                        padding: "10px 12px", borderRadius: 6,
                        background: "var(--bg-card)",
                        transition: "background 0.15s",
                        cursor: "default",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-card-hover)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "var(--bg-card)")}>
                        {/* Mini spine */}
                        <div style={{ width: 4, height: 40, borderRadius: 2, background: book.color, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontFamily: "'Newsreader', serif", fontSize: 13, color: "var(--text-primary)", lineHeight: 1.3, marginBottom: 2 }}>{book.title}</p>
                          <div style={{ display: "flex", gap: 8 }}>
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8.5, color: "var(--text-muted)" }}>{book.ed}</span>
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8.5, color: book.color }}>{book.field}</span>
                          </div>
                        </div>
                        <button
                          onClick={openPicker}
                          style={{
                            background: "none", border: "1px solid rgba(190,200,208,0.5)",
                            borderRadius: 4, padding: "4px 8px", cursor: "pointer",
                            display: "flex", alignItems: "center", gap: 4,
                            fontFamily: "'JetBrains Mono', monospace", fontSize: 8,
                            color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase",
                            transition: "all 0.15s",
                          }}
                          onMouseEnter={e => { (e.currentTarget).style.background = book.color; (e.currentTarget).style.color = "#fff"; (e.currentTarget).style.borderColor = book.color; }}
                          onMouseLeave={e => { (e.currentTarget).style.background = "none"; (e.currentTarget).style.color = "var(--text-muted)"; (e.currentTarget).style.borderColor = "rgba(190,200,208,0.5)"; }}
                          title="Upload this book's PDF"
                        >
                          <Plus size={10} /> Add
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Web / URL ── */}
              {mode === "web" && (
                <div>
                  <p style={{ fontFamily: "'Newsreader', serif", fontStyle: "italic", fontSize: 15, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 20 }}>
                    Paste a direct PDF URL to import a textbook from the web.
                  </p>

                  <div style={{ marginBottom: 14 }}>
                    <label style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 8 }}>
                      PDF URL
                    </label>
                    <div style={{ position: "relative" }}>
                      <Globe size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#6f7880" }} />
                      <input
                        value={webUrl}
                        onChange={e => setWebUrl(e.target.value)}
                        placeholder="https://example.com/textbook.pdf"
                        style={{
                          width: "100%", padding: "10px 12px 10px 32px",
                          background: "var(--bg-card)",
                          border: "none",
                          borderBottom: "1.5px solid rgba(190,200,208,0.5)",
                          fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                          color: "var(--text-primary)", outline: "none",
                          transition: "border-color 0.2s",
                        }}
                        onFocus={e => (e.currentTarget.style.borderColor = "#2f9ad1")}
                        onBlur={e => (e.currentTarget.style.borderColor = "rgba(190,200,208,0.5)")}
                      />
                    </div>
                  </div>

                  <button
                    style={{
                      width: "100%", padding: "10px",
                      background: "linear-gradient(135deg, #00658e, #2f9ad1)",
                      color: "white", border: "none", borderRadius: 6,
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                      letterSpacing: "0.14em", textTransform: "uppercase",
                      cursor: "pointer", opacity: webUrl ? 1 : 0.5,
                    }}
                  >
                    Import from URL
                  </button>

                  <div style={{ marginTop: 20, padding: "12px 14px", background: "rgba(245,158,11,0.08)", borderRadius: 6, borderLeft: "3px solid #f59e0b" }}>
                    <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8.5, textTransform: "uppercase", letterSpacing: "0.12em", color: "#b45309", marginBottom: 4 }}>Note</p>
                    <p style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>Web import is in beta. Only direct PDF links are supported. For best results, use the Upload tab.</p>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
