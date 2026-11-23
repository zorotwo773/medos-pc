"use client";
/* ──────────────────────────────────────────────────────────────
   CodeScreen — runs one algorithm.

   Cardiac arrest runs in full code mode: sticky timer bar (CPR
   cycle countdown, epinephrine clock, shock counter), quick-med
   drawer, voice + chime reminders, timestamped log, End/ROSC flow
   and a post-code summary. Reference algorithms (bradycardia,
   tachycardia, post-arrest) run the same walkable UI without the
   code chrome.
   ────────────────────────────────────────────────────────────── */

import { useCallback, useMemo, useState } from "react";
import type { Algorithm, AlgoNode, CounterKey, MedDose, NodeChoice } from "@/lib/acls/types";
import { CPR_CYCLE_MS } from "@/lib/acls/types";
import { fmtClock, useCodeSession } from "@/lib/acls/useCodeSession";
import { M, cardStyle, monoLabel } from "./ui";
import WalkView, { type WalkHandlers } from "./WalkView";
import MapView from "./MapView";
import { CausesPanel, LogPanel, RefSections } from "./panels";
import AclsPoster, { usePosterAvailable } from "./AclsPoster";

/* Quick-drawer actions (beyond the three headline chips). */
const QUICK_MEDS: { med: MedDose; icon: string }[] = [
  { icon: "medication", med: { name: "Amiodarone", dose: "300 mg → 150 mg IV/IO", counter: "amio" } },
  { icon: "medication", med: { name: "Lidocaine", dose: "1–1.5 mg/kg → 0.5–0.75 mg/kg", counter: "lido" } },
  { icon: "medication", med: { name: "Magnesium", dose: "1–2 g IV/IO (torsades)", counter: "mag" } },
  { icon: "medication", med: { name: "Bicarbonate", dose: "1 mEq/kg (specific indications)", counter: "bicarb" } },
  { icon: "medication", med: { name: "Calcium", dose: "CaCl₂ 1 g (hyperK/CCB toxicity)", counter: "calcium" } },
  { icon: "medication", med: { name: "Naloxone", dose: "2 mg IN / 0.4 mg IV", counter: "naloxone" } },
];

const QUICK_EVENTS: { label: string; icon: string; type: "airway" | "access" | "pulse"; counter?: CounterKey; detail?: string }[] = [
  { label: "Intubation", icon: "pulmonology", type: "airway", counter: "airway", detail: "Advanced airway placed — confirm with waveform capnography" },
  { label: "IV/IO access", icon: "vaccines", type: "access", counter: "access" },
  { label: "Pulse check", icon: "touch_app", type: "pulse", counter: "pulse" },
];

const REF_IDS: Record<string, string[]> = {
  "cardiac-arrest": ["cpr-quality", "shock-energy", "drugs", "airway", "rosc"],
  "pediatric-cardiac-arrest": ["peds-cpr", "peds-shock", "peds-drugs", "rosc"],
  bradycardia: ["drugs", "rosc"],
  tachycardia: ["cardioversion", "drugs"],
  "post-arrest": ["rosc", "cpr-quality"],
};

export default function CodeScreen({ algo, onBack, onOpenAlgo }: {
  algo: Algorithm;
  onBack: () => void;
  onOpenAlgo: (id: string) => void;
}) {
  return algo.codeMode
    ? <CodeModeScreen algo={algo} onBack={onBack} onOpenAlgo={onOpenAlgo} />
    : <ReferenceModeScreen algo={algo} onBack={onBack} onOpenAlgo={onOpenAlgo} />;
}

/* ── Shared chrome ──────────────────────────────────────────────── */

function Header({ algo, onBack, right }: { algo: Algorithm; onBack: () => void; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <button type="button" className="acls-chip" onClick={onBack} aria-label="Back to ACLS hub" style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 9, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", flexShrink: 0 }}>
        <M name="arrow_back" size={18} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 19, fontWeight: 620, color: "var(--text-primary)", lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {algo.title}
        </h1>
        <div style={{ ...monoLabel, fontSize: 8.5, marginTop: 2 }}>{algo.guideline}</div>
      </div>
      {right}
    </div>
  );
}

