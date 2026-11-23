"use client";

import { useEffect, useRef, useState } from "react";
import {
  downloadPdf,
  ensureDefaultPdfExportProviders,
  listPdfExportProviders,
  notifyPdfExport,
  type PdfExportProvider,
} from "@/lib/exportPdf";

interface ProviderEntry {
  provider: PdfExportProvider;
  label: string;
}

export default function ExportPdfButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [entries, setEntries] = useState<ProviderEntry[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureDefaultPdfExportProviders();
    let active = true;
    const providers = listPdfExportProviders();
    Promise.all(
      providers.map(async (provider) => ({
        provider,
        available: Boolean(await provider.available()),
      })),
    )
      .then((checks) => {
        if (active) {
          setEntries(
            checks
              .filter((check) => check.available)
              .map((check) => ({ provider: check.provider, label: check.provider.label })),
          );
        }
      })
      .catch(() => {
        if (active) setEntries([]);
      });

    const closeOnOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => {
      active = false;
      document.removeEventListener("mousedown", closeOnOutside);
    };
  }, []);

  const run = async (entry: ProviderEntry) => {
    if (busy) return;
    setBusy(entry.provider.id);
    setOpen(false);
    try {
      const payload = await entry.provider.collect();
      if (!payload) throw new Error("There is nothing available to export here.");
      const filename = await downloadPdf(payload);
      notifyPdfExport(`PDF exported: ${filename}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyPdfExport(`PDF export failed: ${message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-label="Export PDF"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy !== null}
        title="Export this topic, Q-Bank session or page to PDF"
        onClick={() => setOpen((value) => !value)}
        disabled={busy !== null}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "4px 9px",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: busy ? "var(--bg-card)" : "transparent",
          color: "var(--text-primary)",
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
          cursor: busy ? "progress" : "pointer",
          opacity: busy ? 0.72 : 1,
        }}
      >
        <span aria-hidden="true" style={{ color: "var(--accent)", fontWeight: 700 }}>PDF</span>
        <span>{busy ? "Exporting…" : "Export PDF"}</span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Export PDF options"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: 268,
            maxWidth: 360,
            padding: 6,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-card, #131a17)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
            zIndex: 1000,
            textTransform: "none",
            letterSpacing: 0,
            fontFamily: "var(--font-sans, inherit)",
            fontSize: 12,
          }}
        >
          {entries.length === 0 ? (
            <div style={{ padding: "10px 12px", color: "var(--text-muted)" }}>
              No PDF export source is available on this page.
            </div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.provider.id}
                type="button"
                role="menuitem"
                onClick={() => void run(entry)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "9px 11px",
                  border: 0,
                  borderRadius: 4,
                  background: "transparent",
                  color: "var(--text-primary)",
                  textAlign: "left",
                  font: "inherit",
                  cursor: "pointer",
                }}
              >
                {entry.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
