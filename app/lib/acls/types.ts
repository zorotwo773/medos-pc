/* ──────────────────────────────────────────────────────────────
   MedOS ACLS — shared types for the walkable algorithm engine.

   An algorithm is a directed graph of nodes. "Walk mode" moves a
   cursor through the graph one node at a time; "map mode" renders
   the whole graph as the familiar two-column AHA-style chart.
   Content follows the 2025 AHA Guidelines for CPR & ECC (the
   current standard for 2026).
   ────────────────────────────────────────────────────────────── */

export type NodeKind =
  | "action"    // do these things, then continue (single "next")
  | "decision"  // branch on a question (2+ choices)
  | "outcome"   // terminal or hand-off node (e.g. Post-Cardiac Arrest Care)
  | "loop";     // action node that cycles back (CPR cycles)

/** Inline emphasis: plain string, or bold segment. */
export type Rich = string | { b: string };

export interface MedDose {
  /** Short chip label, e.g. "Epinephrine". */
  name: string;
  /** One-line dose, e.g. "1 mg IV/IO q3–5 min". */
  dose: string;
  /** Counter key this maps to when logged (epi, amio, lido…). */
  counter?: CounterKey;
  /** Extended dosing / preparation / cautions. */
  detail?: string;
  /** Weight-based dosing (pediatric): computed = dosePerKg × weight, capped at doseMaxMg. */
  dosePerKg?: number;
  doseMaxMg?: number;
}

export interface NodeChoice {
  /** Button label, e.g. "Yes — VF/pVT". */
  label: string;
  /** Short qualifier under the label, e.g. "Shockable". */
  sub?: string;
  /** Target node id. */
  to: string;
  /** Log entry recorded when taken, e.g. "Rhythm: shockable". */
  log?: string;
  /** Visual tone of the button. */
  tone?: "danger" | "safe" | "neutral";
}

export interface AlgoNode {
  id: string;
  kind: NodeKind;
  /** Circled step number as printed on the AHA chart (optional). */
  num?: number;
  title: string;
  /** Bullet lines shown on the node card. */
  bullets?: Rich[][];
  /** Decision question (decision nodes). */
  question?: string;
  choices?: NodeChoice[];
  /** Next node for action/loop nodes. */
  next?: string;
  /** Meds that are appropriate at this step (tap-to-log). */
  meds?: MedDose[];
  /** Deeper teaching/detail, expandable in walk mode. */
  detail?: string;
  /** Engine hooks fired when the walker lands on this node. */
  onEnter?: NodeEffect[];
  /** Primary action button label (action nodes), e.g. "Shock delivered". */
  primaryLabel?: string;
  /** Event auto-logged when the primary button advances past this node. */
  primaryEvent?: "shock";
  /** Map layout hint: which column + row of the chart. */
  map?: { col: number; row: number; span?: number };
  /** Cross-reference chip on the map, e.g. "Go to 5". */
  goto?: { label: string; to: string };
}

export type CounterKey =
  | "cpr" | "shock" | "epi" | "amio" | "lido"
  | "bicarb" | "calcium" | "mag" | "naloxone"
  | "atropine" | "adenosine" | "airway" | "access" | "pulse";

export type NodeEffect =
  | { type: "startCprCycle" }          // (re)start the 2-min CPR clock
  | { type: "stopCprCycle" }
  | { type: "suggestRhythmCheck" };    // walker auto-advance target when CPR cycle ends

export interface Algorithm {
  id: string;
  title: string;
  short: string;
  /** Guideline stamp shown in the header. */
  guideline: string;
  entry: string;                        // entry node id
  nodes: Record<string, AlgoNode>;
  /** Whether the full code engine (timers/log bar) runs for this algorithm. */
  codeMode: boolean;
  /** Map column headers, e.g. ["Shockable — VF/pVT", "Nonshockable — Asystole/PEA"]. */
  mapCols?: string[];
  accent: string;                       // CSS color for the hub card
  icon: string;                         // Material Symbols glyph
  blurb: string;
}

/* ── Code session / event log ─────────────────────────────────── */

export interface CodeEvent {
  id: string;
  /** ms since code start */
  t: number;
  /** wall-clock epoch ms */
  at: number;
  type: "start" | "cpr" | "shock" | "med" | "rhythm" | "airway" | "access"
      | "pulse" | "note" | "nav" | "rosc" | "end" | "reminder" | "cause";
  label: string;
  detail?: string;
  /** ordinal for counted events (EPI #2 …) */
  n?: number;
}

export interface CodeSession {
  id: string;
  algoId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: "rosc" | "ended" | null;
  events: CodeEvent[];
  counters: Partial<Record<CounterKey, number>>;
  /** epoch ms when current CPR cycle started (null = no cycle running) */
  cprStartedAt: number | null;
  /** epoch ms of last epinephrine dose */
  lastEpiAt: number | null;
  currentNodeId: string;
  path: string[];
  soundOn: boolean;
  voiceOn: boolean;
  metronomeOn: boolean;
  notes: string;
  /** H's & T's checklist state: cause id -> considered */
  causes: Record<string, boolean>;
}

export const CPR_CYCLE_MS = 120_000;      // 2-minute cycles
export const EPI_WINDOW_OPEN_MS = 180_000; // epi window opens at 3 min
export const EPI_DUE_MS = 300_000;         // epi overdue at 5 min