type ViewMode = "walk" | "map" | "poster";
const VIEW_META: Record<ViewMode, { icon: string; label: string }> = {
  walk: { icon: "footprint", label: "Walk" },
  map: { icon: "account_tree", label: "Map" },
  poster: { icon: "image", label: "Poster" },
};

function ViewToggle({ view, setView, showPoster }: { view: ViewMode; setView: (v: ViewMode) => void; showPoster: boolean }) {
  const modes: ViewMode[] = showPoster ? ["walk", "map", "poster"] : ["walk", "map"];
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 999, overflow: "hidden", background: "var(--bg-card)", flexShrink: 0 }}>
      {modes.map((v) => (
        <button key={v} type="button" className="acls-chip" onClick={() => setView(v)} style={{
          border: 0, padding: "6px 14px", fontSize: 12, fontWeight: 650,
          background: view === v ? "var(--accent)" : "transparent",
          color: view === v ? "#fff" : "var(--text-secondary)",
          display: "flex", alignItems: "center", gap: 5,
        }}>
          <M name={VIEW_META[v].icon} size={14} />
          {VIEW_META[v].label}
        </button>
      ))}
    </div>
  );
}

/* ── Reference mode (no code engine) ────────────────────────────── */

function ReferenceModeScreen({ algo, onBack, onOpenAlgo }: { algo: Algorithm; onBack: () => void; onOpenAlgo: (id: string) => void }) {
  const [view, setView] = useState<ViewMode>("walk");
  const [nodeId, setNodeId] = useState(algo.entry);
  const [path, setPath] = useState<string[]>([algo.entry]);
  const posterAvailable = usePosterAvailable(algo.id);

  const go = useCallback((id: string) => {
    setNodeId(id);
    setPath((p) => [...p, id]);
    setView("walk");
  }, []);

  const handlers: WalkHandlers = useMemo(
    () => ({
      onChoose: (c: NodeChoice) => go(c.to),
      onPrimary: (n: AlgoNode) => n.next && go(n.next),
      onJump: go,
    }),
    [go],
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <Header algo={algo} onBack={onBack} right={<ViewToggle view={view} setView={setView} showPoster={posterAvailable} />} />
      <div className="acls-scroll" style={{ flex: 1, overflowY: "auto", padding: "16px 16px 40px" }}>
        {view === "walk" ? (
          <>
            <WalkView algo={algo} nodeId={nodeId} path={path} handlers={handlers} accent={algo.accent} />
            {algo.id === "post-arrest" && algo.nodes[nodeId]?.kind === "outcome" && (
              <div style={{ maxWidth: 620, margin: "12px auto 0" }}>
                <button type="button" className="acls-chip" onClick={() => onOpenAlgo("cardiac-arrest")} style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 10, padding: "9px 13px", fontSize: 12.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 7 }}>
                  <M name="ecg_heart" size={15} style={{ color: "#E11D48" }} /> Re-arrest? Open Cardiac Arrest
                </button>
              </div>
            )}
            <RefSections ids={REF_IDS[algo.id]} />
          </>
        ) : view === "map" ? (
          <MapView algo={algo} currentId={nodeId} onJump={go} accent={algo.accent} />
        ) : (
          <AclsPoster algoId={algo.id} title={algo.title} />
        )}
      </div>
    </div>
  );
}

/* ── Full code mode ─────────────────────────────────────────────── */

