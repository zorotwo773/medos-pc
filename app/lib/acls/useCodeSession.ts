"use client";
/* ──────────────────────────────────────────────────────────────
   MedOS ACLS — the live code engine.

   One hook owns the whole running code: master clock, CPR-cycle
   clock, epinephrine clock, counters, the timestamped event log,
   the walker position, and the reminder scheduler (sound + voice).

   The active session persists to localStorage on every mutation so
   a crashed/reloaded tab resumes the code exactly where it was —
   the clocks are wall-time anchored (epoch diffs), so they stay
   correct across a reload.
   ────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Algorithm, AlgoNode, CodeEvent, CodeSession, CounterKey, MedDose, NodeChoice } from "./types";
import { CPR_CYCLE_MS, EPI_DUE_MS, EPI_WINDOW_OPEN_MS } from "./types";
import { alarm, chime, fanfare, metronomeTick, speak, stopSpeaking } from "./sound";

const ACTIVE_KEY = "medos.acls.active.v1";
const HISTORY_KEY = "medos.acls.history.v1";
const HISTORY_MAX = 20;

const uid = () => Math.random().toString(36).slice(2, 10);

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function loadActive(algoId: string): CodeSession | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as CodeSession;
    if (s.algoId !== algoId || s.endedAt) return null;
    return s;
  } catch {
    return null;
  }
}

function persist(s: CodeSession | null) {
  try {
    if (s) window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(s));
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch { /* storage full/blocked — session still works in memory */ }
}

function pushHistory(s: CodeSession) {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const list: CodeSession[] = raw ? JSON.parse(raw) : [];
    list.unshift(s);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch { /* ignore */ }
}

export function loadHistory(): CodeSession[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as CodeSession[]) : [];
  } catch {
    return [];
  }
}

/** Human-readable transcript for export / clipboard. */
export function buildTranscript(s: CodeSession, algoTitle: string): string {
  const started = new Date(s.startedAt);
  const dur = (s.endedAt ?? Date.now()) - s.startedAt;
  const c = s.counters;
  const lines = [
    `MedOS Code Log — ${algoTitle}`,
    `Started: ${started.toLocaleString()}`,
    `Duration: ${fmtClock(dur)}   Outcome: ${s.outcome === "rosc" ? "ROSC" : s.outcome === "ended" ? "Resuscitation ended" : "In progress"}`,
    `Totals: CPR cycles ${c.cpr ?? 0} · Shocks ${c.shock ?? 0} · Epinephrine ${c.epi ?? 0} · Amiodarone ${c.amio ?? 0} · Lidocaine ${c.lido ?? 0}`,
    "".padEnd(62, "─"),
    ...s.events.map((e) => {
      const wall = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const n = e.n ? ` #${e.n}` : "";
      return `[${fmtClock(e.t)}] (${wall})  ${e.label}${n}${e.detail ? ` — ${e.detail}` : ""}`;
    }),
  ];
  if (s.notes.trim()) lines.push("".padEnd(62, "─"), "Notes:", s.notes.trim());
  const causes = Object.entries(s.causes).filter(([, v]) => v).map(([k]) => k);
  if (causes.length) lines.push("".padEnd(62, "─"), `Reversible causes addressed: ${causes.join(", ")}`);
  return lines.join("\n");
}

/* ── The hook ───────────────────────────────────────────────────── */

export interface CodeEngine {
  session: CodeSession | null;
  running: boolean;
  now: number;
  elapsed: number;
  /** ms left in the current CPR cycle (negative = overdue), null when no cycle. */
  cprRemaining: number | null;
  /** ms since last epi, null before first dose. */
  sinceEpi: number | null;
  epiState: "none" | "fresh" | "window" | "due";
  cprDue: boolean;
  start: () => void;
  resume: () => void;
  discard: () => void;
  end: (outcome: "rosc" | "ended") => void;
  logMed: (med: MedDose) => void;
  logShock: () => void;
  newCprCycle: (silent?: boolean) => void;
  logQuick: (type: CodeEvent["type"], label: string, counter?: CounterKey, detail?: string) => void;
  choose: (choice: NodeChoice) => void;
  /** Follow an action node's primary "next" — natural flow, no nav log entry. */
  advance: (node: AlgoNode) => void;
  jumpTo: (nodeId: string) => void;
  toggleCause: (id: string, label: string) => void;
  setNotes: (notes: string) => void;
  setToggle: (key: "soundOn" | "voiceOn" | "metronomeOn", v: boolean) => void;
  hasSavedSession: boolean;
}

