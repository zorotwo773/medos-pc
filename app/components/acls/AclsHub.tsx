"use client";
/* ──────────────────────────────────────────────────────────────
   ACLS hub — the emergency landing screen.

   One giant START CODE button (straight into the running cardiac
   arrest code), the walkable algorithm library, and past code
   logs. Deep-linkable with ?algo=<id>.
   ────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ALGORITHMS, getAlgorithm } from "@/lib/acls/algorithms";
import type { CodeSession } from "@/lib/acls/types";
import { buildTranscript, fmtClock, loadHistory } from "@/lib/acls/useCodeSession";
import CodeScreen from "./CodeScreen";
import { ACLS_CSS, M, cardStyle, monoLabel } from "./ui";

export default function AclsHub() {
  const sp = useSearchParams();
  const router = useRouter();
  const [algoId, setAlgoId] = useState<string | null>(() => {
    const q = sp.get("algo");
    return q && getAlgorithm(q) ? q : null;
  });
  const [history, setHistory] = useState<CodeSession[]>([]);

  useEffect(() => {
    setHistory(loadHistory());
  }, [algoId]);

  /* Follow sidebar / deep-link navigations (?algo= changes). */
  useEffect(() => {
    const q = sp.get("algo");
    setAlgoId(q && getAlgorithm(q) ? q : null);
  }, [sp]);

  /* Keep ?algo= in the URL via the router so useSearchParams stays in sync. */
  const openAlgo = useCallback((id: string | null) => {
    setAlgoId(id);
    router.replace(id ? `/acls?algo=${id}` : "/acls", { scroll: false });
  }, [router]);

  const algo = algoId ? getAlgorithm(algoId) : null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <style>{ACLS_CSS}</style>
      {algo ? (
        <CodeScreen key={algo.id} algo={algo} onBack={() => openAlgo(null)} onOpenAlgo={openAlgo} />
      ) : (
        <Landing onOpen={openAlgo} history={history} />
      )}
    </div>
  );
}

/* ── Landing ────────────────────────────────────────────────────── */

function Landing({ onOpen, history }: { onOpen: (id: string) => void; history: CodeSession[] }) {
  return (
    <div className="acls-scroll" style={{ flex: 1, overflowY: "auto", padding: "22px 18px 48px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Header */}
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 30, fontWeight: 640, color: "var(--text-primary)" }}>
              Emergency · ACLS
            </h1>
            <span style={{ ...monoLabel, color: "var(--accent-strong)" }}>AHA Guidelines 2025</span>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
            Walkable resuscitation algorithms with live cycle timers, dose logging, and voice reminders.
            Reference aid for trained providers — not a substitute for clinical judgment.
          </p>
        </div>

        {/* START CODE */}
        <button
          type="button"
          className="acls-btn"
          onClick={() => onOpen("cardiac-arrest")}
          style={{
            border: 0, borderRadius: 18, padding: "28px 22px",
            background: "linear-gradient(135deg, #E11D48, #9f1239)",
            color: "#fff", textAlign: "left", display: "flex", alignItems: "center", gap: 18,
            boxShadow: "0 10px 30px rgba(225,29,72,0.30)",
          }}
        >
          <span style={{ width: 60, height: 60, borderRadius: "50%", background: "rgba(255,255,255,0.16)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <M name="ecg_heart" size={34} fill />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 25, fontWeight: 800, letterSpacing: "0.02em", lineHeight: 1.1 }}>CODE — Cardiac Arrest</span>
            <span style={{ display: "block", fontSize: 13, opacity: 0.92, marginTop: 4, fontWeight: 500 }}>
              CPR 2-min cycles · epinephrine window · shock &amp; dose log · voice prompts
            </span>
          </span>
          <M name="arrow_forward" size={26} />
        </button>

        {/* Algorithm library */}
        <div>
          <div style={{ ...monoLabel, margin: "4px 0 10px 2px" }}>Algorithms</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 11 }}>
            {ALGORITHMS.map((a) => (
              <button
                key={a.id}
                type="button"
                className="acls-chip"
                onClick={() => onOpen(a.id)}
                style={{ ...cardStyle, borderTop: `3px solid ${a.accent}`, padding: "14px 15px", textAlign: "left", display: "flex", flexDirection: "column", gap: 6 }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <M name={a.icon} size={20} style={{ color: a.accent }} />
                  <span style={{ fontSize: 15.5, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-serif)" }}>{a.title}</span>
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{a.blurb}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4, ...monoLabel, fontSize: 8.5, color: a.codeMode ? "var(--red-dim)" : "var(--text-muted)" }}>
                  <M name={a.codeMode ? "timer" : "footprint"} size={11} />
                  {a.codeMode ? "Live code mode + timers" : "Walkable guide"}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Past codes */}
        {history.length > 0 && (
          <div>
            <div style={{ ...monoLabel, margin: "4px 0 10px 2px" }}>Past code logs</div>
            <div style={{ ...cardStyle, overflow: "hidden" }}>
              {history.map((h, i) => <HistoryRow key={h.id} s={h} first={i === 0} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ s, first }: { s: CodeSession; first: boolean }) {
  const [copied, setCopied] = useState(false);
  const algo = getAlgorithm(s.algoId);
  const title = algo?.title ?? s.algoId;
  const rosc = s.outcome === "rosc";
  const dur = (s.endedAt ?? s.startedAt) - s.startedAt;
  const d = new Date(s.startedAt);

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildTranscript(s, title));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const doDownload = () => {
    const blob = new Blob([buildTranscript(s, title)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `code-log-${d.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderTop: first ? "none" : "1px solid var(--border)" }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
        background: rosc ? "var(--green)" : "var(--text-muted)",
        boxShadow: rosc ? "0 0 6px var(--green)" : "none",
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {rosc ? "ROSC" : "Ended"} · {fmtClock(dur)} — {title}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {d.toLocaleString()} · CPR {s.counters.cpr ?? 0} · ⚡ {s.counters.shock ?? 0} · EPI {s.counters.epi ?? 0}
        </div>
      </div>
      <button type="button" className="acls-chip" onClick={doCopy} title="Copy transcript" style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 7, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: copied ? "var(--green-dim)" : "var(--text-muted)", flexShrink: 0 }}>
        <M name={copied ? "check" : "content_copy"} size={15} />
      </button>
      <button type="button" className="acls-chip" onClick={doDownload} title="Download .txt" style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 7, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", flexShrink: 0 }}>
        <M name="download" size={15} />
      </button>
    </div>
  );
}