function CodeModeScreen({ algo, onBack, onOpenAlgo }: { algo: Algorithm; onBack: () => void; onOpenAlgo: (id: string) => void }) {
  const eng = useCodeSession(algo);
  const [view, setView] = useState<ViewMode>("walk");
  const [showLog, setShowLog] = useState(false);
  const [showCauses, setShowCauses] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [armEnd, setArmEnd] = useState<"rosc" | "ended" | null>(null);
  const posterAvailable = usePosterAvailable(algo.id);

  const s = eng.session;

  const handlers: WalkHandlers = useMemo(
    () => ({
      onChoose: (c: NodeChoice) => eng.choose(c),
      onPrimary: (n: AlgoNode) => {
        if (n.primaryEvent === "shock") eng.logShock();
        eng.advance(n);
      },
      onJump: (id: string) => { eng.jumpTo(id); setView("walk"); },
      onMed: (m: MedDose) => eng.logMed(m),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eng.choose, eng.logShock, eng.advance, eng.jumpTo, eng.logMed],
  );

  const armThen = (which: "rosc" | "ended") => {
    if (armEnd === which) {
      eng.end(which);
      setArmEnd(null);
    } else {
      setArmEnd(which);
      setTimeout(() => setArmEnd((v) => (v === which ? null : v)), 3200);
    }
  };

  /* ── Not started ── */
  if (!s) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
        <Header algo={algo} onBack={onBack} />
        <div className="acls-scroll" style={{ flex: 1, overflowY: "auto", padding: "22px 16px 40px" }}>
          <div style={{ maxWidth: 620, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
            {eng.hasSavedSession && (
              <div className="acls-in" style={{ ...cardStyle, borderLeft: "3px solid var(--amber)", padding: "13px 16px", display: "flex", alignItems: "center", gap: 11 }}>
                <M name="history" size={20} style={{ color: "var(--amber-dim)" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text-primary)" }}>A code is still running</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>This tab was closed mid-code — the clocks kept counting.</div>
                </div>
                <button type="button" className="acls-btn" onClick={eng.resume} style={{ border: 0, background: "var(--amber)", color: "#fff", borderRadius: 9, padding: "8px 14px", fontSize: 13, fontWeight: 700 }}>Resume</button>
                <button type="button" className="acls-chip" onClick={eng.discard} style={{ border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text-muted)", borderRadius: 9, padding: "8px 11px", fontSize: 13 }}>Discard</button>
              </div>
            )}

            <button
              type="button"
              className="acls-btn"
              onClick={eng.start}
              style={{
                border: 0, borderRadius: 16, padding: "26px 20px",
                background: "linear-gradient(135deg, #E11D48, #be123c)",
                color: "#fff", display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                boxShadow: "0 8px 24px rgba(225,29,72,0.35)",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 24, fontWeight: 800, letterSpacing: "0.02em" }}>
                <M name="ecg_heart" size={30} fill /> START CODE
              </span>
              <span style={{ fontSize: 12.5, opacity: 0.92, fontWeight: 500 }}>
                Starts the master clock, first CPR cycle, and voice reminders
              </span>
            </button>

            <div style={{ ...cardStyle, padding: "14px 16px", fontSize: 13, lineHeight: 1.6, color: "var(--text-secondary)" }}>
              <b style={{ color: "var(--text-primary)" }}>During the code:</b> the top bar keeps the CPR 2-minute cycle and the epinephrine
              3–5 minute window; every tap is timestamped into the code log. Walk mode guides you step by step —
              map mode shows the whole chart. Voice prompts announce rhythm checks and due medications.
            </div>

            <button type="button" className="acls-chip" onClick={() => { eng.start(); setView("map"); }} style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 7, justifyContent: "center" }}>
              <M name="account_tree" size={16} /> Start on the full-chart view instead
            </button>

            <RefSections ids={REF_IDS[algo.id]} />
          </div>
        </div>
      </div>
    );
  }

  /* ── Ended — summary ── */
  if (s.endedAt) {
    const rosc = s.outcome === "rosc";
    const c = s.counters;
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
        <Header algo={algo} onBack={onBack} />
        <div className="acls-scroll" style={{ flex: 1, overflowY: "auto", padding: "22px 16px 40px" }}>
          <div className="acls-in" style={{ maxWidth: 620, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ ...cardStyle, borderTop: `3px solid ${rosc ? "var(--green)" : "var(--text-muted)"}`, padding: "20px", textAlign: "center" }}>
              <M name={rosc ? "favorite" : "stop_circle"} size={34} fill style={{ color: rosc ? "var(--green)" : "var(--text-muted)" }} />
              <h2 style={{ margin: "8px 0 2px", fontFamily: "var(--font-serif)", fontSize: 26, color: "var(--text-primary)" }}>
                {rosc ? "ROSC achieved" : "Resuscitation ended"}
              </h2>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--text-muted)" }}>
                Total code time {fmtClock(s.endedAt - s.startedAt)}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 15 }}>
                {[
                  ["CPR cycles", c.cpr ?? 0], ["Shocks", c.shock ?? 0], ["Epi", c.epi ?? 0],
                  ["Amio", c.amio ?? 0], ["Lido", c.lido ?? 0], ["Causes ✓", Object.values(s.causes).filter(Boolean).length],
                ].map(([label, v]) => (
                  <div key={label as string} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "7px 13px", background: "var(--bg-subtle)" }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 700, color: "var(--text-primary)" }}>{v as number}</div>
                    <div style={{ ...monoLabel, fontSize: 8.5 }}>{label as string}</div>
                  </div>
                ))}
              </div>
            </div>

            {rosc && (
              <button type="button" className="acls-btn" onClick={() => onOpenAlgo("post-arrest")} style={{ border: 0, borderRadius: 12, padding: "15px 14px", background: "var(--green)", color: "#fff", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <M name="respiratory_rate" size={20} /> Continue → Post-Cardiac Arrest Care
              </button>
            )}

            <div style={{ display: "flex", gap: 9 }}>
              <button type="button" className="acls-chip" onClick={() => setShowLog(true)} style={{ flex: 1, border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 10, padding: "11px", fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <M name="receipt_long" size={17} /> View / export log ({s.events.length})
              </button>
              <button type="button" className="acls-chip" onClick={eng.start} style={{ flex: 1, border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 10, padding: "11px", fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <M name="restart_alt" size={17} /> New code
              </button>
            </div>
          </div>
        </div>
        {showLog && <LogPanel session={s} algoTitle={algo.title} onClose={() => setShowLog(false)} onNotes={eng.setNotes} />}
      </div>
    );
  }

  /* ── Running ── */
  const causesDone = Object.values(s.causes).filter(Boolean).length;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <Header
        algo={algo}
        onBack={onBack}
        right={
          <button type="button" className="acls-chip" onClick={() => setShowLog(true)} style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 9, padding: "6px 12px", fontSize: 12, fontWeight: 650, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
            <M name="receipt_long" size={15} /> LOG ({s.events.length})
          </button>
        }
      />

      {/* ── Timer bar ── */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)", flexWrap: "wrap", flexShrink: 0 }}>
        <button type="button" className="acls-chip" onClick={() => setDrawer((v) => !v)} aria-label="More meds and events" style={{ border: "1px solid var(--border-strong)", background: drawer ? "var(--accent)" : "var(--bg-card)", color: drawer ? "#fff" : "var(--text-secondary)", borderRadius: 10, width: 42, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <M name={drawer ? "remove" : "add"} size={21} />
        </button>

        <TimerChip
          label={`CPR ${s.counters.cpr ?? 0}`}
          icon="compress"
          value={eng.cprRemaining !== null ? (eng.cprRemaining >= 0 ? fmtClock(eng.cprRemaining) : `+${fmtClock(-eng.cprRemaining)}`) : "—:—"}
          tone={eng.cprDue ? "danger" : eng.cprRemaining !== null && eng.cprRemaining < 15_000 ? "warn" : "ok"}
          progress={eng.cprRemaining !== null ? Math.max(0, Math.min(1, 1 - eng.cprRemaining / CPR_CYCLE_MS)) : 0}
          hint="Tap = new 2-min cycle"
          onClick={() => eng.newCprCycle()}
        />
        <TimerChip
          label={`EPI ${s.counters.epi ?? 0}`}
          icon="syringe"
          value={eng.sinceEpi !== null ? fmtClock(eng.sinceEpi) : "—:—"}
          tone={eng.epiState === "due" ? "danger" : eng.epiState === "window" ? "warn" : "ok"}
          hint={eng.epiState === "none" ? "Tap = first dose" : eng.epiState === "due" ? "DUE — tap to log" : eng.epiState === "window" ? "3–5 min window open" : "Tap = dose given"}
          onClick={() => eng.logMed({ name: "Epinephrine", dose: "1 mg IV/IO", counter: "epi" })}
        />
        <TimerChip
          label="SHOCK"
          icon="bolt"
          value={`${s.counters.shock ?? 0}`}
          tone="shock"
          hint="Tap = shock delivered"
          onClick={eng.logShock}
        />
        <button type="button" className="acls-chip" onClick={() => setShowCauses(true)} style={{ border: "1px solid var(--border-strong)", background: "var(--bg-card)", borderRadius: 10, padding: "5px 12px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, flexShrink: 0 }} title="H's & T's checklist">
          <span style={{ ...monoLabel, fontSize: 8 }}>H&rsquo;s &amp; T&rsquo;s</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700, color: causesDone ? "var(--green-dim)" : "var(--text-primary)" }}>{causesDone}/10</span>
        </button>
      </div>

      {/* Quick drawer */}
      {drawer && (
        <div className="acls-in" style={{ display: "flex", flexWrap: "wrap", gap: 7, padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)", flexShrink: 0 }}>
          {QUICK_MEDS.map(({ med, icon }) => (
            <button key={med.name} type="button" className="acls-chip" onClick={() => eng.logMed(med)} title={med.dose} style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 9, padding: "6px 11px", fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
              <M name={icon} size={14} style={{ color: "var(--green-dim)" }} />
              {med.name}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>({s.counters[med.counter!] ?? 0})</span>
            </button>
          ))}
          {QUICK_EVENTS.map((q) => (
            <button key={q.label} type="button" className="acls-chip" onClick={() => eng.logQuick(q.type, q.label, q.counter, q.detail)} style={{ border: "1px solid var(--border)", background: "var(--bg-card)", borderRadius: 9, padding: "6px 11px", fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
              <M name={q.icon} size={14} style={{ color: "var(--indigo)" }} />
              {q.label}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>({s.counters[q.counter!] ?? 0})</span>
            </button>
          ))}
          <button type="button" className="acls-chip" onClick={() => { const t = window.prompt("Log a note:"); if (t?.trim()) eng.logQuick("note", t.trim()); }} style={{ border: "1px dashed var(--border-strong)", background: "transparent", borderRadius: 9, padding: "6px 11px", fontSize: 12.5, fontWeight: 600, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <M name="edit_note" size={15} /> Note…
          </button>
        </div>
      )}

      {/* ── Content ── */}
      <div className="acls-scroll" style={{ flex: 1, overflowY: "auto", padding: "14px 16px 30px" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <ViewToggle view={view} setView={setView} showPoster={posterAvailable} />
        </div>
        {view === "walk" ? (
          <>
            <WalkView algo={algo} nodeId={s.currentNodeId} path={s.path} handlers={handlers} accent={algo.accent} cprDue={eng.cprDue} />
            <RefSections ids={REF_IDS[algo.id]} />
          </>
        ) : view === "map" ? (
          <MapView algo={algo} currentId={s.currentNodeId} onJump={handlers.onJump} accent={algo.accent} />
        ) : (
          <AclsPoster algoId={algo.id} title={algo.title} />
        )}
      </div>

      {/* ── Bottom bar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-subtle)", flexShrink: 0, flexWrap: "wrap" }}>
        <ToggleBtn on={s.soundOn} icon={s.soundOn ? "volume_up" : "volume_off"} label="Sound" onClick={() => eng.setToggle("soundOn", !s.soundOn)} />
        <ToggleBtn on={s.voiceOn} icon="record_voice_over" label="Voice" onClick={() => eng.setToggle("voiceOn", !s.voiceOn)} />
        <ToggleBtn on={s.metronomeOn} icon="av_timer" label="110/min" onClick={() => eng.setToggle("metronomeOn", !s.metronomeOn)} />
        <div style={{ flex: 1, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 21, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "0.05em", minWidth: 80 }}>
          {fmtClock(eng.elapsed)}
        </div>
        <button type="button" className="acls-btn" onClick={() => armThen("rosc")} style={{ border: 0, borderRadius: 10, padding: "9px 15px", background: "var(--green)", color: "#fff", fontSize: 13.5, fontWeight: 700, animation: armEnd === "rosc" ? "acls-blink .6s linear infinite" : undefined }}>
          {armEnd === "rosc" ? "Confirm ROSC" : "ROSC"}
        </button>
        <button type="button" className="acls-btn" onClick={() => armThen("ended")} style={{ border: "1px solid var(--border-strong)", borderRadius: 10, padding: "9px 15px", background: armEnd === "ended" ? "var(--red)" : "var(--bg-card)", color: armEnd === "ended" ? "#fff" : "var(--text-secondary)", fontSize: 13.5, fontWeight: 700, animation: armEnd === "ended" ? "acls-blink .6s linear infinite" : undefined }}>
          {armEnd === "ended" ? "Confirm end" : "End"}
        </button>
      </div>

      {showLog && (
        <LogPanel
          session={s}
          algoTitle={algo.title}
          onClose={() => setShowLog(false)}
          onNotes={eng.setNotes}
          onReset={() => { if (window.confirm("Discard this code without saving?")) { eng.discard(); setShowLog(false); } }}
        />
      )}
      {showCauses && <CausesPanel causes={s.causes} onToggle={eng.toggleCause} onClose={() => setShowCauses(false)} />}
    </div>
  );
}

/* ── Timer chip ─────────────────────────────────────────────────── */

function TimerChip({ label, icon, value, tone, hint, onClick, progress }: {
  label: string;
  icon: string;
  value: string;
  tone: "ok" | "warn" | "danger" | "shock";
  hint: string;
  onClick: () => void;
  progress?: number;
}) {
  const colors = {
    ok:     { bg: "var(--bg-card)", border: "var(--border-strong)", text: "var(--text-primary)", accent: "var(--accent)" },
    warn:   { bg: "var(--amber-glow)", border: "var(--amber)", text: "var(--amber-dim)", accent: "var(--amber)" },
    danger: { bg: "var(--red-glow)", border: "var(--red)", text: "var(--red-dim)", accent: "var(--red)" },
    shock:  { bg: "var(--bg-card)", border: "color-mix(in srgb, var(--red) 55%, var(--border))", text: "var(--red-dim)", accent: "var(--red)" },
  }[tone];

  return (
    <button
      type="button"
      className="acls-btn"
      onClick={onClick}
      title={hint}
      style={{
        border: `1.5px solid ${colors.border}`, background: colors.bg, borderRadius: 10,
        padding: "5px 13px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
        minWidth: 92, position: "relative", overflow: "hidden", flexShrink: 0,
        animation: tone === "danger" ? "acls-blink 1s linear infinite" : undefined,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: colors.text, fontWeight: 700 }}>
        <M name={icon} size={12} fill={tone !== "ok"} /> {label}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 17, fontWeight: 700, color: colors.text, lineHeight: 1.05 }}>{value}</span>
      {progress !== undefined && (
        <span style={{ position: "absolute", left: 0, bottom: 0, height: 3, width: `${progress * 100}%`, background: colors.accent, transition: "width .4s linear" }} />
      )}
    </button>
  );
}

function ToggleBtn({ on, icon, label, onClick }: { on: boolean; icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className="acls-chip" onClick={onClick} title={label} style={{
      border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
      background: on ? "var(--accent-glow)" : "var(--bg-card)",
      color: on ? "var(--accent-strong)" : "var(--text-muted)",
      borderRadius: 9, padding: "6px 10px", fontSize: 11, fontWeight: 650,
      display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
    }}>
      <M name={icon} size={15} /> {label}
    </button>
  );
}