export function useCodeSession(algo: Algorithm): CodeEngine {
  const [session, setSession] = useState<CodeSession | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [hasSavedSession, setHasSavedSession] = useState(false);
  const firedRef = useRef<Set<string>>(new Set());
  const sessionRef = useRef<CodeSession | null>(null);
  sessionRef.current = session;

  /* Detect a resumable session once on mount. */
  useEffect(() => {
    setHasSavedSession(!!loadActive(algo.id));
  }, [algo.id]);

  /* Master tick — 500 ms is enough for mm:ss displays. */
  const running = !!session && !session.endedAt;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  /* Persist on every session mutation. */
  useEffect(() => {
    if (session) persist(session.endedAt ? null : session);
  }, [session]);

  const mutate = useCallback((fn: (s: CodeSession) => CodeSession) => {
    setSession((prev) => (prev ? fn(prev) : prev));
  }, []);

  const addEvent = useCallback(
    (s: CodeSession, type: CodeEvent["type"], label: string, opts?: { detail?: string; counter?: CounterKey }): CodeSession => {
      const t = Date.now() - s.startedAt;
      const counters = { ...s.counters };
      let n: number | undefined;
      if (opts?.counter) {
        n = (counters[opts.counter] ?? 0) + 1;
        counters[opts.counter] = n;
      }
      const ev: CodeEvent = { id: uid(), t, at: Date.now(), type, label, detail: opts?.detail, n };
      return { ...s, counters, events: [...s.events, ev] };
    },
    [],
  );

  /* ── Session lifecycle ── */

  const start = useCallback(() => {
    firedRef.current = new Set();
    const nowMs = Date.now();
    const entry = algo.nodes[algo.entry];
    let s: CodeSession = {
      id: uid(),
      algoId: algo.id,
      startedAt: nowMs,
      endedAt: null,
      outcome: null,
      events: [],
      counters: {},
      cprStartedAt: null,
      lastEpiAt: null,
      currentNodeId: algo.entry,
      path: [algo.entry],
      soundOn: true,
      voiceOn: true,
      metronomeOn: false,
      notes: "",
      causes: {},
    };
    s = addEvent(s, "start", "Code start");
    if (entry?.onEnter?.some((e) => e.type === "startCprCycle")) {
      s = { ...s, cprStartedAt: nowMs };
      s = addEvent(s, "cpr", "CPR cycle", { counter: "cpr" });
    }
    setSession(s);
    setHasSavedSession(false);
    setNow(nowMs);
  }, [algo, addEvent]);

  const resume = useCallback(() => {
    const saved = loadActive(algo.id);
    if (saved) {
      firedRef.current = new Set();
      setSession(saved);
      setNow(Date.now());
    }
    setHasSavedSession(false);
  }, [algo.id]);

  const discard = useCallback(() => {
    persist(null);
    setHasSavedSession(false);
    setSession(null);
    stopSpeaking();
  }, []);

  const end = useCallback(
    (outcome: "rosc" | "ended") => {
      stopSpeaking();
      const cur = sessionRef.current;
      if (!cur || cur.endedAt) return;
      let nx = addEvent(cur, outcome === "rosc" ? "rosc" : "end", outcome === "rosc" ? "ROSC — code ended" : "Resuscitation ended");
      nx = { ...nx, endedAt: Date.now(), outcome, cprStartedAt: null };
      setSession(nx);
      pushHistory(nx);
      persist(null);
      if (nx.soundOn && outcome === "rosc") fanfare();
    },
    [addEvent],
  );

  /* ── Logging actions ── */

  const newCprCycle = useCallback(
    (silent = false) => {
      mutate((s) => {
        let nx = addEvent(s, "cpr", "CPR cycle", { counter: "cpr" });
        nx = { ...nx, cprStartedAt: Date.now() };
        if (!silent && nx.soundOn) chime();
        return nx;
      });
    },
    [mutate, addEvent],
  );

  const logShock = useCallback(() => {
    mutate((s) => {
      const nx = addEvent(s, "shock", "Shock delivered", { counter: "shock" });
      if (nx.soundOn) chime();
      return nx;
    });
  }, [mutate, addEvent]);

  const logMed = useCallback(
    (med: MedDose) => {
      mutate((s) => {
        let nx = addEvent(s, "med", med.name, { detail: med.dose, counter: med.counter });
        if (med.counter === "epi") nx = { ...nx, lastEpiAt: Date.now() };
        if (nx.soundOn) chime();
        return nx;
      });
    },
    [mutate, addEvent],
  );

  const logQuick = useCallback(
    (type: CodeEvent["type"], label: string, counter?: CounterKey, detail?: string) => {
      mutate((s) => addEvent(s, type, label, { counter, detail }));
    },
    [mutate, addEvent],
  );

  /* ── Walker ── */

  const enterNode = useCallback(
    (s: CodeSession, nodeId: string): CodeSession => {
      const node = algo.nodes[nodeId];
      let nx: CodeSession = { ...s, currentNodeId: nodeId, path: [...s.path, nodeId] };
      if (node?.onEnter) {
        for (const eff of node.onEnter) {
          if (eff.type === "startCprCycle") {
            nx = addEvent(nx, "cpr", "CPR cycle", { counter: "cpr" });
            nx = { ...nx, cprStartedAt: Date.now() };
          } else if (eff.type === "stopCprCycle") {
            nx = { ...nx, cprStartedAt: null };
          }
        }
      }
      return nx;
    },
    [algo, addEvent],
  );

  const choose = useCallback(
    (choice: NodeChoice) => {
      mutate((s) => {
        let nx = choice.log ? addEvent(s, "rhythm", choice.log) : s;
        nx = enterNode(nx, choice.to);
        return nx;
      });
    },
    [mutate, addEvent, enterNode],
  );

  const advance = useCallback(
    (node: AlgoNode) => {
      if (!node.next) return;
      mutate((s) => enterNode(s, node.next!));
    },
    [mutate, enterNode],
  );

  const jumpTo = useCallback(
    (nodeId: string) => {
      mutate((s) => {
        if (s.currentNodeId === nodeId) return s;
        const node = algo.nodes[nodeId];
        const nx = addEvent(s, "nav", `Moved to: ${node?.title ?? nodeId}`);
        return enterNode(nx, nodeId);
      });
    },
    [mutate, addEvent, enterNode, algo],
  );

  const toggleCause = useCallback(
    (id: string, label: string) => {
      mutate((s) => {
        const on = !s.causes[id];
        const nx = on ? addEvent(s, "cause", `Cause addressed: ${label}`) : s;
        return { ...nx, causes: { ...s.causes, [id]: on } };
      });
    },
    [mutate, addEvent],
  );

  const setNotes = useCallback((notes: string) => mutate((s) => ({ ...s, notes })), [mutate]);
  const setToggle = useCallback(
    (key: "soundOn" | "voiceOn" | "metronomeOn", v: boolean) => mutate((s) => ({ ...s, [key]: v })),
    [mutate],
  );

  /* ── Derived clocks ── */

  const elapsed = session ? (session.endedAt ?? now) - session.startedAt : 0;
  const cprElapsed = running && session?.cprStartedAt ? now - session.cprStartedAt : null;
  const cprRemaining = cprElapsed !== null ? CPR_CYCLE_MS - cprElapsed : null;
  const cprDue = cprRemaining !== null && cprRemaining <= 0;
  const sinceEpi = running && session?.lastEpiAt ? now - session.lastEpiAt : null;
  const epiState: CodeEngine["epiState"] =
    sinceEpi === null ? "none" : sinceEpi >= EPI_DUE_MS ? "due" : sinceEpi >= EPI_WINDOW_OPEN_MS ? "window" : "fresh";

  /* ── Reminder scheduler — edge-triggered, once per clock anchor ── */

  useEffect(() => {
    if (!running || !session) return;
    const fired = firedRef.current;
    const fire = (key: string, fn: () => void) => {
      if (fired.has(key)) return;
      fired.add(key);
      fn();
    };

    if (session.cprStartedAt && cprRemaining !== null) {
      const anchor = session.cprStartedAt;
      if (cprRemaining <= 15_000 && cprRemaining > 0) {
        fire(`cpr:${anchor}:warn`, () => {
          if (session.soundOn) chime();
          speak("Fifteen seconds. Prepare for rhythm check.", session.soundOn && session.voiceOn);
        });
      }
      if (cprRemaining <= 0) {
        fire(`cpr:${anchor}:due`, () => {
          if (session.soundOn) alarm();
          speak("Two minutes. Check rhythm. Rotate compressor.", session.soundOn && session.voiceOn);
          setSession((s) => (s ? addEvent(s, "reminder", "2-minute cycle complete — rhythm check") : s));
        });
      }
    }

    if (session.lastEpiAt && sinceEpi !== null) {
      const anchor = session.lastEpiAt;
      if (sinceEpi >= EPI_WINDOW_OPEN_MS && sinceEpi < EPI_DUE_MS) {
        fire(`epi:${anchor}:window`, () => {
          if (session.soundOn) chime();
          speak("Epinephrine window open.", session.soundOn && session.voiceOn);
        });
      }
      if (sinceEpi >= EPI_DUE_MS) {
        fire(`epi:${anchor}:due`, () => {
          if (session.soundOn) alarm();
          speak("Epinephrine due.", session.soundOn && session.voiceOn);
          setSession((s) => (s ? addEvent(s, "reminder", "Epinephrine due (> 5 min since last dose)") : s));
        });
      }
    }

    /* After the 3rd shock with no antiarrhythmic on board, nudge once. */
    const shocks = session.counters.shock ?? 0;
    const antiarr = (session.counters.amio ?? 0) + (session.counters.lido ?? 0);
    if (shocks >= 3 && antiarr === 0) {
      fire(`antiarr:${session.id}`, () => {
        if (session.soundOn) chime();
        speak("Consider amiodarone or lidocaine.", session.soundOn && session.voiceOn);
        setSession((s) => (s ? addEvent(s, "reminder", "Refractory VF/pVT — consider amiodarone or lidocaine") : s));
      });
    }
  }, [running, session, cprRemaining, sinceEpi, now, addEvent]);

  /* ── CPR metronome (110/min) ── */
  const metronomeActive = running && !!session?.metronomeOn && !!session?.soundOn && !!session?.cprStartedAt;
  useEffect(() => {
    if (!metronomeActive) return;
    let beat = 0;
    const t = setInterval(() => metronomeTick(beat++ % 10 === 0), 60_000 / 110);
    return () => clearInterval(t);
  }, [metronomeActive]);

  return useMemo(
    () => ({
      session, running, now, elapsed, cprRemaining, sinceEpi, epiState, cprDue,
      start, resume, discard, end, logMed, logShock, newCprCycle, logQuick,
      choose, advance, jumpTo, toggleCause, setNotes, setToggle, hasSavedSession,
    }),
    [session, running, now, elapsed, cprRemaining, sinceEpi, epiState, cprDue,
     start, resume, discard, end, logMed, logShock, newCprCycle, logQuick,
     choose, advance, jumpTo, toggleCause, setNotes, setToggle, hasSavedSession],
  );
}
