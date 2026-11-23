"use client";
/* Log modal, H's & T's checklist, and the collapsible reference
   sections that live under the algorithm views. */

import { useMemo, useState } from "react";
import type { CodeEvent, CodeSession } from "@/lib/acls/types";
import { REFERENCE_SECTIONS, REVERSIBLE_CAUSES } from "@/lib/acls/reference";
import { buildTranscript, fmtClock } from "@/lib/acls/useCodeSession";
import { M, cardStyle, monoLabel } from "./ui";

/* ── Event icon/color mapping ───────────────────────────────────── */

const EVENT_META: Partial<Record<CodeEvent["type"], { icon: string; color: string }>> = {
  start:    { icon: "play_arrow", color: "var(--accent)" },
  cpr:      { icon: "compress", color: "var(--accent)" },
  shock:    { icon: "bolt", color: "var(--red)" },
  med:      { icon: "medication", color: "var(--green-dim)" },
  rhythm:   { icon: "ecg", color: "var(--purple)" },
  airway:   { icon: "pulmonology", color: "var(--indigo)" },
  access:   { icon: "vaccines", color: "var(--indigo)" },
  pulse:    { icon: "touch_app", color: "var(--text-muted)" },
  note:     { icon: "edit_note", color: "var(--text-muted)" },
  nav:      { icon: "route", color: "var(--text-muted)" },
  reminder: { icon: "notifications_active", color: "var(--amber-dim)" },
  cause:    { icon: "checklist", color: "var(--green-dim)" },
  rosc:     { icon: "favorite", color: "var(--green)" },
  end:      { icon: "stop_circle", color: "var(--text-muted)" },
};

/* ── Modal shell ────────────────────────────────────────────────── */

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "var(--overlay-bg)", zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div
        className="acls-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
        style={{ ...cardStyle, width: "100%", maxWidth: wide ? 620 : 480, maxHeight: "86vh", display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: 14 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 16px", borderBottom: "1px solid var(--border)" }}>
          <h3 style={{ margin: 0, flex: 1, fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 620, color: "var(--text-primary)" }}>{title}</h3>
          <button type="button" className="acls-chip" onClick={onClose} aria-label="Close" style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 8, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
            <M name="close" size={17} />
          </button>
        </div>
        <div className="acls-scroll" style={{ overflowY: "auto", padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}

/* ── Code log ───────────────────────────────────────────────────── */

export function LogPanel({ session, algoTitle, onClose, onNotes, onReset }: {
  session: CodeSession;
  algoTitle: string;
  onClose: () => void;
  onNotes: (notes: string) => void;
  onReset?: () => void;
}) {
  const [tab, setTab] = useState<"log" | "notes">("log");
  const [copied, setCopied] = useState(false);

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildTranscript(session, algoTitle));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked */ }
  };

  const doDownload = () => {
    const blob = new Blob([buildTranscript(session, algoTitle)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date(session.startedAt);
    a.href = url;
    a.download = `code-log-${d.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title="Code Log" onClose={onClose} wide>
      <div style={{ display: "flex", gap: 7, marginBottom: 13, alignItems: "center" }}>
        {(["log", "notes"] as const).map((t) => (
          <button key={t} type="button" className="acls-chip" onClick={() => setTab(t)} style={{
            border: `1px solid ${tab === t ? "var(--accent)" : "var(--border)"}`,
            background: tab === t ? "var(--accent-glow)" : "var(--bg-card)",
            color: "var(--text-primary)", borderRadius: 999, padding: "5px 14px", fontSize: 12.5, fontWeight: 600, textTransform: "capitalize",
          }}>{t === "log" ? `Events (${session.events.length})` : "Notes"}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button type="button" className="acls-chip" onClick={doCopy} title="Copy transcript" style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 8, padding: "5px 10px", fontSize: 12, color: copied ? "var(--green-dim)" : "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
          <M name={copied ? "check" : "content_copy"} size={15} /> {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="acls-chip" onClick={doDownload} title="Download .txt" style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 8, padding: "5px 10px", fontSize: 12, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
          <M name="download" size={15} /> Export
        </button>
      </div>

      {tab === "log" ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {session.events.map((e) => {
            const meta = EVENT_META[e.type] ?? { icon: "circle", color: "var(--text-muted)" };
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 2px", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--text-muted)", width: 44, flexShrink: 0, paddingTop: 1 }}>{fmtClock(e.t)}</span>
                <M name={meta.icon} size={16} style={{ color: meta.color, flexShrink: 0, paddingTop: 1 }} />
                <span style={{ flex: 1, fontSize: 13.5, color: "var(--text-primary)", lineHeight: 1.35 }}>
                  {e.label}
                  {e.detail && <span style={{ color: "var(--text-muted)", fontSize: 12 }}> — {e.detail}</span>}
                </span>
                {e.n !== undefined && <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>#{e.n}</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <textarea
          value={session.notes}
          onChange={(e) => onNotes(e.target.value)}
          placeholder="Free-text notes — team members, patient details, context. Included in the export."
          style={{ width: "100%", minHeight: 200, resize: "vertical", border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-subtle)", color: "var(--text-primary)", padding: 11, fontSize: 13.5, lineHeight: 1.55, fontFamily: "inherit" }}
        />
      )}

      {onReset && (
        <button type="button" className="acls-btn" onClick={onReset} style={{ marginTop: 15, width: "100%", border: "1px solid color-mix(in srgb, var(--red) 45%, var(--border))", background: "var(--red-glow)", color: "var(--red-dim)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5, fontWeight: 650 }}>
          Discard this code (reset without saving)
        </button>
      )}
    </Modal>
  );
}

/* ── H's & T's checklist ────────────────────────────────────────── */

export function CausesPanel({ causes, onToggle, onClose }: {
  causes: Record<string, boolean>;
  onToggle: (id: string, label: string) => void;
  onClose: () => void;
}) {
  const [openHint, setOpenHint] = useState<string | null>(null);
  const done = REVERSIBLE_CAUSES.filter((c) => causes[c.id]).length;

  return (
    <Modal title={`Reversible Causes — H's & T's (${done}/${REVERSIBLE_CAUSES.length})`} onClose={onClose} wide>
      {(["H", "T"] as const).map((group) => (
        <div key={group} style={{ marginBottom: 14 }}>
          <div style={{ ...monoLabel, marginBottom: 7 }}>{group === "H" ? "The H's" : "The T's"}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {REVERSIBLE_CAUSES.filter((c) => c.group === group).map((c) => {
              const on = !!causes[c.id];
              const open = openHint === c.id;
              return (
                <div key={c.id} style={{ border: `1px solid ${on ? "color-mix(in srgb, var(--green) 45%, var(--border))" : "var(--border)"}`, borderRadius: 10, background: on ? "var(--green-glow)" : "var(--bg-card)", overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <button type="button" className="acls-chip" onClick={() => onToggle(c.id, c.label)} style={{ flex: 1, display: "flex", alignItems: "center", gap: 9, border: 0, background: "transparent", padding: "9px 11px", textAlign: "left" }}>
                      <M name={on ? "check_box" : "check_box_outline_blank"} size={19} style={{ color: on ? "var(--green-dim)" : "var(--text-muted)", flexShrink: 0 }} />
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{c.label}</span>
                    </button>
                    <button type="button" className="acls-chip" onClick={() => setOpenHint(open ? null : c.id)} aria-label="Hints" style={{ border: 0, background: "transparent", padding: "9px 11px", color: "var(--text-muted)", display: "flex" }}>
                      <M name={open ? "expand_less" : "expand_more"} size={18} />
                    </button>
                  </div>
                  {open && (
                    <div className="acls-in" style={{ padding: "0 12px 10px 40px", fontSize: 12.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                      <div><b style={{ color: "var(--text-primary)" }}>Suspect:</b> {c.hint}</div>
                      <div style={{ marginTop: 3 }}><b style={{ color: "var(--text-primary)" }}>Act:</b> {c.action}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Modal>
  );
}

/* ── Collapsible reference sections ─────────────────────────────── */

export function RefSections({ ids }: { ids?: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const sections = useMemo(
    () => (ids ? REFERENCE_SECTIONS.filter((s) => ids.includes(s.id)) : REFERENCE_SECTIONS),
    [ids],
  );

  return (
    <div style={{ maxWidth: 620, margin: "18px auto 0", width: "100%" }}>
      <div style={{ ...monoLabel, margin: "0 0 8px 2px" }}>Reference</div>
      <div style={{ ...cardStyle, overflow: "hidden" }}>
        {sections.map((s, i) => {
          const isOpen = open === s.id;
          return (
            <div key={s.id} style={{ borderTop: i ? "1px solid var(--border)" : "none" }}>
              <button type="button" className="acls-chip" onClick={() => setOpen(isOpen ? null : s.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, border: 0, background: "transparent", padding: "12px 15px", textAlign: "left" }}>
                <M name={s.icon} size={18} style={{ color: "var(--text-muted)" }} />
                <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{s.title}</span>
                <M name={isOpen ? "expand_less" : "expand_more"} size={18} style={{ color: "var(--text-muted)" }} />
              </button>
              {isOpen && (
                <div className="acls-in" style={{ padding: "1px 15px 13px 43px", display: "flex", flexDirection: "column", gap: 7 }}>
                  {s.rows.map((r, j) => (
                    <div key={j} style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                      {r.head && <b style={{ color: "var(--text-primary)" }}>{r.head}: </b>}
                      {r.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
