"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, BarChart3, BookOpen, Check, ChevronLeft, ChevronRight,
  Calculator, Clock3, ExternalLink, Flag, FlaskConical, FolderOpen, Highlighter, History,
  Database, GripVertical, Image as ImageIcon, Images, ListFilter, Lock, Maximize2, PanelRightOpen, Pause, Play,
  RotateCcw, Search, Shuffle, Sparkles, Trash2, X,
  Share2, Users, Download,
  CheckSquare, MinusSquare, Square, Info,
} from "lucide-react";
import MediaViewer from "@/components/common/MediaViewer";
import { ReferenceLayer, prefetchDocTerms } from "@/components/common/ReferenceLayer";
import QbankHighlightLayer from "@/components/qbank/QbankHighlightLayer";
import SessionLibrary from "@/components/qbank/SessionLibrary";
import { useDarkMode } from "@/components/common/useDarkMode";
import { getBackendUrl } from "@/lib/api";
import { downloadPdf, htmlToPlainText, notifyPdfExport, type PdfQuestion } from "@/lib/exportPdf";
import { useSearchParams } from "next/navigation";
import { recordRecent } from "@/lib/useRecent";
import { useProgression } from "@/lib/activity";
import { isEditableTouchTarget, useMultiTouchSwipe, usePinchZoom, useSwipeGesture, useTrackpadPinch } from "@/lib/useTouchGestures";
import {
  buildQbankReviewStats,
  finalizeQuestionTimers,
  formatQuestionTime,
  moveTimedQuestion,
  normalizeQuestionTiming,
  questionSpentSeconds,
  recordTimedAnswer,
  type QbankFacets,
} from "@/components/qbank/qbankAnalytics";
import {
  parseNbmeKey, predictNbmeScore, scorePercentile, distributionBars,
  SCORE_BUCKETS, SCORE_DISTRIBUTION, PASS_THRESHOLD,
  type ScorePrediction, type UsmleStep,
} from "@/lib/nbmeScore";
import {
  buildQbankActiveTab,
  findQbankResumeSession,
  readQbankSelection,
  writeQbankSelection,
} from "@/lib/qbankWorkspaceState";

// Bank keys are free-form strings resolved by the backend registry: the 3 core
// UWorld banks keep "step{n}"; NBME/CMS forms get "nbme-<step>-<form>" /
// "cms-<subject-slug>-<form>". See /qbank/banks for the catalog.
type DB = string;
type Mode = "home" | "browse" | "quiz" | "results" | "break";
type TestMode = "tutor" | "exam";
type SortMode = "random" | "id" | "difficulty" | "newest";
type PoolKey = "unused" | "incorrect" | "marked" | "all";
type SourceFamily = "uworld" | "amboss";
const QBANK_STATE_API = "/api/qbank";

const POOL_OPTIONS: { key: PoolKey; label: string; hint: string }[] = [
  { key: "unused", label: "Unused", hint: "Not yet seen" },
  { key: "incorrect", label: "Incorrect", hint: "Previously missed" },
  { key: "marked", label: "Marked", hint: "Bookmarked QIDs" },
  { key: "all", label: "All", hint: "Whole bank" },
];

// ─── Bank catalog (from GET /qbank/banks) ───────────────────────────────────
interface BankForm { key: string; label: string; form: string; count: number }
interface BankStep { step: number; key?: string; label?: string; count?: number; forms?: BankForm[] }
interface BankSubject { subject: string; count: number; forms: BankForm[] }
interface BankCategory { id: "uworld" | "nbme" | "cms" | "mehlman" | string; label: string; steps?: BankStep[]; subjects?: BankSubject[]; banks?: BankLeaf[] }
interface BankLeaf { key: string; label: string; count?: number }
interface BankCatalog { categories: BankCategory[] }
interface BankMeta { category: "uworld" | "amboss" | "nbme" | "cms" | "mehlman" | "boardvitals" | "mksap" | "imported"; step?: number | null; subject?: string | null; form?: string | null; label: string }

// New USMLE block format (effective 14 May 2026): ~1.5 min per question
// (20 questions / 30 minutes). Used to seed the timed-block minute slider.
const EXAM_MIN_PER_Q = 1.5;
const examMinutesForCount = (count: number) => Math.max(1, Math.round(count * EXAM_MIN_PER_Q));

interface Subject { id: number; name: string; count: number }
interface System { id: number; name: string; count: number; group_count?: number }
interface MediaItem { name: string; url: string }
interface QBankStats { available: boolean; count: number; valid_count: number }
interface Question {
  id: number;
  source_id?: string;
  source_kind?: string;
  title: string;
  stem: string;
  stem_html?: string;
  choices: string[];
  choices_html?: string[];
  correct: number;
  explanation: string;
  explanation_html?: string;
  subject_id: number;
  system_id: number;
  subject: string;
  system: string;
  system_group: string;
  system_detail: string;
  tags: string[];
  media: MediaItem[];
  answer_stats?: { taken?: number; correct?: number; percent_correct?: number | null };
  quality?: { valid: boolean; answer_count: number; issues: string[] };
  parentQId?: number | null;
  questionType?: number | null;
  explanation_media?: MediaItem[];
}
const questionDisplayId = (question: Question) => question.source_id || String(question.id);
interface TagHit { tag: string; count: number }
interface ToolSearchHit { id: string | number; title: string; subtitle: string; href: string; scope: string; kind: string; score: number }
type ToolTab = "search" | "labs" | "images" | "article";
interface LabValue { name: string; conventional: string; si: string }
interface LabGroup { title: string; subtitle: string; values: LabValue[] }
type ExamLabTabId = "serum" | "csf" | "blood" | "urine";
interface ExamLabRow { kind?: "section"; name: string; conventional?: string; si?: string; indent?: boolean }
interface ExamLabTab { id: ExamLabTabId; label: string; heading: string; rows: ExamLabRow[] }
interface ArticleFrame {
  title: string;
  url: string;
  nativeUrl: string;
  source: "amboss" | "utd" | "article" | "uworld-library";
}
interface RelatedArticle {
  source: "amboss" | "uworld-library";
  docId: number;
  title: string;
  url: string;
}
/** One cross-database article that mentions a concept (from /umls/concept/{cui}/mentions). */
interface ConceptMention {
  source: string;
  source_id: string;
  title: string;
  href: string;
  kind?: string;
  subtitle?: string;
}
export interface Session {
  id: string;
  db: DB;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  transient?: boolean;
  mode: TestMode;
  trackedPrep?: boolean;
  /** Built from every question matching the filters (not a fixed 1-100 block). */
  allMatched?: boolean;
  filters: {
    subject: string;
    systemGroup: string;
    system: string;
    query: string;
    tag: string;
    sort: SortMode;
    systems?: number[];
    systemNames?: string[];
    subjects?: number[];
    subjectNames?: string[];
    pool?: PoolKey;
    imagesOnly?: boolean;
  };
  questions: Question[];
  current: number;
  answers: Record<number, number>;
  revealed: Record<number, boolean>;
  marked?: Record<number, boolean>;
  eliminated?: Record<number, Record<number, boolean>>;
  notes?: Record<number, string>;
  answerMeta?: Record<number, AnswerMeta>;
  questionStartedAt?: Record<number, string>;
  questionTimeSec?: Record<number, number>;
  activity?: SessionActivity[];
  parentSessionId?: string;
  blockLabel?: string;
  timeRemainingSec?: number;
  examTimeRemainingSec?: number;
  examTotalSec?: number;       // full timed-block duration (new USMLE format is user-chosen)
  timerSavedAt?: string;
  examPaused?: boolean;
  examLocked?: boolean;
  // Multi-block NBME exam run linkage (see ExamRun). A block Session belongs to
  // an exam when examId is set.
  examId?: string;
  examBlockIndex?: number;   // 0-based position in the exam
  examBlockCount?: number;
  examBlockLabel?: string;   // e.g. "Block 1" or the NBME subject name
}
type UsedQbankProgress = Record<DB, number[]>;

// A full multi-block NBME exam: an ordered set of timed block Sessions taken
// back-to-back with break screens between them. Persisted separately so a crash
// / reload resumes the exact block, question, and timer.
interface ExamRun {
  id: string;
  db: DB;
  label: string;
  structure: "native" | "chunked";   // native = the form's own Block 1-4; chunked = 20-Q blocks
  blockCount: number;
  currentBlock: number;               // index of the in-progress / just-finished block
  blocks: Session[];                  // full block Sessions, in order (self-contained for recovery)
  phase: "block" | "break" | "done";
  endedEarly?: boolean;               // true when the run was ended before all blocks finished
  breakRemainingSec?: number;
  breakTotalSec?: number;
  breakSavedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface AnswerMeta {
  qid: number;
  questionIndex: number;
  choiceIndex: number;
  correctIndex: number;
  answeredAt: string;
  elapsedSec: number;
  spentSec?: number;
  remainingSec?: number;
  mode: TestMode;
}

interface SessionActivity {
  event: "start" | "answer" | "reveal" | "mark" | "unmark" | "finish" | "regenerate" | "resume";
  qid?: number;
  questionIndex?: number;
  answeredChoice?: number;
  correctChoice?: number;
  elapsedSec?: number;
  remainingSec?: number;
  createdAt: string;
  detail?: string;
}

interface QBankBackendState {
  sessions?: Session[];
  usedIdsByDb?: UsedQbankProgress;
  markedIdsByDb?: UsedQbankProgress;
  trackingPref?: boolean;
  trackingPrefStored?: boolean;
  storage?: string;
}

// Fallback labels for the 3 core UWorld banks; NBME/CMS labels come from the
// fetched catalog (see bankLabel()).
const DB_LABELS: Record<string, string> = { step1: "UWorld STEP 1", step2: "UWorld STEP 2", step3: "UWorld STEP 3", amboss1: "AMBOSS Step 1", amboss2: "AMBOSS Step 2 CK", amboss3: "AMBOSS Step 3" };
const DB_OPTIONS: DB[] = ["step1", "step2", "step3"];
type StudyStepPref = "1" | "2" | "3";
const MEDOS_SETTINGS_KEY = "medos.settings.v1";
const dbForStudyStep = (step: StudyStepPref) => `step${step}`;
const dbForSourceFamily = (family: SourceFamily, step: StudyStepPref) => family === "amboss" ? `amboss${step}` : dbForStudyStep(step);
function alignBankToStudyStep(current: string, step: StudyStepPref) {
  if (/^amboss[123]$/.test(current)) return `amboss${step}`;
  if (/^step[123]$/.test(current)) return dbForStudyStep(step);
  return current;
}

function dailyBankMeta(key: string): BankMeta | null {
  if (key === "mksap19") return { category: "mksap", label: "MKSAP 19" };
  if (/^boardvitals-/i.test(key)) return { category: "boardvitals", label: prettyDbLabel(key) };
  if (key === "amboss-abim-2025") {
    return { category: "amboss", label: "AMBOSS Internal Medicine (ABIM) 2025" };
  }
  if (key === "uworld-abim-2026-march") {
    return { category: "uworld", label: "UWorld Internal Medicine (ABIM) 2026" };
  }
  const stepMatch = /^step([123])$/.exec(key);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    return { category: "uworld", step, label: DB_LABELS[key] || `UWorld STEP ${step}` };
  }
  const ambossMatch = /^amboss([123])$/.exec(key);
  if (ambossMatch) {
    const step = Number(ambossMatch[1]);
    return { category: "amboss", step, label: DB_LABELS[key] || `AMBOSS Step ${step}` };
  }
  return null;
}

function readStudyStepPreference(): StudyStepPref {
  if (typeof window === "undefined") return "2";
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MEDOS_SETTINGS_KEY) || "null") as { studyStep?: string } | null;
    if (parsed?.studyStep === "1" || parsed?.studyStep === "2" || parsed?.studyStep === "3") return parsed.studyStep;
  } catch {
    // fall through to legacy preference/default
  }
  const legacy = window.localStorage.getItem("medos.studyStep.v1");
  return legacy === "1" || legacy === "2" || legacy === "3" ? legacy : "2";
}

function isDailyQbankDb(value: string) {
  return /^step[123]$/.test(value)
    || /^amboss[123]$/.test(value)
    || value === "amboss-abim-2025"
    || value === "uworld-abim-2026-march";
}

function isDirectSourceQbankDb(value: string) {
  return value === "mksap19"
    || /^boardvitals-/i.test(value)
    || value === "amboss-abim-2025"
    || value === "uworld-abim-2026-march";
}

function directSourceCategory(value: string) {
  if (value === "mksap19") return "mksap";
  if (/^boardvitals-/i.test(value)) return "boardvitals";
  if (value === "amboss-abim-2025" || value === "uworld-abim-2026-march") return "abim";
  return null;
}

function isAmbossDb(value: string) {
  return /^amboss/.test(value || "");
}

// Distinct point/line colors per bank family so a mixed AMBOSS + UWorld history
// reads clearly on the Performance-by-test graph.
function bankGraphColor(db: string | undefined) {
  return isAmbossDb(db || "") ? "#7c3aed" : "#059669";
}

// Human label for any bank key, derived without needing the catalog (used in
// callbacks/headers where only the db key is on hand).
function prettyDbLabel(db: string): string {
  if (DB_LABELS[db]) return DB_LABELS[db];
  if (db === "mksap19") return "MKSAP 19";
  if (db === "amboss-abim-2025") return "AMBOSS Internal Medicine (ABIM) 2025";
  if (db === "uworld-abim-2026-march") return "UWorld Internal Medicine (ABIM) 2026";
  if (/^boardvitals-/i.test(db)) {
    const years = db.match(/(?:19|20)\d{2}/g);
    return years?.length ? `BoardVitals ${years[years.length - 1]}` : "BoardVitals";
  }
  let m = /^nbme-([123])-(.+)$/.exec(db);
  if (m) return `NBME Step ${m[1]} · Form ${m[2]}`;
  m = /^cms-(.+)-([^-]+)$/.exec(db);
  if (m) {
    const subject = m[1].split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    return `${subject} · Form ${m[2]}`;
  }
  if (/^mehlman-/i.test(db)) return "Mehlman " + db.slice("mehlman-".length).replace(/-/g, " · ");
  return db;
}
const STORAGE_KEY = "medos.qbank.sessions.v2";
const USED_QIDS_KEY = "medos.qbank.usedQuestionIds.v1";
const TRACKING_PREF_KEY = "medos.qbank.prepTracking.v1";
const MARKED_QIDS_KEY = "medos.qbank.markedQuestionIds.v1";
const EXAM_TIMERS_KEY = "medos.qbank.examTimers.v1";
const EXAM_RUN_KEY = "medos.qbank.examRun.v1";
const EXAM_HISTORY_KEY = "medos.qbank.examHistory.v1";
const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
const EXAM_BLOCK_SECONDS = 60 * 60;
// Break length between exam blocks: a short pause for chunked 20-Q blocks, a
// longer one between the larger native NBME blocks. The user can start early.
const EXAM_BREAK_SECONDS = { native: 5 * 60, chunked: 60 };

const TOPIC_QUERY: Record<string, string> = {
  cardiology: "Cardiovascular",
  cardio: "Cardiovascular",
  pulmonology: "Pulmonary",
  pulmonary: "Pulmonary",
  nephrology: "Renal",
  renal: "Renal",
  gi: "Gastrointestinal",
  gastroenterology: "Gastrointestinal",
  hepatology: "Hepatology",
  neurology: "Neurology",
  neuro: "Neurology",
  endocrine: "Endocrine",
  endocrinology: "Endocrine",
  hematology: "Hematology",
  heme: "Hematology",
  id: "Infectious",
  infectious: "Infectious",
  obgyn: "Obstetrics",
  obstetrics: "Obstetrics",
  gynecology: "Gynecology",
  psych: "Psychiatry",
  psychiatry: "Psychiatry",
  biostats: "Biostatistics",
  biostatistics: "Biostatistics",
  derm: "Dermatology",
  dermatology: "Dermatology",
};

const shell: React.CSSProperties = { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg-base)" };
const page: React.CSSProperties = { flex: 1, overflow: "auto", padding: "24px 28px" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const LAB_GROUPS: LabGroup[] = [
  {
    title: "Serum",
    subtitle: "Chemistry, liver, lipids, iron, endocrine, immunoglobulins",
    values: [
      { name: "Sodium (Na+)", conventional: "136-146 mEq/L", si: "136-146 mmol/L" },
      { name: "Potassium (K+)", conventional: "3.5-5.0 mEq/L", si: "3.5-5.0 mmol/L" },
      { name: "Chloride (Cl-)", conventional: "95-105 mEq/L", si: "95-105 mmol/L" },
      { name: "Bicarbonate (HCO3-)", conventional: "22-28 mEq/L", si: "22-28 mmol/L" },
      { name: "Urea nitrogen", conventional: "7-18 mg/dL", si: "2.5-6.4 mmol/L" },
      { name: "Creatinine", conventional: "0.6-1.2 mg/dL", si: "53-106 umol/L" },
      { name: "Glucose, fasting", conventional: "70-100 mg/dL", si: "3.8-5.6 mmol/L" },
      { name: "Glucose, random", conventional: "<140 mg/dL", si: "<7.77 mmol/L" },
      { name: "Calcium", conventional: "8.4-10.2 mg/dL", si: "2.1-2.6 mmol/L" },
      { name: "Magnesium", conventional: "1.5-2.0 mg/dL", si: "0.75-1.0 mmol/L" },
      { name: "Phosphorus", conventional: "3.0-4.5 mg/dL", si: "1.0-1.5 mmol/L" },
      { name: "ALT", conventional: "10-40 U/L", si: "10-40 U/L" },
      { name: "AST", conventional: "12-38 U/L", si: "12-38 U/L" },
      { name: "Alkaline phosphatase", conventional: "25-100 U/L", si: "25-100 U/L" },
      { name: "Bilirubin, total / direct", conventional: "0.1-1.0 / 0.0-0.3 mg/dL", si: "2-17 / 0-5 umol/L" },
      { name: "Albumin", conventional: "3.5-5.5 g/dL", si: "35-55 g/L" },
      { name: "Total cholesterol", conventional: "Normal <200 mg/dL; high >240 mg/dL", si: "<5.2; >6.2 mmol/L" },
      { name: "HDL / LDL", conventional: "40-60 / <160 mg/dL", si: "1.0-1.6 / <4.2 mmol/L" },
      { name: "Triglycerides", conventional: "Normal <150; borderline 151-199 mg/dL", si: "<1.70; 1.71-2.25 mmol/L" },
      { name: "Ferritin, male / female", conventional: "20-250 / 10-120 ng/mL", si: "20-250 / 10-120 ug/L" },
      { name: "Iron, male / female", conventional: "65-175 / 50-170 ug/dL", si: "11.6-31.3 / 9.0-30.4 umol/L" },
      { name: "TSH", conventional: "0.4-4.0 uU/mL", si: "0.4-4.0 mIU/L" },
      { name: "Free T4", conventional: "0.9-1.7 ng/dL", si: "12.0-21.9 pmol/L" },
      { name: "Intact PTH", conventional: "10-60 pg/mL", si: "10-60 ng/L" },
      { name: "IgA / IgG / IgM", conventional: "76-390 / 650-1500 / 50-300 mg/dL", si: "0.76-3.90 / 6.5-15.0 / 0.5-3.0 g/L" },
    ],
  },
  {
    title: "Blood Gases & CSF",
    subtitle: "Arterial blood on room air plus cerebrospinal fluid",
    values: [
      { name: "Po2", conventional: "75-105 mm Hg", si: "10.0-14.0 kPa" },
      { name: "Pco2", conventional: "33-45 mm Hg", si: "4.4-5.9 kPa" },
      { name: "pH", conventional: "7.35-7.45", si: "[H+] 36-44 nmol/L" },
      { name: "CSF cell count", conventional: "0-5/mm3", si: "0-5 x 10^6/L" },
      { name: "CSF chloride", conventional: "118-132 mEq/L", si: "118-132 mmol/L" },
      { name: "CSF glucose", conventional: "40-70 mg/dL", si: "2.2-3.9 mmol/L" },
      { name: "CSF pressure", conventional: "70-180 mm H2O", si: "70-180 mm H2O" },
      { name: "CSF protein, total", conventional: "<40 mg/dL", si: "<0.40 g/L" },
    ],
  },
  {
    title: "Hematologic & Coagulation",
    subtitle: "CBC, differential, red cell indices, coagulation",
    values: [
      { name: "Hematocrit, male / female", conventional: "41%-53% / 36%-46%", si: "0.41-0.53 / 0.36-0.46" },
      { name: "Hemoglobin, male / female", conventional: "13.5-17.5 / 12.0-16.0 g/dL", si: "135-175 / 120-160 g/L" },
      { name: "MCV", conventional: "80-100 um3", si: "80-100 fL" },
      { name: "MCH", conventional: "25-35 pg/cell", si: "0.39-0.54 fmol/cell" },
      { name: "MCHC", conventional: "31%-36% Hb/cell", si: "4.8-5.6 mmol Hb/L" },
      { name: "Leukocyte count (WBC)", conventional: "4500-11,000/mm3", si: "4.5-11.0 x 10^9/L" },
      { name: "Neutrophils, segmented / bands", conventional: "54%-62% / 3%-5%", si: "0.54-0.62 / 0.03-0.05" },
      { name: "Lymphocytes / monocytes", conventional: "25%-33% / 3%-7%", si: "0.25-0.33 / 0.03-0.07" },
      { name: "Eosinophils / basophils", conventional: "1%-3% / 0%-0.75%", si: "0.01-0.03 / 0.00-0.0075" },
      { name: "Platelet count", conventional: "150,000-400,000/mm3", si: "150-400 x 10^9/L" },
      { name: "PTT/aPTT", conventional: "25-40 seconds", si: "25-40 seconds" },
      { name: "PT", conventional: "11-15 seconds", si: "11-15 seconds" },
      { name: "D-dimer", conventional: "<=250 ng/mL", si: "<=1.4 nmol/L" },
      { name: "Reticulocyte count", conventional: "0.5%-1.5%", si: "0.005-0.015" },
      { name: "RBC, male / female", conventional: "4.3-5.9 / 3.5-5.5 million/mm3", si: "4.3-5.9 / 3.5-5.5 x 10^12/L" },
      { name: "ESR, male / female", conventional: "0-15 / 0-20 mm/h", si: "0-15 / 0-20 mm/h" },
      { name: "CD4+ T-lymphocyte count", conventional: ">=500/mm3", si: ">=0.5 x 10^9/L" },
      { name: "Hemoglobin A1c", conventional: "<=6%", si: "<=42 mmol/mol" },
    ],
  },
  {
    title: "Urine & Body Measures",
    subtitle: "Urine studies and BMI",
    values: [
      { name: "Urine calcium", conventional: "100-300 mg/24 h", si: "2.5-7.5 mmol/24 h" },
      { name: "Urine osmolality", conventional: "50-1200 mOsmol/kg H2O", si: "50-1200 mOsmol/kg H2O" },
      { name: "Urine oxalate", conventional: "8-40 ug/mL", si: "90-445 umol/L" },
      { name: "Urine proteins, total", conventional: "<150 mg/24 h", si: "<0.15 g/24 h" },
      { name: "BMI, adult", conventional: "19-25 kg/m2", si: "19-25 kg/m2" },
    ],
  },
];

const EXAM_LAB_TABS: ExamLabTab[] = [
  {
    id: "serum",
    label: "Serum",
    heading: "Serum",
    rows: [
      { name: "Alanine aminotransferase (ALT)", conventional: "10–40 U/L", si: "10–40 U/L" },
      { name: "Aspartate aminotransferase (AST)", conventional: "12–38 U/L", si: "12–38 U/L" },
      { name: "Alkaline phosphatase", conventional: "25–100 U/L", si: "25–100 U/L" },
      { name: "Amylase", conventional: "25–125 U/L", si: "25–125 U/L" },
      { name: "Bilirubin, total // direct", conventional: "0.1–1.0 mg/dL // 0.0–0.3 mg/dL", si: "2–17 µmol/L // 0–5 µmol/L" },
      { name: "Calcium", conventional: "8.4–10.2 mg/dL", si: "2.1–2.6 mmol/L" },
      { kind: "section", name: "Cholesterol" },
      { name: "Total", conventional: "Normal: <200 mg/dL // High: >240 mg/dL", si: "<5.2 mmol/L // >6.2 mmol/L", indent: true },
      { name: "HDL", conventional: "40–60 mg/dL", si: "1.0–1.6 mmol/L", indent: true },
      { name: "LDL", conventional: "<160 mg/dL", si: "<4.2 mmol/L", indent: true },
      { name: "Triglycerides", conventional: "Normal: <150 mg/dL // Borderline: 151–199 mg/dL", si: "<1.70 mmol/L // 1.71–2.25 mmol/L" },
      { name: "Cortisol", conventional: "0800 h: 5–23 µg/dL // 1600 h: 3–15 µg/dL\n2000 h: <50% of 0800 h", si: "138–635 nmol/L // 82–413 nmol/L\nFraction of 0800 h: <0.50" },
      { name: "Creatine kinase", conventional: "Male: 25–90 U/L\nFemale: 10–70 U/L", si: "25–90 U/L\n10–70 U/L" },
      { name: "Creatinine", conventional: "0.6–1.2 mg/dL", si: "53–106 µmol/L" },
      { name: "Urea nitrogen", conventional: "7–18 mg/dL", si: "2.5–6.4 mmol/L" },
      { name: "Creatinine clearance", conventional: "Male: 97–137 mL/min\nFemale: 88–128 mL/min", si: "97–137 mL/min\n88–128 mL/min" },
      { kind: "section", name: "Electrolytes, serum" },
      { name: "Sodium (Na+)", conventional: "136–146 mEq/L", si: "136–146 mmol/L", indent: true },
      { name: "Potassium (K+)", conventional: "3.5–5.0 mEq/L", si: "3.5–5.0 mmol/L", indent: true },
      { name: "Chloride (Cl−)", conventional: "95–105 mEq/L", si: "95–105 mmol/L", indent: true },
      { name: "Bicarbonate (HCO3−)", conventional: "22–28 mEq/L", si: "22–28 mmol/L", indent: true },
      { name: "Magnesium (Mg2+)", conventional: "1.5–2.0 mg/dL", si: "0.75–1.0 mmol/L", indent: true },
      { name: "Ferritin", conventional: "Male: 20–250 ng/mL\nFemale: 10–120 ng/mL", si: "20–250 µg/L\n10–120 µg/L" },
      { name: "Follicle-stimulating hormone", conventional: "Male: 4–25 mIU/mL\nFemale: premenopause 4–30 mIU/mL\nmidcycle peak 10–90 mIU/mL\npostmenopause 40–250 mIU/mL", si: "4–25 U/L\n4–30 U/L\n10–90 U/L\n40–250 U/L" },
      { name: "Glucose", conventional: "Fasting: 70–100 mg/dL\nRandom, non-fasting: <140 mg/dL", si: "3.8–5.6 mmol/L\n<7.77 mmol/L" },
      { name: "Growth hormone - arginine stimulation", conventional: "Fasting: <5 ng/mL\nProvocative stimuli: >7 ng/mL", si: "<5 µg/L\n>7 µg/L" },
      { name: "Iron", conventional: "Male: 65–175 µg/dL\nFemale: 50–170 µg/dL", si: "11.6–31.3 µmol/L\n9.0–30.4 µmol/L" },
      { name: "Total iron-binding capacity", conventional: "250–400 µg/dL", si: "44.8–71.6 µmol/L" },
      { name: "Transferrin", conventional: "200–360 mg/dL", si: "2.0–3.6 g/L" },
      { name: "Lactate dehydrogenase", conventional: "45–200 U/L", si: "45–200 U/L" },
      { name: "Lipase", conventional: "13–60 U/L", si: "13–60 U/L" },
      { name: "Luteinizing hormone", conventional: "Male: 6–23 mIU/mL\nFemale: follicular phase 5–30 mIU/mL\nmidcycle 75–150 mIU/mL\npostmenopause 30–200 mIU/mL", si: "6–23 U/L\n5–30 IU/L\n75–150 IU/L\n30–200 IU/L" },
      { name: "Osmolality", conventional: "275–295 mOsmol/kg H2O", si: "275–295 mOsmol/kg H2O" },
      { name: "Intact parathyroid hormone (PTH)", conventional: "10–60 pg/mL", si: "10–60 ng/L" },
      { name: "Phosphorus (inorganic)", conventional: "3.0–4.5 mg/dL", si: "1.0–1.5 mmol/L" },
      { name: "Prolactin (hPRL)", conventional: "Male: <17 ng/mL\nFemale: <25 ng/mL", si: "<17 µg/L\n<25 µg/L" },
      { kind: "section", name: "Proteins" },
      { name: "Total", conventional: "6.0–7.8 g/dL", si: "60–78 g/L", indent: true },
      { name: "Albumin", conventional: "3.5–5.5 g/dL", si: "35–55 g/L", indent: true },
      { name: "Globulin", conventional: "2.3–3.5 g/dL", si: "23–35 g/L", indent: true },
      { name: "Troponin I", conventional: "≤0.04 ng/mL", si: "≤0.04 µg/L" },
      { name: "TSH", conventional: "0.4–4.0 μU/mL", si: "0.4–4.0 mIU/L" },
      { name: "Thyroidal iodine (123I) uptake", conventional: "8%–30% of administered dose/24 h", si: "0.08–0.30/24 h" },
      { name: "Thyroxine (T4)", conventional: "5–12 µg/dL", si: "64–155 nmol/L" },
      { name: "Free T4", conventional: "0.9–1.7 ng/dL", si: "12.0–21.9 pmol/L" },
      { name: "Triiodothyronine (T3) (RIA)", conventional: "100–200 ng/dL", si: "1.5–3.1 nmol/L" },
      { name: "Triiodothyronine (T3) resin uptake", conventional: "25%–35%", si: "0.25–0.35" },
      { name: "Uric acid", conventional: "3.0–8.2 mg/dL", si: "0.18–0.48 mmol/L" },
      { kind: "section", name: "Immunoglobulins" },
      { name: "IgA", conventional: "76–390 mg/dL", si: "0.76–3.90 g/L", indent: true },
      { name: "IgE", conventional: "0–380 IU/mL", si: "0–380 kIU/L", indent: true },
      { name: "IgG", conventional: "650–1500 mg/dL", si: "6.5–15.0 g/L", indent: true },
      { name: "IgM", conventional: "50–300 mg/dL", si: "0.5–3.0 g/L", indent: true },
      { kind: "section", name: "Gases, arterial blood (room air)" },
      { name: "pH", conventional: "7.35–7.45", si: "[H+] 36–44 nmol/L", indent: true },
      { name: "Pco2", conventional: "33–45 mm Hg", si: "4.4–5.9 kPa", indent: true },
      { name: "Po2", conventional: "75–105 mm Hg", si: "10.0–14.0 kPa", indent: true },
    ],
  },
  {
    id: "csf",
    label: "Cerebrospinal",
    heading: "Cerebrospinal Fluid",
    rows: [
      { name: "Cell count", conventional: "0–5/mm3", si: "0–5 x 106/L" },
      { name: "Chloride", conventional: "118–132 mEq/L", si: "118–132 mmol/L" },
      { name: "Gamma globulin", conventional: "3%–12% total proteins", si: "0.03–0.12" },
      { name: "Glucose", conventional: "40–70 mg/dL", si: "2.2–3.9 mmol/L" },
      { name: "Pressure", conventional: "70–180 mm H2O", si: "70–180 mm H2O" },
      { name: "Proteins, total", conventional: "<40 mg/dL", si: "<0.40 g/L" },
    ],
  },
  {
    id: "blood",
    label: "Blood",
    heading: "Hematologic",
    rows: [
      { name: "Erythrocyte count (RBC)", conventional: "Male: 4.3–5.9 million/mm3\nFemale: 3.5–5.5 million/mm3", si: "4.3–5.9 x 1012/L\n3.5–5.5 x 1012/L" },
      { name: "Erythrocyte sedimentation rate (Westergren)", conventional: "Male: 0–15 mm/h\nFemale: 0–20 mm/h", si: "0–15 mm/h\n0–20 mm/h" },
      { name: "Hematocrit", conventional: "Male: 41%–53%\nFemale: 36%–46%", si: "0.41–0.53\n0.36–0.46" },
      { name: "Hemoglobin, blood", conventional: "Male: 13.5–17.5 g/dL\nFemale: 12.0–16.0 g/dL", si: "135–175 g/L\n120–160 g/L" },
      { name: "Hemoglobin A1c", conventional: "≤6%", si: "≤42 mmol/mol" },
      { name: "Leukocyte count (WBC)", conventional: "4500–11,000/mm3", si: "4.5–11.0 x 109/L" },
      { name: "Neutrophils, segmented", conventional: "54%–62%", si: "0.54–0.62" },
      { name: "Neutrophils, bands", conventional: "3%–5%", si: "0.03–0.05" },
      { name: "Eosinophils", conventional: "1%–3%", si: "0.01–0.03" },
      { name: "Basophils", conventional: "0%–0.75%", si: "0.00–0.0075" },
      { name: "Lymphocytes", conventional: "25%–33%", si: "0.25–0.33" },
      { name: "Monocytes", conventional: "3%–7%", si: "0.03–0.07" },
      { name: "CD4+ T-lymphocyte count", conventional: "≥500/mm3", si: "≥0.5 x 109/L" },
      { name: "Platelet count", conventional: "150,000–400,000/mm3", si: "150–400 x 109/L" },
      { name: "Reticulocyte count", conventional: "0.5%–1.5%", si: "0.005–0.015" },
      { name: "D-Dimer", conventional: "≤250 ng/mL", si: "≤1.4 nmol/L" },
      { name: "Partial thromboplastin time (aPTT) (activated)", conventional: "25–40 seconds", si: "25–40 seconds" },
      { name: "Prothrombin time (PT)", conventional: "11–15 seconds", si: "11–15 seconds" },
      { name: "Mean corpuscular hemoglobin (MCH)", conventional: "25–35 pg/cell", si: "0.39–0.54 fmol/cell" },
      { name: "Mean corpuscular hemoglobin concentration (MCHC)", conventional: "31%–36% Hb/cell", si: "4.8–5.6 mmol Hb/L" },
      { name: "Mean corpuscular volume (MCV)", conventional: "80–100 µm3", si: "80–100 fL" },
      { kind: "section", name: "Volume" },
      { name: "Plasma", conventional: "Male: 25–43 mL/kg\nFemale: 28–45 mL/kg", si: "0.025–0.043 L/kg\n0.028–0.045 L/kg", indent: true },
      { name: "Red cell", conventional: "Male: 20–36 mL/kg\nFemale: 19–31 mL/kg", si: "0.020–0.036 L/kg\n0.019–0.031 L/kg", indent: true },
    ],
  },
  {
    id: "urine",
    label: "Urine/BMI",
    heading: "Urine",
    rows: [
      { name: "Calcium", conventional: "100–300 mg/24 h", si: "2.5–7.5 mmol/24 h" },
      { name: "Osmolality", conventional: "50–1200 mOsmol/kg H2O", si: "50–1200 mOsmol/kg H2O" },
      { name: "Oxalate", conventional: "8–40 µg/mL", si: "90–445 µmol/L" },
      { name: "Proteins, total", conventional: "<150 mg/24 h", si: "<0.15 g/24 h" },
      { name: "17-Hydroxycorticosteroids", conventional: "Male: 3.0–10.0 mg/24 h\nFemale: 2.0–8.0 mg/24 h", si: "8.2–27.6 µmol/24 h\n5.5–22.0 µmol/24 h" },
      { name: "17-Ketosteroids, total", conventional: "Male: 8–20 mg/24 h\nFemale: 6–15 mg/24 h", si: "28–70 µmol/24 h\n21–52 µmol/24 h" },
      { kind: "section", name: "Body Mass Index (BMI)" },
      { name: "Adult", conventional: "19–25 kg/m2", si: "", indent: true },
    ],
  },
];

function isReferenceSession(session: Session) {
  return session.questions.length === 1 && /^QID \d+$/i.test(session.filters.query || "");
}

function hasChoicesHtml(question: Question) {
  return Array.isArray(question.choices_html) && question.choices_html.length === question.choices.length;
}

function shouldPersistExplanationHtml(session: Session, index: number) {
  return Boolean(session.mode === "tutor" && (session.completedAt || session.revealed[index] || session.answers[index] !== undefined));
}

function missingExplanationQidsForPrefetch(session: Session) {
  const missingQids = session.questions
    .filter(q => !q.explanation_html)
    .map(q => q.id);
  const currentQid = session.questions[session.current]?.id;
  if (!currentQid || !missingQids.includes(currentQid)) return missingQids;
  return [currentQid, ...missingQids.filter(qid => qid !== currentQid)];
}

function normalizeExamRemaining(seconds: number | undefined, totalSec: number = EXAM_BLOCK_SECONDS) {
  return clampNumber(Math.floor(seconds ?? totalSec), 0, Math.max(1, totalSec));
}

function loadExamTimerSnapshot(sessionId: string | undefined) {
  if (typeof window === "undefined" || !sessionId) return undefined;
  try {
    const timers = JSON.parse(window.localStorage.getItem(EXAM_TIMERS_KEY) || "{}") as Record<string, unknown>;
    const value = Number(timers[sessionId]);
    // Return the raw remaining seconds; the caller clamps against the block's own
    // total (blocks can exceed 60 min, so we must NOT clamp to EXAM_BLOCK_SECONDS here).
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
  } catch {
    return undefined;
  }
}

function saveExamTimerSnapshot(session: Session) {
  if (typeof window === "undefined" || !session.id || session.completedAt) return;
  const value = session.timeRemainingSec ?? session.examTimeRemainingSec;
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  try {
    const timers = JSON.parse(window.localStorage.getItem(EXAM_TIMERS_KEY) || "{}") as Record<string, number>;
    timers[session.id] = Math.max(0, Math.floor(value));
    window.localStorage.setItem(EXAM_TIMERS_KEY, JSON.stringify(timers));
  } catch {
    // Session storage remains the primary persistence path.
  }
}

function stripQuestionExplanation(question: Question): Question {
  return { ...question, explanation: "", explanation_html: undefined, explanation_media: undefined };
}

function questionsForMode(questions: Question[], mode: TestMode, completed = false): Question[] {
  // Strip explanations during a LIVE exam block (no peeking). Once the block is
  // completed, keep them so the exam review can show the correct answer + rationale.
  return mode === "exam" && !completed ? questions.map(stripQuestionExplanation) : questions;
}

function normalizeSession(session: Session): Session {
  const rawMode = typeof session.mode === "string" ? session.mode.toLowerCase() : "";
  const normalizedMode: TestMode = rawMode === "exam" || rawMode === "timed" ? "exam" : "tutor";
  const rawExamRemaining = session.timeRemainingSec ?? session.examTimeRemainingSec ?? loadExamTimerSnapshot(session.id);
  const hasExamTimer = !session.completedAt && (normalizedMode === "exam" || typeof rawExamRemaining === "number");
  const examPaused = normalizedMode === "exam" && !session.completedAt && Boolean(session.examPaused);
  const normalizedRemaining = hasExamTimer ? normalizeExamRemaining(rawExamRemaining, session.examTotalSec ?? EXAM_BLOCK_SECONDS) : undefined;
  const normalizedQuestions = questionsForMode(session.questions || [], normalizedMode, Boolean(session.completedAt));
  const normalized = {
    ...session,
    mode: normalizedMode,
    questions: normalizedQuestions,
    trackedPrep: session.trackedPrep ?? true,
    marked: session.marked || {},
    eliminated: session.eliminated || {},
    notes: session.notes || {},
    answerMeta: session.answerMeta || {},
    questionStartedAt: session.questionStartedAt || {},
    questionTimeSec: session.questionTimeSec || {},
    activity: Array.isArray(session.activity) ? session.activity.slice(-1000) : [],
    timeRemainingSec: normalizedRemaining ?? session.timeRemainingSec,
    examTimeRemainingSec: normalizedRemaining ?? session.examTimeRemainingSec,
    timerSavedAt: hasExamTimer ? (session.timerSavedAt || session.updatedAt || session.createdAt) : session.timerSavedAt,
    examPaused,
    examLocked: normalizedMode === "exam" && !session.completedAt && !examPaused && Boolean(session.examLocked),
  };
  return normalizeQuestionTiming(normalized);
}

function sessionElapsedSec(session: Session, at = new Date().toISOString()) {
  const started = Date.parse(session.createdAt || at);
  const now = Date.parse(at);
  if (!Number.isFinite(started) || !Number.isFinite(now) || now < started) return 0;
  return Math.round((now - started) / 1000);
}

function appendSessionActivity(session: Session, event: SessionActivity): Session {
  return {
    ...session,
    activity: [...(session.activity || []), event].slice(-1000),
  };
}

function withExamTimerState(session: Session, state: Partial<Pick<Session, "mode" | "examPaused" | "examLocked" | "timeRemainingSec">> = {}) {
  const now = new Date().toISOString();
  const remaining = state.timeRemainingSec ?? session.timeRemainingSec ?? session.examTimeRemainingSec ?? loadExamTimerSnapshot(session.id);
  const nextPaused = Boolean(state.examPaused);
  const normalizedRemaining = normalizeExamRemaining(remaining, session.examTotalSec ?? EXAM_BLOCK_SECONDS);
  return normalizeSession({
    ...session,
    ...state,
    mode: state.mode ?? session.mode,
    updatedAt: now,
    timeRemainingSec: normalizedRemaining,
    examTimeRemainingSec: normalizedRemaining,
    timerSavedAt: now,
    examPaused: nextPaused,
    examLocked: nextPaused ? false : Boolean(state.examLocked),
  });
}

function initialExamFields(mode: TestMode, now: string, totalSec: number = EXAM_BLOCK_SECONDS): Pick<Session, "timeRemainingSec" | "examTimeRemainingSec" | "examTotalSec" | "timerSavedAt" | "examPaused" | "examLocked"> {
  return mode === "exam"
    ? { timeRemainingSec: totalSec, examTimeRemainingSec: totalSec, examTotalSec: totalSec, timerSavedAt: now, examPaused: false, examLocked: false }
    : { timeRemainingSec: undefined, examTimeRemainingSec: undefined, examTotalSec: undefined, timerSavedAt: undefined, examPaused: false, examLocked: false };
}

function formatExamTime(seconds: number | undefined, totalSec: number = EXAM_BLOCK_SECONDS) {
  const safe = normalizeExamRemaining(seconds, totalSec);
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatShortDate(value: string | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function summarizeFilters(session: Session) {
  const bits = [prettyDbLabel(session.db), session.mode === "exam" ? "Exam" : "Tutor"];
  const remaining = session.timeRemainingSec ?? session.examTimeRemainingSec;
  if (session.mode === "tutor" && typeof remaining === "number") bits.push(`Exam timer ${formatExamTime(remaining)}`);
  if (session.trackedPrep === false) bits.push("Practice only");
  if (session.filters.pool && session.filters.pool !== "all") {
    bits.push(session.filters.pool.charAt(0).toUpperCase() + session.filters.pool.slice(1));
  }
  if (session.filters.query) bits.push(`"${session.filters.query}"`);
  if (session.filters.tag) bits.push(session.filters.tag);
  if (session.filters.imagesOnly) bits.push("Images only");
  const subjectNames = session.filters.subjectNames;
  if (subjectNames && subjectNames.length) {
    bits.push(subjectNames.length <= 2 ? subjectNames.join(", ") : `${subjectNames.length} subjects`);
  }
  const sysNames = session.filters.systemNames;
  if (sysNames && sysNames.length) {
    bits.push(sysNames.length <= 2 ? sysNames.join(", ") : `${sysNames.length} systems`);
  } else if (session.filters.systemGroup) {
    bits.push(session.filters.systemGroup);
  }
  return bits.join(" / ");
}

function dbFromStepParam(step: string | null, fallback: DB = "step2"): DB {
  const value = (step || "").toLowerCase();
  if (value === "1" || value === "step1" || value === "s1") return "step1";
  if (value === "2" || value === "step2" || value === "ck" || value === "s2") return "step2";
  if (value === "3" || value === "step3" || value === "s3") return "step3";
  return fallback;
}

function emptyUsedQbankProgress(): UsedQbankProgress {
  return { step1: [], step2: [], step3: [] };
}

function normalizeUsedQbankProgress(value: unknown): UsedQbankProgress {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next = emptyUsedQbankProgress();
  // Iterate every present bank key (not just the 3 UWorld defaults) so NBME/CMS
  // used/marked QIDs survive load + merge.
  for (const item of Object.keys(input)) {
    const raw = input[item];
    if (!Array.isArray(raw)) continue;
    next[item] = Array.from(new Set(raw.map(Number).filter(qid => Number.isInteger(qid) && qid > 0))).sort((a, b) => a - b);
  }
  return next;
}

function loadUsedQuestionIds(): UsedQbankProgress {
  if (typeof window === "undefined") return emptyUsedQbankProgress();
  try {
    return normalizeUsedQbankProgress(JSON.parse(window.localStorage.getItem(USED_QIDS_KEY) || "null"));
  } catch {
    return emptyUsedQbankProgress();
  }
}

function setLocalStorageSafely(key: string, value: string) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    try {
      window.localStorage.removeItem(key);
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
}

function emitQbankStorageNotice(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("medos:qbank-storage-notice", {
    detail: { message: `Storage notice: ${message}` },
  }));
}

function saveUsedQuestionIds(progress: UsedQbankProgress) {
  setLocalStorageSafely(USED_QIDS_KEY, JSON.stringify(normalizeUsedQbankProgress(progress)));
}

function loadMarkedQuestionIds(): UsedQbankProgress {
  if (typeof window === "undefined") return emptyUsedQbankProgress();
  try {
    return normalizeUsedQbankProgress(JSON.parse(window.localStorage.getItem(MARKED_QIDS_KEY) || "null"));
  } catch {
    return emptyUsedQbankProgress();
  }
}

function saveMarkedQuestionIds(progress: UsedQbankProgress) {
  setLocalStorageSafely(MARKED_QIDS_KEY, JSON.stringify(normalizeUsedQbankProgress(progress)));
}

function loadTrackingPreference() {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(TRACKING_PREF_KEY) !== "practice";
}

function saveTrackingPreference(track: boolean) {
  setLocalStorageSafely(TRACKING_PREF_KEY, track ? "prep" : "practice");
}

function loadSessions(): Session[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const sessions = (raw ? JSON.parse(raw) as Session[] : []).map(normalizeSession);
    const kept = sessions.filter(session => !session.transient && !isReferenceSession(session));
    if (kept.length !== sessions.length || JSON.stringify(kept) !== raw) saveSessions(kept);
    return kept;
  } catch {
    return [];
  }
}

function compactQuestionForStorage(question: Question, keepExplanationHtml = false): Question {
  return {
    ...question,
    stem_html: question.stem_html ? question.stem_html.slice(0, 6000) : undefined,
    choices_html: question.choices_html?.map(h => (h || "").slice(0, 800)),
    explanation_html: keepExplanationHtml && question.explanation_html ? question.explanation_html.slice(0, 60000) : undefined,
    explanation_media: keepExplanationHtml ? (question.explanation_media || []).slice(0, 20) : undefined,
    stem: (question.stem || "").slice(0, 8000),
    explanation: (question.explanation || "").slice(0, 14000),
    choices: question.choices.map(choice => (choice || "").slice(0, 2400)),
    media: (question.media || []).slice(0, 10),
    tags: (question.tags || []).slice(0, 16),
  };
}

function compactSessionForStorage(session: Session): Session {
  return {
    ...session,
    questions: session.questions.map((question, index) =>
      compactQuestionForStorage(question, shouldPersistExplanationHtml(session, index))
    ),
  };
}

function markedMapForQuestions(questions: Question[], markedIds: number[]) {
  if (!markedIds.length) return {};
  const markedSet = new Set(markedIds);
  return Object.fromEntries(
    questions
      .map((question, index) => [index, markedSet.has(question.id)] as const)
      .filter(([, isMarked]) => isMarked)
  );
}

// ─── "All matched questions" paging ─────────────────────────────────────────
// /qbank/list caps `limit` at 100. Building a block from every matching
// question means probing the total and walking pages of 100.
const ALL_MATCHED_PAGE = 100;
const ALL_MATCHED_CONFIRM_THRESHOLD = 300;
const ALL_MATCHED_MAX_QUERY_IDS = 200;

async function fetchQbankListSlice(
  backend: string,
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<{ questions?: Question[]; total?: number }> {
  const response = await fetch(`${backend}/qbank/list?${params}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function shuffleQuestions(list: Question[]) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function orderAllMatched(questions: Question[], sort: SortMode) {
  if (sort === "id") return [...questions].sort((a, b) => a.id - b.id);
  if (sort === "newest") return [...questions].sort((a, b) => b.id - a.id);
  // `random` and `difficulty` are resolved client-side because paging needs a
  // stable order; a shuffled block is the closest match for both.
  return shuffleQuestions(questions);
}

function confirmLargeAllMatchedBlock(total: number) {
  if (total <= ALL_MATCHED_CONFIRM_THRESHOLD) return true;
  return window.confirm(
    `All matched questions: ${total.toLocaleString()} questions.\n\n` +
    `Loading a block this large can take a while and uses more browser storage. Build it anyway?`,
  );
}

async function collectAllMatchedQuestions(
  backend: string,
  base: URLSearchParams,
  signal?: AbortSignal,
): Promise<{ questions: Question[]; total: number; cancelled: boolean }> {
  const questions: Question[] = [];
  const seen = new Set<number>();
  const add = (list: Question[] | undefined) => {
    for (const question of list || []) {
      if (!question || seen.has(question.id) || excludeIds.has(question.id)) continue;
      seen.add(question.id);
      questions.push(question);
    }
  };

  const rawInclude = base.get("include_ids") || "";
  const includeIds = rawInclude
    .split(",")
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0);

  // A long exclusion list (practice-only progress) must not be repeated on every
  // page request — it would blow the query-string limit. Fetch without it and
  // drop those questions client-side instead.
  const rawExclude = base.get("exclude_ids") || "";
  const excludeIds = new Set(
    rawExclude
      .split(",")
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value > 0),
  );
  const pageBase = new URLSearchParams(base);
  if (excludeIds.size > ALL_MATCHED_MAX_QUERY_IDS) pageBase.delete("exclude_ids");

  if (includeIds.length) {
    const total = includeIds.length;
    if (!confirmLargeAllMatchedBlock(total)) return { questions: [], total, cancelled: true };
    // Chunk the id list so the query string never approaches HTTP limits.
    for (let i = 0; i < includeIds.length; i += ALL_MATCHED_PAGE) {
      const chunk = includeIds.slice(i, i + ALL_MATCHED_PAGE);
      const params = new URLSearchParams(pageBase);
      params.set("include_ids", chunk.join(","));
      params.set("limit", String(chunk.length));
      params.set("page", "1");
      add((await fetchQbankListSlice(backend, params, signal)).questions);
    }
    return { questions, total, cancelled: false };
  }

  const probeParams = new URLSearchParams(pageBase);
  probeParams.set("limit", "1");
  probeParams.set("page", "1");
  probeParams.set("sort", "id");
  const probe = await fetchQbankListSlice(backend, probeParams, signal);
  const parsedTotal = Number(probe.total);
  const total = Number.isFinite(parsedTotal) && parsedTotal > 0
    ? parsedTotal
    : (probe.questions || []).length;
  if (!confirmLargeAllMatchedBlock(total)) return { questions: [], total, cancelled: true };

  const pages = Math.max(1, Math.ceil(total / ALL_MATCHED_PAGE));
  for (let page = 1; page <= pages; page += 1) {
    const params = new URLSearchParams(pageBase);
    params.set("limit", String(ALL_MATCHED_PAGE));
    params.set("page", String(page));
    // Stable paging; the caller re-orders the finished block.
    params.set("sort", "id");
    const batch = (await fetchQbankListSlice(backend, params, signal)).questions || [];
    add(batch);
    if (batch.length < ALL_MATCHED_PAGE) break;
  }
  return { questions, total, cancelled: false };
}

// ─── Partner sharing ────────────────────────────────────────────────────────
// A share code carries only the bank, mode, block name and the ordered question
// ids. The partner's own MedOS re-fetches those questions from its local bank,
// so the clipboard payload stays small even for an all-matched block.
const SHARE_CODE_PREFIX = "MEDOS-QBANK-SESSION:1:";

interface SharedSessionPayload {
  db: string;
  mode: TestMode;
  label: string;
  ids: number[];
  examTotalSec?: number;
  allMatched?: boolean;
  filters?: Session["filters"];
}

function encodeSharedSession(session: Session): string {
  const payload: SharedSessionPayload = {
    db: session.db,
    mode: session.mode,
    label: session.blockLabel || "",
    ids: session.questions.map(question => question.id).filter(id => Number.isInteger(id) && id > 0),
    examTotalSec: session.examTotalSec,
    allMatched: session.allMatched,
    filters: session.filters,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${SHARE_CODE_PREFIX}${base64}`;
}

function decodeSharedSession(raw: string): SharedSessionPayload {
  const code = (raw || "").replace(/\s+/g, "");
  if (!code) throw new Error("Paste your partner's session code first.");
  if (!code.startsWith(SHARE_CODE_PREFIX)) {
    throw new Error("That is not a MedOS session code. Ask your partner to press Share and copy the whole code.");
  }
  const base64 = code.slice(SHARE_CODE_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let json = "";
  try {
    const binary = window.atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch {
    throw new Error("This session code is damaged. Ask your partner to copy it again.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("This session code is damaged. Ask your partner to copy it again.");
  }
  const value = (parsed || {}) as Partial<SharedSessionPayload>;
  const db = typeof value.db === "string" ? value.db.trim() : "";
  if (!db) throw new Error("This session code is missing its Q-bank.");
  const ids = Array.isArray(value.ids)
    ? Array.from(new Set(value.ids.map(Number).filter(id => Number.isInteger(id) && id > 0)))
    : [];
  if (!ids.length) throw new Error("This session code has no questions.");
  const examTotalSec = Number(value.examTotalSec);
  return {
    db,
    mode: value.mode === "exam" ? "exam" : "tutor",
    label: typeof value.label === "string" ? value.label.slice(0, 160) : "",
    ids,
    examTotalSec: Number.isFinite(examTotalSec) && examTotalSec > 0 ? examTotalSec : undefined,
    allMatched: Boolean(value.allMatched),
    filters: value.filters && typeof value.filters === "object" ? value.filters as Session["filters"] : undefined,
  };
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* insecure context or denied — fall back below */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function saveSessions(sessions: Session[]) {
  if (typeof window === "undefined") return;
  const normalSessions = sessions.filter(session => !session.transient && !isReferenceSession(session));
  const storageCandidates = [
    normalSessions.slice(0, 12).map(compactSessionForStorage),
    normalSessions.filter(session => !session.completedAt).slice(0, 6).map(compactSessionForStorage),
    normalSessions.slice(0, 3).map(compactSessionForStorage),
    normalSessions.slice(0, 1).map(compactSessionForStorage),
  ];
  for (const candidate of storageCandidates) {
    if (setLocalStorageSafely(STORAGE_KEY, JSON.stringify(candidate))) return;
  }
  window.localStorage.removeItem(STORAGE_KEY);
  emitQbankStorageNotice("saved question sessions exceeded browser storage. Older local sessions were cleared; backend sync remains available.");
}

function loadExamRun(): ExamRun | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = JSON.parse(window.localStorage.getItem(EXAM_RUN_KEY) || "null");
    if (!raw || !Array.isArray(raw.blocks) || !raw.blocks.length) return null;
    return { ...raw, blocks: raw.blocks.map(normalizeSession) } as ExamRun;
  } catch {
    return null;
  }
}

function saveExamRun(run: ExamRun | null) {
  if (typeof window === "undefined") return;
  if (!run) { window.localStorage.removeItem(EXAM_RUN_KEY); return; }
  const compact = { ...run, blocks: run.blocks.map(compactSessionForStorage) };
  if (!setLocalStorageSafely(EXAM_RUN_KEY, JSON.stringify(compact))) {
    // Last resort: drop question media-heavy fields are already stripped; if it
    // still doesn't fit, keep the run metadata so at least block timing survives.
    try {
      window.localStorage.setItem(EXAM_RUN_KEY, JSON.stringify({ ...compact, blocks: compact.blocks }));
      return;
    } catch {
      emitQbankStorageNotice("the active exam could not be saved locally because browser storage is full.");
    }
  }
}

interface BlockResult { index: number; label: string; total: number; correct: number; wrong: number; omitted: number; percentCorrect: number }
interface ExamSummary {
  blocks: BlockResult[];
  totalQuestions: number; correct: number; wrong: number; omitted: number;
  percentCorrect: number; percentWrong: number;
  prediction: ScorePrediction | null;
  step: UsmleStep | null; form: string | null;
}

// Aggregate an exam run into per-block + total right/wrong/omitted and a
// predicted 3-digit score (NBME Step forms only; CMS subject forms get none).
function summarizeExam(run: ExamRun): ExamSummary {
  const blocks: BlockResult[] = run.blocks.map((b, i) => {
    let correct = 0, wrong = 0;
    b.questions.forEach((q, qi) => {
      const a = b.answers?.[qi];
      if (a == null) return;
      if ((q.correct - 1) === a) correct++; else wrong++;
    });
    const total = b.questions.length;
    const omitted = Math.max(0, total - correct - wrong);
    return { index: i, label: b.examBlockLabel || `Block ${i + 1}`, total, correct, wrong, omitted, percentCorrect: total ? Math.round((correct / total) * 100) : 0 };
  });
  const totalQuestions = blocks.reduce((s, b) => s + b.total, 0);
  const correct = blocks.reduce((s, b) => s + b.correct, 0);
  const wrong = blocks.reduce((s, b) => s + b.wrong, 0);
  const omitted = blocks.reduce((s, b) => s + b.omitted, 0);
  const percentCorrect = totalQuestions ? Math.round((correct / totalQuestions) * 100) : 0;
  const percentWrong = totalQuestions ? Math.round(((wrong + omitted) / totalQuestions) * 100) : 0;
  const parsed = parseNbmeKey(run.db);
  // "Missed" (not-correct = wrong + omitted) drives the regression — on the real
  // exam every item is answered, so omitted counts against you like a wrong.
  // Step 3 self-assessments have no validated wrong→3-digit conversion, so we
  // only predict for Step 1 / Step 2 CK and show % correct for Step 3.
  const prediction = parsed && parsed.step !== "3" ? predictNbmeScore(parsed.step, parsed.form, wrong + omitted, totalQuestions) : null;
  return { blocks, totalQuestions, correct, wrong, omitted, percentCorrect, percentWrong, prediction, step: parsed?.step ?? null, form: parsed?.form ?? null };
}

interface ExamHistoryEntry {
  id: string; db: string; label: string; step: string | null; form: string | null;
  structure: string; completedAt: string; complete: boolean;
  totalQuestions: number; correct: number; wrong: number; omitted: number;
  percentCorrect: number; predictedScore: number | null; blockCount: number;
}

function loadExamHistory(): ExamHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(EXAM_HISTORY_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveExamHistory(list: ExamHistoryEntry[]) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(EXAM_HISTORY_KEY, JSON.stringify(list.slice(0, 200))); } catch { /* over quota */ }
}

function mergeSessions(primary: Session[], secondary: Session[]) {
  const byId = new Map<string, Session>();
  [...primary, ...secondary]
    .filter(session => session && !session.transient && !isReferenceSession(session))
    .map(normalizeSession)
    .forEach(session => {
      const existing = byId.get(session.id);
      if (!existing || Date.parse(session.updatedAt || session.createdAt) >= Date.parse(existing.updatedAt || existing.createdAt)) {
        byId.set(session.id, session);
      }
    });
  return Array.from(byId.values())
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
}

function unionProgress(...items: UsedQbankProgress[]) {
  const next = emptyUsedQbankProgress();
  const keys = new Set<string>([...DB_OPTIONS, ...items.flatMap(item => Object.keys(item))]);
  keys.forEach(db => {
    next[db] = Array.from(new Set(items.flatMap(item => item[db] || []))).sort((a, b) => a - b);
  });
  return next;
}

function qbankStateFetch(path: string, init: RequestInit = {}) {
  return fetch(`${QBANK_STATE_API}${path}`, { ...init, credentials: "include" });
}

function persistSessionToBackend(session: Session) {
  if (typeof window === "undefined" || session.transient || isReferenceSession(session)) return;
  qbankStateFetch(`/sessions/${encodeURIComponent(session.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: compactSessionForStorage(normalizeSession(session)) }),
  }).catch(() => {});
}

function persistProgressToBackend(usedIdsByDb: UsedQbankProgress, markedIdsByDb: UsedQbankProgress, trackingPref: boolean) {
  if (typeof window === "undefined") return;
  qbankStateFetch("/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usedIdsByDb, markedIdsByDb, trackingPref }),
  }).catch(() => {});
}

function persistFullStateToBackend(sessions: Session[], usedIdsByDb: UsedQbankProgress, markedIdsByDb: UsedQbankProgress, trackingPref: boolean) {
  if (typeof window === "undefined") return;
  qbankStateFetch("/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessions: sessions.filter(session => !session.transient && !isReferenceSession(session)).map(compactSessionForStorage),
      usedIdsByDb,
      markedIdsByDb,
      trackingPref,
    }),
  }).catch(() => {});
}

function pct(session: Session) {
  const total = Object.keys(session.answers).length;
  if (!total) return 0;
  const right = Object.entries(session.answers).filter(([i, a]) => session.questions[+i]?.correct - 1 === a).length;
  return Math.round((right / total) * 100);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function withoutNumberKey<T>(record: Record<number, T> | undefined, key: number) {
  const next = { ...(record || {}) };
  delete next[key];
  return next;
}

function calculateSimpleExpression(expression: string) {
  const clean = expression.trim();
  if (!clean || !/^[0-9+\-*/().\s]+$/.test(clean)) return "Error";
  try {
    const result = Function(`"use strict"; return (${clean})`)() as unknown;
    if (typeof result !== "number" || !Number.isFinite(result)) return "Error";
    return String(Math.round(result * 1000000) / 1000000);
  } catch {
    return "Error";
  }
}

function percentCorrectFor(question: Question) {
  const value = question.answer_stats?.percent_correct;
  return typeof value === "number" && Number.isFinite(value) ? clampNumber(Math.round(value), 1, 99) : 50;
}

function seriesInfo(questions: Question[], index: number): { part: number; total: number } | null {
  const q = questions[index];
  if (!q?.parentQId) return null;
  const parentId = q.parentQId;
  // A parent question has parentQId === id; a child has a different parentQId.
  // Collect all members of this series from the block, sorted by id.
  const members = questions
    .filter(x => x.parentQId === parentId || x.id === parentId)
    .sort((a, b) => a.id - b.id);
  if (members.length < 2) return null;
  const part = members.findIndex(x => x.id === q.id) + 1;
  return { part, total: members.length };
}

function questionWeightedCredit(question: Question, selected?: number) {
  const peerRate = percentCorrectFor(question) / 100;
  const correct = selected === question.correct - 1;
  if (selected === undefined) return -peerRate;
  return correct ? 1 + (1 - peerRate) : -peerRate;
}

function weightedPerformance(session: Session) {
  let raw = 0;
  let min = 0;
  let max = 0;
  let right = 0;
  let hardCorrect = 0;
  let easyMiss = 0;
  let unanswered = 0;

  session.questions.forEach((question, index) => {
    const peerRate = percentCorrectFor(question) / 100;
    min -= peerRate;
    max += 1 + (1 - peerRate);
    const selected = session.answers[index];
    const correct = selected === question.correct - 1;
    raw += questionWeightedCredit(question, selected);
    if (selected === undefined) unanswered += 1;
    if (correct) {
      right += 1;
      if (peerRate < 0.5) hardCorrect += 1;
    } else if (peerRate >= 0.7) {
      easyMiss += 1;
    }
  });

  const normalized = max === min ? 0 : Math.round(clampNumber(((raw - min) / (max - min)) * 100, 0, 100));
  return {
    normalized,
    raw: Math.round(raw * 10) / 10,
    max: Math.round(max * 10) / 10,
    right,
    hardCorrect,
    easyMiss,
    unanswered,
  };
}

function testModeFromParam(mode: string | null): TestMode {
  const value = (mode || "").toLowerCase();
  return value === "timed" || value === "exam" ? "exam" : "tutor";
}

function queryFromTopicParam(topic: string | null) {
  const value = (topic || "").trim();
  if (!value) return "";
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return TOPIC_QUERY[key] || value.replace(/[-_]+/g, " ");
}

function qbankHtml(value: string | undefined, backend: string, db: DB) {
  if (!value) return "";
  return value.replace(
    /(src|href)=(["'])\/qbank\/media\/([^"']+)\2/g,
    (_match, attr, quote, path) => {
      const sep = path.includes("?") ? "&" : "?";
      return `${attr}=${quote}${backend}/qbank/media/${path}${sep}db=${db}&_v=3${quote}`;
    }
  ).replace(
    /(href)=(["'])\/qbank\/exhibit\/([^"']+)\2/g,
    (_match, attr, quote, path) => {
      // `path` may already carry ?srcqid=<id> from the backend rewrite — join with
      // & so we never produce a malformed double-`?` URL.
      const sep = path.includes("?") ? "&" : "?";
      return `${attr}=${quote}${backend}/qbank/exhibit/${path}${sep}db=${db}${quote}`;
    }
  );
}

function qbankReferenceClass(className: string, referencesEnabled: boolean) {
  return referencesEnabled ? className : `${className} qbank-reference-pending`;
}

function addExhibitCuesToHtml(html: string, enabled: boolean) {
  if (!enabled || !html || html.includes("qbank-exhibit-cue")) return html;
  let replaced = false;
  return html.split(/(<[^>]+>)/g).map(part => {
    if (replaced || part.startsWith("<")) return part;
    const cuePattern = /\b(exhibit|figure|image)\b/i.test(part)
      ? /\b(exhibit|figure|image)\b/i
      : /\b(ECG|EKG|radiograph|x-ray)\b/i;
    const next = part.replace(cuePattern, match => {
      replaced = true;
      return `<a href="#qbank-exhibit" class="qbank-exhibit-cue" data-exhibit-cue="1">${match}</a>`;
    });
    return next;
  }).join("");
}

function qbankStemHtml(value: string | undefined, backend: string, db: DB, hasMedia: boolean) {
  return addExhibitCuesToHtml(qbankHtml(value, backend, db), hasMedia);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function qbankExamPlainStemHtml(value: string | undefined) {
  return escapeHtml(value || "Question stem unavailable.").replace(/\n/g, "<br />");
}

interface QBankChoiceMatrix {
  stemHtml: string;
  headers: string[];
  rows: string[][];
  sourceWidth?: number;
}

function trimQbankCellHtml(value: string) {
  return value
    .replace(/^\s*<p\b[^>]*>/i, "")
    .replace(/<\/p>\s*$/i, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function isIgnorableQbankHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/<br\s*\/?>/gi, "")
    .replace(/<\/?(?:p|div|span)\b[^>]*>/gi, "")
    .replace(/\s+/g, "")
    .trim() === "";
}

function extractQbankTableCells(tableHtml: string) {
  const cells = Array.from(tableHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi))
    .map(match => trimQbankCellHtml(match[1] || ""))
    .filter(cell => cell.length > 0);
  return cells.length >= 2 ? cells : null;
}

function extractQbankTableWidth(tableHtml: string) {
  const styleWidth = tableHtml.match(/\bstyle=(["'])([\s\S]*?)\1/i)?.[2]
    ?.match(/\bwidth\s*:\s*(\d+(?:\.\d+)?)px/i)?.[1];
  const attrWidth = tableHtml.match(/\bwidth=(["']?)(\d+(?:\.\d+)?)\1/i)?.[2];
  const width = Number(styleWidth || attrWidth || 0);
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

function splitTrailingQbankTable(value: string | undefined) {
  if (!value || !/<table\b/i.test(value)) return null;
  const matches = Array.from(value.matchAll(/<table\b[\s\S]*?<\/table>/gi));
  const last = matches[matches.length - 1];
  if (!last || last.index == null) return null;
  const tableHtml = last[0];
  const after = value.slice(last.index + tableHtml.length);
  if (!isIgnorableQbankHtml(after)) return null;
  const cells = extractQbankTableCells(tableHtml);
  if (!cells) return null;
  return { stemHtml: value.slice(0, last.index).trim(), cells, sourceWidth: extractQbankTableWidth(tableHtml) };
}

function extractSingleRowQbankTable(value: string | undefined) {
  if (!value || !/<table\b/i.test(value)) return null;
  const withoutTable = value.replace(/<table\b[\s\S]*?<\/table>/i, "");
  if (!isIgnorableQbankHtml(withoutTable)) return null;
  return extractQbankTableCells(value);
}

function buildQbankChoiceMatrix(question: Question): QBankChoiceMatrix | null {
  if (!question.choices_html || question.choices_html.length !== question.choices.length) return null;
  const stemSplit = splitTrailingQbankTable(question.stem_html);
  if (!stemSplit) return null;
  const rows = question.choices_html.map(extractSingleRowQbankTable);
  if (rows.some(row => !row || row.length !== stemSplit.cells.length)) return null;
  return {
    stemHtml: stemSplit.stemHtml,
    headers: stemSplit.cells,
    rows: rows as string[][],
    sourceWidth: stemSplit.sourceWidth,
  };
}

function choiceMatrixStyle(columnCount: number, sourceWidth?: number) {
  const labelWidth = 64;
  const dataWidth = sourceWidth ? Math.max(sourceWidth, columnCount * 92) : columnCount * 150;
  return {
    "--qbank-choice-matrix-cols": `${labelWidth}px repeat(${columnCount}, minmax(96px, 1fr))`,
    "--qbank-choice-matrix-width": `${Math.round(dataWidth + labelWidth)}px`,
  } as React.CSSProperties;
}

function QBankAnswerMatrix({
  matrix,
  variant,
  selected,
  correctIndex,
  marked,
  answered,
  eliminated,
  backend,
  db,
  sourceId,
  referenceEnabled = true,
  onChoose,
  onToggleEliminate,
  onOpenMatch,
  onMediaClick,
}: {
  matrix: QBankChoiceMatrix;
  variant: "tutor" | "exam";
  selected: number | undefined;
  correctIndex: number;
  marked?: boolean;
  answered?: boolean;
  eliminated?: Record<number, boolean>;
  backend: string;
  db: DB;
  sourceId: string;
  referenceEnabled?: boolean;
  onChoose: (index: number) => void;
  onToggleEliminate?: (index: number) => void;
  onOpenMatch?: React.ComponentProps<typeof ReferenceLayer>["onOpenMatch"];
  onMediaClick?: React.MouseEventHandler<HTMLElement>;
}) {
  const gridStyle = choiceMatrixStyle(matrix.headers.length, matrix.sourceWidth);
  const renderCell = (html: string, key: string, className: string) => {
    const rendered = qbankHtml(html, backend, db);
    return (
      <ReferenceLayer
        key={key}
        className={qbankReferenceClass(className, referenceEnabled)}
        onClick={onMediaClick}
        html={rendered}
        onOpenMatch={referenceEnabled ? onOpenMatch : undefined}
        db={db}
        source="qbank"
        sourceId={sourceId}
        hoverEnabled={referenceEnabled}
        modeOverride="full"
      />
    );
  };

  return (
    <div className={`qbank-answer-matrix qbank-answer-matrix-${variant}`} style={gridStyle}>
      <div className="qbank-answer-matrix-head" style={gridStyle}>
        <span className="qbank-answer-matrix-corner" aria-hidden="true" />
        {matrix.headers.map((header, index) => renderCell(header, `head-${index}`, "qbank-answer-matrix-heading"))}
      </div>
      <div className="qbank-answer-matrix-body">
        {matrix.rows.map((cells, index) => {
          const isSelected = selected === index;
          const isCorrect = correctIndex === index;
          const isEliminated = Boolean(eliminated?.[index]);
          const rowClassName = [
            "qbank-answer-matrix-row",
            `qbank-answer-matrix-row-${variant}`,
            isSelected ? "is-selected" : "",
            isEliminated ? "is-eliminated" : "",
            marked && isCorrect ? "is-correct" : "",
            marked && isSelected && !isCorrect ? "is-incorrect" : "",
          ].filter(Boolean).join(" ");
          const handleChoose = () => {
            if (answered) return;
            onChoose(index);
          };
          return (
            <div
              key={`choice-row-${index}`}
              className={rowClassName}
              style={gridStyle}
              role="button"
              tabIndex={answered ? -1 : 0}
              aria-pressed={isSelected}
              aria-disabled={Boolean(answered)}
              onClick={handleChoose}
              onContextMenu={event => {
                if (!onToggleEliminate) return;
                event.preventDefault();
                onToggleEliminate(index);
              }}
              onKeyDown={event => {
                if (answered) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onChoose(index);
                }
              }}
              title={variant === "exam" ? "Left click to answer. Right click to strike out." : undefined}
            >
              <span className="qbank-answer-matrix-choice-label">
                {variant === "exam" ? (
                  <>
                    <span className="qbank-answer-matrix-radio" aria-hidden="true">{isSelected && <Check size={13} />}</span>
                    <b>{letters[index]}</b>
                  </>
                ) : (
                  <span
                    className="qbank-answer-matrix-badge"
                    aria-label={marked && isCorrect ? "Correct answer" : marked && isSelected ? "Incorrect selected answer" : `Answer ${letters[index]}`}
                  >
                    {marked && isCorrect ? <Check size={15} /> : marked && isSelected ? <X size={15} /> : letters[index]}
                  </span>
                )}
              </span>
              {cells.map((cell, cellIndex) => renderCell(cell, `row-${index}-cell-${cellIndex}`, "qbank-answer-matrix-cell"))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const MEDIA_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav|m4a)(?:[?#].*)?$/i;

function cleanMediaCaption(value?: string) {
  if (!value) return "";
  let text = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the original text when a malformed escape sequence appears in source HTML.
  }
  return text.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

function isMeaningfulMediaCaption(value?: string) {
  const text = cleanMediaCaption(value);
  if (!text || text.length < 3) return false;
  const leaf = text.split(/[\\/]/).pop() || text;
  if (MEDIA_FILE_EXT_RE.test(leaf)) return false;
  const base = leaf.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
  if (!base) return false;
  if (/^(?:media|image|img|figure|fig|photo|picture|audio|video)(?:\s*\d+)?$/i.test(base)) return false;
  const compact = base.replace(/[\s._-]+/g, "");
  if (/^(?:big|small|thumb|thumbnail)?[a-f0-9]{8,}$/i.test(compact)) return false;
  if (/^(?:big|small|thumb|thumbnail|img|image|fig|figure|media|photo)?\d{3,}$/i.test(compact)) return false;
  return /[a-z]{3,}/i.test(base);
}

function mediaDisplayCaption(value?: string) {
  return isMeaningfulMediaCaption(value) ? cleanMediaCaption(value) : "";
}

function mediaKind(value?: string) {
  const text = value || "";
  if (/\.(mp3|wav|m4a)(?:[?#]|$)/i.test(text)) return "Audio";
  if (/\.(mp4|webm)(?:[?#]|$)/i.test(text)) return "Video";
  return "Image";
}

function mediaLinksFromHtml(value: string | undefined, backend: string, db: DB) {
  if (!value) return [] as { src: string; label: string; caption: string }[];
  const html = qbankHtml(value, backend, db);
  const out: { src: string; label: string; caption: string }[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/qbank\/media\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>|<img\b[^>]*src=["']([^"']*\/qbank\/media\/[^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi)) {
    const src = match[1] || match[3] || "";
    const rawLabel = (match[2] || match[4] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const fallback = decodeURIComponent(src.split("/").pop()?.split("?")[0] || "media");
    const caption = mediaDisplayCaption(rawLabel);
    const label = caption || fallback;
    if (src && !out.some(item => item.src === src)) out.push({ src, label, caption });
  }
  for (const match of html.matchAll(/(?:src|href)=["']([^"']*\/qbank\/media\/[^"']+)["']/g)) {
    const src = match[1];
    const label = decodeURIComponent(src.split("/").pop()?.split("?")[0] || "media");
    if (!out.some(item => item.src === src)) out.push({ src, label, caption: "" });
  }
  return out;
}

function withThemeParam(url: string, theme: "light" | "dark") {
  if (!url) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}theme=${theme}${hash}`;
}

function qbankToolActionLabel(hit: ToolSearchHit) {
  const href = hit.href || "";
  if (hit.scope === "firstaid" || href.startsWith("#firstaid-")) return "Open First Aid";
  if (
    href.startsWith("/amboss?doc=") ||
    href.startsWith("/uptodate?t=") ||
    href.startsWith("/library/uworld?doc=")
  ) {
    return "Open in sidebar";
  }
  return "Open in tab";
}

export default function QuizEngine() {
  const backend = getBackendUrl();
  const searchParams = useSearchParams();
  const [darkModeOn] = useDarkMode();
  const articleTheme = darkModeOn ? "dark" : "light";
  const initialDeepLinkLoadedRef = useRef(false);
  const activeRef = useRef<Session | null>(null);
  const examRunRef = useRef<ExamRun | null>(null);
  const qbankGestureRef = useRef<HTMLDivElement>(null);
  const qbankTutorPageRef = useRef<HTMLDivElement>(null);
  const qbankExamQuestionRef = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<Mode>("home");
  // Multi-block NBME exam in progress (null when not in an exam).
  const [examRun, setExamRun] = useState<ExamRun | null>(null);
  const [examStructure, setExamStructure] = useState<"native" | "chunked">("native");
  // How a COMPLETED exam block is reviewed: "tutor" (rich explanations, the default)
  // or "exam" (the FRED-replica look). Only affects completed blocks — a live block
  // always shows the exam UI regardless of this.
  const [examReviewView, setExamReviewView] = useState<"tutor" | "exam">("tutor");
  const [examHistory, setExamHistory] = useState<ExamHistoryEntry[]>([]);
  const [initialBankSelection] = useState(() => {
    const step = readStudyStepPreference();
    const fallbackDb = dbForStudyStep(step);
    return readQbankSelection(
      typeof window === "undefined" ? undefined : window.localStorage,
      { db: fallbackDb, meta: dailyBankMeta(fallbackDb)! },
    ) as { db: DB; meta: BankMeta };
  });
  const [studyStep, setStudyStep] = useState<StudyStepPref>(() => {
    const step = initialBankSelection.meta.step;
    return step === 1 || step === 2 || step === 3 ? String(step) as StudyStepPref : readStudyStepPreference();
  });
  const [db, setDb] = useState<DB>(initialBankSelection.db);
  const [catalog, setCatalog] = useState<BankCatalog | null>(null);
  const [bankMeta, setBankMeta] = useState<BankMeta>(initialBankSelection.meta);
  // Which Question Type branches are expanded in the hierarchical navigator.
  const [openBankNodes, setOpenBankNodes] = useState<Set<string>>(() => new Set(["uworld"]));
  // Workspace pages: the builder is the focus; Review holds history + memory.
  const [workspaceTab, setWorkspaceTab] = useState<"build" | "review" | "custom" | "partner">("build");
  // Optional name for the block about to be built; becomes the session title.
  const [sessionName, setSessionName] = useState("");
  // Partner tab: a pasted share code from another MedOS user.
  const [partnerCode, setPartnerCode] = useState("");
  const [partnerError, setPartnerError] = useState("");
  const [partnerBusy, setPartnerBusy] = useState(false);
  // Share dialog (copyable session code) opened from the question toolbar.
  const [sharePayload, setSharePayload] = useState<{ code: string; copied: boolean; count: number } | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [reviewDbFilter, setReviewDbFilter] = useState<DB | "all">("all");
  // Which axis the Review progression table breaks down by (UWorld-style tabs).
  const [reviewBreakdownTab, setReviewBreakdownTab] = useState<"subjects" | "systems" | "topics" | "banks">("subjects");
  // Per-bank "total available" counts (subjects / organ systems / topics) used to
  // show usage and pending in the Review tab. Lazily fetched per bank in scope.
  const [reviewFacets, setReviewFacets] = useState<QbankFacets>({});
  // Unified cross-source progression rollup (refetched when entering Review).
  const progression = useProgression(workspaceTab);
  const [stats, setStats] = useState<Record<DB, QBankStats> | null>(null);
  // Timed-block duration in minutes (new USMLE format seeds it from question count).
  const [examMinutes, setExamMinutes] = useState(() => examMinutesForCount(40));
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [systems, setSystems] = useState<System[]>([]);
  const [tags, setTags] = useState<TagHit[]>([]);
  const [subjectFilter, setSubjectFilter] = useState("");
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<Set<number>>(() => new Set());
  const [systemGroupFilter, setSystemGroupFilter] = useState("");
  const [systemFilter, setSystemFilter] = useState("");
  // Bootcamp-style multi-select Systems tree + Question Pool.
  const [selectedSystemIds, setSelectedSystemIds] = useState<Set<number>>(() => new Set());
  // NBME/CMS forms scope by Block (their Subjects are "Block 1..4"); selecting
  // blocks maps to subject_ids in the query.
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<number>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [systemTreeFilter, setSystemTreeFilter] = useState("");
  const [pool, setPool] = useState<PoolKey>("unused");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [imagesOnly, setImagesOnly] = useState(false);
  const [batchSize, setBatchSize] = useState(40);
  // "All matched questions": ignore the 100-question cap and build the block
  // from every question the current filters match.
  const [allMatched, setAllMatched] = useState(false);
  const [testMode, setTestMode] = useState<TestMode>("tutor");
  const [sort, setSort] = useState<SortMode>("random");
  const [browse, setBrowse] = useState<Question[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [usedIdsByDb, setUsedIdsByDb] = useState<UsedQbankProgress>(() => emptyUsedQbankProgress());
  const [markedIdsByDb, setMarkedIdsByDb] = useState<UsedQbankProgress>(() => emptyUsedQbankProgress());
  const [trackPrepProgress, setTrackPrepProgress] = useState(true);
  const [persistentStorage, setPersistentStorage] = useState("");
  const [memoryReady, setMemoryReady] = useState(false);
  const [active, setActive] = useState<Session | null>(null);
  const [showNavigator, setShowNavigator] = useState(false);
  const [mediaViewer, setMediaViewer] = useState<string | null>(null);
  // Zoom is handled inside MediaViewer now; this setter is kept as a harmless
  // no-op target for the existing "open media" call sites.
  const [, setMediaZoom] = useState(1);
  // Per-question record of whether the formatted-explanation fetch has DEFINITIVELY
  // resolved — keyed `${db}:${qid}`. "Resolved" means the backend returned the
  // question (with or without explanation_html) OR the safety timeout elapsed. The
  // "Loading formatted references…" spinner is gated on this so it can NEVER outlive
  // the fetch (the recurring stuck-spinner bug): a missing/empty explanation_html
  // simply falls back to the plain-text explanation instead of spinning forever.
  const [explanationResolved, setExplanationResolved] = useState<Record<string, boolean>>({});
  const markExplanationResolved = useCallback((db: string, qid: number | undefined) => {
    if (!qid) return;
    const key = `${db}:${qid}`;
    setExplanationResolved(prev => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  const [storageNotice, setStorageNotice] = useState("");
  const [toolOpen, setToolOpen] = useState(true);
  const [toolTab, setToolTab] = useState<ToolTab>("search");
  const [toolWidth, setToolWidth] = useState(420);
  const [selectedText, setSelectedText] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [toolResults, setToolResults] = useState<ToolSearchHit[]>([]);
  const [toolLoading, setToolLoading] = useState(false);
  const [articleFrame, setArticleFrame] = useState<ArticleFrame | null>(null);
  const [conceptPanel, setConceptPanel] = useState<{ cui: string; name: string; items: ConceptMention[] } | null>(null);
  const [relatedArticles, setRelatedArticles] = useState<RelatedArticle[]>([]);
  const [examLabsOpen, setExamLabsOpen] = useState(false);
  const [examNotesOpen, setExamNotesOpen] = useState(false);
  const [examDrawerContent, setExamDrawerContent] = useState<"labs" | "notes" | null>(null);
  const [examLabTab, setExamLabTab] = useState<ExamLabTabId>("serum");
  const [examLabSearch, setExamLabSearch] = useState("");
  const [examLabShowSi, setExamLabShowSi] = useState(false);
  const [examDark, setExamDark] = useState(false);
  const [examFontScale, setExamFontScale] = useState(1);
  const [gesturesEnabled, setGesturesEnabled] = useState(true);
  const [examNavigatorOpen, setExamNavigatorOpen] = useState(true);
  const [examCalculatorOpen, setExamCalculatorOpen] = useState(false);
  const [examPaused, setExamPaused] = useState(false);
  const [examLocked, setExamLocked] = useState(false);
  const [examStatusOpen, setExamStatusOpen] = useState(false);
  const [calcExpression, setCalcExpression] = useState("0");
  const [openLabGroups, setOpenLabGroups] = useState<Record<string, boolean>>({
    Serum: true,
    "Blood Gases & CSF": true,
    "Hematologic & Coagulation": true,
    "Urine & Body Measures": false,
  });

  const storageNoticeToast = storageNotice ? (
    <div className="qbank-storage-notice" role="status" aria-live="polite">
      <span>{storageNotice}</span>
      <button type="button" onClick={() => setStorageNotice("")} aria-label="Dismiss storage notice">
        <X size={14} />
      </button>
    </div>
  ) : null;

  useEffect(() => {
    const openReaderTools = () => {
      if (mode !== "quiz") return;
      setToolOpen(prev => !prev);
    };
    window.addEventListener("medos:reader-tools-toggle", openReaderTools);
    return () => window.removeEventListener("medos:reader-tools-toggle", openReaderTools);
  }, [mode]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setStorageNotice(detail?.message || "Storage notice: QBank could not save to browser storage.");
    };
    window.addEventListener("medos:qbank-storage-notice", handler);
    return () => window.removeEventListener("medos:qbank-storage-notice", handler);
  }, []);

  useEffect(() => {
    const readAppSettings = () => {
      try {
        const raw = window.localStorage.getItem(MEDOS_SETTINGS_KEY);
        if (!raw) {
          setGesturesEnabled(true);
          return;
        }
        const parsed = JSON.parse(raw) as { gestures?: boolean; studyStep?: string };
        setGesturesEnabled(parsed.gestures !== false);
        if (parsed.studyStep === "1" || parsed.studyStep === "2" || parsed.studyStep === "3") {
          setStudyStep(parsed.studyStep);
          setDb(current => {
            const aligned = alignBankToStudyStep(current, parsed.studyStep as StudyStepPref);
            const meta = dailyBankMeta(aligned);
            if (meta) setBankMeta(meta);
            return aligned;
          });
        }
      } catch {
        setGesturesEnabled(true);
      }
    };
    readAppSettings();
    window.addEventListener("medos:settings-changed", readAppSettings);
    return () => window.removeEventListener("medos:settings-changed", readAppSettings);
  }, []);

  const activeSessionId = active?.id;
  const activeCurrentIndex = active?.current ?? -1;
  const activeDbKey = active?.db;
  const activeModeKey = active?.mode;
  const activeCompletedAtKey = active?.completedAt;
  const activeCurrentQuestion = activeCurrentIndex >= 0 ? active?.questions[activeCurrentIndex] : undefined;
  const activeCurrentQuestionId = activeCurrentQuestion?.id;
  const activeCurrentStemHtml = activeCurrentQuestion?.stem_html;
  const activeCurrentChoicesHtmlCount = activeCurrentQuestion?.choices_html?.length ?? 0;
  const activeCurrentExplanationHtml = activeCurrentQuestion?.explanation_html;
  const activeCurrentAnswer = active && activeCurrentIndex >= 0 ? active.answers[activeCurrentIndex] : undefined;
  const activeCurrentRevealed = active && activeCurrentIndex >= 0 ? active.revealed[activeCurrentIndex] : undefined;
  // Per-question resolution flag as a primitive boolean, so the safety-net effect
  // below depends only on the CURRENT question's state and is not re-armed every
  // time some OTHER question resolves (which would reset its 10s clock).
  const activeCurrentExplanationResolved = Boolean(
    activeDbKey && activeCurrentQuestionId && explanationResolved[`${activeDbKey}:${activeCurrentQuestionId}`]
  );

  useEffect(() => {
    if (mode !== "quiz" || !activeSessionId) return;
    qbankTutorPageRef.current?.scrollTo({ top: 0, left: 0 });
    qbankExamQuestionRef.current?.scrollTo({ top: 0, left: 0 });
  }, [activeCurrentIndex, activeSessionId, mode]);

  useEffect(() => {
    let cancelled = false;
    const localSessions = loadSessions();
    const localUsed = loadUsedQuestionIds();
    const localMarked = loadMarkedQuestionIds();
    const localTracking = loadTrackingPreference();
    setSessions(localSessions);
    setUsedIdsByDb(localUsed);
    setMarkedIdsByDb(localMarked);
    setTrackPrepProgress(localTracking);

    setExamHistory(loadExamHistory());

    // Crash recovery: resume an interrupted multi-block exam exactly where it
    // stopped — same block, question, and timer (or the running break clock).
    const savedRun = loadExamRun();
    if (savedRun && savedRun.phase !== "done") {
      examRunRef.current = savedRun;
      setExamRun(savedRun);
      setDb(savedRun.db);
      if (savedRun.phase === "break") {
        let rem = savedRun.breakRemainingSec ?? 0;
        if (savedRun.breakSavedAt) {
          const elapsed = Math.floor((Date.now() - Date.parse(savedRun.breakSavedAt)) / 1000);
          if (Number.isFinite(elapsed) && elapsed > 0) rem = Math.max(0, rem - elapsed);
        }
        const upd: ExamRun = { ...savedRun, breakRemainingSec: rem };
        examRunRef.current = upd; setExamRun(upd); saveExamRun(upd);
        setMode("break");
      } else {
        const block = savedRun.blocks[savedRun.currentBlock];
        if (block && !block.completedAt) {
          // Prefer the per-second timer snapshot (freshest) over the block's
          // last-interaction time.
          const snap = loadExamTimerSnapshot(block.id);
          const restored = snap != null ? { ...block, timeRemainingSec: snap, examTimeRemainingSec: snap } : block;
          applyActiveSession(restored);
          setMode("quiz");
        }
      }
    }

    // A Qbank workspace tab carries the exact unfinished session id. Restore
    // that block when the user returns after opening an article, PDF, or other
    // MedOS tab. An interrupted multi-block exam remains the higher priority.
    if (!savedRun || savedRun.phase === "done") {
      const resumeSession = findQbankResumeSession(localSessions, searchParams.get("resume"));
      if (resumeSession) {
        initialDeepLinkLoadedRef.current = true;
        setDb(resumeSession.db);
        const resumeMeta = dailyBankMeta(resumeSession.db);
        if (resumeMeta) setBankMeta(resumeMeta);
        applyActiveSession(resumeSession);
        setMode("quiz");
      }
    }

    qbankStateFetch("/state")
      .then(r => r.ok ? r.json() : null)
      .then((state: QBankBackendState | null) => {
        if (cancelled || !state) return;
        const backendSessions = (state.sessions || []).map(normalizeSession);
        const mergedSessions = mergeSessions(backendSessions, localSessions);
        const mergedUsed = unionProgress(normalizeUsedQbankProgress(state.usedIdsByDb), localUsed);
        const mergedMarked = unionProgress(normalizeUsedQbankProgress(state.markedIdsByDb), localMarked);
        const tracking = state.trackingPrefStored ? Boolean(state.trackingPref) : localTracking;
        setSessions(mergedSessions);
        setUsedIdsByDb(mergedUsed);
        setMarkedIdsByDb(mergedMarked);
        setTrackPrepProgress(tracking);
        setPersistentStorage(state.storage || "");
        setMemoryReady(true);
        saveSessions(mergedSessions);
        saveUsedQuestionIds(mergedUsed);
        saveMarkedQuestionIds(mergedMarked);
        saveTrackingPreference(tracking);
        persistFullStateToBackend(mergedSessions, mergedUsed, mergedMarked, tracking);
      })
      .catch(() => {
        if (!cancelled) setMemoryReady(false);
      });
    return () => { cancelled = true; };
    // Run once on mount; applyActiveSession is stable for our purposes here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (mode !== "quiz" || !active || active.completedAt || typeof window === "undefined") return;
    const tab = buildQbankActiveTab(active, prettyDbLabel(active.db));
    if (!tab) return;
    window.dispatchEvent(new CustomEvent("TabBar:open", {
      detail: { ...tab, navigate: false },
    }));
  }, [active?.completedAt, active?.current, active?.db, active?.id, active?.questions.length, mode]);

  useEffect(() => {
    examRunRef.current = examRun;
  }, [examRun]);

  useEffect(() => {
    const examActive = mode === "quiz" && active?.mode === "exam";
    document.body.classList.toggle("qbank-exam-active", Boolean(examActive));
    return () => document.body.classList.remove("qbank-exam-active");
  }, [active?.completedAt, active?.mode, mode]);

  useEffect(() => {
    const readingActive = mode === "quiz";
    document.body.classList.toggle("qbank-tutor-active", readingActive);
    window.dispatchEvent(new CustomEvent("medos:reader-active-change"));
    return () => {
      document.body.classList.remove("qbank-tutor-active");
      window.dispatchEvent(new CustomEvent("medos:reader-active-change"));
    };
  }, [mode]);

  useEffect(() => {
    const onSelection = () => {
      const text = window.getSelection()?.toString().replace(/\s+/g, " ").trim() || "";
      if (text && text.length <= 180) {
        setSelectedText(text);
        setSearchTerm(text);
      }
    };
    document.addEventListener("mouseup", onSelection);
    document.addEventListener("keyup", onSelection);
    return () => {
      document.removeEventListener("mouseup", onSelection);
      document.removeEventListener("keyup", onSelection);
    };
  }, []);

  // Bank catalog (UWorld steps · NBME steps→forms · CMS subjects→forms) drives
  // the hierarchical Question Type navigator.
  useEffect(() => {
    fetch(`${backend}/qbank/banks`).then(r => r.json()).then(setCatalog).catch(console.error);
  }, [backend]);

  // Stats are fetched per selected bank (and merged) so we never have to decrypt
  // all 50+ NBME/CMS forms up front just to render counts.
  useEffect(() => {
    fetch(`${backend}/qbank/stats?db=${encodeURIComponent(db)}`)
      .then(r => r.json())
      .then((data: Record<string, QBankStats>) => setStats(prev => ({ ...(prev || {}), ...data })))
      .catch(console.error);
  }, [backend, db]);

  // Report current question to backend so the extension can auto-load the topic
  useEffect(() => {
    if (!active) return;
    const q = active.questions[active.current];
    if (!q) return;
    const term = q.title || q.subject || "";
    if (!term) return;
    recordRecent({
      tag: "QB",
      label: q.title || `${q.subject || q.system || "UWorld"} question #${q.id}`,
      href: `/qbank?db=${active.db}`,
      source: "qbank",
      kind: "qbank",
      detail: `${active.db.toUpperCase()} · Question ${active.current + 1}/${active.questions.length}`,
    });
    fetch(`${backend}/session/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_term: term,
        current_source: "qbank",
        current_id: String(q.id),
        current_title: q.title || "",
        qbank_active: true,
        db: active.db,
      }),
    }).catch(() => {});
  }, [backend, active?.id, active?.current]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch(`${backend}/qbank/subjects?db=${db}`).then(r => r.json()).then(setSubjects).catch(console.error);
    fetch(`${backend}/qbank/tags?db=${db}&limit=48`).then(r => r.json()).then(setTags).catch(console.error);
    setSelectedSubjectIds(new Set());
    setImagesOnly(false);
  }, [backend, db]);

  // Select a bank from the Question Type navigator: switch the active db, record
  // its metadata (drives which scope picker shows), and clear bank-specific scope.
  const selectBank = useCallback((key: DB, meta: BankMeta) => {
    setDb(key);
    setBankMeta(meta);
    writeQbankSelection(window.localStorage, { db: key, meta });
    setSubjectFilter("");
    setSelectedSubjectIds(new Set());
    setSelectedSystemIds(new Set());
    setSelectedBlockIds(new Set());
    setPool("unused");
    setImagesOnly(false);
    if ((meta.category === "uworld" || meta.category === "amboss") && (meta.step === 1 || meta.step === 2 || meta.step === 3)) {
      const nextStep = String(meta.step) as StudyStepPref;
      setStudyStep(nextStep);
      try {
        const current = JSON.parse(window.localStorage.getItem(MEDOS_SETTINGS_KEY) || "{}") as Record<string, unknown>;
        window.localStorage.setItem(MEDOS_SETTINGS_KEY, JSON.stringify({ ...current, studyStep: nextStep }));
        window.localStorage.setItem("medos.studyStep.v1", nextStep);
      } catch {
        // non-blocking preference write
      }
    }
    // NBME/CMS forms are taken as full timed exams; UWorld defaults to tutor.
    if (meta.category === "nbme" || meta.category === "cms") setTestMode("exam");
    setMode("home");
  }, []);

  const selectDailySource = useCallback((family: SourceFamily) => {
    const key = dbForSourceFamily(family, studyStep);
    const meta = dailyBankMeta(key);
    if (meta) selectBank(key, meta);
    setOpenBankNodes(previous => {
      const next = new Set(previous);
      next.add(family);
      return next;
    });
  }, [selectBank, studyStep]);

  const toggleBankNode = useCallback((id: string) => {
    setOpenBankNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    // Fetch the full system list for the current db/subject so the multi-select
    // tree can show every group and subsystem with counts in one shot.
    const params = new URLSearchParams({ db });
    if (subjectFilter) params.set("subject_id", subjectFilter);
    fetch(`${backend}/qbank/systems?${params}`).then(r => r.json()).then(setSystems).catch(console.error);
    setSystemFilter("");
    // Reset the tree selection whenever the scope (db/subject) changes — system
    // ids are not comparable across banks.
    setSelectedSystemIds(new Set());
  }, [backend, db, subjectFilter]);

  // When the Review tab is open, fetch per-bank "total available" counts for every
  // daily Q-bank the user has touched, so the progression table can show usage
  // (done / available) and how many questions are still pending per group.
  useEffect(() => {
    if (workspaceTab !== "review") return;
    const banks = Array.from(new Set([
      ...sessions.filter(s => s.completedAt && isDailyQbankDb(s.db)).map(s => s.db),
      ...(isDailyQbankDb(db) ? [db] : []),
    ]));
    let cancelled = false;
    const toMap = (rows: unknown): Record<string, number> => {
      const map: Record<string, number> = {};
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && typeof row.name === "string") map[row.name] = Number(row.count) || 0;
        }
      }
      return map;
    };
    for (const bankDb of banks) {
      if (reviewFacets[bankDb]) continue; // already loaded
      const q = encodeURIComponent(bankDb);
      Promise.all([
        fetch(`${backend}/qbank/subjects?db=${q}`).then(r => r.json()).catch(() => []),
        fetch(`${backend}/qbank/system-groups?db=${q}`).then(r => r.json()).catch(() => []),
        fetch(`${backend}/qbank/topics?db=${q}`).then(r => r.json()).catch(() => []),
        fetch(`${backend}/qbank/stats?db=${q}`).then(r => r.json()).catch(() => ({})),
      ]).then(([subjectRows, systemRows, topicRows, statRows]) => {
        if (cancelled) return;
        const statEntry = statRows && typeof statRows === "object" ? (statRows as Record<string, QBankStats>)[bankDb] : undefined;
        setReviewFacets(prev => ({
          ...prev,
          [bankDb]: {
            total: statEntry?.valid_count || statEntry?.count || 0,
            subjects: toMap(subjectRows),
            systems: toMap(systemRows),
            topics: toMap(topicRows),
          },
        }));
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [backend, workspaceTab, sessions, db]); // eslint-disable-line react-hooks/exhaustive-deps

  // Group the flat system list into Bootcamp-style groups → subsystems.
  // "Biochemistry (Cellular)" → group "Biochemistry", subsystem "Cellular".
  const systemTree = useMemo(() => {
    const groups = new Map<string, { name: string; count: number; children: { id: number; label: string; count: number }[] }>();
    for (const s of systems) {
      const group = (s.name || "").replace(/\s*\([^)]*\)\s*$/, "").trim() || s.name || "Other";
      const detailMatch = /\(([^)]*)\)\s*$/.exec(s.name || "");
      const label = (detailMatch ? detailMatch[1] : s.name || "").trim() || group;
      if (!groups.has(group)) groups.set(group, { name: group, count: 0, children: [] });
      const entry = groups.get(group)!;
      entry.children.push({ id: s.id, label, count: s.count || 0 });
      if (typeof s.group_count === "number") entry.count = s.group_count;
      else entry.count += s.count || 0;
    }
    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [systems]);

  const selectedSystemNames = useMemo(
    () => systems.filter(s => selectedSystemIds.has(s.id)).map(s => s.name),
    [systems, selectedSystemIds],
  );
  const selectedSubjectNames = useMemo(
    () => subjects.filter(s => selectedSubjectIds.has(s.id)).map(s => s.name),
    [subjects, selectedSubjectIds],
  );

  // QIDs the user answered incorrectly in completed blocks for this db — drives
  // the "Incorrect" question pool. Lifted to a memo so filteredParams can read it.
  const incorrectIds = useMemo(() => Array.from(new Set(
    sessions
      .filter(s => s.completedAt && s.db === db)
      .flatMap(session => Object.entries(session.answers)
        .filter(([i, answer]) => session.questions[+i] && session.questions[+i].correct - 1 !== answer)
        .map(([i]) => session.questions[+i].id))
  )), [sessions, db]);

  const filteredParams = useCallback((limit = batchSize, overrides: Partial<{ query: string; tag: string }> = {}) => {
    const effectiveQuery = overrides.query ?? query;
    const effectiveTag = overrides.tag ?? tag;
    const params = new URLSearchParams({ db, limit: String(limit), page: "1", valid_only: "true", sort });
    if (bankMeta.category === "uworld" || bankMeta.category === "amboss") {
      if (selectedSubjectIds.size) params.set("subject_ids", Array.from(selectedSubjectIds).join(","));
      else if (subjectFilter) params.set("subject_id", subjectFilter);
      if (selectedSystemIds.size) params.set("system_ids", Array.from(selectedSystemIds).join(","));
    } else if (selectedBlockIds.size) {
      // NBME/CMS forms: scope by selected Block(s) → subject_ids.
      params.set("subject_ids", Array.from(selectedBlockIds).join(","));
    }
    if (imagesOnly) params.set("images_only", "true");
    if (effectiveQuery.trim()) params.set("q", effectiveQuery.trim());
    if (effectiveTag) params.set("tag", effectiveTag);
    // Question pool — restrict the draw to a learning state.
    if (pool === "marked") {
      const ids = markedIdsByDb[db] || [];
      params.set("include_ids", ids.length ? ids.join(",") : "-1");
    } else if (pool === "incorrect") {
      params.set("include_ids", incorrectIds.length ? incorrectIds.join(",") : "-1");
    } else if (pool === "unused") {
      const usedIds = usedIdsByDb[db] || [];
      if (usedIds.length) params.set("exclude_ids", usedIds.join(","));
    }
    return params;
  }, [bankMeta.category, batchSize, db, imagesOnly, incorrectIds, markedIdsByDb, pool, query, selectedBlockIds, selectedSubjectIds, selectedSystemIds, sort, subjectFilter, tag, usedIdsByDb]);

  const applyActiveSession = useCallback((session: Session | null) => {
    const normalized = session ? normalizeSession(session) : null;
    activeRef.current = normalized;
    setActive(normalized);
    const examOverlayActive = normalized?.mode === "exam" && !normalized.completedAt;
    setExamPaused(Boolean(examOverlayActive && normalized.examPaused));
    setExamLocked(Boolean(examOverlayActive && normalized.examLocked));
  }, []);

  const persistActive = useCallback((next: Session) => {
    const normalized = normalizeSession(next);
    applyActiveSession(normalized);
    saveExamTimerSnapshot(normalized);
    const nextSessions = [normalized, ...sessions.filter(s => s.id !== normalized.id)];
    saveSessions(nextSessions);
    setSessions(nextSessions);
    persistSessionToBackend(normalized);
  }, [applyActiveSession, sessions]);

  // Re-hydrate rich HTML for questions loaded from storage. Stems, choices, and
  // revealed explanations are checked independently so a saved rich stem never
  // prevents a missing explanation from being restored.
  useEffect(() => {
    if (!activeSessionId || !activeDbKey || activeCurrentIndex < 0 || (mode !== "quiz" && mode !== "results")) return;
    const q = activeCurrentQuestion;
    if (!q) return;
    const missingStemHtml = !q.stem_html || !hasChoicesHtml(q);
    const shouldPersistCurrentExplanation = Boolean(
      activeModeKey === "tutor" &&
        (activeCompletedAtKey || activeCurrentRevealed || activeCurrentAnswer !== undefined)
    );
    const shouldPreloadTutorExplanation = activeModeKey === "tutor" && !q.explanation_html;
    const missingExplanationHtml =
      (shouldPersistCurrentExplanation || shouldPreloadTutorExplanation) && !q.explanation_html;
    if (!missingStemHtml && !missingExplanationHtml) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const delays = [0, 1500, 3000, 6000];

    const doFetch = () => {
      fetch(`${backend}/qbank/question/${q.id}?db=${activeDbKey}`)
        .then(r => r.ok ? r.json() : null)
        .then((fresh: Question | null) => {
          if (cancelled) return;
          if (!fresh) {
            attempt++;
            if (attempt < delays.length) retryTimer = setTimeout(doFetch, delays[attempt]);
            return;
          }
          const current = activeRef.current;
          if (!current || current.id !== activeSessionId || current.db !== activeDbKey || current.current !== activeCurrentIndex) return;
          // The backend has definitively answered for this question — clear the
          // "Loading formatted references…" spinner now, even if explanation_html
          // came back empty (it then falls back to the plain explanation). Done
          // BEFORE the no-op early-return below so an empty/unchanged response can
          // never leave the spinner stuck.
          if (current.mode === "tutor") markExplanationResolved(activeDbKey, q.id);
          const keepExplanationHtml = shouldPersistExplanationHtml(current, activeCurrentIndex) || current.mode === "tutor";
          const updatedQuestions = current.questions.map((existing, i) =>
            i === activeCurrentIndex && existing.id === q.id ? {
              ...existing,
              stem_html: fresh.stem_html || existing.stem_html,
              choices_html: fresh.choices_html?.length ? fresh.choices_html : existing.choices_html,
              explanation_html: keepExplanationHtml ? fresh.explanation_html || existing.explanation_html : undefined,
            } : existing
          );
          const previousQuestion = current.questions[activeCurrentIndex];
          const updatedQuestion = updatedQuestions[activeCurrentIndex];
          if (
            !updatedQuestion ||
            (previousQuestion.stem_html === updatedQuestion.stem_html &&
              previousQuestion.choices_html === updatedQuestion.choices_html &&
              previousQuestion.explanation_html === updatedQuestion.explanation_html)
          ) return;
          const updatedSession = normalizeSession({ ...current, questions: updatedQuestions, updatedAt: new Date().toISOString() });
          if (updatedSession.transient) {
            applyActiveSession(updatedSession);
          } else {
            applyActiveSession(updatedSession);
            window.setTimeout(() => {
              const latest = activeRef.current;
              if (!latest || latest.id !== updatedSession.id) return;
              saveSessions([latest, ...loadSessions().filter(session => session.id !== latest.id)]);
              persistSessionToBackend(latest);
            }, 0);
          }
        })
        .catch(() => {
          if (cancelled) return;
          attempt++;
          if (attempt < delays.length) retryTimer = setTimeout(doFetch, delays[attempt]);
        });
    };

    doFetch();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    activeSessionId,
    activeDbKey,
    activeCurrentIndex,
    activeModeKey,
    activeCompletedAtKey,
    activeCurrentAnswer,
    activeCurrentRevealed,
    activeCurrentQuestion,
    activeCurrentQuestionId,
    activeCurrentStemHtml,
    activeCurrentChoicesHtmlCount,
    activeCurrentExplanationHtml,
    applyActiveSession,
    markExplanationResolved,
    backend,
    mode,
  ]);

  // Safety net for the "Loading formatted references…" spinner. The rehydrate
  // fetch above marks a question resolved as soon as the backend answers, but if
  // it NEVER lands (cold/slow/frozen backend, all retries exhausted) the spinner
  // would otherwise hang forever — the exact bug that keeps resurfacing. Here we
  // force-resolve after a grace period so the plain-text explanation is shown
  // instead. Depends only on stable per-question primitives, so the 1 Hz exam
  // timer can't keep re-arming (and thus never firing) this timeout.
  useEffect(() => {
    if (mode !== "quiz" || activeModeKey !== "tutor" || !activeDbKey || !activeCurrentQuestionId) return;
    const wantsExplanation = Boolean(activeCompletedAtKey || activeCurrentRevealed || activeCurrentAnswer !== undefined);
    if (!wantsExplanation || activeCurrentExplanationHtml) return;
    if (activeCurrentExplanationResolved) return;
    const dbKey = activeDbKey;
    const qid = activeCurrentQuestionId;
    const timer = window.setTimeout(() => markExplanationResolved(dbKey, qid), 10000);
    return () => window.clearTimeout(timer);
  }, [
    mode,
    activeModeKey,
    activeDbKey,
    activeCurrentQuestionId,
    activeCompletedAtKey,
    activeCurrentRevealed,
    activeCurrentAnswer,
    activeCurrentExplanationHtml,
    activeCurrentExplanationResolved,
    markExplanationResolved,
  ]);

  // Bulk-prefetch all missing explanation_html when a completed block is opened.
  // Runs once per session open (keyed on active.id + completedAt), fetches up to
  // 20 questions at a time via the batch endpoint, then applies results live so
  // the user never sees "Loading formatted explanation…" while navigating.
  useEffect(() => {
    // Runs for BOTH completed tutor blocks and completed exam blocks so exam review
    // can show explanations (they were stripped during the live block).
    if (!active?.completedAt) return;
    if (mode !== "quiz" && mode !== "results") return;
    const missingQids = missingExplanationQidsForPrefetch(active);
    if (!missingQids.length) return;

    const sessionId = active.id;
    const db = active.db;
    let cancelled = false;
    const CHUNK = 20;

    (async () => {
      for (let i = 0; i < missingQids.length && !cancelled; i += CHUNK) {
        const chunk = missingQids.slice(i, i + CHUNK);
        const snapshot = activeRef.current;
        if (!snapshot || snapshot.id !== sessionId) break;
        try {
          const r = await fetch(`${backend}/qbank/questions/batch?ids=${chunk.join(",")}&db=${db}`);
          if (!r.ok || cancelled) continue;
          const freshList: Question[] = await r.json();
          if (cancelled) break;
          const c = activeRef.current;
          if (!c || c.id !== sessionId) break;
          const freshById = new Map(freshList.map(q => [q.id, q]));
          const updatedQs = c.questions.map(q => {
            const fresh = freshById.get(q.id);
            if (!fresh || q.explanation_html) return q;
            return { ...q, explanation_html: fresh.explanation_html || undefined, explanation_media: fresh.explanation_media };
          });
          applyActiveSession(normalizeSession({ ...c, questions: updatedQs }));
        } catch {
          // non-critical background prefetch — ignore errors
        }
      }
      // Persist once at the end so next open is instant (no re-fetch needed)
      if (!cancelled) {
        const c = activeRef.current;
        if (c?.id === sessionId && c.completedAt) persistSessionToBackend(normalizeSession(c));
      }
    })();
    return () => { cancelled = true; };
  }, [active?.id, active?.completedAt, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const flushActiveSessionSnapshot = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.transient) return;
    const now = new Date().toISOString();
    const snapshot = normalizeSession({
      ...current,
      updatedAt: now,
      timerSavedAt: typeof (current.timeRemainingSec ?? current.examTimeRemainingSec) === "number" ? now : current.timerSavedAt,
    });
    saveExamTimerSnapshot(snapshot);
    saveSessions([snapshot, ...loadSessions().filter(session => session.id !== snapshot.id)]);
    persistSessionToBackend(snapshot);
  }, []);

  useEffect(() => {
    const flush = () => flushActiveSessionSnapshot();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushActiveSessionSnapshot();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flushActiveSessionSnapshot]);

  const setPrepProgressTracking = useCallback((track: boolean) => {
    setTrackPrepProgress(track);
    saveTrackingPreference(track);
    persistProgressToBackend(usedIdsByDb, markedIdsByDb, track);
  }, [markedIdsByDb, usedIdsByDb]);

  const recordUsedQuestions = useCallback((targetDb: DB, questions: Question[]) => {
    const ids = questions.map(question => question.id).filter(qid => Number.isInteger(qid) && qid > 0);
    if (!ids.length) return;
    setUsedIdsByDb(previous => {
      const merged = Array.from(new Set([...(previous[targetDb] || []), ...ids])).sort((a, b) => a - b);
      if (merged.length === (previous[targetDb] || []).length) return previous;
      const next = { ...previous, [targetDb]: merged };
      saveUsedQuestionIds(next);
      persistProgressToBackend(next, markedIdsByDb, trackPrepProgress);
      return next;
    });
  }, [markedIdsByDb, trackPrepProgress]);

  const setQuestionMarkedForRevision = useCallback((targetDb: DB, qid: number, marked: boolean) => {
    if (!Number.isInteger(qid) || qid <= 0) return;
    setMarkedIdsByDb(previous => {
      const current = previous[targetDb] || [];
      const nextIds = marked
        ? Array.from(new Set([...current, qid])).sort((a, b) => a - b)
        : current.filter(item => item !== qid);
      if (nextIds.length === current.length && nextIds.every((item, index) => item === current[index])) return previous;
      const next = { ...previous, [targetDb]: nextIds };
      saveMarkedQuestionIds(next);
      persistProgressToBackend(usedIdsByDb, next, trackPrepProgress);
      return next;
    });
  }, [trackPrepProgress, usedIdsByDb]);

  const resetCurrentQbankProgress = useCallback(() => {
    const label = prettyDbLabel(db);
    const confirmed = window.confirm(
      `Reset ${label} prep progress?\n\nThis clears the used-QID tally and deletes saved test blocks for ${label} from permanent Q-bank memory. Marked questions are kept.`
    );
    if (!confirmed) return;
    const nextSessions = loadSessions().filter(session => session.db !== db);
    saveSessions(nextSessions);
    setSessions(nextSessions);
    setUsedIdsByDb(previous => {
      const next = { ...previous, [db]: [] };
      saveUsedQuestionIds(next);
      return next;
    });
    if (active?.db === db) {
      applyActiveSession(null);
      setMode("home");
    }
    qbankStateFetch("/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ db, sessions: true, used_ids: true, marked_ids: false }),
    })
      .then(r => r.ok ? r.json() : null)
      .then((state: QBankBackendState | null) => {
        if (!state) return;
        const nextBackendSessions = (state.sessions || []).map(normalizeSession);
        setSessions(nextBackendSessions);
        setUsedIdsByDb(normalizeUsedQbankProgress(state.usedIdsByDb));
        setMarkedIdsByDb(normalizeUsedQbankProgress(state.markedIdsByDb));
        saveSessions(nextBackendSessions);
        saveUsedQuestionIds(normalizeUsedQbankProgress(state.usedIdsByDb));
        saveMarkedQuestionIds(normalizeUsedQbankProgress(state.markedIdsByDb));
      })
      .catch(() => {});
  }, [active?.db, applyActiveSession, db]);

  const setStudyStepPreference = useCallback((step: StudyStepPref) => {
    setStudyStep(step);
    setSubjectFilter("");
    setSelectedSubjectIds(new Set());
    setSelectedSystemIds(new Set());
    setSelectedBlockIds(new Set());
    setDb(current => {
      const aligned = alignBankToStudyStep(current, step);
      const meta = dailyBankMeta(aligned);
      if (meta) {
        setBankMeta(meta);
        writeQbankSelection(window.localStorage, { db: aligned, meta });
      }
      return aligned;
    });
    setOpenBankNodes(previous => {
      const next = new Set(previous);
      next.add("uworld");
      next.add("amboss");
      return next;
    });
    try {
      const current = JSON.parse(window.localStorage.getItem(MEDOS_SETTINGS_KEY) || "{}") as Record<string, unknown>;
      const next = { ...current, studyStep: step };
      window.localStorage.setItem(MEDOS_SETTINGS_KEY, JSON.stringify(next));
      window.localStorage.setItem("medos.studyStep.v1", step);
      window.dispatchEvent(new CustomEvent("medos:settings-changed", { detail: next }));
    } catch {
      // Settings remain usable for this session even if localStorage is unavailable.
    }
  }, []);

  const loadBrowse = useCallback(async (overrides: Partial<{ query: string; tag: string }> = {}) => {
    setLoading(true);
    try {
      const params = filteredParams(60, overrides);
      if (params.get("sort") === "random") params.set("sort", "id");
      const data = await fetch(`${backend}/qbank/list?${params}`).then(r => r.json());
      setBrowse(data.questions || []);
      setTotal(data.total || 0);
      setMode("browse");
    } finally {
      setLoading(false);
    }
  }, [backend, filteredParams]);

  const startSession = useCallback(async (single?: Question) => {
    setLoading(true);
    try {
      let questions = single ? [single] : [];
      let found = 1;
      const shouldTrackBlock = !single && trackPrepProgress;
      if (!single) {
        if (pool === "marked" && !(markedIdsByDb[db] || []).length) {
          alert(`No marked questions saved for ${prettyDbLabel(db)} yet.`);
          return;
        }
        if (pool === "incorrect" && !incorrectIds.length) {
          alert(`No incorrect questions saved for ${prettyDbLabel(db)} yet.`);
          return;
        }
        const params = filteredParams(allMatched ? ALL_MATCHED_PAGE : batchSize);
        // Abort rather than spin forever: right after app launch the backend
        // can be busy warming caches, and an unbounded fetch left this button
        // on an infinite spinner with no feedback.
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), allMatched ? 180000 : 30000);
        try {
          if (allMatched) {
            const collected = await collectAllMatchedQuestions(backend, params, controller.signal);
            if (collected.cancelled) return;
            questions = orderAllMatched(collected.questions, sort);
            found = collected.total || questions.length;
          } else {
            const data = await fetch(`${backend}/qbank/list?${params}`, { signal: controller.signal }).then(r => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.json();
            });
            questions = data.questions || [];
            found = data.total || questions.length;
          }
        } finally {
          window.clearTimeout(timer);
        }
      }
      if (!questions.length) {
        alert(pool === "marked"
          ? "No marked questions match those filters."
          : pool === "unused"
          ? "No unused questions remain for those filters. Switch the pool to All or reset this Q-bank's progress."
          : "No valid questions found for those filters.");
        return;
      }
      const now = new Date().toISOString();
      const session: Session = {
        id: `${Date.now()}`,
        db,
        createdAt: now,
        updatedAt: now,
        mode: testMode,
        trackedPrep: shouldTrackBlock,
        allMatched: allMatched || undefined,
        blockLabel: single ? undefined : (sessionName.trim() || undefined),
        filters: {
          subject: subjectFilter, systemGroup: systemGroupFilter, system: systemFilter, query, tag, sort,
          subjects: Array.from(selectedSubjectIds),
          subjectNames: selectedSubjectNames,
          systems: Array.from(selectedSystemIds),
          systemNames: selectedSystemNames,
          pool,
          imagesOnly,
        },
        questions,
        current: 0,
        answers: {},
        revealed: {},
        marked: markedMapForQuestions(questions, markedIdsByDb[db] || []),
        eliminated: {},
        notes: {},
        questionStartedAt: { 0: now },
        questionTimeSec: {},
        activity: [{
          event: "start",
          createdAt: now,
          detail: `${questions.length} question ${testMode} block`,
        }],
        ...initialExamFields(
          testMode,
          now,
          (allMatched ? examMinutesForCount(questions.length) : examMinutes) * 60,
        ),
      };
      setTotal(found);
      if (shouldTrackBlock) recordUsedQuestions(db, questions);
      persistActive(session);
      if (testMode === "exam") {
        setExamLabsOpen(false);
        setExamNotesOpen(false);
        setExamCalculatorOpen(false);
        setExamNavigatorOpen(true);
        setExamPaused(false);
        setExamLocked(false);
        setExamStatusOpen(false);
      }
      setMode("quiz");
      setSessionName("");
    } catch (error) {
      console.error(error);
      if (error instanceof DOMException && error.name === "AbortError") {
        alert("The backend is still warming up (this can take a minute or two right after launch). Wait a moment and press Start again.");
      } else {
        alert("Could not start the block. Check that the Q-bank backend is running, then try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [allMatched, backend, batchSize, db, examMinutes, filteredParams, imagesOnly, incorrectIds, markedIdsByDb, persistActive, pool, query, recordUsedQuestions, selectedSubjectIds, selectedSubjectNames, selectedSystemIds, selectedSystemNames, sessionName, sort, subjectFilter, systemFilter, systemGroupFilter, tag, testMode, trackPrepProgress]);

  // ── Multi-block NBME exam engine ──────────────────────────────────────────
  const requestExamFullscreen = useCallback(() => {
    try {
      if (typeof document === "undefined" || document.fullscreenElement) return;
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      const p = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* fullscreen denied */ }
  }, []);
  const exitExamFullscreen = useCallback(() => {
    try { if (typeof document !== "undefined" && document.fullscreenElement) { const p = document.exitFullscreen?.(); if (p && typeof p.catch === "function") p.catch(() => {}); } } catch { /* */ }
  }, []);

  // Persist the live block back into the exam run so a reload restores answers.
  const syncBlockToRun = useCallback((session: Session) => {
    const run = examRunRef.current;
    if (!run || !session.examId || session.examId !== run.id) return;
    const idx = session.examBlockIndex ?? run.currentBlock;
    const next: ExamRun = { ...run, blocks: run.blocks.map((b, i) => i === idx ? session : b), updatedAt: new Date().toISOString() };
    examRunRef.current = next;
    setExamRun(next);
    saveExamRun(next);
  }, []);

  const beginExamBlock = useCallback((session: Session) => {
    setExamLabsOpen(false); setExamNotesOpen(false); setExamCalculatorOpen(false);
    setExamNavigatorOpen(true); setExamPaused(false); setExamLocked(false); setExamStatusOpen(false);
    applyActiveSession(session);
    saveExamTimerSnapshot(session);
    setMode("quiz");
  }, [applyActiveSession]);

  // Append a finished exam to the persistent NBME exam history (for progression).
  const recordExamResult = useCallback((run: ExamRun, complete: boolean) => {
    const summary = summarizeExam(run);
    const parsed = parseNbmeKey(run.db);
    const entry: ExamHistoryEntry = {
      id: run.id, db: run.db, label: run.label,
      step: parsed?.step ?? null, form: parsed?.form ?? null,
      structure: run.structure, completedAt: new Date().toISOString(), complete,
      totalQuestions: summary.totalQuestions, correct: summary.correct, wrong: summary.wrong, omitted: summary.omitted,
      percentCorrect: summary.percentCorrect, predictedScore: summary.prediction?.score ?? null, blockCount: run.blockCount,
    };
    setExamHistory(prev => {
      const next = [entry, ...prev.filter(e => e.id !== entry.id)];
      saveExamHistory(next);
      return next;
    });
  }, []);

  // A block ended (timer expired or End Block). Record it on the run, then go to
  // the break screen, or finish the exam after the last block.
  const advanceAfterBlock = useCallback((finished: Session) => {
    const run = examRunRef.current;
    if (!run || !finished.examId || finished.examId !== run.id) { setMode("results"); return; }
    const idx = finished.examBlockIndex ?? run.currentBlock;
    const now = new Date().toISOString();
    const blocks = run.blocks.map((b, i) => (i === idx ? { ...b, ...finished, completedAt: finished.completedAt || now } : b));
    if (idx + 1 >= run.blockCount) {
      const done: ExamRun = { ...run, blocks, currentBlock: run.blockCount - 1, phase: "done", updatedAt: now };
      examRunRef.current = done; setExamRun(done); saveExamRun(done);
      recordExamResult(done, true);
      exitExamFullscreen();
      setMode("results");
    } else {
      const breakSec = EXAM_BREAK_SECONDS[run.structure];
      const next: ExamRun = { ...run, blocks, currentBlock: idx, phase: "break", breakRemainingSec: breakSec, breakTotalSec: breakSec, breakSavedAt: now, updatedAt: now };
      examRunRef.current = next; setExamRun(next); saveExamRun(next);
      setMode("break");
    }
  }, [exitExamFullscreen, recordExamResult]);

  const startNextBlock = useCallback(() => {
    const run = examRunRef.current;
    if (!run) return;
    const idx = run.currentBlock + 1;
    if (idx >= run.blockCount) { setMode("results"); return; }
    const now = new Date().toISOString();
    const next: ExamRun = { ...run, currentBlock: idx, phase: "block", breakRemainingSec: undefined, breakSavedAt: undefined, updatedAt: now };
    examRunRef.current = next; setExamRun(next); saveExamRun(next);
    requestExamFullscreen();
    beginExamBlock(run.blocks[idx]);
  }, [beginExamBlock, requestExamFullscreen]);

  const buildExam = useCallback(async (structure: "native" | "chunked") => {
    // Request fullscreen SYNCHRONOUSLY here — this runs inside the button's click
    // gesture. Requesting it later (after the awaits below) fails silently because
    // the browser has lost the user-activation the Fullscreen API requires.
    requestExamFullscreen();
    setLoading(true);
    const label = bankMeta.label || prettyDbLabel(db);
    try {
      const blockSubjects = subjects.filter(s => (s.count || 0) > 0);
      if (!blockSubjects.length) { exitExamFullscreen(); alert("This form has no questions available yet."); return; }
      const perBlock: Question[][] = [];
      for (const bs of blockSubjects) {
        const p = new URLSearchParams({ db, valid_only: "true", sort: "id", limit: "100", page: "1", subject_ids: String(bs.id) });
        const data = await fetch(`${backend}/qbank/list?${p}`).then(r => (r.ok ? r.json() : { questions: [] }));
        perBlock.push(data.questions || []);
      }
      const blocks: Question[][] = [];
      const blockNames: string[] = [];
      if (structure === "native") {
        perBlock.forEach((qs, i) => { if (qs.length) { blocks.push(qs); blockNames.push(blockSubjects[i]?.name || `Block ${blocks.length}`); } });
      } else {
        const all = perBlock.flat();
        for (let i = 0; i < all.length; i += 20) { blocks.push(all.slice(i, i + 20)); blockNames.push(`Block ${blocks.length}`); }
      }
      if (!blocks.length || !blocks[0].length) { exitExamFullscreen(); alert("No questions available for this form."); return; }
      const now = new Date().toISOString();
      const examId = `exam-${Date.now()}`;
      const blockSessions: Session[] = blocks.map((qs, i) => {
        const minutes = Math.max(1, Math.round(qs.length * EXAM_MIN_PER_Q));
        const sid = `${examId}-b${i}`;
        return {
          id: sid, db, createdAt: now, updatedAt: now, mode: "exam" as TestMode, trackedPrep: false,
          examId, examBlockIndex: i, examBlockCount: blocks.length, examBlockLabel: blockNames[i],
          blockLabel: `${label} · ${blockNames[i]} (${i + 1}/${blocks.length})`,
          filters: { subject: "", systemGroup: "", system: "", query: "", tag: "", sort: "id" },
          questions: qs, current: 0, answers: {}, revealed: {}, marked: {}, eliminated: {}, notes: {},
          questionStartedAt: { 0: now }, questionTimeSec: {},
          activity: [{ event: "start" as const, createdAt: now, detail: `${blockNames[i]} · ${qs.length} questions` }],
          ...initialExamFields("exam", now, minutes * 60),
        };
      });
      const run: ExamRun = {
        id: examId, db, label, structure,
        blockCount: blocks.length, currentBlock: 0, blocks: blockSessions,
        phase: "block", createdAt: now, updatedAt: now,
      };
      examRunRef.current = run; setExamRun(run); saveExamRun(run);
      beginExamBlock(blockSessions[0]);
    } catch (e) {
      console.error(e);
      exitExamFullscreen();
      alert("Could not start the exam. Check that the Q-bank backend is running, then try again.");
    } finally {
      setLoading(false);
    }
  }, [backend, db, subjects, bankMeta, beginExamBlock, requestExamFullscreen, exitExamFullscreen]);

  const endExamRun = useCallback(() => {
    const run = examRunRef.current;
    if (run) {
      const done: ExamRun = { ...run, phase: "done", endedEarly: true, updatedAt: new Date().toISOString() };
      examRunRef.current = done; setExamRun(done); saveExamRun(done);
      recordExamResult(done, false);
    }
    exitExamFullscreen();
    setMode("results");
  }, [exitExamFullscreen, recordExamResult]);

  useEffect(() => {
    if (initialDeepLinkLoadedRef.current) return;
    const qid = Number(searchParams.get("qid") || "");
    if (!qid) return;
    const requestedDb = searchParams.get("db");
    const urlDb: DB = requestedDb || dbFromStepParam(searchParams.get("step"), "step2");
    initialDeepLinkLoadedRef.current = true;
    setDb(urlDb);
    const meta = dailyBankMeta(urlDb);
    if (meta) setBankMeta(meta);
    setLoading(true);
    fetch(`${backend}/qbank/question/${qid}?db=${urlDb}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((question: Question) => {
        const now = new Date().toISOString();
        const session: Session = {
          id: `${Date.now()}`,
          db: urlDb,
          createdAt: now,
          updatedAt: now,
          transient: true,
          mode: testMode,
          trackedPrep: false,
          filters: { subject: "", systemGroup: "", system: "", query: `QID ${qid}`, tag: "", sort: "id" },
          questions: [question],
          current: 0,
          answers: {},
          revealed: {},
          marked: markedMapForQuestions([question], markedIdsByDb[urlDb] || []),
          eliminated: {},
          notes: {},
          questionStartedAt: { 0: now },
          questionTimeSec: {},
          ...initialExamFields(testMode, now, examMinutesForCount(1) * 60),
        };
        setTotal(1);
        applyActiveSession(session);
        if (testMode === "exam") {
          setExamLabsOpen(false);
          setExamNotesOpen(false);
          setExamCalculatorOpen(false);
          setExamStatusOpen(false);
        }
        setMode("quiz");
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [applyActiveSession, backend, markedIdsByDb, searchParams, testMode]);

  useEffect(() => {
    if (initialDeepLinkLoadedRef.current) return;
    if (searchParams.get("qid")) return;
    // Sidebar Q-Bank navigator drives bank/category selection via the effect
    // below; don't let the default UWorld block selection override it.
    if (searchParams.get("bank") || searchParams.get("cat")) return;

    const requestedDb = searchParams.get("db");
    const requestedStep = searchParams.get("step");
    const stepDb = (isDailyQbankDb(requestedDb || "") || isDirectSourceQbankDb(requestedDb || ""))
      ? requestedDb as DB
      : requestedStep ? dbFromStepParam(requestedStep, db) : db;
    const topicQuery = queryFromTopicParam(searchParams.get("topic"));
    const urlMode = testModeFromParam(searchParams.get("mode"));
    const shouldStart = Boolean(topicQuery || searchParams.get("mode") || searchParams.get("start") === "1");
    const rawLimit = Number(searchParams.get("count") || searchParams.get("limit") || "40");
    const urlLimit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 40;

    setDb(stepDb);
    const meta = dailyBankMeta(stepDb);
    if (meta) {
      setBankMeta(meta);
      writeQbankSelection(window.localStorage, { db: stepDb, meta });
    }
    setTestMode(urlMode);
    setBatchSize(urlLimit);
    if (topicQuery) setQuery(topicQuery);
    if (!shouldStart) return;

    initialDeepLinkLoadedRef.current = true;
    setSort("random");
    setSubjectFilter("");
    setSystemGroupFilter("");
    setSystemFilter("");
    setTag("");
    setLoading(true);

    const params = new URLSearchParams({
      db: stepDb,
      limit: String(urlLimit),
      page: "1",
      valid_only: "true",
      sort: "random",
    });
    if (topicQuery) params.set("q", topicQuery);
    const usedIds = usedIdsByDb[stepDb] || [];
    if (trackPrepProgress && usedIds.length) params.set("exclude_ids", usedIds.join(","));

    fetch(`${backend}/qbank/list?${params}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { total?: number; questions?: Question[] }) => {
        const questions = data.questions || [];
        if (!questions.length) {
          alert(trackPrepProgress
            ? "No unused questions remain for that dashboard block. Switch to Practice only or reset this Q-bank's progress."
            : "No valid questions found for that dashboard block.");
          return;
        }
        const now = new Date().toISOString();
        const session: Session = {
          id: `${Date.now()}`,
          db: stepDb,
          createdAt: now,
          updatedAt: now,
          mode: urlMode,
          trackedPrep: trackPrepProgress,
          filters: { subject: "", systemGroup: "", system: "", query: topicQuery, tag: "", sort: "random" },
          questions,
          current: 0,
          answers: {},
          revealed: {},
          marked: markedMapForQuestions(questions, markedIdsByDb[stepDb] || []),
          eliminated: {},
          notes: {},
          questionStartedAt: { 0: now },
          questionTimeSec: {},
          activity: [{
            event: "start",
            createdAt: now,
            detail: `${questions.length} question ${urlMode} block from dashboard`,
          }],
          ...initialExamFields(urlMode, now, examMinutesForCount(questions.length) * 60),
        };
        setTotal(data.total || questions.length);
        if (trackPrepProgress) recordUsedQuestions(stepDb, questions);
        persistActive(session);
        if (urlMode === "exam") {
          setExamLabsOpen(false);
          setExamNotesOpen(false);
          setExamCalculatorOpen(false);
          setExamNavigatorOpen(true);
          setExamPaused(false);
          setExamLocked(false);
          setExamStatusOpen(false);
        }
        setMode("quiz");
        window.history.replaceState({ qbankBlock: true }, "Q-Bank", `/qbank?db=${stepDb}`);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [backend, markedIdsByDb, persistActive, recordUsedQuestions, searchParams, trackPrepProgress, usedIdsByDb]);

  // Q-Bank navigator deep links from the sidebar:
  //   ?bank=step1|step2|step3|amboss1|amboss2|amboss3 → select that bank
  //   ?cat=nbme|cms                                   → open that category node
  // Runs on first mount and on same-page param changes (router.push), and is
  // independent of the one-shot deep-link guard above.
  const appliedBankTokenRef = useRef<string | null>(null);
  useEffect(() => {
    const bankParam = searchParams.get("bank");
    const catParam = searchParams.get("cat");
    const token = `${bankParam || ""}|${catParam || ""}`;
    if (token === "|") return;
    if (appliedBankTokenRef.current === token) return;
    appliedBankTokenRef.current = token;

    const m = /^(step|amboss)([123])$/.exec(bankParam || "");
    if (m) {
      const step = Number(m[2]);
      const isAmboss = m[1] === "amboss";
      selectBank(bankParam as DB, {
        category: isAmboss ? "amboss" : "uworld",
        step,
        label: DB_LABELS[bankParam as string] || (isAmboss ? `AMBOSS Step ${step}` : `UWorld STEP ${step}`),
      });
      setOpenBankNodes(prev => {
        const next = new Set(prev);
        next.add(isAmboss ? "amboss" : "uworld");
        return next;
      });
    } else if (bankParam && isDirectSourceQbankDb(bankParam)) {
      const meta = dailyBankMeta(bankParam);
      if (meta) selectBank(bankParam, meta);
      setOpenBankNodes(prev => {
        const next = new Set(prev);
        const category = directSourceCategory(bankParam);
        if (category) next.add(category);
        return next;
      });
    } else if (catParam === "nbme" || catParam === "cms" || catParam === "mehlman" || catParam === "boardvitals" || catParam === "mksap" || catParam === "abim") {
      setOpenBankNodes(prev => {
        const next = new Set(prev);
        next.add(catParam);
        return next;
      });
      setMode("home");
    }
  }, [searchParams, selectBank]);

  const updateSession = (recipe: (session: Session) => Session) => {
    const current = activeRef.current || active;
    if (!current) return;
    const next = recipe({ ...current, updatedAt: new Date().toISOString() });
    if (next.examId && examRunRef.current && next.examId === examRunRef.current.id) {
      // Exam block: keep it live in the UI and persist it inside the ExamRun so a
      // crash/reload restores the exact answers, marks, and position.
      applyActiveSession(next);
      saveExamTimerSnapshot(next);
      syncBlockToRun(next);
      return;
    }
    if (next.transient) {
      applyActiveSession(next);
      return;
    }
    persistActive(next);
  };

  const finishSession = useCallback((target: Session | null = active) => {
    if (!target) return;
    const now = new Date().toISOString();
    const timedTarget = finalizeQuestionTimers(target, now) as Session;
    const finished = appendSessionActivity(
      { ...timedTarget, completedAt: now, updatedAt: now, timerSavedAt: now, examPaused: false, examLocked: false },
      {
        event: "finish",
        elapsedSec: sessionElapsedSec(timedTarget, now),
        remainingSec: timedTarget.timeRemainingSec ?? timedTarget.examTimeRemainingSec,
        createdAt: now,
        detail: `${Object.keys(timedTarget.answers).length}/${timedTarget.questions.length} answered`,
      }
    );
    if (finished.examId && examRunRef.current && finished.examId === examRunRef.current.id) {
      // Block of a multi-block exam: record it and go to the break / next block.
      applyActiveSession(finished);
      advanceAfterBlock(finished);
      return;
    }
    if (finished.transient) applyActiveSession(finished);
    else persistActive(finished);
    setMode("results");
  }, [active, applyActiveSession, persistActive, advanceAfterBlock]);

  useEffect(() => {
    if (mode !== "quiz" || active?.mode !== "exam" || active.completedAt || active.examPaused || examPaused) return;
    const timer = window.setInterval(() => {
      const current = activeRef.current;
      if (!current || current.id !== active.id || current.mode !== "exam" || current.completedAt || current.examPaused) return;
      const total = current.examTotalSec ?? EXAM_BLOCK_SECONDS;
      const remaining = normalizeExamRemaining((current.timeRemainingSec ?? current.examTimeRemainingSec ?? total) - 1, total);
      const now = new Date().toISOString();
      const nextSnapshot: Session = {
        ...current,
        timeRemainingSec: remaining,
        examTimeRemainingSec: remaining,
        timerSavedAt: now,
        updatedAt: now,
        completedAt: remaining === 0 ? now : current.completedAt,
        examPaused: false,
      };
      const baseNext = remaining === 0 ? finalizeQuestionTimers(nextSnapshot, now) as Session : nextSnapshot;
      const next = remaining === 0
        ? appendSessionActivity(baseNext, {
            event: "finish",
            elapsedSec: sessionElapsedSec(current, now),
            remainingSec: 0,
            createdAt: now,
            detail: "Timer expired",
          })
        : baseNext;
      const isExamRun = Boolean(current.examId && examRunRef.current && current.examId === examRunRef.current.id);
      if (isExamRun) {
        // Exam blocks persist via the ExamRun (not the capped sessions store).
        // Per-second we only update the live timer snapshot; answers were saved
        // on each interaction.
        applyActiveSession(next);
        saveExamTimerSnapshot(next);
        if (remaining === 0) advanceAfterBlock(next);
      } else {
        if (next.transient) applyActiveSession(next);
        else persistActive(next);
        if (remaining === 0) setMode("results");
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active?.completedAt, active?.examPaused, active?.id, active?.mode, applyActiveSession, examPaused, mode, persistActive, advanceAfterBlock]);

  // Break countdown between exam blocks. Auto-starts the next block at zero; the
  // remaining time + breakSavedAt persist so a reload resumes the break clock.
  useEffect(() => {
    if (mode !== "break") return;
    const timer = window.setInterval(() => {
      const run = examRunRef.current;
      if (!run || run.phase !== "break") return;
      const rem = Math.max(0, (run.breakRemainingSec ?? 0) - 1);
      const upd: ExamRun = { ...run, breakRemainingSec: rem, breakSavedAt: new Date().toISOString() };
      examRunRef.current = upd; setExamRun(upd); saveExamRun(upd);
      if (rem === 0) startNextBlock();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [mode, startNextBlock]);

  const mediaFromEvent = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return "";
    // Match both media (images/video) and exhibit (UWorld tables) so neither
    // navigates the browser to the backend asset URL — both open in the viewer.
    const link = target.closest("a[href*='/qbank/media/'], a[href*='/qbank/exhibit/']") as HTMLAnchorElement | null;
    const image = target.closest("img[src*='/qbank/media/'], img[src*='/qbank/exhibit/']") as HTMLImageElement | null;
    return link?.href || image?.src || "";
  };

  // Guarantee an exhibit URL carries its source question id so the backend can
  // use the O(1) single-row decrypt instead of scanning the whole bank. The HTML
  // rewrite already injects srcqid, but stem cues / older saved HTML may not, so
  // we backfill from the live session here as a belt-and-suspenders measure.
  const withExhibitSrcQid = (src: string) => {
    if (!src || !/\/qbank\/exhibit\//.test(src) || /[?&]srcqid=/.test(src)) return src;
    const sess = activeRef.current;
    const qid = sess?.questions[sess.current]?.id;
    if (!qid) return src;
    return `${src}${src.includes("?") ? "&" : "?"}srcqid=${qid}`;
  };

  const openInlineMedia = (e: React.MouseEvent<HTMLElement>) => {
    const src = mediaFromEvent(e.target);
    if (!src) return;
    e.preventDefault();
    setMediaViewer(withExhibitSrcQid(src));
    setMediaZoom(1);
  };

  // The synthetic "exhibit/figure/image" cue (added when a question has media but
  // no inline exhibit link) opens the question's first image/exhibit. Shared by
  // both the tutor and exam stems so the behaviour is identical in either mode.
  const openStemMedia = (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target?.closest("[data-exhibit-cue]")) {
      e.preventDefault();
      const sess = activeRef.current;
      const cq = sess?.questions[sess.current];
      const cueSrc = cq?.media[0]
        ? `${backend}${cq.media[0].url}?db=${sess!.db}`
        : (cq && mediaLinksFromHtml(cq.stem_html, backend, sess!.db)[0]?.src) || "";
      if (cueSrc) { setMediaViewer(withExhibitSrcQid(cueSrc)); setMediaZoom(1); }
      return;
    }
    openInlineMedia(e);
  };

  // Persistent highlighting lives in QbankHighlightLayer: it owns the overlay,
  // the annotation store and the popover. This button is only a second trigger.
  const applyHighlight = (color = "yellow") => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("medos:qbank-highlight", { detail: { color } }));
  };

  const runToolSearch = useCallback(async (term = searchTerm || selectedText) => {
    const clean = term.trim();
    if (!clean) return;
    setToolOpen(true);
    setToolTab("search");
    setSearchTerm(clean);
    setToolLoading(true);
    try {
      const data = await fetch(`${backend}/dashboard/search?q=${encodeURIComponent(clean)}&scopes=firstaid,uptodate,amboss,meds,lexi,calc&limit=18`).then(r => r.json());
      setToolResults(data.results || []);
    } finally {
      setToolLoading(false);
    }
  }, [backend, searchTerm, selectedText]);

  const expandToolForArticle = useCallback(() => {
    if (typeof window === "undefined") return;
    const target = Math.round(Math.min(920, Math.max(620, window.innerWidth * 0.42)));
    setToolWidth(width => Math.max(width, target));
    setToolOpen(true);
  }, []);

  const notifyReaderScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const maxY = Math.max(0, el.scrollHeight - el.clientHeight);
    // Near the bottom (incl. overscroll bounce) we tell the chrome controller to
    // stop toggling and stay shown — otherwise tiny scroll jitter at the end of a
    // long question rapidly hides/shows the top/status bars (visible flicker) and
    // the footer actions get harder to reach.
    const atBottom = maxY - el.scrollTop <= 24;
    window.dispatchEvent(new CustomEvent("medos:reader-scroll", {
      detail: { source: "qbank", y: el.scrollTop, maxY, atBottom },
    }));
  }, []);

  const openNativeArticleTab = useCallback((frame: ArticleFrame) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("TabBar:open", {
      detail: {
        href: frame.nativeUrl,
        title: frame.title,
      },
    }));
  }, []);

  const openMedosTab = useCallback((href: string, title?: string) => {
    if (typeof window === "undefined" || !href) return;
    window.dispatchEvent(new CustomEvent("TabBar:open", {
      detail: {
        href,
        title,
      },
    }));
  }, []);

  const openResultInPanel = (hit: ToolSearchHit) => {
    if (hit.scope === "firstaid" || hit.href.startsWith("#firstaid-")) {
      const headingId = Number(String(hit.id || hit.href).match(/\d+/)?.[0] || "");
      if (Number.isFinite(headingId) && headingId > 0) {
        window.dispatchEvent(new CustomEvent("medos:open-firstaid", { detail: { heading_id: headingId, query: hit.title } }));
      }
      return;
    }
    if (hit.href.startsWith("/amboss?doc=")) {
      const id = hit.href.split("doc=")[1]?.split("&")[0];
      setArticleFrame({ title: hit.title, url: `${backend}/amboss/article/${id}`, nativeUrl: `/amboss?doc=${id}`, source: "amboss" });
      expandToolForArticle();
      setToolTab("article");
      return;
    }
    if (hit.href.startsWith("/uptodate?t=")) {
      const id = hit.href.split("t=")[1]?.split("&")[0];
      setArticleFrame({ title: hit.title, url: `${backend}/utd/topic/${id}/html`, nativeUrl: `/uptodate?t=${id}`, source: "utd" });
      expandToolForArticle();
      setToolTab("article");
      return;
    }
    if (hit.href.startsWith("/library/uworld?doc=")) {
      const id = hit.href.split("doc=")[1]?.split("&")[0];
      setArticleFrame({ title: hit.title, url: `${backend}/uworld-library/article/${id}`, nativeUrl: `/library/uworld?doc=${id}`, source: "uworld-library" });
      expandToolForArticle();
      setToolTab("article");
      return;
    }
    openMedosTab(hit.href, hit.title);
  };

  const openHoverMatchInPanel = useCallback((match: { title: string; href: string; source?: string; kind?: string }) => {
    const href = match.href || "";
    if (match.source === "firstaid" || href.startsWith("#firstaid-")) {
      const headingId = Number(href.match(/firstaid-(\d+)/)?.[1] || href.match(/heading_id=(\d+)/)?.[1] || "");
      if (!Number.isFinite(headingId) || headingId <= 0) return false;
      window.dispatchEvent(new CustomEvent("medos:open-firstaid", { detail: { heading_id: headingId, query: match.title } }));
      return true;
    }
    if (href.startsWith("/amboss?doc=")) {
      const id = href.split("doc=")[1]?.split("&")[0];
      if (!id) return false;
      setArticleFrame({ title: match.title, url: `${backend}/amboss/article/${id}`, nativeUrl: `/amboss?doc=${id}`, source: "amboss" });
      expandToolForArticle();
      setToolTab("article");
      return true;
    }
    if (href.startsWith("/library/uworld?doc=")) {
      const id = href.split("doc=")[1]?.split("&")[0];
      if (!id) return false;
      setArticleFrame({ title: match.title, url: `${backend}/uworld-library/article/${id}`, nativeUrl: `/library/uworld?doc=${id}`, source: "uworld-library" });
      expandToolForArticle();
      setToolTab("article");
      return true;
    }
    if (href.startsWith("/uptodate?t=")) {
      const id = href.split("t=")[1]?.split("&")[0];
      if (!id) return false;
      setArticleFrame({
        title: match.title.replace(/^Open UpToDate topic$/i, "UpToDate topic"),
        url: `${backend}/utd/topic/${id}/html`,
        nativeUrl: `/uptodate?t=${id}`,
        source: "utd",
      });
      expandToolForArticle();
      setToolTab("article");
      return true;
    }
    if (href.startsWith("/qbank?")) {
      const params = new URLSearchParams(href.split("?")[1] || "");
      const qid = Number(params.get("qid") || "");
      const requestedDb = params.get("db");
      const targetDb: DB = requestedDb === "step1" || requestedDb === "step2" || requestedDb === "step3" ? requestedDb : db;
      if (!qid) return false;
      setLoading(true);
      void fetch(`${backend}/qbank/question/${qid}?db=${targetDb}`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((question: Question) => {
          const now = new Date().toISOString();
          const session: Session = {
            id: `${Date.now()}`,
            db: targetDb,
            createdAt: now,
            updatedAt: now,
            transient: true,
            mode: testMode,
            filters: { subject: "", systemGroup: "", system: "", query: `QID ${qid}`, tag: "", sort: "id" },
            questions: [question],
            current: 0,
            answers: {},
            revealed: {},
            marked: markedMapForQuestions([question], markedIdsByDb[targetDb] || []),
            eliminated: {},
            notes: {},
            questionStartedAt: { 0: now },
            questionTimeSec: {},
            ...initialExamFields(testMode, now, examMinutesForCount(1) * 60),
          };
          setDb(targetDb);
          setTotal(1);
          applyActiveSession(session);
          setMode("quiz");
        })
        .catch(console.error)
        .finally(() => setLoading(false));
      return true;
    }
    return false;
  }, [applyActiveSession, backend, db, expandToolForArticle, markedIdsByDb, testMode]);

  const resizeTool = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = toolWidth;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.classList.add("qbank-resizing");
    const move = (ev: PointerEvent) => {
      const maxWidth = Math.max(520, Math.min(1120, window.innerWidth - 420));
      setToolWidth(Math.min(maxWidth, Math.max(360, startWidth - (ev.clientX - startX))));
    };
    const up = () => {
      document.body.classList.remove("qbank-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const appendCalculatorToken = (token: string) => {
    setCalcExpression(value => {
      if (token === "M+" || token === "MR" || token === "MC") return value;
      if (token === "C") return "0";
      if (token === "DEL") return value.length > 1 ? value.slice(0, -1) : "0";
      if (token === "±") return value.startsWith("-") ? value.slice(1) || "0" : `-${value}`;
      if (token === "√x") {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? String(Math.round(Math.sqrt(number) * 1000000) / 1000000) : "Error";
      }
      if (token === "1/x") {
        const number = Number(value);
        return Number.isFinite(number) && number !== 0 ? String(Math.round((1 / number) * 1000000) / 1000000) : "Error";
      }
      if (token === "=") return calculateSimpleExpression(value);
      if (value === "0" || value === "Error") return token;
      return `${value}${token}`;
    });
  };

  const deleteSavedSession = useCallback((session: Session) => {
    const confirmed = window.confirm(`Delete this saved ${session.mode} block?\n\nThe source questions remain in the bank, but this block's answers, notes, timer, and activity log will be removed.`);
    if (!confirmed) return;
    const nextSessions = sessions.filter(item => item.id !== session.id);
    setSessions(nextSessions);
    saveSessions(nextSessions);
    if (active?.id === session.id) {
      applyActiveSession(null);
      setMode("home");
    }
    qbankStateFetch(`/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" })
      .then(r => r.ok ? r.json() : null)
      .then((state: QBankBackendState | null) => {
        if (!state?.sessions) return;
        const backendSessions = state.sessions.map(normalizeSession);
        setSessions(backendSessions);
        saveSessions(backendSessions);
      })
      .catch(() => {});
  }, [active?.id, applyActiveSession, sessions]);

  const openSavedSession = useCallback((session: Session) => {
    applyActiveSession(session);
    setMode(session.completedAt ? "results" : "quiz");
  }, [applyActiveSession]);

  const renameSavedSession = useCallback((sessionId: string, rawTitle: string) => {
    const title = rawTitle.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!title) return;
    const now = new Date().toISOString();
    const nextSessions = sessions.map(item =>
      item.id === sessionId ? normalizeSession({ ...item, blockLabel: title, updatedAt: now }) : item);
    setSessions(nextSessions);
    saveSessions(nextSessions);
    const renamed = nextSessions.find(item => item.id === sessionId);
    if (renamed) persistSessionToBackend(renamed);
    if (activeRef.current?.id === sessionId) applyActiveSession(renamed || null);
  }, [applyActiveSession, sessions]);

  const startQuestionIdBlock = useCallback(async (targetDb: DB, ids: number[], label: string) => {
    const validIds = Array.from(new Set(ids.filter(qid => Number.isInteger(qid) && qid > 0)));
    if (!validIds.length) {
      alert(`No ${label.toLowerCase()} available for ${prettyDbLabel(targetDb)}.`);
      return;
    }
    setLoading(true);
    try {
      const selectedIds = allMatched
        ? validIds
        : [...validIds].sort(() => Math.random() - 0.5).slice(0, Math.min(batchSize, 100));
      const params = new URLSearchParams({
        db: targetDb,
        limit: String(selectedIds.length),
        page: "1",
        valid_only: "true",
        sort: "id",
        include_ids: selectedIds.join(","),
      });
      let questions: Question[] = [];
      if (allMatched) {
        const collected = await collectAllMatchedQuestions(backend, params);
        if (collected.cancelled) return;
        questions = collected.questions;
      } else {
        const data = await fetch(`${backend}/qbank/list?${params}`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        questions = data.questions || [];
      }
      if (!questions.length) {
        alert(`No valid ${label.toLowerCase()} could be loaded.`);
        return;
      }
      const now = new Date().toISOString();
      const session: Session = {
        id: `${Date.now()}`,
        db: targetDb,
        createdAt: now,
        updatedAt: now,
        mode: testMode,
        trackedPrep: false,
        allMatched: allMatched || undefined,
        blockLabel: label,
        filters: { subject: "", systemGroup: "", system: "", query: label, tag: "", sort: "id", pool: "all" },
        questions,
        current: 0,
        answers: {},
        revealed: {},
        marked: markedMapForQuestions(questions, markedIdsByDb[targetDb] || []),
        eliminated: {},
        notes: {},
        questionStartedAt: { 0: now },
        questionTimeSec: {},
        activity: [{ event: "start", createdAt: now, detail: label }],
        ...initialExamFields(testMode, now, examMinutesForCount(questions.length) * 60),
      };
      setDb(targetDb);
      setTotal(questions.length);
      persistActive(session);
      setMode("quiz");
    } catch (error) {
      console.error(error);
      alert(`Could not start ${label.toLowerCase()}.`);
    } finally {
      setLoading(false);
    }
  }, [allMatched, backend, batchSize, markedIdsByDb, persistActive, testMode]);

  const regenerateSession = useCallback(async (source: Session) => {
    setLoading(true);
    try {
      const limit = Math.max(1, Math.min(100, source.questions.length || batchSize));
      const params = new URLSearchParams({
        db: source.db,
        limit: String(source.allMatched ? ALL_MATCHED_PAGE : limit),
        page: "1",
        valid_only: "true",
        sort: source.filters.sort || "random",
      });
      if (source.filters.subjects?.length) params.set("subject_ids", source.filters.subjects.join(","));
      else if (source.filters.subject) params.set("subject_id", source.filters.subject);
      if (source.filters.systems?.length) params.set("system_ids", source.filters.systems.join(","));
      if (source.filters.systemGroup) params.set("system_group", source.filters.systemGroup);
      if (source.filters.system) params.set("system_id", source.filters.system);
      if (source.filters.query) params.set("q", source.filters.query);
      if (source.filters.tag) params.set("tag", source.filters.tag);
      if (source.filters.imagesOnly) params.set("images_only", "true");
      const sourcePool = source.filters.pool || (source.trackedPrep ? "unused" : "all");
      if (sourcePool === "marked") {
        const ids = markedIdsByDb[source.db] || [];
        params.set("include_ids", ids.length ? ids.join(",") : "-1");
      } else if (sourcePool === "incorrect") {
        const ids = Array.from(new Set(
          sessions
            .filter(s => s.completedAt && s.db === source.db)
            .flatMap(session => Object.entries(session.answers)
              .filter(([i, answer]) => session.questions[+i] && session.questions[+i].correct - 1 !== answer)
              .map(([i]) => session.questions[+i].id))
        ));
        params.set("include_ids", ids.length ? ids.join(",") : "-1");
      } else if (sourcePool === "unused" && source.trackedPrep) {
        const usedIds = usedIdsByDb[source.db] || [];
        if (usedIds.length) params.set("exclude_ids", usedIds.join(","));
      }
      let questions: Question[] = [];
      let totalMatched = 0;
      if (source.allMatched) {
        const collected = await collectAllMatchedQuestions(backend, params);
        if (collected.cancelled) return;
        questions = orderAllMatched(collected.questions, source.filters.sort || "random");
        totalMatched = collected.total;
      } else {
        const data = await fetch(`${backend}/qbank/list?${params}`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        questions = data.questions || [];
        totalMatched = data.total || questions.length;
      }
      if (!questions.length) {
        alert("No replacement questions match that saved block. Try Practice only or reset progress.");
        return;
      }
      const now = new Date().toISOString();
      const session: Session = {
        id: `${Date.now()}`,
        db: source.db,
        createdAt: now,
        updatedAt: now,
        mode: source.mode,
        trackedPrep: source.trackedPrep,
        allMatched: source.allMatched,
        parentSessionId: source.id,
        blockLabel: source.allMatched
          ? `Regenerated all-matched block (${questions.length} Qs)`
          : `Regenerated ${source.questions.length}-question block`,
        filters: source.filters,
        questions,
        current: 0,
        answers: {},
        revealed: {},
        marked: markedMapForQuestions(questions, markedIdsByDb[source.db] || []),
        eliminated: {},
        notes: {},
        questionStartedAt: { 0: now },
        questionTimeSec: {},
        activity: [{ event: "regenerate", createdAt: now, detail: `Regenerated from block ${source.id}` }],
        ...initialExamFields(
          source.mode,
          now,
          source.allMatched
            ? examMinutesForCount(questions.length) * 60
            : source.examTotalSec ?? examMinutesForCount(questions.length) * 60,
        ),
      };
      if (source.trackedPrep) recordUsedQuestions(source.db, questions);
      setDb(source.db);
      setTestMode(source.mode);
      setTotal(totalMatched || questions.length);
      persistActive(session);
      setMode("quiz");
    } catch (error) {
      console.error(error);
      alert("Could not regenerate that block.");
    } finally {
      setLoading(false);
    }
  }, [backend, batchSize, markedIdsByDb, persistActive, recordUsedQuestions, sessions, usedIdsByDb]);

  // Start the identical block from a partner's share code. Only question ids
  // travel in the code, so the block is rebuilt from the local bank in the
  // same order with fresh answers, marks, and notes.
  const startSharedSession = useCallback(async (raw: string) => {
    let payload: SharedSessionPayload;
    try {
      payload = decodeSharedSession(raw);
    } catch (error) {
      setPartnerError(error instanceof Error ? error.message : "That session code could not be read.");
      return;
    }
    setPartnerBusy(true);
    setPartnerError("");
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 120000);
      const byId = new Map<number, Question>();
      try {
        for (let offset = 0; offset < payload.ids.length; offset += ALL_MATCHED_PAGE) {
          const chunk = payload.ids.slice(offset, offset + ALL_MATCHED_PAGE);
          const params = new URLSearchParams({
            db: payload.db,
            limit: String(chunk.length),
            page: "1",
            sort: "id",
            valid_only: "false",
            include_ids: chunk.join(","),
          });
          const data = await fetchQbankListSlice(backend, params, controller.signal);
          for (const question of data.questions || []) {
            if (question?.id) byId.set(question.id, question);
          }
        }
      } finally {
        window.clearTimeout(timer);
      }
      const questions: Question[] = [];
      let missing = 0;
      for (const id of payload.ids) {
        const question = byId.get(id);
        if (question) questions.push(question); else missing += 1;
      }
      if (!questions.length) {
        setPartnerError(`None of those ${payload.ids.length.toLocaleString()} questions exist in your ${prettyDbLabel(payload.db)} bank. Your partner may be using a different bank.`);
        return;
      }
      if (missing) {
        const proceed = window.confirm(
          `${missing.toLocaleString()} of ${payload.ids.length.toLocaleString()} questions are not in your ${prettyDbLabel(payload.db)} bank (different bank version).\n\nStart the block with the ${questions.length.toLocaleString()} questions that are available?`,
        );
        if (!proceed) return;
      }
      const now = new Date().toISOString();
      const label = payload.label.trim() || `Shared block · ${questions.length} Q`;
      const session: Session = {
        id: `${Date.now()}`,
        db: payload.db,
        createdAt: now,
        updatedAt: now,
        mode: payload.mode,
        trackedPrep: false,
        allMatched: payload.allMatched || undefined,
        blockLabel: label,
        filters: payload.filters || { subject: "", systemGroup: "", system: "", query: label, tag: "", sort: "id", pool: "all" },
        questions,
        current: 0,
        answers: {},
        revealed: {},
        marked: markedMapForQuestions(questions, markedIdsByDb[payload.db] || []),
        eliminated: {},
        notes: {},
        questionStartedAt: { 0: now },
        questionTimeSec: {},
        activity: [{
          event: "start",
          createdAt: now,
          detail: `Shared by partner · ${questions.length} question ${payload.mode} block`,
        }],
        ...initialExamFields(
          payload.mode,
          now,
          payload.examTotalSec ?? examMinutesForCount(questions.length) * 60,
        ),
      };
      const meta = dailyBankMeta(payload.db) || { category: "uworld" as const, label: prettyDbLabel(payload.db) };
      setBankMeta(meta);
      writeQbankSelection(window.localStorage, { db: payload.db, meta });
      setDb(payload.db);
      setSubjectFilter("");
      setSelectedSubjectIds(new Set());
      setSelectedSystemIds(new Set());
      setSelectedBlockIds(new Set());
      setTestMode(payload.mode);
      setTotal(questions.length);
      if (payload.mode === "exam") {
        setExamLabsOpen(false);
        setExamNotesOpen(false);
        setExamCalculatorOpen(false);
        setExamNavigatorOpen(true);
        setExamPaused(false);
        setExamLocked(false);
        setExamStatusOpen(false);
      }
      persistActive(session);
      setPartnerCode("");
      setWorkspaceTab("build");
      setMode("quiz");
    } catch (error) {
      console.error(error);
      setPartnerError(error instanceof DOMException && error.name === "AbortError"
        ? "Loading the shared block timed out. Ask your partner to share it again."
        : "Could not load that shared block. Check that the Q-bank backend is running, then try again.");
    } finally {
      setPartnerBusy(false);
    }
  }, [backend, markedIdsByDb, persistActive]);

  const q = active?.questions[active.current];
  const answered = active && active.answers[active.current] !== undefined;
  const score = useMemo(() => active ? Object.entries(active.answers).filter(([i, a]) => active.questions[+i]?.correct - 1 === a).length : 0, [active]);

  // Prefetch the next two questions' reference concepts while the tester reads
  // the current one, so underlines (and the hover boxes they enable) are ready
  // the instant they advance — fixing the "hover boxes absent when you answer
  // very quickly" gap. Deduped + cached, so re-firing on each answer is cheap.
  const upcomingSourceIds = useMemo(() => {
    if (!active) return [] as string[];
    return [1, 2]
      .map(offset => active.questions[active.current + offset]?.id)
      .filter((id): id is number => typeof id === "number")
      .map(id => `${active.db}:${id}`);
  }, [active]);
  useEffect(() => {
    upcomingSourceIds.forEach(sid => prefetchDocTerms("qbank", sid));
  }, [upcomingSourceIds]);

  // Related reference-library articles for the answered question (AMBOSS qbank →
  // AMBOSS articles via learning-card ids; UWorld qbank → UWorld library via Refs).
  const openRelatedArticle = useCallback((item: RelatedArticle) => {
    const nativeUrl = item.source === "amboss" ? `/amboss?doc=${item.docId}` : `/library/uworld?doc=${item.docId}`;
    setArticleFrame({ title: item.title, url: `${backend}${item.url}`, nativeUrl, source: item.source });
    setToolTab("article");
  }, [backend]);

  // Open one cross-database concept article: into the right article panel when the
  // panel can host it (AMBOSS / UWorld library / UpToDate / First Aid), else as a
  // MedOS tab so the running quiz is never navigated away from.
  const openConceptMention = useCallback((item: ConceptMention) => {
    const handled = openHoverMatchInPanel(item);
    if (handled) return;
    // Books / diseases / drugs can't be hosted in the article iframe; open them
    // through the MedOS tab bar rather than a separate browser tab.
    if (item.href) openMedosTab(item.href, item.title);
  }, [openHoverMatchInPanel, openMedosTab]);

  // Concept chip → the concept's articles across every database, in the right panel.
  const openConceptInPanel = useCallback((cui: string, name: string) => {
    expandToolForArticle();
    setToolTab("article");
    setConceptPanel({ cui, name, items: [] });
    void fetch(`${backend}/umls/concept/${encodeURIComponent(cui)}/mentions?per_source=4&limit=48`)
      .then(r => r.ok ? r.json() : { results: [] })
      .then((data: { results?: ConceptMention[] }) => {
        const items = (Array.isArray(data?.results) ? data.results : []).filter(it => it.href && it.title);
        setConceptPanel(cp => (cp && cp.cui === cui ? { ...cp, items } : cp));
        // Auto-open the best hostable article, preferring UWorld library, then AMBOSS / UTD.
        const best = ["uworld", "amboss", "utd", "firstaid"].map(s => items.find(it => it.source === s)).find(Boolean) || items[0];
        if (best) openConceptMention(best);
      })
      .catch(() => {});
  }, [backend, expandToolForArticle, openConceptMention]);

  const relatedQid = q?.id ?? null;
  const relatedDb = active?.db ?? "";
  useEffect(() => {
    if (!relatedDb || !relatedQid || !answered) { setRelatedArticles([]); return; }
    let cancelled = false;
    setRelatedArticles([]);
    fetch(`${backend}/qbank/related?qid=${relatedQid}&db=${relatedDb}`)
      .then(r => r.ok ? r.json() : { items: [] })
      .then(data => { if (!cancelled) setRelatedArticles(Array.isArray(data?.items) ? data.items : []); })
      .catch(() => { if (!cancelled) setRelatedArticles([]); });
    return () => { cancelled = true; };
  }, [relatedDb, relatedQid, answered, backend]);
  // A concept's article list is question-scoped — drop it when the question changes.
  useEffect(() => { setConceptPanel(null); }, [q?.id]);
  const qMediaLinks = useMemo(() => {
    if (!q || !active) return [];
    const answered = shouldPersistExplanationHtml(active, active.current);
    const isAmbossBank = active.db.startsWith("amboss");
    const stemMediaLinks = isAmbossBank ? mediaLinksFromHtml(q.stem_html, backend, active.db) : [];
    const rawLinks = [
      // q.media = only declared question media (e.g. heart-sound audio).
      ...q.media.map(m => ({ src: `${backend}${m.url}?db=${active.db}`, label: m.name, caption: mediaDisplayCaption(m.name), filename: m.name })),
      // AMBOSS stores question-bound figures inline in the stem instead of q.media.
      ...stemMediaLinks.map(m => ({ ...m, caption: mediaDisplayCaption(m.caption || m.label), filename: m.label })),
      // After answering: show explanation HTML links and supplementary media.
      ...(answered ? mediaLinksFromHtml(q.explanation_html, backend, active.db).map(m => ({ ...m, caption: mediaDisplayCaption(m.caption || m.label), filename: m.label })) : []),
      ...(answered ? (q.explanation_media || []).map(m => ({ src: `${backend}${m.url}?db=${active.db}`, label: m.name, caption: mediaDisplayCaption(m.name), filename: m.name })) : []),
    ];
    const links = rawLinks.map((item, index) => {
      const caption = mediaDisplayCaption(item.caption || item.label);
      return {
        ...item,
        caption,
        label: caption || `${mediaKind(item.filename || item.src)} ${index + 1}`,
      };
    });
    return links.reduce<typeof links>((acc, item) => {
      const existingIndex = acc.findIndex(other => other.src === item.src);
      if (existingIndex < 0) return [...acc, item];
      if (!acc[existingIndex].caption && item.caption) acc[existingIndex] = item;
      return acc;
    }, []);
  }, [active, backend, q]);
  const activeExamLabTab = useMemo(
    () => EXAM_LAB_TABS.find(tab => tab.id === examLabTab) || EXAM_LAB_TABS[0],
    [examLabTab],
  );
  const visibleExamLabRows = useMemo(() => {
    const term = examLabSearch.trim().toLowerCase();
    if (!term) return activeExamLabTab.rows;
    return activeExamLabTab.rows.filter(item => {
      const haystack = [item.name, item.conventional || "", item.si || ""].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [activeExamLabTab, examLabSearch]);

  const moveQuestionBy = (delta: number) => {
    updateSession(session => {
      const nextCurrent = Math.max(0, Math.min(session.questions.length - 1, session.current + delta));
      return nextCurrent === session.current ? session : moveTimedQuestion(session, nextCurrent, new Date().toISOString());
    });
  };

  const goToQuestion = (index: number) => {
    updateSession(session => moveTimedQuestion(session, index, new Date().toISOString()));
  };

  const qbankTouchOverlayOpen = showNavigator || examStatusOpen || examLabsOpen || examNotesOpen || examCalculatorOpen || Boolean(mediaViewer);
  const qbankTouchIgnoreSelector = [
    ".qbank-tool-shell",
    ".qbank-tutor-navigator-popover",
    ".qbank-exam-status-popover",
    ".qbank-exam-drawer",
    ".qbank-exam-calculator",
    ".qbank-hl-popover",
    ".medos-amboss-tooltip",
    ".definition-tooltip",
    "[data-touch-ignore]",
  ].join(",");

  const chooseActiveAnswer = (choiceIndex: number) => {
    const session = activeRef.current;
    const question = session?.questions[session.current];
    if (!session || !question || session.completedAt) return;
    if (choiceIndex < 0 || choiceIndex >= question.choices.length) return;
    if (session.mode === "tutor" && session.answers[session.current] !== undefined) return;

    updateSession(s => {
      const currentQuestion = s.questions[s.current];
      if (!currentQuestion || s.completedAt) return s;
      if (choiceIndex < 0 || choiceIndex >= currentQuestion.choices.length) return s;
      if (s.mode === "tutor" && s.answers[s.current] !== undefined) return s;

      const now = new Date().toISOString();
      const remainingSec = s.timeRemainingSec ?? s.examTimeRemainingSec;
      const timed = recordTimedAnswer(s, { choiceIndex, at: now, remainingSec, stopTimer: s.mode === "tutor" }) as Session;
      const answerMeta = timed.answerMeta?.[s.current] as AnswerMeta | undefined;

      return appendSessionActivity({
        ...timed,
        revealed: s.mode === "tutor" ? { ...s.revealed, [s.current]: true } : s.revealed,
        eliminated: {
          ...(s.eliminated || {}),
          [s.current]: withoutNumberKey(s.eliminated?.[s.current], choiceIndex),
        },
      }, {
        event: "answer",
        qid: currentQuestion.id,
        questionIndex: s.current,
        answeredChoice: choiceIndex,
        correctChoice: currentQuestion.correct - 1,
        elapsedSec: answerMeta?.spentSec ?? answerMeta?.elapsedSec,
        remainingSec,
        createdAt: now,
      });
    });
  };

  const toggleActiveMark = () => {
    const session = activeRef.current;
    const question = session?.questions[session.current];
    if (!session || !question) return;
    const nextMarked = !Boolean(session.marked?.[session.current]);
    setQuestionMarkedForRevision(session.db, question.id, nextMarked);
    updateSession(s => appendSessionActivity(
      { ...s, marked: { ...(s.marked || {}), [s.current]: nextMarked } },
      {
        event: nextMarked ? "mark" : "unmark",
        qid: question.id,
        questionIndex: s.current,
        elapsedSec: sessionElapsedSec(s),
        remainingSec: s.timeRemainingSec ?? s.examTimeRemainingSec,
        createdAt: new Date().toISOString(),
      }
    ));
  };

  const shareActiveSession = async () => {
    const session = activeRef.current;
    if (!session || !session.questions.length) return;
    try {
      const code = encodeSharedSession(session);
      const copied = await copyToClipboard(code);
      setSharePayload({ code, copied, count: session.questions.length });
    } catch (error) {
      console.error(error);
      alert("Could not prepare this session for sharing.");
    }
  };

  /** Exports a saved block or the live block directly, before it is saved. */
  const exportSessionPdf = async (sessionOverride?: Session | null) => {
    const session = sessionOverride || activeRef.current;
    if (!session || !session.questions.length) {
      notifyPdfExport("Open or finish a Q-Bank block before exporting it.", "error");
      return;
    }
    setExportingPdf(true);
    try {
      // Pass the ORIGINAL source HTML and relative media/exhibit refs. The
      // backend resolves them from the shipped bank (same readers the UI uses)
      // and embeds tables + images, so nothing depends on browser fetches/CORS.
      const sourceUrls = (items: MediaItem[] | undefined) =>
        (items || []).map(item => item && item.url).filter((url): url is string => !!url);
      const questions: PdfQuestion[] = session.questions.map((question, index) => ({
        id: question.source_id || question.id,
        stem: htmlToPlainText(question.stem_html) || question.stem || "",
        stemHtml: question.stem_html || "",
        choices: question.choices.map((choice, choiceIndex) =>
          htmlToPlainText(question.choices_html?.[choiceIndex]) || choice || "",
        ),
        choicesHtml: question.choices.map((_, choiceIndex) => question.choices_html?.[choiceIndex] || ""),
        correct: question.correct,
        explanation: htmlToPlainText(question.explanation_html) || question.explanation || "",
        explanationHtml: question.explanation_html || "",
        media: sourceUrls(question.media),
        explanationMedia: sourceUrls(question.explanation_media),
        db: session.db,
        subject: question.subject || "",
        system: question.system || "",
        tags: (question.tags || []).slice(0, 50),
        chosen: typeof session.answers[index] === "number" ? session.answers[index] : null,
      }));
      const label =
        session.blockLabel ||
        session.examBlockLabel ||
        `${prettyDbLabel(session.db)} · ${session.mode === "exam" ? "Timed" : "Tutor"}`;
      const filename = await downloadPdf({
        kind: "qbank",
        title: `${label} · ${questions.length} questions`,
        questions,
        meta: {
          source: "medos-qbank",
          sessionId: session.id,
          bank: session.db,
          mode: session.mode,
          completedAt: session.completedAt || "",
          answersIncluded: true,
        },
      });
      notifyPdfExport(`PDF exported: ${filename}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(error);
      notifyPdfExport(`PDF export failed: ${message}`, "error");
    } finally {
      setExportingPdf(false);
    }
  };

  const exportActiveSessionPdf = () => exportSessionPdf();

  const revealActiveTutorAnswer = () => {
    const session = activeRef.current;
    const question = session?.questions[session.current];
    if (!session || !question || session.mode !== "tutor" || session.answers[session.current] === undefined || session.revealed[session.current]) return;
    updateSession(s => appendSessionActivity(
      { ...s, revealed: { ...s.revealed, [s.current]: true } },
      {
        event: "reveal",
        qid: question.id,
        questionIndex: s.current,
        elapsedSec: sessionElapsedSec(s),
        remainingSec: s.timeRemainingSec ?? s.examTimeRemainingSec,
        createdAt: new Date().toISOString(),
      }
    ));
  };

  const toggleSelectedElimination = () => {
    const session = activeRef.current;
    if (!session || session.mode !== "exam" || session.completedAt) return;
    const selectedChoice = session.answers[session.current];
    if (selectedChoice === undefined) return;
    updateSession(s => {
      const currentEliminated = s.eliminated?.[s.current] || {};
      const shouldEliminate = !currentEliminated[selectedChoice];
      const nextEliminated = shouldEliminate
        ? { ...currentEliminated, [selectedChoice]: true }
        : withoutNumberKey(currentEliminated, selectedChoice);
      return {
        ...s,
        answers: shouldEliminate ? withoutNumberKey(s.answers, s.current) : s.answers,
        eliminated: { ...(s.eliminated || {}), [s.current]: nextEliminated },
      };
    });
  };

  const handleQbankShortcut = (event: KeyboardEvent) => {
    const session = activeRef.current;
    if (mode !== "quiz" || !session || qbankTouchOverlayOpen || isEditableTouchTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const rawKey = event.key || "";
    const key = rawKey.toLowerCase();
    // e/f/m/r are reserved for actions (eliminate, flag, mark, reveal), so they
    // must NOT also be consumed as letter answer-choices — otherwise pressing E/F
    // would pick choice E/F and the eliminate/flag shortcuts would never fire.
    // Every choice stays reachable via the number keys (1-8).
    const reservedActionKey = key === "e" || key === "f" || key === "m" || key === "r";
    const numberChoice = /^[1-8]$/.test(rawKey) ? Number(rawKey) - 1 : -1;
    const letterChoice = !reservedActionKey && /^[a-h]$/.test(key) ? letters.indexOf(key.toUpperCase()) : -1;
    const choiceIndex = numberChoice >= 0 ? numberChoice : letterChoice;

    if (choiceIndex >= 0) {
      event.preventDefault();
      chooseActiveAnswer(choiceIndex);
      return;
    }

    if (rawKey === "ArrowLeft" || rawKey === "PageUp") {
      event.preventDefault();
      moveQuestionBy(-1);
      return;
    }
    if (rawKey === "ArrowRight" || rawKey === "PageDown") {
      event.preventDefault();
      moveQuestionBy(1);
      return;
    }
    // Only hijack Space/Enter/R for reveal when a reveal can actually happen
    // (tutor, answered, not yet revealed). Otherwise let them through so Space
    // still scrolls a long stem and Enter still activates the focused button.
    const canReveal = session.mode === "tutor"
      && session.answers[session.current] !== undefined
      && !session.revealed[session.current];
    if (canReveal && (rawKey === " " || rawKey === "Enter" || key === "r")) {
      event.preventDefault();
      revealActiveTutorAnswer();
      return;
    }
    if (key === "m" || key === "f") {
      event.preventDefault();
      toggleActiveMark();
      return;
    }
    if (key === "e") {
      event.preventDefault();
      toggleSelectedElimination();
    }
  };

  useEffect(() => {
    window.addEventListener("keydown", handleQbankShortcut, true);
    return () => window.removeEventListener("keydown", handleQbankShortcut, true);
  });

  useSwipeGesture(qbankGestureRef, {
    disabled: !gesturesEnabled || mode !== "quiz" || !active || qbankTouchOverlayOpen,
    effectKey: `${mode}:${active?.mode || "none"}:${active?.id || "none"}`,
    minDistancePx: 76,
    maxCrossAxisPx: 84,
    ignoreSelector: qbankTouchIgnoreSelector,
    onSwipeLeft: () => moveQuestionBy(1),
    onSwipeRight: () => moveQuestionBy(-1),
  });

  usePinchZoom(qbankGestureRef, {
    value: examFontScale,
    min: 0.62,
    max: 1.36,
    step: 0.02,
    onChange: setExamFontScale,
    disabled: !gesturesEnabled || mode !== "quiz" || active?.mode !== "exam" || qbankTouchOverlayOpen,
    effectKey: `${mode}:${active?.mode || "none"}:${active?.id || "none"}`,
    ignoreSelector: qbankTouchIgnoreSelector,
  });

  useMultiTouchSwipe(qbankGestureRef, {
    fingers: 2,
    disabled: !gesturesEnabled || mode !== "quiz" || !active || qbankTouchOverlayOpen,
    effectKey: `${mode}:${active?.mode || "none"}:${active?.id || "none"}:two-finger`,
    minDistancePx: 76,
    maxCrossAxisPx: 84,
    ignoreSelector: qbankTouchIgnoreSelector,
    onSwipeLeft: () => moveQuestionBy(1),
    onSwipeRight: () => moveQuestionBy(-1),
  });

  useMultiTouchSwipe(qbankGestureRef, {
    fingers: 3,
    disabled: !gesturesEnabled || mode !== "quiz" || qbankTouchOverlayOpen,
    effectKey: `${mode}:${active?.mode || "none"}:${active?.id || "none"}:three-finger`,
    minDistancePx: 76,
    maxCrossAxisPx: 84,
    ignoreSelector: qbankTouchIgnoreSelector,
    onSwipeLeft: () => window.history.forward(),
    onSwipeRight: () => window.history.back(),
    onSwipeUp: () => window.dispatchEvent(new CustomEvent("medos:open-command-center")),
  });

  useTrackpadPinch(qbankGestureRef, {
    value: examFontScale,
    min: 0.62,
    max: 1.36,
    step: 0.02,
    onChange: setExamFontScale,
    disabled: !gesturesEnabled || mode !== "quiz" || active?.mode !== "exam" || qbankTouchOverlayOpen,
    effectKey: `${mode}:${active?.mode || "none"}:${active?.id || "none"}:trackpad`,
    ignoreSelector: qbankTouchIgnoreSelector,
  });

  useEffect(() => {
    if (examLabsOpen) {
      setExamDrawerContent("labs");
      return;
    }
    if (examNotesOpen) {
      setExamDrawerContent("notes");
      return;
    }
    const timer = window.setTimeout(() => setExamDrawerContent(null), 360);
    return () => window.clearTimeout(timer);
  }, [examLabsOpen, examNotesOpen]);

  if (mode === "break" && examRun) {
    const justFinished = examRun.currentBlock;        // block that just ended
    const nextIndex = justFinished + 1;
    const nextBlock = examRun.blocks[nextIndex];
    const breakRem = examRun.breakRemainingSec ?? 0;
    const breakMin = Math.floor(breakRem / 60);
    const breakSec = breakRem % 60;
    return (
      <div style={shell}>
        {storageNoticeToast}
        <div className="qbank-break-screen">
          <div className="qbank-break-card">
            <span className="qbank-break-badge"><Pause size={26} /></span>
            <h1>Break</h1>
            <p>You finished <strong>Block {justFinished + 1}</strong> of {examRun.blockCount} — {examRun.label}.</p>
            <div className="qbank-break-timer" aria-live="polite">
              {String(breakMin).padStart(2, "0")}:{String(breakSec).padStart(2, "0")}
              <em>break time remaining</em>
            </div>
            <div className="qbank-break-progress">
              {examRun.blocks.map((b, i) => (
                <span key={i} className={`qbank-break-dot ${b.completedAt ? "is-done" : i === nextIndex ? "is-next" : ""}`} title={`Block ${i + 1}`} />
              ))}
            </div>
            <p className="qbank-break-next">{nextBlock ? `Up next: Block ${nextIndex + 1} of ${examRun.blockCount} · ${nextBlock.questions.length} questions, ${Math.round((nextBlock.examTotalSec ?? 0) / 60)} min` : "That was the last block."}</p>
            <div className="qbank-break-actions">
              <button className="qbank-start-button qbank-launch-cta" onClick={startNextBlock} disabled={loading}>
                <Play size={16} /> {nextBlock ? `Start Block ${nextIndex + 1}` : "See results"}
              </button>
              <button className="qbank-break-end" onClick={() => { if (window.confirm("End the whole exam now? You can review what you've answered so far.")) endExamRun(); }}>
                End exam
              </button>
            </div>
            <p className="qbank-break-hint">The next block starts automatically when the break timer reaches zero. Your exam is saved — you can safely close this and resume later.</p>
          </div>
        </div>
      </div>
    );
  }

  // A LIVE exam block always renders the FRED exam UI. A COMPLETED exam block renders
  // here only when the user has chosen the "exam" review view; in the default "tutor"
  // view it falls through to the tutor branch below (rich explanations).
  if (mode === "quiz" && active && q && active.mode === "exam" && !(active.completedAt && examReviewView === "tutor")) {
    const selected = active.answers[active.current];
    const remaining = active.timeRemainingSec ?? active.examTimeRemainingSec ?? active.examTotalSec ?? EXAM_BLOCK_SECONDS;
    const isLowTime = remaining <= 5 * 60;
    const isMarked = Boolean(active.marked?.[active.current]);
    const currentNotes = active.notes?.[active.current] || "";
    const eliminatedForCurrent = active.eliminated?.[active.current] || {};
    const examReview = Boolean(active.completedAt);
    const questionReferencesEnabled = selected !== undefined;
    const examDrawerOpen = examLabsOpen || examNotesOpen;
    const examDrawerMode = examLabsOpen ? "labs" : examNotesOpen ? "notes" : examDrawerContent;
    const mediaScale = Math.min(examFontScale, 1);
    const choiceMatrix = buildQbankChoiceMatrix(q);
    const examStemHtml = choiceMatrix ? choiceMatrix.stemHtml : q.stem_html;
    const examShellStyle = {
      "--exam-font-scale": String(examFontScale),
      "--exam-media-max-height": `${Math.round(260 * mediaScale)}px`,
      "--exam-media-max-width": `${Math.round(560 * mediaScale)}px`,
    } as React.CSSProperties;
    const answeredCount = Object.keys(active.answers).length;
    const unansweredCount = Math.max(0, active.questions.length - answeredCount);
    // Exam stem media uses the same shared handler as the tutor stem
    // (openStemMedia) so exhibit/image clicks behave identically in both modes.
    const confirmEndBlock = () => {
      if (window.confirm("End this block and submit your current answers?")) finishSession(active);
    };
    const toggleExamMark = () => {
      const nextMarked = !isMarked;
      setQuestionMarkedForRevision(active.db, q.id, nextMarked);
      updateSession(s => appendSessionActivity(
        { ...s, marked: { ...(s.marked || {}), [s.current]: nextMarked } },
        {
          event: nextMarked ? "mark" : "unmark",
          qid: q.id,
          questionIndex: s.current,
          elapsedSec: sessionElapsedSec(s),
          remainingSec: s.timeRemainingSec ?? s.examTimeRemainingSec,
          createdAt: new Date().toISOString(),
        }
      ));
    };
    const chooseExamAnswer = (choiceIndex: number) => {
      if (examReview) return;
      updateSession(s => {
        const now = new Date().toISOString();
        const question = s.questions[s.current];
        const remainingSec = s.timeRemainingSec ?? s.examTimeRemainingSec;
        const timed = recordTimedAnswer(s, { choiceIndex, at: now, remainingSec, stopTimer: false }) as Session;
        const answerMeta = timed.answerMeta?.[s.current] as AnswerMeta | undefined;
        return appendSessionActivity({
          ...timed,
          eliminated: {
            ...(s.eliminated || {}),
            [s.current]: withoutNumberKey(s.eliminated?.[s.current], choiceIndex),
          },
        }, {
          event: "answer",
          qid: question.id,
          questionIndex: s.current,
          answeredChoice: choiceIndex,
          correctChoice: question.correct - 1,
          elapsedSec: answerMeta?.spentSec ?? answerMeta?.elapsedSec,
          remainingSec,
          createdAt: now,
        });
      });
    };
    const toggleExamElimination = (choiceIndex: number) => {
      if (examReview) return;
      updateSession(s => {
        const currentEliminated = s.eliminated?.[s.current] || {};
        const shouldEliminate = !currentEliminated[choiceIndex];
        const nextEliminated = shouldEliminate
          ? { ...currentEliminated, [choiceIndex]: true }
          : withoutNumberKey(currentEliminated, choiceIndex);
        const nextAnswers = shouldEliminate && s.answers[s.current] === choiceIndex
          ? withoutNumberKey(s.answers, s.current)
          : s.answers;
        return {
          ...s,
          answers: nextAnswers,
          eliminated: { ...(s.eliminated || {}), [s.current]: nextEliminated },
        };
      });
    };

    return (
      <div
        ref={qbankGestureRef}
        className={`qbank-exam-shell touch-gesture-surface ${examDark ? "qbank-exam-dark" : ""}`}
        style={examShellStyle}
      >
        {storageNoticeToast}
        <header className="qbank-exam-topbar">
          <div className="qbank-exam-left-status">
            <button className="qbank-exam-item-counter" onClick={() => setExamStatusOpen(v => !v)}>
              <span>{active.current + 1}/{active.questions.length}</span>
            </button>
            <button
              className={`qbank-exam-mark-toggle ${isMarked ? "is-marked" : ""}`}
              onClick={toggleExamMark}
              aria-label="Mark item"
              title="Mark item"
            >
              <span className="qbank-webfred-checkbox" />
              <Flag size={24} />
            </button>
          </div>

          <div className="qbank-exam-nav-actions">
            <button className="qbank-webfred-nav-button" onClick={() => moveQuestionBy(-1)} disabled={active.current === 0} aria-label="Previous item" title="Previous item">
              <span className="qbank-webfred-arrow is-prev" aria-hidden="true" />
              <span className="qbank-webfred-nav-label">Previous</span>
            </button>
            <button className="qbank-webfred-nav-button is-next" onClick={() => moveQuestionBy(1)} disabled={active.current === active.questions.length - 1} aria-label="Next item" title="Next item">
              <span className="qbank-webfred-nav-label">Next</span>
              <span className="qbank-webfred-arrow is-next" aria-hidden="true" />
            </button>
          </div>

          <div className="qbank-exam-tool-strip">
            <button
              className={`qbank-webfred-tool ${examLabsOpen ? "is-active" : ""}`}
              onClick={() => { setExamLabsOpen(v => !v); setExamNotesOpen(false); }}
              aria-label="Lab Values"
              title="Lab Values"
            >
              <FlaskConical size={32} />
            </button>
            <button
              className={`qbank-webfred-tool ${examNotesOpen ? "is-active" : ""}`}
              onClick={() => { setExamNotesOpen(v => !v); setExamLabsOpen(false); }}
              aria-label="Notes"
              title="Notes"
            >
              <BookOpen size={31} />
            </button>
            <button
              className={`qbank-webfred-tool ${examCalculatorOpen ? "is-active" : ""}`}
              onClick={() => setExamCalculatorOpen(v => !v)}
              aria-label="Calculator"
              title="Calculator"
            >
              <Calculator size={32} />
            </button>
            <button
              className={`qbank-webfred-tool qbank-webfred-reverse ${examDark ? "is-active" : ""}`}
              onClick={() => setExamDark(v => !v)}
              aria-label="Reverse Color"
              title="Reverse Color"
            >
              <span className="qbank-reverse-icon" />
            </button>
            <div className="qbank-webfred-font-slider" title="Text zoom">
              <span>A</span>
              <input
                aria-label="Text zoom"
                type="range"
                min="0.62"
                max="1.36"
                step="0.074"
                value={examFontScale}
                onChange={event => setExamFontScale(Number(event.target.value))}
                list="qbank-exam-font-stops"
              />
              <span>A</span>
              <datalist id="qbank-exam-font-stops">
                <option value="0.62" />
                <option value="0.768" />
                <option value="0.916" />
                <option value="1.064" />
                <option value="1.212" />
                <option value="1.36" />
              </datalist>
            </div>
          </div>
        </header>

        {examStatusOpen && (
          <div className="qbank-exam-status-popover">
            <header>
              <strong>Block Status</strong>
              <button onClick={() => setExamStatusOpen(false)} title="Close"><X size={16} /></button>
            </header>
            <div className="qbank-exam-status-summary">
              <span><b>{answeredCount}</b> answered</span>
              <span><b>{unansweredCount}</b> unanswered</span>
              <span><b>{active.questions.length}</b> total</span>
            </div>
            <div className="qbank-exam-status-grid">
              {active.questions.map((item, i) => {
                const itemAnswered = active.answers[i] !== undefined;
                const itemMarked = Boolean(active.marked?.[i]);
                return (
                  <button
                    key={`status-${item.id}`}
                    className={`${itemAnswered ? "is-answered" : "is-unanswered"} ${itemMarked ? "is-marked" : ""} ${i === active.current ? "is-current" : ""}`}
                    onClick={() => {
                      goToQuestion(i);
                      setExamStatusOpen(false);
                    }}
                  >
                    {i + 1}
                    {itemMarked && <Flag size={11} />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className={`qbank-exam-main ${examDrawerOpen ? "has-drawer" : ""}`}>
          {examNavigatorOpen && (
            <aside className="qbank-exam-nav-panel">
              <div className="qbank-exam-item-grid">
                {active.questions.map((item, i) => {
                  const itemAnswered = active.answers[i] !== undefined;
                  const itemMarked = Boolean(active.marked?.[i]);
                  const className = [
                    "qbank-exam-item",
                    i === active.current ? "is-current" : "",
                    itemAnswered ? "is-answered" : "",
                    itemMarked ? "is-marked" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <button key={item.id} className={className} onClick={() => goToQuestion(i)}>
                      <span className="qbank-exam-nav-dot">{itemAnswered ? "" : "•"}</span>
                      <span className="qbank-exam-nav-num">{i + 1}</span>
                      {itemMarked && <Flag className="qbank-exam-nav-flag" size={12} />}
                    </button>
                  );
                })}
              </div>
            </aside>
          )}

          <main ref={qbankExamQuestionRef} key={`${active.id}-${active.current}`} className="qbank-exam-question-card">
            <div className="qbank-exam-question-meta">
              <span>Question ID {questionDisplayId(q)}</span>
              <span>{q.subject || "Subject"} / {q.system || "System"}</span>
              {(() => { const si = seriesInfo(active.questions, active.current); return si ? <span className="qbank-exam-mark-chip" title="This question is part of a consecutive case series">Case {si.part}/{si.total}</span> : null; })()}
              {isMarked && <span className="qbank-exam-mark-chip"><Flag size={12} /> Marked</span>}
            </div>

            <section className="qbank-exam-stem">
              {examStemHtml ? (
                <ReferenceLayer
                  className={qbankReferenceClass("qbank-exam-html", questionReferencesEnabled)}
                  onClick={openStemMedia}
                  html={qbankHtml(examStemHtml, backend, active.db)}
                  onOpenMatch={questionReferencesEnabled ? openHoverMatchInPanel : undefined}
                  db={active.db}
                  source="qbank"
                  sourceId={`${active.db}:${q.id}`}
                  hoverEnabled={questionReferencesEnabled}
                  modeOverride="full"
                />
              ) : !choiceMatrix ? (
                <ReferenceLayer
                  className={qbankReferenceClass("qbank-exam-html", questionReferencesEnabled)}
                  onClick={openStemMedia}
                  html={qbankExamPlainStemHtml(q.stem)}
                  onOpenMatch={questionReferencesEnabled ? openHoverMatchInPanel : undefined}
                  db={active.db}
                  source="qbank"
                  sourceId={`${active.db}:${q.id}`}
                  hoverEnabled={questionReferencesEnabled}
                  modeOverride="full"
                />
              ) : null}
              {!!q.media.length && (
                <div className="qbank-exam-media-grid">
                  {q.media.map(m => {
                    const caption = mediaDisplayCaption(m.name);
                    return (
                      <figure key={m.name}>
                        {/\.(mp3|wav|m4a)$/i.test(m.name) ? (
                          <audio controls src={`${backend}${m.url}?db=${active.db}`} />
                        ) : /\.(mp4|webm)$/i.test(m.name) ? (
                          <video controls src={`${backend}${m.url}?db=${active.db}`} />
                        ) : (
                          <img
                            src={`${backend}${m.url}?db=${active.db}`}
                            alt={caption || "Question media"}
                            onClick={() => {
                              setMediaViewer(`${backend}${m.url}?db=${active.db}`);
                              setMediaZoom(1);
                            }}
                          />
                        )}
                        {caption ? <figcaption>{caption}</figcaption> : null}
                      </figure>
                    );
                  })}
                </div>
              )}
            </section>

            <section className={`qbank-exam-choices ${choiceMatrix ? "has-choice-matrix" : ""}`} aria-label="Answer choices">
              {choiceMatrix ? (
                <QBankAnswerMatrix
                  matrix={choiceMatrix}
                  variant="exam"
                  selected={selected}
                  correctIndex={q.correct - 1}
                  marked={examReview}
                  answered={examReview}
                  eliminated={eliminatedForCurrent}
                  backend={backend}
                  db={active.db}
                  sourceId={`${active.db}:${q.id}`}
                  referenceEnabled={questionReferencesEnabled}
                  onChoose={chooseExamAnswer}
                  onToggleEliminate={toggleExamElimination}
                  onOpenMatch={questionReferencesEnabled ? openHoverMatchInPanel : undefined}
                  onMediaClick={openInlineMedia}
                />
              ) : q.choices.map((choice, i) => {
                const choiceHtml = q.choices_html?.[i];
                const isSelected = selected === i;
                const isEliminated = Boolean(eliminatedForCurrent[i]);
                const isCorrect = q.correct - 1 === i;
                return (
                  <div
                    key={`${q.id}-exam-${i}`}
                    className={`qbank-exam-choice ${isSelected ? "is-selected" : ""} ${isEliminated ? "is-eliminated" : ""} ${examReview && isCorrect ? "is-correct" : ""} ${examReview && isSelected && !isCorrect ? "is-incorrect" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => chooseExamAnswer(i)}
                    onContextMenu={event => {
                      event.preventDefault();
                      toggleExamElimination(i);
                    }}
                    onKeyDown={event => {
                      if (!examReview && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        chooseExamAnswer(i);
                      }
                    }}
                    title="Left click to answer. Right click to strike out."
                  >
                    <span className="qbank-exam-radio">{isSelected && <Check size={13} />}</span>
                    <span className="qbank-exam-letter">{letters[i]}</span>
                    {choiceHtml ? (
                      <ReferenceLayer
                        className={qbankReferenceClass("qbank-exam-choice-content", questionReferencesEnabled)}
                        onClick={openInlineMedia}
                        html={qbankHtml(choiceHtml, backend, active.db)}
                        onOpenMatch={questionReferencesEnabled ? openHoverMatchInPanel : undefined}
                        db={active.db}
                        source="qbank"
                        sourceId={`${active.db}:${q.id}`}
                        hoverEnabled={questionReferencesEnabled}
                        modeOverride="full"
                      />
                    ) : (
                      <ReferenceLayer
                        className={qbankReferenceClass("qbank-exam-choice-content", questionReferencesEnabled)}
                        html={escapeHtml(choice || "Unavailable answer choice")}
                        onOpenMatch={questionReferencesEnabled ? openHoverMatchInPanel : undefined}
                        db={active.db}
                        source="qbank"
                        sourceId={`${active.db}:${q.id}`}
                        hoverEnabled={questionReferencesEnabled}
                        modeOverride="full"
                      />
                    )}
                    </div>
                  );
              })}
            </section>

            {examReview && (
              <section className="qbank-exam-review-explanation card" style={{ margin: "18px 0 0", padding: 18, borderColor: "rgba(14,165,233,.35)" }}>
                <div className={`qbank-feedback-banner ${selected === q.correct - 1 ? "is-correct" : "is-incorrect"}`} style={{ marginBottom: 12 }}>
                  <div className="qbank-feedback-result">
                    {selected === undefined ? (
                      <><strong>Omitted.</strong> Correct answer is <b>{letters[q.correct - 1]}</b></>
                    ) : selected === q.correct - 1 ? (
                      <><strong>Correct.</strong> You selected {letters[q.correct - 1]}</>
                    ) : (
                      <><strong>Incorrect.</strong> You selected {letters[selected]} — correct answer is <b>{letters[q.correct - 1]}</b></>
                    )}
                  </div>
                </div>
                <div style={{ ...row, marginBottom: 10, color: "var(--accent-strong)", fontWeight: 800 }}><BookOpen size={16} /> Explanation</div>
                {q.explanation_html ? (
                  <ReferenceLayer
                    className="qbank-rich-html qbank-explanation-html"
                    onClick={openInlineMedia}
                    html={qbankHtml(q.explanation_html, backend, active.db)}
                    onOpenMatch={openHoverMatchInPanel}
                    db={active.db}
                    source="qbank"
                    sourceId={`${active.db}:${q.id}`}
                    modeOverride="full"
                  />
                ) : q.explanation ? (
                  <p style={{ fontSize: 15, lineHeight: 1.75, color: "var(--text-secondary)" }}>{q.explanation}</p>
                ) : (
                  <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-muted)", fontStyle: "italic" }}>
                    Loading explanation… (if it stays blank, the explanation is unavailable for this question).
                  </p>
                )}
              </section>
            )}

          </main>

          <aside className={`qbank-exam-drawer ${examDrawerOpen ? "is-open" : "is-closed"}`} aria-hidden={!examDrawerOpen}>
              <div className="qbank-exam-drawer-header">
                <strong>{examDrawerMode === "labs" ? "Lab Values" : "Notes"}</strong>
                <button className="qbank-exam-icon-button" onClick={() => { setExamLabsOpen(false); setExamNotesOpen(false); }} title="Close"><X size={16} /></button>
              </div>
              {examDrawerMode === "labs" && (
                <>
                  <div className="qbank-exam-lab-controls">
                    <input
                      type="search"
                      placeholder="Search"
                      aria-label="Search lab values"
                      value={examLabSearch}
                      onChange={event => setExamLabSearch(event.target.value)}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={examLabShowSi}
                        onChange={event => setExamLabShowSi(event.target.checked)}
                      />
                      SI Reference Intervals
                    </label>
                  </div>
                  <div className="qbank-exam-lab-tabs" aria-label="Lab value sections">
                    {EXAM_LAB_TABS.map(tab => (
                      <button
                        key={tab.id}
                        className={tab.id === examLabTab ? "is-active" : ""}
                        onClick={() => setExamLabTab(tab.id)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  <div className="qbank-exam-labs">
                    <div key={`${activeExamLabTab.id}-${examLabShowSi ? "si" : "conventional"}`} className={`qbank-exam-lab-table ${examLabShowSi ? "is-si" : ""}`}>
                      <div className="qbank-exam-lab-head">
                        <span>{activeExamLabTab.heading}</span>
                        <span>Reference Range</span>
                        {examLabShowSi && <span>SI Reference</span>}
                      </div>
                      {visibleExamLabRows.map((value, index) => {
                        if (value.kind === "section") {
                          return (
                            <div key={`${activeExamLabTab.id}-section-${value.name}-${index}`} className="qbank-exam-lab-section-row">
                              <strong>{value.name}</strong>
                              <span />
                              {examLabShowSi && <span />}
                            </div>
                          );
                        }
                        return (
                          <div
                            key={`${activeExamLabTab.id}-${value.name}-${index}`}
                            className={`qbank-exam-lab-row ${value.indent ? "is-indented" : ""}`}
                          >
                            <strong>{value.name}</strong>
                            <span>{value.conventional}</span>
                            {examLabShowSi && <span>{value.si}</span>}
                          </div>
                        );
                      })}
                      {!visibleExamLabRows.length && (
                        <div className="qbank-exam-lab-empty">No lab values match “{examLabSearch.trim()}”.</div>
                      )}
                    </div>
                  </div>
                </>
              )}
              {examDrawerMode === "notes" && (
                <textarea
                  className="qbank-exam-notes"
                  value={currentNotes}
                  onChange={e => {
                    const value = e.target.value;
                    updateSession(s => ({ ...s, notes: { ...(s.notes || {}), [s.current]: value } }));
                  }}
                  placeholder="Scratch notes for this block..."
                />
              )}
          </aside>
        </div>

        <footer className="qbank-exam-footer">
          <div className={`qbank-exam-time-panel ${isLowTime && !examReview ? "is-low" : ""}`}>
            <span>Block Time Remaining:</span><strong>{examReview ? "Review" : formatExamTime(remaining, active.examTotalSec)}</strong>
          </div>
          <div className="qbank-exam-footer-actions">
            {examReview && (
              <div className="qbank-review-viewtoggle" role="group" aria-label="Review view">
                <button className="is-active" aria-pressed="true" title="Exam-style review">Exam</button>
                <button onClick={() => setExamReviewView("tutor")} aria-pressed="false" title="Switch to tutor review with explanations">Tutor</button>
              </div>
            )}
            {!examReview && (
              <button className="qbank-exam-pause-footer" onClick={() => updateSession(s => withExamTimerState(s, { examPaused: true, examLocked: false }))} aria-label="Pause block" title="Pause block">
                <Pause size={23} />
              </button>
            )}
            {!examReview && (
              <button className="qbank-exam-lock-footer" onClick={() => updateSession(s => withExamTimerState(s, { examPaused: false, examLocked: true }))} aria-label="Lock exam" title="Lock exam">
                <Lock size={23} />
              </button>
            )}
          </div>
          {!examReview && (
            <button className="qbank-exam-end-footer" onClick={confirmEndBlock} aria-label="End block" title="End block">
              <X size={26} />
            </button>
          )}
          {examReview && (
            <button className="qbank-exam-end-footer qbank-exam-review-done" onClick={() => setMode("results")} aria-label="Finish review" title="Finish review">
              <Check size={24} />
            </button>
          )}
        </footer>

        {examCalculatorOpen && (
          <div className="qbank-exam-calculator">
            <div className="qbank-exam-calc-display">{calcExpression}</div>
            <div className="qbank-exam-calc-grid">
              {["M+", "MR", "MC", "C", "±", "√x", "1/x", "/", "7", "8", "9", "*", "4", "5", "6", "-", "1", "2", "3", "+", "0", ".", "="].map(token => (
                <button key={token} onClick={() => appendCalculatorToken(token)} className={token === "=" ? "is-equals" : ""}>{token}</button>
              ))}
            </div>
          </div>
        )}

        {(examPaused || examLocked) && (
          <div className="qbank-exam-shield">
            <section>
              {examPaused ? <Pause size={34} /> : <Lock size={34} />}
              <h2>{examPaused ? "Block Paused" : "Exam Locked"}</h2>
              <p>{examPaused ? "The block timer is paused. Resume when ready." : "Question content is hidden. The block timer continues to run."}</p>
              <div className="qbank-exam-shield-time">{formatExamTime(remaining, active.examTotalSec)}</div>
              <div className="qbank-exam-pause-actions">
                <button className="qbank-exam-footer-button qbank-exam-proceed" onClick={() => updateSession(s => withExamTimerState(s, { examPaused: false, examLocked: false }))}>
                  {examPaused ? "Resume Block" : "Return to Exam"}
                </button>
                {examPaused && (
                  <button className="qbank-exam-footer-button" onClick={() => {
                    updateSession(s => withExamTimerState(s, { mode: "tutor", timeRemainingSec: remaining, examPaused: false, examLocked: false }));
                  }}>
                    Enter Tutor Mode
                  </button>
                )}
                {examPaused && (
                  <button className="qbank-exam-footer-button" onClick={() => {
                    updateSession(s => withExamTimerState(s, { examPaused: true, examLocked: false }));
                    setMode("home");
                  }}>
                    Exit To Q-Bank Home
                  </button>
                )}
              </div>
            </section>
          </div>
        )}

        {mediaViewer && (
          <MediaViewer
            open
            onClose={() => setMediaViewer(null)}
            source="UWorld"
            imageUrl={/\/qbank\/exhibit\//.test(mediaViewer) ? undefined : mediaViewer}
            frameUrl={/\/qbank\/exhibit\//.test(mediaViewer) ? mediaViewer : undefined}
          />
        )}
      </div>
    );
  }

  if (mode === "quiz" && active && q) {
    const selected = active.answers[active.current];
    // Tutor sessions always; also a COMPLETED exam block reviewed in tutor view (the
    // block is over, so revealing answers + explanations is correct — no live leak
    // because a live exam block never reaches this branch).
    const canShowTutorExplanation = active.mode === "tutor" || Boolean(active.completedAt);
    const showAnswer = canShowTutorExplanation && answered;
    const questionReferencesEnabled = selected !== undefined;
    const explanationPending = canShowTutorExplanation
      && shouldPersistExplanationHtml(active, active.current)
      && !q.explanation_html
      && !explanationResolved[`${active.db}:${q.id}`];
    const itemPeerPercent = percentCorrectFor(q);
    const itemCredit = selected === undefined ? null : questionWeightedCredit(q, selected);
    const itemTimeSpent = active.answerMeta?.[active.current]?.spentSec ?? questionSpentSeconds(active, active.current);
    const preservedExamRemaining = active.timeRemainingSec ?? active.examTimeRemainingSec ?? loadExamTimerSnapshot(active.id);
    const choiceMatrix = buildQbankChoiceMatrix(q);
    const tutorStemHtml = choiceMatrix ? choiceMatrix.stemHtml : q.stem_html;
    const tutorStemHasMedia = q.media.length > 0 || (
      active.db.startsWith("amboss") && mediaLinksFromHtml(tutorStemHtml, backend, active.db).length > 0
    );
    const chooseTutorAnswer = (choiceIndex: number) => {
      if (answered || active.completedAt) return;   // review of a completed block is read-only
      updateSession(s => {
        const now = new Date().toISOString();
        const question = s.questions[s.current];
        const remainingSec = s.timeRemainingSec ?? s.examTimeRemainingSec;
        const timed = recordTimedAnswer(s, { choiceIndex, at: now, remainingSec, stopTimer: true }) as Session;
        const answerMeta = timed.answerMeta?.[s.current] as AnswerMeta | undefined;
        return appendSessionActivity({
          ...timed,
          revealed: s.mode === "tutor" ? { ...s.revealed, [s.current]: true } : s.revealed,
        }, {
          event: "answer",
          qid: question.id,
          questionIndex: s.current,
          answeredChoice: choiceIndex,
          correctChoice: question.correct - 1,
          elapsedSec: answerMeta?.spentSec ?? answerMeta?.elapsedSec,
          remainingSec: answerMeta?.remainingSec,
          createdAt: now,
        });
      });
    };
    return (
      <div ref={qbankGestureRef} className="qbank-tutor-shell touch-gesture-surface" style={shell}>
        {storageNoticeToast}
        <div className="qbank-tutor-topbar" style={{ ...row, padding: "12px 18px", background: "var(--bg-card)", borderBottom: "1px solid var(--border)", justifyContent: "space-between" }}>
          <div style={row}>
            <button className="btn-ghost" onClick={() => setMode("home")} title="Back"><ChevronLeft size={16} /></button>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {prettyDbLabel(active.db)} / Question {active.current + 1} of {active.questions.length}
                {(() => { const si = seriesInfo(active.questions, active.current); return si ? <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "var(--accent-bg, #eff6ff)", borderRadius: 4, padding: "1px 6px" }}>Case {si.part}/{si.total}</span> : null; })()}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{q.subject} / {q.system}</div>
            </div>
          </div>
          <div style={row}>
            {active.completedAt && active.examId ? (
              // Reviewing a completed exam block: let the user flip between the rich
              // tutor review (default) and the FRED exam-style review.
              <div className="qbank-review-viewtoggle" role="group" aria-label="Review view">
                <button onClick={() => setExamReviewView("exam")} aria-pressed="false" title="Exam-style review">Exam</button>
                <button className="is-active" aria-pressed="true" title="Tutor review with explanations">Tutor</button>
              </div>
            ) : active.mode === "tutor" ? (
              <button
                className="tag tag-blue qbank-mode-chip-button"
                onClick={() => {
                  updateSession(s => withExamTimerState(s, {
                    mode: "exam",
                    timeRemainingSec: preservedExamRemaining,
                    examPaused: false,
                    examLocked: false,
                  }));
                  setExamLabsOpen(false);
                  setExamNotesOpen(false);
                  setExamCalculatorOpen(false);
                  setExamNavigatorOpen(true);
                  setExamPaused(false);
                  setExamLocked(false);
                  setExamStatusOpen(false);
                }}
                title="Enter exam mode"
              >
                Tutor
              </button>
            ) : (
              <span className="tag tag-blue">Exam</span>
            )}
            <span className="tag tag-gray">{score}/{Object.keys(active.answers).length}</span>
            <button
              className="btn-ghost qbank-mobile-tools-button"
              onClick={() => setToolOpen(true)}
              title="Open study tools"
            >
              <PanelRightOpen size={14} /> Tools
            </button>
            <button className="btn-ghost" onClick={requestExamFullscreen} title="Enter fullscreen">
              <Maximize2 size={14} /> Fullscreen
            </button>
            <button
              className={`btn-ghost qbank-mark-toggle ${active.marked?.[active.current] ? "is-marked" : ""}`}
              onClick={toggleActiveMark}
              title={active.marked?.[active.current] ? "Remove mark" : "Mark question for review"}
              aria-pressed={Boolean(active.marked?.[active.current])}
            >
              <Flag size={14} /> {active.marked?.[active.current] ? "Marked" : "Mark"}
            </button>
            <button
              className="btn-ghost qbank-share-toggle"
              onClick={() => void shareActiveSession()}
              title="Share this exact session with a partner"
            >
              <Share2 size={14} /> Share
            </button>
            <button
              className="btn-ghost qbank-export-pdf-toggle"
              onClick={() => void exportActiveSessionPdf()}
              title="Export this session to PDF — questions and choices first, answers and explanations on a new page"
              disabled={exportingPdf}
            >
              <Download size={14} /> {exportingPdf ? "Exporting…" : "Export PDF"}
            </button>
            <button className="btn-ghost" onClick={() => setShowNavigator(v => !v)} title="Question navigator">
              <ListFilter size={14} /> {active.current + 1}/{active.questions.length}
            </button>
          </div>
        </div>

        <div style={{ height: 6, background: "#e8eef8" }}>
          <div style={{ height: "100%", width: `${((active.current + 1) / active.questions.length) * 100}%`, background: "var(--accent)" }} />
        </div>

        {showNavigator && (
          <div className="card qbank-tutor-navigator-popover" style={{ position: "fixed", zIndex: 30, right: 18, top: 62, width: 306, padding: 14, boxShadow: "var(--shadow-lg)" }}>
            <div style={{ ...row, justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Navigator</span>
              <button className="btn-ghost" onClick={() => setShowNavigator(false)} title="Close" style={{ padding: 4 }}><X size={14} /></button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
              {active.questions.map((item, i) => {
                const done = active.answers[i] !== undefined;
                const good = done && active.answers[i] === item.correct - 1;
                const isMarked = Boolean(active.marked?.[i]);
                const isCurrent = i === active.current;
                return (
                  <button
                    key={item.id}
                    onClick={() => { goToQuestion(i); setShowNavigator(false); }}
                    title={`Question ${i + 1}${isMarked ? " · marked" : ""}`}
                    style={{
                      height: 38,
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: isCurrent ? "var(--accent)" : isMarked ? "#7c3aed" : done ? (good ? "var(--green)" : "var(--red)") : "#fff",
                      color: isCurrent || done || isMarked ? "#fff" : "var(--text-secondary)",
                      fontWeight: 700,
                      cursor: "pointer",
                      boxShadow: isMarked && isCurrent ? "0 0 0 3px rgba(124,58,237,.45)" : undefined,
                    }}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {sharePayload && (
          <div
            className="qbank-share-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qbank-share-title"
            onClick={() => setSharePayload(null)}
          >
            <div className="qbank-share-dialog" onClick={event => event.stopPropagation()}>
              <div className="qbank-share-head">
                <span className="qbank-share-icon"><Share2 size={16} /></span>
                <div>
                  <h3 id="qbank-share-title">Share this session</h3>
                  <p>{sharePayload.count.toLocaleString()} questions · same order, same mode, same timer.</p>
                </div>
                <button className="btn-ghost" onClick={() => setSharePayload(null)} title="Close"><X size={16} /></button>
              </div>
              <p className="qbank-share-note">
                Copy this code and send it to your partner. They paste it into
                <strong> Q-Bank → Partner → Enter your partner session</strong> and get the exact same block.
                Answers, notes, and marks stay yours — the partner starts fresh.
              </p>
              <textarea
                className="qbank-share-code"
                readOnly
                value={sharePayload.code}
                onFocus={event => event.currentTarget.select()}
              />
              <div className="qbank-share-actions">
                <span className={sharePayload.copied ? "qbank-share-status is-ok" : "qbank-share-status"}>
                  {sharePayload.copied
                    ? <><Check size={13} /> Copied to clipboard</>
                    : "Copy the code manually if the button does not work."}
                </span>
                <button className="btn-ghost" onClick={() => setSharePayload(null)}>Done</button>
                <button
                  className="btn-primary"
                  onClick={async () => {
                    const copied = await copyToClipboard(sharePayload.code);
                    setSharePayload(current => current ? { ...current, copied } : current);
                  }}
                >
                  <Share2 size={14} /> Copy code
                </button>
              </div>
            </div>
          </div>
        )}

        <div ref={qbankTutorPageRef} style={{ ...page, paddingBottom: 96 }} onScroll={notifyReaderScroll}>
          <div className={`qbank-tutor-layout ${toolOpen ? "has-tool" : "is-rail"}`} style={{ width: "100%", maxWidth: "none", display: "grid", gridTemplateColumns: toolOpen ? `minmax(520px, 1fr) ${toolWidth}px` : "minmax(0, 1fr) 48px", gap: 14 }}>
            <QbankHighlightLayer as="main" db={active.db} qid={q.id}>
              <div style={{ ...row, flexWrap: "wrap", marginBottom: 12 }}>
                <span className="tag tag-amber">QID {questionDisplayId(q)}</span>
                {q.tags.slice(0, 4).map(t => (
                  <button
                    key={t}
                    className="tag tag-blue"
                    onClick={() => {
                      setTag(t);
                      setQuery(t);
                      void loadBrowse({ query: t, tag: t });
                    }}
                    title={`Use tag: ${t}`}
                    style={{ cursor: "pointer" }}
                  >
                    {t}
                  </button>
                ))}
                {q.quality && !q.quality.valid && <span className="tag tag-red"><AlertTriangle size={10} /> Data issue</span>}
              </div>

              <section className="card" style={{ padding: 22, marginBottom: 14 }}>
                {tutorStemHtml ? (
                  <ReferenceLayer
                    className={qbankReferenceClass("qbank-rich-html qbank-question-html", questionReferencesEnabled)}
                    onClick={openStemMedia}
                    html={qbankStemHtml(tutorStemHtml, backend, active.db, tutorStemHasMedia)}
                    onOpenMatch={questionReferencesEnabled ? openHoverMatchInPanel : undefined}
                    db={active.db}
                    source="qbank"
                    sourceId={`${active.db}:${q.id}`}
                    hoverEnabled={questionReferencesEnabled}
                    modeOverride="full"
                  />
                ) : !choiceMatrix ? (
                  <div style={{ fontSize: 18, lineHeight: 1.75, color: "var(--text-primary)" }}>{q.stem || "Question stem unavailable."}</div>
                ) : null}
                {!!q.media.length && (
                  <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                    {q.media.map(m => {
                      const caption = mediaDisplayCaption(m.name);
                      return (
                        <figure key={m.name} style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", padding: 8 }}>
                          {/\.(mp3|wav|m4a)$/i.test(m.name) ? (
                            <audio controls src={`${backend}${m.url}?db=${active.db}`} style={{ width: "100%" }} />
                          ) : /\.(mp4|webm)$/i.test(m.name) ? (
                            <video controls src={`${backend}${m.url}?db=${active.db}`} style={{ width: "100%", maxHeight: 360, display: "block" }} />
                          ) : (
                            <img src={`${backend}${m.url}?db=${active.db}`} alt={caption || "Question media"} style={{ width: "100%", maxHeight: 360, objectFit: "contain", display: "block" }} />
                          )}
                          {caption ? <figcaption style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 11 }}><ImageIcon size={11} /> {caption}</figcaption> : null}
                        </figure>
                      );
                    })}
                  </div>
                )}
              </section>

              <div style={{ display: "grid", gap: 10, marginBottom: 14 }}>
                {choiceMatrix ? (
                  <QBankAnswerMatrix
                    matrix={choiceMatrix}
                    variant="tutor"
                    selected={selected}
                    correctIndex={q.correct - 1}
                    marked={showAnswer || Boolean(active.completedAt)}
                    answered={Boolean(answered)}
                    backend={backend}
                    db={active.db}
                    sourceId={`${active.db}:${q.id}`}
                    referenceEnabled={questionReferencesEnabled}
                    onChoose={chooseTutorAnswer}
                    onOpenMatch={questionReferencesEnabled ? openHoverMatchInPanel : undefined}
                    onMediaClick={openInlineMedia}
                  />
                ) : q.choices.map((choice, i) => {
                  const choiceHtml = q.choices_html?.[i];
                  const isSelected = selected === i;
                  const isCorrect = q.correct - 1 === i;
                  const marked = showAnswer || (canShowTutorExplanation && active.completedAt);
                  const border = marked && isCorrect ? "var(--green)" : marked && isSelected ? "var(--red)" : isSelected ? "var(--accent)" : "var(--border)";
                  const bg = marked && isCorrect ? "rgba(16,185,129,.16)" : marked && isSelected ? "rgba(239,68,68,.16)" : isSelected ? "rgba(14,165,233,.14)" : "var(--bg-card)";
                  return (
                    <div
                      key={`${q.id}-${i}`}
                      onClick={() => chooseTutorAnswer(i)}
                      onKeyDown={event => {
                        if (answered) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.currentTarget.click();
                        }
                      }}
                      className="qbank-tutor-choice"
                      role="button"
                      tabIndex={answered ? -1 : 0}
                      aria-pressed={isSelected}
                      aria-disabled={Boolean(answered)}
                      style={{ minHeight: 58, padding: "14px 16px", borderRadius: 8, border: `1px solid ${border}`, background: bg, color: "var(--text-primary)", display: "flex", gap: 12, alignItems: "center", textAlign: "left", cursor: answered ? "default" : "pointer" }}
                    >
                      <span style={{ width: 30, height: 30, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", background: marked || isSelected ? border : "var(--bg-subtle)", border: `1px solid ${border}`, color: marked && (isCorrect || isSelected) ? "#fff" : "var(--text-secondary)", fontWeight: 800, flexShrink: 0 }}>
                        {marked && isCorrect ? <Check size={15} /> : marked && isSelected ? <X size={15} /> : letters[i]}
                      </span>
                      {choiceHtml ? (
                        <ReferenceLayer
                          className={qbankReferenceClass("qbank-rich-html qbank-choice-html", questionReferencesEnabled)}
                          onClick={openInlineMedia}
                          html={qbankHtml(choiceHtml, backend, active.db)}
                          onOpenMatch={questionReferencesEnabled ? openHoverMatchInPanel : undefined}
                          db={active.db}
                          source="qbank"
                          sourceId={`${active.db}:${q.id}`}
                          hoverEnabled={questionReferencesEnabled}
                          modeOverride="full"
                        />
                      ) : (
                        <span style={{ fontSize: 16, lineHeight: 1.45, color: choice ? "var(--text-primary)" : "var(--red-dim)" }}>{choice || "Unavailable answer choice"}</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {canShowTutorExplanation && (active.revealed[active.current] || active.completedAt) && (
                <div className="animate-slide-up" style={{ marginBottom: 16 }}>
                  <div className={`qbank-feedback-banner ${selected === q.correct - 1 ? "is-correct" : "is-incorrect"}`}>
                    <div className="qbank-feedback-result">
                      {selected === q.correct - 1 ? (
                        <><strong>Correct.</strong> You selected {letters[q.correct - 1]}</>
                      ) : (
                        <><strong>Incorrect.</strong> Correct answer is <b>{letters[q.correct - 1]}</b></>
                      )}
                    </div>
                    <div className="qbank-feedback-metrics">
                      <span><b>{itemPeerPercent}%</b> answered correctly</span>
                      <span><b>{formatQuestionTime(itemTimeSpent)}</b> time spent</span>
                      <span><b>{itemCredit != null && itemCredit > 0 ? "+" : ""}{itemCredit?.toFixed(2)}</b> weighted credit</span>
                      <span><b>{itemPeerPercent < 50 ? "Hard" : itemPeerPercent > 75 ? "High-yield miss risk" : "Moderate"}</b> peer difficulty</span>
                    </div>
                  </div>
                  <section className="card" style={{ padding: 18, borderColor: "rgba(14,165,233,.35)" }}>
                  <div style={{ ...row, marginBottom: 10, color: "var(--accent-strong)", fontWeight: 800 }}><BookOpen size={16} /> Explanation</div>
                  {q.explanation_html ? (
                    <ReferenceLayer
                      className="qbank-rich-html qbank-explanation-html"
                      onClick={openInlineMedia}
                      html={qbankHtml(q.explanation_html, backend, active.db)}
                      onOpenMatch={openHoverMatchInPanel}
                      db={active.db}
                      source="qbank"
                      sourceId={`${active.db}:${q.id}`}
                      modeOverride="full"
                    />
                  ) : q.explanation ? (
                    <>
                      {explanationPending && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                          Loading formatted references...
                        </div>
                      )}
                      <p style={{ fontSize: 15, lineHeight: 1.75, color: "var(--text-secondary)" }}>{q.explanation}</p>
                    </>
                  ) : explanationPending ? (
                    <p style={{ fontSize: 15, lineHeight: 1.75, color: "var(--text-secondary)" }}>Loading formatted explanation...</p>
                  ) : (
                    <p style={{ fontSize: 15, lineHeight: 1.75, color: "var(--text-muted)", fontStyle: "italic" }}>
                      Explanation unavailable for this question.
                    </p>
                  )}
                  {!!q.explanation_media?.length && (
                    <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                      {q.explanation_media.map(m => {
                        const caption = mediaDisplayCaption(m.name);
                        return (
                          <figure key={m.name} style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", padding: 8 }}>
                            {/\.(mp3|wav|m4a)$/i.test(m.name) ? (
                              <audio controls src={`${backend}${m.url}?db=${active.db}`} style={{ width: "100%" }} />
                            ) : /\.(mp4|webm)$/i.test(m.name) ? (
                              <video controls src={`${backend}${m.url}?db=${active.db}`} style={{ width: "100%", maxHeight: 360, display: "block" }} />
                            ) : (
                              <img
                                src={`${backend}${m.url}?db=${active.db}`}
                                alt={caption || "Explanation media"}
                                onClick={() => { setMediaViewer(`${backend}${m.url}?db=${active.db}`); setMediaZoom(1); }}
                                style={{ width: "100%", maxHeight: 360, objectFit: "contain", display: "block", cursor: "zoom-in" }}
                              />
                            )}
                            {caption ? <figcaption style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 11 }}><ImageIcon size={11} /> {caption}</figcaption> : null}
                          </figure>
                        );
                      })}
                    </div>
                  )}
                  {/* Related reference-library articles (AMBOSS / UWorld library) */}
                  {showAnswer && relatedArticles.length > 0 && (
                    <div className="qbank-related-articles" style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
                      <div style={{ ...row, marginBottom: 10, color: "var(--accent-strong)", fontWeight: 800, fontSize: 13 }}>
                        <BookOpen size={14} /> Related {relatedArticles[0].source === "amboss" ? "AMBOSS" : "UWorld"} articles
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {relatedArticles.map(item => (
                          <button
                            key={`${item.source}:${item.docId}`}
                            type="button"
                            className="btn-ghost"
                            onClick={() => openRelatedArticle(item)}
                            title={`Open "${item.title}" in the article panel`}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "5px 10px", maxWidth: "100%" }}
                          >
                            <span className={`qbank-article-source is-${item.source}`} style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".04em" }}>
                              {item.source === "amboss" ? "A" : "UW"}
                            </span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
                            <ExternalLink size={11} />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* UMLS concept chips derived from paragraph tagging */}
                  {showAnswer && <QBankConceptChips questionId={q.id} db={active.db} onOpenConcept={openConceptInPanel} />}
                  </section>
                </div>
              )}

              <div className="qbank-tutor-navbar" style={{ ...row, flexWrap: "wrap" }}>
                <button className="btn-ghost" onClick={() => moveQuestionBy(-1)} disabled={active.current === 0}><ChevronLeft size={14} /> Previous</button>
                {canShowTutorExplanation && answered && !active.revealed[active.current] && <button className="btn-ghost" onClick={() => updateSession(s => {
                  const question = s.questions[s.current];
                  return appendSessionActivity(
                    { ...s, revealed: { ...s.revealed, [s.current]: true } },
                    {
                      event: "reveal",
                      qid: question.id,
                      questionIndex: s.current,
                      elapsedSec: sessionElapsedSec(s),
                      remainingSec: s.timeRemainingSec ?? s.examTimeRemainingSec,
                      createdAt: new Date().toISOString(),
                    }
                  );
                })}>Show Explanation</button>}
                {active.current < active.questions.length - 1 ? (
                  <button className="btn-primary" disabled={!answered && active.mode === "exam" && !active.completedAt} onClick={() => moveQuestionBy(1)}>Next <ChevronRight size={14} /></button>
                ) : active.completedAt ? (
                  <button className="btn-primary" onClick={() => setMode(examRun ? "results" : "home")}><Check size={14} /> Done</button>
                ) : (
                  <button className="btn-primary" onClick={() => finishSession(active)}><Check size={14} /> Finish</button>
                )}
                <button className="btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setMode("home")}><History size={14} /> Save & Exit</button>
              </div>
            </QbankHighlightLayer>
            <aside className={`qbank-tool-shell ${toolTab === "article" ? "qbank-tool-shell-article" : ""}`}>
              {toolOpen ? (
                <>
                  <div className="qbank-tool-resizer" onPointerDown={resizeTool} title="Drag to resize sidebar">
                    <GripVertical size={16} />
                  </div>
                  <div className="qbank-tool-header">
                    <button className="btn-ghost" onClick={() => setToolOpen(false)} title="Collapse panel" style={{ padding: 6 }}><PanelRightOpen size={15} /></button>
                    <button className={toolTab === "search" ? "btn-primary" : "btn-ghost"} onClick={() => setToolTab("search")} title="Search selected text"><Search size={14} /></button>
                    <button className={toolTab === "labs" ? "btn-primary" : "btn-ghost"} onClick={() => setToolTab("labs")} title="Lab values"><FlaskConical size={14} /></button>
                    <button className={toolTab === "images" ? "btn-primary" : "btn-ghost"} onClick={() => setToolTab("images")} title="Question media"><Images size={14} /></button>
                    <button className={toolTab === "article" ? "btn-primary" : "btn-ghost"} onClick={() => setToolTab("article")} title="Article viewer"><BookOpen size={14} /></button>
                  </div>
                  {toolTab !== "article" && (
                    <>
                      <div className="qbank-tool-actions">
                        <button className="btn-ghost" onClick={() => applyHighlight()} disabled={!selectedText}><Highlighter size={14} /> Highlight</button>
                        <button className="btn-ghost" onClick={() => runToolSearch()} disabled={!searchTerm && !selectedText}><Search size={14} /> Search</button>
                      </div>
                      {selectedText && <div className="qbank-selection-chip">Selected: {selectedText}</div>}
                    </>
                  )}
                  <div className={`qbank-tool-body ${toolTab === "article" ? "qbank-tool-body-article" : ""}`}>
                    {toolTab === "search" && (
                      <div>
                        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                          <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void runToolSearch(); }} placeholder="Search MedOS..." style={{ flex: 1 }} />
                          <button className="btn-primary" onClick={() => runToolSearch()} disabled={toolLoading}>{toolLoading ? <span className="loader" style={{ width: 14, height: 14 }} /> : <Search size={14} />}</button>
                        </div>
                        <div className="qbank-tool-results">
                          {toolResults.map(hit => (
                            <button key={`${hit.scope}-${hit.kind}-${hit.id}`} onClick={() => openResultInPanel(hit)} className="qbank-tool-result">
                              <span className="qbank-tool-result-kind">{hit.scope.toUpperCase()}</span>
                              <strong>{hit.title}</strong>
                              <span className="qbank-tool-result-subtitle">{hit.kind}{hit.subtitle ? ` / ${hit.subtitle}` : ""}</span>
                              <span className="qbank-tool-result-action">{qbankToolActionLabel(hit)}</span>
                            </button>
                          ))}
                          {!toolResults.length && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Select text like “Pertussis”, then search to read MedOS results here.</p>}
                        </div>
                      </div>
                    )}
                    {toolTab === "labs" && (
                      <div className="qbank-lab-groups">
                        {LAB_GROUPS.map(group => (
                          <div key={group.title} className="qbank-lab-group">
                            <button
                              className="qbank-lab-group-header"
                              onClick={() => setOpenLabGroups(prev => ({ ...prev, [group.title]: !prev[group.title] }))}
                            >
                              <span>
                                <strong>{group.title}</strong>
                                <em>{group.subtitle}</em>
                              </span>
                              <ChevronRight className={openLabGroups[group.title] ? "qbank-lab-chevron-open" : ""} size={16} />
                            </button>
                            {openLabGroups[group.title] && (
                              <div className="qbank-lab-table">
                                <div className="qbank-lab-table-head"><span>Test</span><span>Reference range</span><span>SI</span></div>
                                {group.values.map(value => (
                                  <div key={`${group.title}-${value.name}`} className="qbank-lab-row">
                                    <strong>{value.name}</strong><span>{value.conventional}</span><em>{value.si}</em>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {toolTab === "images" && (
                      <div style={{ display: "grid", gap: 10 }}>
                        {qMediaLinks.map(item => (
                          <button key={item.src} className="qbank-media-tile" onClick={() => { setMediaViewer(item.src); setMediaZoom(1); }} aria-label={item.caption || item.label} title={item.caption || undefined}>
                            {/\.(mp3|wav|m4a)(\?|$)/i.test(item.src) ? <audio controls src={item.src} /> : /\.(mp4|webm)(\?|$)/i.test(item.src) ? <video src={item.src} /> : <img src={item.src} alt={item.caption || item.label} />}
                            {item.caption && <span>{item.caption}</span>}
                          </button>
                        ))}
                        {!qMediaLinks.length && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No visible media for this stage of the question.</p>}
                      </div>
                    )}
                    {toolTab === "article" && (
                      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                        {conceptPanel && (
                          <div style={{ flex: "0 0 auto", borderBottom: "1px solid var(--border)", background: "var(--bg-card)", padding: "8px 10px", maxHeight: 168, overflowY: "auto" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-muted)", flex: "0 0 auto" }}>Across your libraries</span>
                              <strong style={{ fontSize: 12.5, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{conceptPanel.name}</strong>
                              <button className="btn-ghost" style={{ marginLeft: "auto", padding: "2px 6px", flex: "0 0 auto" }} onClick={() => setConceptPanel(null)} title="Close concept list"><X size={13} /></button>
                            </div>
                            {conceptPanel.items.length === 0 ? (
                              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Finding articles…</span>
                            ) : (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                {conceptPanel.items.map((it, i) => {
                                  const badge = hubSourceBadge(it.source);
                                  const active = !!articleFrame && articleFrame.title === it.title;
                                  return (
                                    <button
                                      key={`${it.source}:${it.source_id}:${i}`}
                                      type="button"
                                      className="btn-ghost"
                                      onClick={() => openConceptMention(it)}
                                      title={`${it.title}${it.subtitle ? " · " + it.subtitle : ""}`}
                                      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, padding: "4px 8px", maxWidth: 230, borderColor: active ? badge.color : undefined }}
                                    >
                                      <span style={{ fontSize: 9, fontWeight: 900, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 4, padding: "0 4px", lineHeight: "15px", flex: "0 0 auto" }}>{badge.label}</span>
                                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        <div style={{ flex: 1, minHeight: 0 }}>
                          {articleFrame ? (
                            <div className="qbank-article-panel">
                              <div className="qbank-article-panel-header">
                                <span className={`qbank-article-source is-${articleFrame.source}`}>
                                  {articleFrame.source === "amboss" ? "AMBOSS" : articleFrame.source === "utd" ? "UTD" : articleFrame.source === "uworld-library" ? "UWORLD" : "ARTICLE"}
                                </span>
                                <strong>{articleFrame.title}</strong>
                                <button className="btn-ghost qbank-article-go" onClick={() => openNativeArticleTab(articleFrame)} title="Open in MedOS tab"><ExternalLink size={13} /><span>Go</span></button>
                              </div>
                              <iframe
                                key={`${articleFrame.source}:${articleFrame.url}:${articleTheme}`}
                                src={withThemeParam(articleFrame.url, articleTheme)}
                                title={articleFrame.title}
                                style={{ background: darkModeOn ? "#0f172a" : "#ffffff" }}
                              />
                            </div>
                          ) : (
                            <p style={{ color: "var(--text-muted)", fontSize: 13, padding: 12 }}>
                              {conceptPanel ? "Select an article above to read it here." : "Open a search result to read it here."}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="qbank-tool-rail">
                  <button className="btn-primary" onClick={() => setToolOpen(true)} title="Open tools"><PanelRightOpen size={16} /></button>
                  <button className="btn-ghost" onClick={() => { setToolOpen(true); setToolTab("search"); }} title="Search"><Search size={15} /></button>
                  <button className="btn-ghost" onClick={() => { setToolOpen(true); setToolTab("labs"); }} title="Labs"><FlaskConical size={15} /></button>
                  <button className="btn-ghost" onClick={() => { setToolOpen(true); setToolTab("images"); }} title="Images"><Images size={15} /></button>
                  <button className="btn-ghost" onClick={() => { setToolOpen(true); setToolTab("article"); }} title="Article viewer"><BookOpen size={15} /></button>
                </div>
              )}
            </aside>
          </div>
        </div>
        {mediaViewer && (
          <MediaViewer
            open
            onClose={() => setMediaViewer(null)}
            source="UWorld"
            imageUrl={/\/qbank\/exhibit\//.test(mediaViewer) ? undefined : mediaViewer}
            frameUrl={/\/qbank\/exhibit\//.test(mediaViewer) ? mediaViewer : undefined}
          />
        )}
      </div>
    );
  }

  if (mode === "results" && examRun && examRun.phase === "done") {
    const sum = summarizeExam(examRun);
    // A prediction is only meaningful for a fully-attempted exam. When the run was
    // ended early, every unseen question is scored as wrong, which would render a
    // wildly pessimistic 3-digit score as if it were authoritative — so suppress it
    // and show % correct on what was actually attempted instead.
    const endedEarly = Boolean(examRun.endedEarly);
    const pred = endedEarly ? null : sum.prediction;
    const attempted = sum.correct + sum.wrong;
    const attemptedPercent = attempted ? Math.round((sum.correct / attempted) * 100) : 0;
    const dist = pred ? SCORE_DISTRIBUTION[pred.step] : null;
    const bars = pred ? distributionBars(pred.step) : [];
    const passLine = pred ? PASS_THRESHOLD[pred.step] : null;
    const scoreToX = (s: number) => Math.max(0, Math.min(1, (s - 140) / 145));
    const CW = 560, CH = 188, COL = CW / SCORE_BUCKETS.length;
    return (
      <div style={shell}>
        <div style={{ ...page, display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
          <section className="qbank-examresult">
            <header className="qbank-examresult-head">
              <span className="qbank-examresult-badge"><BarChart3 size={24} /></span>
              <div>
                <h2>Exam complete</h2>
                <p>{examRun.label} · {examRun.blockCount} {examRun.blockCount === 1 ? "block" : "blocks"} · {sum.totalQuestions} questions{endedEarly ? " · ended early" : ""}</p>
              </div>
            </header>

            {pred ? (
              <div className="qbank-examresult-scoreblock">
                <div className="qbank-examresult-bigscore">
                  <span className="qbank-examresult-num">{pred.score}</span>
                  <span className="qbank-examresult-sub">predicted 3-digit score</span>
                  <span className="qbank-examresult-range">
                    likely {pred.low}–{pred.high} · {scorePercentile(pred.step, pred.score)}th percentile{pred.confidence !== "high" ? " · estimate (form not individually calibrated)" : ""}
                  </span>
                </div>
                <div className="qbank-dist">
                  <div className="qbank-dist-title">Score Distribution <em>National Step {pred.step} · mean {dist!.mean}</em></div>
                  <svg className="qbank-dist-svg" viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label="Predicted score on the national distribution">
                    {bars.map((h, i) => (
                      <rect key={i} x={i * COL + 5} y={CH - h * (CH - 26)} width={COL - 10} height={h * (CH - 26)} rx={3} fill="#dbe4f0" />
                    ))}
                    {passLine != null && (
                      <line x1={scoreToX(passLine) * CW} x2={scoreToX(passLine) * CW} y1={20} y2={CH} stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 4" />
                    )}
                    <line x1={scoreToX(pred.score) * CW} x2={scoreToX(pred.score) * CW} y1={18} y2={CH} stroke="#f97316" strokeWidth={2.5} />
                    <rect x={Math.max(0, Math.min(CW - 38, scoreToX(pred.score) * CW - 19))} y={2} width={38} height={16} rx={4} fill="#f97316" />
                    <text x={Math.max(19, Math.min(CW - 19, scoreToX(pred.score) * CW))} y={14} fontSize={11} fontWeight={800} textAnchor="middle" fill="#fff">{pred.score}</text>
                  </svg>
                  <div className="qbank-dist-axis">
                    {SCORE_BUCKETS.map(b => <span key={b.label}>{b.label}</span>)}
                  </div>
                  <div className="qbank-dist-legend">
                    <span><i className="qbank-dist-key-you" /> your predicted score</span>
                    {passLine != null && <span><i className="qbank-dist-key-pass" /> passing ({passLine})</span>}
                  </div>
                </div>
              </div>
            ) : endedEarly ? (
              <div className="qbank-examresult-scoreblock">
                <div className="qbank-examresult-bigscore">
                  <span className="qbank-examresult-num">{attemptedPercent}%</span>
                  <span className="qbank-examresult-sub">correct on {attempted} attempted · {sum.omitted} not reached</span>
                  <span className="qbank-examresult-range">Exam ended early — a 3-digit score prediction needs the full exam and is unavailable.</span>
                </div>
              </div>
            ) : (
              <div className="qbank-examresult-scoreblock">
                <div className="qbank-examresult-bigscore">
                  <span className="qbank-examresult-num">{sum.percentCorrect}%</span>
                  <span className="qbank-examresult-sub">correct · {sum.correct}/{sum.totalQuestions}</span>
                  <span className="qbank-examresult-range">CMS subject self-assessment — no 3-digit USMLE conversion</span>
                </div>
              </div>
            )}

            <div className="qbank-examresult-stats">
              <div><b>{sum.correct}</b><em>correct</em></div>
              <div><b>{sum.wrong + sum.omitted}</b><em>incorrect</em></div>
              <div><b>{sum.percentCorrect}%</b><em>% correct</em></div>
              <div><b>{sum.percentWrong}%</b><em>% incorrect</em></div>
            </div>

            <div className="qbank-examresult-blocks">
              <div className="qbank-examresult-blockhead"><span>Block</span><span>Right</span><span>Wrong</span><span>Omit</span><span>% correct</span><span /></div>
              {sum.blocks.map(b => (
                <div className="qbank-examresult-blockrow" key={b.index}>
                  <span className="qbank-examresult-blockname">{b.label}</span>
                  <span className="qbank-examresult-good">{b.correct}</span>
                  <span className="qbank-examresult-bad">{b.wrong}</span>
                  <span>{b.omitted}</span>
                  <span><b>{b.percentCorrect}%</b></span>
                  <button className="qbank-examresult-reviewbtn" onClick={() => { setExamReviewView("tutor"); applyActiveSession(examRun.blocks[b.index]); setMode("quiz"); }}>Review</button>
                </div>
              ))}
            </div>

            <p className="qbank-examresult-note">
              {pred
                ? `Predicted from ${sum.wrong + sum.omitted} missed of ${sum.totalQuestions} using NBME ${pred.step === "1" ? "Step 1" : pred.step === "2" ? "Step 2 CK" : "Step 3"} Form ${pred.form}'s published conversion (a community regression on past test-takers). It's an estimate, good to about ±${pred.high - pred.score} points — not an official score.`
                : "Scored by percent correct. Clinical subject self-assessments don't map to a 3-digit USMLE score."}
            </p>

            <div className="qbank-examresult-actions">
              <button className="btn-primary" onClick={() => { setExamReviewView("tutor"); applyActiveSession(examRun.blocks[0]); setMode("quiz"); }}><BookOpen size={15} /> Review answers</button>
              <button className="btn-ghost" onClick={() => { setExamRun(null); examRunRef.current = null; saveExamRun(null); setWorkspaceTab("review"); setMode("home"); }}><BarChart3 size={15} /> Progression</button>
              <button className="btn-ghost" onClick={() => { setExamRun(null); examRunRef.current = null; saveExamRun(null); setWorkspaceTab("build"); setMode("home"); }}><RotateCcw size={15} /> Done</button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (mode === "results" && active) {
    const resultPct = pct(active);
    const weighted = weightedPerformance(active);
    const resultRows = active.questions.map((question, index) => {
      const selected = active.answers[index];
      const correct = selected !== undefined && selected === question.correct - 1;
      const spentSec = questionSpentSeconds(active, index);
      return {
        question,
        index,
        selected,
        correct,
        omitted: selected === undefined,
        spentSec,
      };
    });
    const avgTime = resultRows.length
      ? Math.round(resultRows.reduce((sum, item) => sum + item.spentSec, 0) / resultRows.length)
      : 0;
    return (
      <div style={shell}>
        <div style={{ ...page, display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
          <section className="qbank-results-card qbank-results-card-wide">
            <BarChart3 size={44} color={weighted.normalized >= 70 ? "var(--green)" : "var(--amber)"} style={{ margin: "0 auto 12px" }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
              <h2 style={{ fontSize: 24, marginBottom: 6 }}>Test Complete</h2>
              <button
                className="btn-ghost qbank-export-pdf-toggle"
                onClick={() => void exportActiveSessionPdf()}
                title="Export this session to PDF — questions and choices first, answers and explanations on a new page"
                disabled={exportingPdf}
              >
                <Download size={14} /> {exportingPdf ? "Exporting…" : "Export PDF"}
              </button>
            </div>
            <p style={{ color: "var(--text-muted)", marginBottom: 18 }}>{score} of {active.questions.length} correct / raw {resultPct}%</p>
            <div className="qbank-results-score" style={{ "--score": String(weighted.normalized) } as React.CSSProperties}>{weighted.normalized}<span>difficulty-adjusted</span></div>
            <div style={{ height: 10, background: "#e8eef8", borderRadius: 999, overflow: "hidden", marginBottom: 20 }}><div style={{ height: "100%", width: `${weighted.normalized}%`, background: weighted.normalized >= 70 ? "var(--green)" : weighted.normalized >= 50 ? "var(--amber)" : "var(--red)" }} /></div>
            <div className="qbank-results-grid">
              <span><b>{weighted.raw}</b> weighted points</span>
              <span><b>{weighted.hardCorrect}</b> hard wins</span>
              <span><b>{weighted.easyMiss}</b> easy misses</span>
              <span><b>{weighted.unanswered}</b> omitted</span>
              <span><b>{formatQuestionTime(avgTime)}</b> avg time</span>
            </div>
            <p className="qbank-results-note">Scoring weights each item by peer performance: correct hard questions earn more credit, while missing questions most users answered correctly costs more.</p>
            <div className="qbank-results-summary-table" role="table" aria-label="Block question statistics">
              <div className="qbank-results-summary-head" role="row">
                <span>QID</span>
                <span>Subject</span>
                <span>Topic / system</span>
                <span>Result</span>
                <span>% correct</span>
                <span>Time spent</span>
              </div>
              {resultRows.map(item => {
                const peer = item.question.answer_stats?.percent_correct;
                return (
                  <button
                    key={`${item.question.id}-${item.index}`}
                    type="button"
                    className={`qbank-results-summary-row ${item.correct ? "is-correct" : item.omitted ? "is-omitted" : "is-wrong"}`}
                    onClick={() => { setMode("quiz"); goToQuestion(item.index); }}
                  >
                    <span>#{item.question.id}</span>
                    <span>{item.question.subject || "Unassigned"}</span>
                    <span>{item.question.system_detail || item.question.system_group || item.question.system || "Unassigned"}</span>
                    <span>{item.correct ? "Correct" : item.omitted ? "Omitted" : "Incorrect"}</span>
                    <span>{typeof peer === "number" ? `${Math.round(peer)}%` : "—"}</span>
                    <span>{formatQuestionTime(item.spentSec)}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ ...row, justifyContent: "center" }}>
              <button className="btn-primary" onClick={() => { setMode("quiz"); goToQuestion(0); }}><BookOpen size={14} /> Review</button>
              <button className="btn-ghost" onClick={() => setMode("home")}><RotateCcw size={14} /> New Test</button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const homeStats = stats?.[db];
  const bankLabel = DB_LABELS[db] || bankMeta.label || db;
  const isFormBank = bankMeta.category === "nbme" || bankMeta.category === "cms";
  const isAmbossBank = bankMeta.category === "amboss";
  const subjectAxisLabel = isAmbossBank ? "Source subject / topic" : "Subject";
  const allSubjectLabel = isAmbossBank ? "All AMBOSS subjects/topics" : "All Subjects";
  const systemAxisLabel = isAmbossBank ? "Organ systems" : "Systems";
  const allSystemLabel = isAmbossBank ? "All organ systems" : "All systems";
  const activeSessions = sessions.filter(s => !s.completedAt && s.db === db);
  const completedSessions = sessions.filter(s => s.completedAt && s.db === db);
  const dailyQbankCompletedSessions = sessions.filter(s => s.completedAt && isDailyQbankDb(s.db));
  // Everything the Custom tab organizes: every real block the user created.
  const customSessions = sessions.filter(s => !s.transient && !isReferenceSession(s));
  const savedSessionCount = customSessions.length;
  const reviewBankOptions = Array.from(new Set([
    ...dailyQbankCompletedSessions.map(s => s.db),
    ...(isDailyQbankDb(db) ? [db] : []),
  ])).sort((a, b) => prettyDbLabel(a).localeCompare(prettyDbLabel(b)));
  const selectedReviewDb = reviewDbFilter === "all" ? "all" : reviewDbFilter;
  const reviewStats = buildQbankReviewStats(dailyQbankCompletedSessions, selectedReviewDb, reviewFacets);
  const reviewAvgTime = reviewStats.overall.total ? formatQuestionTime(reviewStats.overall.avgSec) : "—";
  const reviewAvailable = reviewStats.overall.available;
  const reviewPending = reviewStats.overall.pending;
  // UWorld-style breakdown tabs: pick which axis the progression table groups by.
  const breakdownTabs: { key: typeof reviewBreakdownTab; label: string; rows: typeof reviewStats.subjects }[] = [
    { key: "subjects", label: isAmbossBank ? "Subjects / topics" : "Subjects", rows: reviewStats.subjects },
    { key: "systems", label: "Systems", rows: reviewStats.systems },
    { key: "topics", label: "Topics", rows: reviewStats.topics },
    { key: "banks", label: "Q-banks", rows: reviewStats.banks },
  ];
  const activeBreakdown = breakdownTabs.find(t => t.key === reviewBreakdownTab) || breakdownTabs[0];
  const breakdownRows = activeBreakdown.rows;
  const usedCount = usedIdsByDb[db]?.length || 0;
  const cleanCount = homeStats?.valid_count || 0;
  const unusedCount = cleanCount ? Math.max(0, cleanCount - usedCount) : 0;
  const usedPercent = cleanCount ? clampNumber(Math.round((usedCount / cleanCount) * 100), 0, 100) : 0;
  const unusedLabel = homeStats ? unusedCount.toLocaleString() : "...";
  const cleanLabel = homeStats ? cleanCount.toLocaleString() : "...";
  const latestSession = [...activeSessions, ...completedSessions]
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))[0];
  const markedCount = (markedIdsByDb[db] || []).length;
  const incorrectCount = incorrectIds.length;
  const sourceFamily: SourceFamily = isAmbossBank ? "amboss" : "uworld";
  const sourceCountFor = (family: SourceFamily) => {
    const step = Number(studyStep);
    return catalog?.categories.find(cat => cat.id === family)?.steps?.find(item => item.step === step)?.count;
  };
  const sourceOptions: { family: SourceFamily; label: string; hint: string; count?: number }[] = [
    { family: "uworld", label: "UWorld", hint: "Subjects, foundations, systems", count: sourceCountFor("uworld") },
    { family: "amboss", label: "AMBOSS", hint: "Exam, systems, disciplines, filters", count: sourceCountFor("amboss") },
  ];
  const selectableSubjects = subjects.filter(s => (s.count || 0) > 0);
  const allSubjectsSelected = selectableSubjects.length > 0 && selectableSubjects.every(s => selectedSubjectIds.has(s.id));
  const selectedSubjectLabel = selectedSubjectIds.size ? `${selectedSubjectIds.size} selected` : allSubjectLabel;
  const renderSubjectChecklist = (variant: SourceFamily) => (
    <div className={`qbank-subject-checklist qbank-subject-checklist-${variant}`}>
      <div className="qbank-scope-toolbar">
        <span>{selectedSubjectLabel}</span>
        <div>
          <button
            type="button"
            className="qbank-systems-clear"
            onClick={() => setSelectedSubjectIds(new Set())}
            disabled={!selectedSubjectIds.size}
          >
            Clear
          </button>
          <button
            type="button"
            className="qbank-systems-clear"
            onClick={() => setSelectedSubjectIds(allSubjectsSelected ? new Set() : new Set(selectableSubjects.map(s => s.id)))}
            disabled={!selectableSubjects.length}
          >
            {allSubjectsSelected ? "Unselect all" : "Select all"}
          </button>
        </div>
      </div>
      <div className="qbank-subject-grid">
        {selectableSubjects.length === 0 && <p className="qbank-systems-empty">Loading {variant === "amboss" ? "disciplines" : "subjects"}...</p>}
        {selectableSubjects.map(subject => {
          const checked = selectedSubjectIds.has(subject.id);
          return (
            <button
              key={subject.id}
              type="button"
              className={`qbank-subject-chip ${checked ? "is-checked" : ""}`}
              onClick={() => setSelectedSubjectIds(prev => {
                const next = new Set(prev);
                if (next.has(subject.id)) next.delete(subject.id);
                else next.add(subject.id);
                return next;
              })}
            >
              {checked ? <CheckSquare size={15} /> : <Square size={15} />}
              <span>{subject.name}</span>
              <em>{subject.count}</em>
            </button>
          );
        })}
      </div>
    </div>
  );
  const systemPicker = (
    <>
      <div className="qbank-systems-toolbar">
        <label className="qbank-systems-search">
          <Search size={14} />
          <input
            value={systemTreeFilter}
            onChange={e => setSystemTreeFilter(e.target.value)}
            placeholder={isAmbossBank ? "Filter organ systems..." : "Filter systems..."}
          />
        </label>
        <button
          type="button"
          className="qbank-systems-clear"
          onClick={() => setSelectedSystemIds(new Set())}
          disabled={!selectedSystemIds.size}
        >
          Clear
        </button>
        <button
          type="button"
          className="qbank-systems-clear"
          onClick={() => setExpandedGroups(prev => prev.size ? new Set() : new Set(systemTree.map(g => g.name)))}
        >
          {expandedGroups.size ? "Collapse" : "Expand"} all
        </button>
      </div>
      <div className="qbank-systems-tree">
        {systemTree.length === 0 && <p className="qbank-systems-empty">Loading systems...</p>}
        {systemTree.map(group => {
          const q = systemTreeFilter.trim().toLowerCase();
          const visibleChildren = q
            ? group.children.filter(ch => ch.label.toLowerCase().includes(q) || group.name.toLowerCase().includes(q))
            : group.children;
          if (q && visibleChildren.length === 0) return null;
          const childIds = group.children.map(ch => ch.id);
          const selectedInGroup = childIds.filter(id => selectedSystemIds.has(id)).length;
          const allSelected = selectedInGroup === childIds.length && childIds.length > 0;
          const someSelected = selectedInGroup > 0 && !allSelected;
          const expanded = expandedGroups.has(group.name) || Boolean(q);
          return (
            <div key={group.name} className="qbank-systems-group">
              <div className={`qbank-systems-grouprow ${allSelected ? "is-all" : someSelected ? "is-some" : ""}`}>
                <button
                  type="button"
                  className="qbank-systems-checkbox"
                  onClick={() => setSelectedSystemIds(prev => {
                    const next = new Set(prev);
                    if (allSelected) childIds.forEach(id => next.delete(id));
                    else childIds.forEach(id => next.add(id));
                    return next;
                  })}
                  aria-label={`Select all ${group.name}`}
                >
                  {allSelected ? <CheckSquare size={16} /> : someSelected ? <MinusSquare size={16} /> : <Square size={16} />}
                </button>
                <button
                  type="button"
                  className="qbank-systems-grouplabel"
                  onClick={() => setExpandedGroups(prev => {
                    const next = new Set(prev);
                    if (next.has(group.name)) next.delete(group.name); else next.add(group.name);
                    return next;
                  })}
                >
                  <span className="qbank-systems-name">{group.name}</span>
                  <span className="qbank-systems-count">{group.count}</span>
                  <ChevronRight size={14} className={`qbank-systems-caret ${expanded ? "is-open" : ""}`} />
                </button>
              </div>
              {expanded && (
                <div className="qbank-systems-children">
                  {visibleChildren.map(ch => {
                    const checked = selectedSystemIds.has(ch.id);
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        className={`qbank-systems-child ${checked ? "is-checked" : ""}`}
                        onClick={() => setSelectedSystemIds(prev => {
                          const next = new Set(prev);
                          if (next.has(ch.id)) next.delete(ch.id); else next.add(ch.id);
                          return next;
                        })}
                      >
                        {checked ? <CheckSquare size={15} /> : <Square size={15} />}
                        <span className="qbank-systems-name">{ch.label}</span>
                        <span className="qbank-systems-count">{ch.count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div style={shell}>
      <div className="qbank-ws-header">
        <div className="qbank-ws-brand">
          <h1>Q-Bank Workstation</h1>
          <p>{homeStats ? `${cleanLabel} clean · ${homeStats.count.toLocaleString()} total · ${bankLabel}` : `${bankLabel} · loading…`}</p>
        </div>
        <nav className="qbank-ws-nav" role="tablist">
          <button role="tab" className={workspaceTab === "build" ? "is-active" : ""} onClick={() => { setWorkspaceTab("build"); if (mode === "browse") setMode("home"); }}>
            <ListFilter size={15} /> Build
          </button>
          <button role="tab" className={workspaceTab === "review" ? "is-active" : ""} onClick={() => setWorkspaceTab("review")}>
            <BarChart3 size={15} /> Review{completedSessions.length ? <span className="qbank-ws-badge">{completedSessions.length}</span> : null}
          </button>
          <button role="tab" className={workspaceTab === "custom" ? "is-active" : ""} onClick={() => setWorkspaceTab("custom")}>
            <FolderOpen size={15} /> Custom{savedSessionCount ? <span className="qbank-ws-badge">{savedSessionCount}</span> : null}
          </button>
          <button role="tab" className={workspaceTab === "partner" ? "is-active" : ""} onClick={() => setWorkspaceTab("partner")}>
            <Users size={15} /> Partner
          </button>
        </nav>
        <div className="qbank-step-focus" role="group" aria-label="USMLE step focus">
          <span>Step</span>
          {(["1", "2", "3"] as StudyStepPref[]).map(step => (
            <button
              key={step}
              type="button"
              className={studyStep === step ? "is-active" : ""}
              onClick={() => setStudyStepPreference(step)}
              aria-pressed={studyStep === step}
              title={`Use Step ${step} as the default Q-bank focus`}
            >
              {step}
            </button>
          ))}
        </div>
        <div className="qbank-ws-status" title={persistentStorage ? `Saved in ${persistentStorage}` : "Browser cache fallback"}>
          <span className={`qbank-ws-sync ${memoryReady ? "is-on" : ""}`}><i /> {memoryReady ? "Synced" : "Local"}</span>
          <div className="qbank-ws-meter">
            <div className="qbank-ws-meter-head"><span><strong>{unusedLabel}</strong> unused</span><span>{cleanLabel} clean</span></div>
            <div className="qbank-ws-meter-bar"><span style={{ width: `${cleanCount ? 100 - usedPercent : 100}%` }} /></div>
          </div>
          <button className="qbank-ws-reset" onClick={resetCurrentQbankProgress} title={`Reset ${bankLabel} progress`}><RotateCcw size={13} /></button>
        </div>
      </div>

      <div style={page}>
        {examRun && examRun.phase !== "done" && (
          <div className="qbank-resume-exam" role="status">
            <div className="qbank-resume-exam-text">
              <strong>Exam in progress</strong>
              <span>{examRun.label} · Block {Math.min(examRun.currentBlock + 1, examRun.blockCount)} of {examRun.blockCount}{examRun.phase === "break" ? " · on break" : ""}</span>
            </div>
            <div className="qbank-resume-exam-actions">
              <button
                className="btn-primary"
                onClick={() => {
                  const run = examRunRef.current;
                  if (!run) return;
                  if (run.phase === "break") { setMode("break"); return; }
                  requestExamFullscreen();
                  beginExamBlock(run.blocks[run.currentBlock]);
                }}
              >
                <Play size={14} /> Resume exam
              </button>
              <button
                className="qbank-resume-exam-end"
                onClick={() => { if (window.confirm("End this exam now? You can review what you've answered so far.")) endExamRun(); }}
              >
                End exam
              </button>
            </div>
          </div>
        )}
        {workspaceTab === "build" && mode !== "browse" && (
        <div className="qbank-build-stage">
          <div className="qbank-build-primary">
            <div className="qbank-builder-card qbank-builder-v2">
              <div className="qbank-builder-hero">
                <span className="qbank-builder-mark"><ListFilter size={18} /></span>
                <div>
                  <h2>{isFormBank ? "Start exam" : "Build a block"}</h2>
                  <p>{isFormBank ? "Full-screen, timed, multi-block — just like the real NBME." : (testMode === "exam" ? "NBME-style timed session, no explanations during the block." : "Tutor block with explanations and reference tools after each answer.")}</p>
                </div>
                {!isFormBank && (
                  <button className="qbank-hero-start" onClick={() => startSession()} disabled={loading}>
                    {loading ? <span className="loader" style={{ width: 13, height: 13 }} /> : <Play size={14} />} Start {allMatched ? "all matched" : batchSize}
                  </button>
                )}
              </div>

              {!isFormBank && (
                <label className="qbank-session-name">
                  <span><Sparkles size={14} /> Session name <em>optional</em></span>
                  <input
                    type="text"
                    value={sessionName}
                    onChange={event => setSessionName(event.target.value)}
                    placeholder="e.g. Cardiology weak spots — Monday"
                    maxLength={160}
                  />
                </label>
              )}

              <div className="qbank-source-switch" role="group" aria-label="Q-bank source">
                {sourceOptions.map(option => (
                  <button
                    key={option.family}
                    type="button"
                    className={sourceFamily === option.family && !isFormBank ? "is-active" : ""}
                    onClick={() => selectDailySource(option.family)}
                    aria-pressed={sourceFamily === option.family && !isFormBank}
                  >
                    <span className="qbank-source-icon">{option.family === "amboss" ? <FlaskConical size={17} /> : <BookOpen size={17} />}</span>
                    <span>
                      <b>{option.label}</b>
                      <em>{option.hint}</em>
                    </span>
                    <strong>{option.count != null ? option.count.toLocaleString() : `Step ${studyStep}`}</strong>
                  </button>
                ))}
              </div>

              <div className="qbank-build-section">
                <div className="qbank-build-section-title">
                  <strong>Question Type</strong>
                  <em>{bankLabel}</em>
                </div>
                <div className="qbank-banktype-tree">
                  {!catalog && <p className="qbank-systems-empty">Loading banks…</p>}
                  {catalog?.categories.map(cat => {
                    const open = openBankNodes.has(cat.id);
                    return (
                      <div key={cat.id} className="qbank-bt-cat">
                        <button type="button" className="qbank-bt-row" onClick={() => toggleBankNode(cat.id)}>
                          <ChevronRight size={14} className={`qbank-systems-caret ${open ? "is-open" : ""}`} />
                          <span className="qbank-bt-name">{cat.label}</span>
                        </button>
                        {open && cat.id === "uworld" && cat.steps?.map(s => (
                          <button
                            key={s.key}
                            type="button"
                            className={`qbank-bt-leaf ${db === s.key ? "is-active" : ""}`}
                            onClick={() => selectBank(s.key!, { category: "uworld", step: s.step, label: DB_LABELS[s.key!] || `UWorld STEP ${s.step}` })}
                          >
                            <span className="qbank-bt-name">{s.label}</span>
                            <span className="qbank-bt-count">{(s.count ?? 0).toLocaleString()}</span>
                          </button>
                        ))}
                        {open && cat.id === "amboss" && cat.steps?.map(s => (
                          <button
                            key={s.key}
                            type="button"
                            className={`qbank-bt-leaf ${db === s.key ? "is-active" : ""}`}
                            onClick={() => selectBank(s.key!, { category: "amboss", step: s.step, label: DB_LABELS[s.key!] || `AMBOSS ${s.label}` })}
                          >
                            <span className="qbank-bt-name">{s.label}</span>
                            <span className="qbank-bt-count">{(s.count ?? 0).toLocaleString()}</span>
                          </button>
                        ))}
                        {open && cat.banks?.map(b => (
                          <button
                            key={b.key}
                            type="button"
                            className={`qbank-bt-leaf ${db === b.key ? "is-active" : ""}`}
                            onClick={() => selectBank(
                              b.key,
                              dailyBankMeta(b.key) || { category: cat.id as BankMeta["category"], label: b.label },
                            )}
                          >
                            <span className="qbank-bt-name">{b.label}</span>
                            <span className="qbank-bt-count">{(b.count ?? 0).toLocaleString()}</span>
                          </button>
                        ))}
                        {open && cat.id === "nbme" && cat.steps?.map(s => {
                          const nodeId = `nbme-step-${s.step}`;
                          const subOpen = openBankNodes.has(nodeId);
                          return (
                            <div key={nodeId} className="qbank-bt-sub">
                              <button type="button" className="qbank-bt-row qbank-bt-row-2" onClick={() => toggleBankNode(nodeId)}>
                                <ChevronRight size={13} className={`qbank-systems-caret ${subOpen ? "is-open" : ""}`} />
                                <span className="qbank-bt-name">Step {s.step}</span>
                                <span className="qbank-bt-count">{s.forms?.length || 0}</span>
                              </button>
                              {subOpen && s.forms?.map(f => (
                                <button
                                  key={f.key}
                                  type="button"
                                  className={`qbank-bt-leaf qbank-bt-leaf-2 ${db === f.key ? "is-active" : ""}`}
                                  onClick={() => selectBank(f.key, { category: "nbme", step: s.step, form: f.form, label: `NBME ${s.step} · ${f.label}` })}
                                >
                                  <span className="qbank-bt-name">{f.label}</span>
                                  <span className="qbank-bt-count">{f.count.toLocaleString()}</span>
                                </button>
                              ))}
                            </div>
                          );
                        })}
                        {open && cat.id === "cms" && cat.subjects?.map(sub => {
                          const nodeId = `cms-${sub.subject}`;
                          const subOpen = openBankNodes.has(nodeId);
                          return (
                            <div key={nodeId} className="qbank-bt-sub">
                              <button type="button" className="qbank-bt-row qbank-bt-row-2" onClick={() => toggleBankNode(nodeId)}>
                                <ChevronRight size={13} className={`qbank-systems-caret ${subOpen ? "is-open" : ""}`} />
                                <span className="qbank-bt-name">{sub.subject}</span>
                                <span className="qbank-bt-count">{sub.count} {sub.count === 1 ? "form" : "forms"}</span>
                              </button>
                              {subOpen && sub.forms.map(f => (
                                <button
                                  key={f.key}
                                  type="button"
                                  className={`qbank-bt-leaf qbank-bt-leaf-2 ${db === f.key ? "is-active" : ""}`}
                                  onClick={() => selectBank(f.key, { category: "cms", subject: sub.subject, form: f.form, label: `${sub.subject} · ${f.label}` })}
                                >
                                  <span className="qbank-bt-name">{f.label}</span>
                                  <span className="qbank-bt-count">{f.count.toLocaleString()}</span>
                                </button>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>

              {isFormBank && (
                <div className="qbank-build-section qbank-exam-launch">
                  <div className="qbank-build-section-title">
                    <strong>Exam mode</strong>
                    <em>{bankLabel}</em>
                  </div>
                  <p className="qbank-exam-launch-note">
                    Take {bankLabel} as a timed, full-screen exam. Answer choices are not graded until you finish every block, with a timed break between blocks. Progress is saved continuously — a crash or accidental close resumes you on the same question with the same timer.
                  </p>
                  <div className="qbank-exam-structure">
                    <button type="button" className={examStructure === "native" ? "is-active" : ""} onClick={() => setExamStructure("native")}>
                      <b>Native blocks</b>
                      <em>{(subjects.filter(s => (s.count || 0) > 0).length || 4)} blocks · how the real NBME is given</em>
                    </button>
                    <button type="button" className={examStructure === "chunked" ? "is-active" : ""} onClick={() => setExamStructure("chunked")}>
                      <b>20-question blocks</b>
                      <em>New USMLE format · ~30 min each</em>
                    </button>
                  </div>
                  <button className="qbank-start-button qbank-launch-cta qbank-exam-go" onClick={() => buildExam(examStructure)} disabled={loading}>
                    {loading ? <span className="loader" style={{ width: 16, height: 16 }} /> : <Play size={16} />} Get started
                  </button>
                </div>
              )}

              {!isFormBank && (<>
              <div className="qbank-build-section">
                <div className="qbank-build-section-title">
                  <strong>Test mode</strong>
                  <em>{allMatched ? "All matched questions" : `${batchSize} questions`} · {testMode === "exam" ? `${examMinutes} min timed` : "self-paced tutor"}</em>
                </div>
                <div className="qbank-mode-cards">
                  <button className={testMode === "tutor" ? "is-active" : ""} onClick={() => setTestMode("tutor")}>
                    <Sparkles size={15} />
                    <span><b>Tutor</b><em>Explain as you go</em></span>
                  </button>
                  <button className={testMode === "exam" ? "is-active" : ""} onClick={() => setTestMode("exam")}>
                    <Clock3 size={15} />
                    <span><b>Timed</b><em>New USMLE block</em></span>
                  </button>
                </div>
                <div className="qbank-slider-row">
                  <div className="qbank-slider-head">
                    <span className="qbank-mini-label">Questions</span>
                    <strong>{allMatched ? "All matched" : batchSize}</strong>
                  </div>
                  <input
                    type="range" min={1} max={100} value={batchSize}
                    disabled={allMatched}
                    onChange={e => { const n = Number(e.target.value); setBatchSize(n); setExamMinutes(examMinutesForCount(n)); }}
                  />
                  <label className={`qbank-all-matched ${allMatched ? "is-on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={allMatched}
                      onChange={e => setAllMatched(e.target.checked)}
                    />
                    <span>
                      <b>All matched questions</b>
                      <em>Ignore the 100-question cap and build with every question that matches these filters. Large sets ask for confirmation.</em>
                    </span>
                  </label>
                </div>
                {testMode === "exam" && (
                  <>
                    <div className="qbank-slider-row">
                      <div className="qbank-slider-head">
                        <span className="qbank-mini-label">Time (minutes)</span>
                        <strong>{examMinutes} min</strong>
                      </div>
                      <input type="range" min={1} max={180} value={examMinutes} onChange={e => setExamMinutes(Number(e.target.value))} />
                    </div>
                    <div className="qbank-format-note">
                      <Clock3 size={13} />
                      <span>New USMLE block format (from 14 May 2026): shorter, more frequent blocks — Step 1: 14 blocks × 20 Q × 30 min; Step 2 CK: 16 blocks × 20 Q × 30 min. Total exam time is unchanged. Defaults to ~1.5 min/question.</span>
                    </div>
                  </>
                )}
              </div>

              <div className="qbank-build-section">
                <div className="qbank-build-section-title">
                  <strong>Question pool</strong>
                  <em>{cleanCount ? `${usedCount.toLocaleString()} of ${cleanLabel} used` : "Draw from a learning state."}</em>
                </div>
                <div className="qbank-pool-row">
                  {POOL_OPTIONS.map(opt => {
                    const count = opt.key === "unused" ? unusedCount
                      : opt.key === "incorrect" ? incorrectCount
                      : opt.key === "marked" ? markedCount
                      : cleanCount;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        className={`qbank-pool-chip ${pool === opt.key ? "is-active" : ""}`}
                        onClick={() => setPool(opt.key)}
                        title={opt.hint}
                      >
                        <b>{opt.label}</b>
                        <span>{homeStats ? count.toLocaleString() : "..."}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="qbank-pool-progress">
                  <div className="qbank-used-meter" aria-hidden="true"><span style={{ width: `${usedPercent}%` }} /></div>
                  <div className="qbank-pool-progress-foot">
                    <span>{unusedLabel} unused</span>
                    <button type="button" className={`qbank-track-toggle ${trackPrepProgress ? "is-prep" : ""}`} onClick={() => setPrepProgressTracking(!trackPrepProgress)} title="Toggle whether finished QIDs are logged so Unused shrinks over time">
                      {trackPrepProgress ? "Logging progress" : "Practice (no log)"}
                    </button>
                  </div>
                </div>
                <label className="qbank-builder-searchbox qbank-focus-inline">
                  <span><Search size={15} /></span>
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Optional: focus by diagnosis, drug, symptom, or QID topic" />
                </label>
              </div>

              <div className="qbank-build-section">
                {isFormBank ? (
                <>
                <div className="qbank-build-section-title">
                  <strong>Blocks</strong>
                  <em>{selectedBlockIds.size ? `${selectedBlockIds.size} selected` : "All blocks"}</em>
                </div>
                <div className="qbank-block-picker">
                  {subjects.filter(s => (s.count || 0) > 0).length === 0 && <p className="qbank-systems-empty">Loading blocks…</p>}
                  {subjects.filter(s => (s.count || 0) > 0).map(b => {
                    const checked = selectedBlockIds.has(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={`qbank-systems-child ${checked ? "is-checked" : ""}`}
                        onClick={() => setSelectedBlockIds(prev => {
                          const next = new Set(prev);
                          if (next.has(b.id)) next.delete(b.id); else next.add(b.id);
                          return next;
                        })}
                      >
                        {checked ? <CheckSquare size={15} /> : <Square size={15} />}
                        <span className="qbank-systems-name">{b.name}</span>
                        <span className="qbank-systems-count">{b.count}</span>
                      </button>
                    );
                  })}
                </div>
                </>
                ) : isAmbossBank ? (
                <>
                <div className="qbank-build-section-title">
                  <strong>AMBOSS custom session</strong>
                  <em>{selectedSubjectIds.size || selectedSystemIds.size ? `${selectedSubjectIds.size + selectedSystemIds.size} filters selected` : "Exam-wide AMBOSS pool"}</em>
                </div>
                <div className="qbank-origin-subhead">Include questions from</div>
                <div className="qbank-origin-grid">
                  <button type="button" className="qbank-origin-tile is-active" onClick={() => selectDailySource("amboss")}>
                    <CheckSquare size={16} />
                    <span><b>Exam</b><em>USMLE Step {studyStep}</em></span>
                    <strong>{cleanLabel}</strong>
                  </button>
                  <button type="button" className={`qbank-origin-tile ${selectedSystemIds.size ? "is-active" : ""}`} onClick={() => setExpandedGroups(new Set(systemTree.map(g => g.name)))}>
                    <ListFilter size={16} />
                    <span><b>Systems</b><em>{selectedSystemIds.size ? `${selectedSystemIds.size} selected` : allSystemLabel}</em></span>
                    <strong>{systemTree.length}</strong>
                  </button>
                  <button type="button" className={`qbank-origin-tile ${selectedSubjectIds.size ? "is-active" : ""}`} onClick={() => setSelectedSubjectIds(prev => prev.size ? new Set() : new Set(selectableSubjects.map(s => s.id)))}>
                    <BookOpen size={16} />
                    <span><b>Discipline</b><em>{selectedSubjectLabel}</em></span>
                    <strong>{selectableSubjects.length}</strong>
                  </button>
                  <button type="button" className={`qbank-origin-tile ${query.trim() ? "is-active" : ""}`} onClick={() => setQuery("")}>
                    <Search size={16} />
                    <span><b>Search focus</b><em>{query.trim() || "Symptom, diagnosis, drug"}</em></span>
                    <strong>{query.trim() ? "On" : "Any"}</strong>
                  </button>
                </div>

                <div className="qbank-origin-subhead">Filter questions by</div>
                <div className="qbank-filter-panel">
                  <button type="button" className={`qbank-filter-control ${sort === "difficulty" ? "is-active" : ""}`} onClick={() => setSort(sort === "difficulty" ? "random" : "difficulty")}>
                    <BarChart3 size={15} />
                    <span><b>Difficulty</b><em>{sort === "difficulty" ? "Hardest first" : "Random order"}</em></span>
                  </button>
                  <div className="qbank-filter-status">
                    <strong>Status</strong>
                    <div>
                      {POOL_OPTIONS.map(opt => (
                        <button key={opt.key} type="button" className={pool === opt.key ? "is-active" : ""} onClick={() => setPool(opt.key)}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button type="button" className={`qbank-filter-control qbank-filter-toggle ${imagesOnly ? "is-active" : ""}`} onClick={() => setImagesOnly(v => !v)} aria-pressed={imagesOnly}>
                    <Images size={15} />
                    <span><b>Images only</b><em>{imagesOnly ? "Required" : "Any media state"}</em></span>
                  </button>
                </div>

                <div className="qbank-origin-columns">
                  <div>
                    <div className="qbank-origin-subhead">{subjectAxisLabel}</div>
                    {renderSubjectChecklist("amboss")}
                  </div>
                  <div>
                    <div className="qbank-origin-subhead">{systemAxisLabel}</div>
                    {systemPicker}
                  </div>
                </div>
                </>
                ) : (
                <>
                <div className="qbank-build-section-title">
                  <strong>Subjects and foundations</strong>
                  <em>{selectedSubjectIds.size ? `${selectedSubjectIds.size} selected` : "All UWorld subjects"}</em>
                </div>
                <div className="qbank-uworld-panel" aria-label="UWorld-style subjects and foundations">
                  {renderSubjectChecklist("uworld")}
                </div>
                <div className="qbank-build-section-title qbank-subsection-title">
                  <strong>{systemAxisLabel}</strong>
                  <em>{selectedSystemIds.size ? `${selectedSystemIds.size} selected` : allSystemLabel}</em>
                </div>
                {systemPicker}
                </>
                )}
              </div>
              </>)}

            </div>

            {!isFormBank && (
            <div className="qbank-tags-card">
              <div style={{ ...row, marginBottom: 12 }}><Flag size={15} color="var(--amber)" /><strong>Search Tags</strong></div>
              <div style={{ ...row, flexWrap: "wrap" }}>
                {tags.slice(0, 28).map(t => (
                  <button
                    key={t.tag}
                    className={tag === t.tag ? "btn-primary" : "btn-ghost"}
                    onClick={() => {
                      const next = tag === t.tag ? "" : t.tag;
                      setTag(next);
                      setQuery(next);
                      void loadBrowse({ query: next, tag: next });
                    }}
                    title={`Browse ${t.count} tagged questions`}
                  >
                    {t.tag}
                  </button>
                ))}
              </div>
            </div>
            )}
          </div>

          {!isFormBank && (
          <div className="qbank-launch-bar">
            <div className="qbank-launch-summary">
              <span>{bankLabel}</span>
              <span>{allMatched ? "All matched questions" : `${batchSize} questions`}</span>
              <span>{testMode === "exam" ? `Timed · ${allMatched ? "auto" : `${examMinutes} min`}` : "Tutor mode"}</span>
              <span>{POOL_OPTIONS.find(p => p.key === pool)?.label} pool</span>
              <span>{selectedSubjectIds.size ? `${selectedSubjectIds.size} subjects` : allSubjectLabel}</span>
              <span>{isFormBank
                ? (selectedBlockIds.size ? `${selectedBlockIds.size} blocks` : "All blocks")
                : (selectedSystemIds.size ? `${selectedSystemIds.size} systems` : "All systems")}</span>
              {imagesOnly && <span>Images only</span>}
            </div>
            <div className="qbank-launch-actions">
              <label className="qbank-select-field qbank-order-field">
                <span>Order</span>
                <select value={sort} onChange={e => setSort(e.target.value as SortMode)}>
                  <option value="random">Random</option>
                  <option value="difficulty">Hardest first</option>
                  <option value="newest">Newest</option>
                  <option value="id">QID order</option>
                </select>
              </label>
              <button className="qbank-browse-button" onClick={() => loadBrowse()} disabled={loading}><Search size={15} /> Browse</button>
              <button className="qbank-start-button qbank-launch-cta" onClick={() => startSession()} disabled={loading}>
                {loading ? <span className="loader" style={{ width: 16, height: 16 }} /> : <Play size={16} />} {allMatched ? "Start all matched" : "Start block"}
              </button>
              {latestSession && latestSession.questions.length > 0 && (
                <button
                  className="btn-ghost qbank-export-pdf-toggle"
                  onClick={() => void exportSessionPdf(latestSession)}
                  title="Export the latest Q-Bank session to PDF"
                  disabled={exportingPdf}
                >
                  <Download size={15} /> {exportingPdf ? "Exporting…" : "Export PDF"}
                </button>
              )}
            </div>
          </div>
          )}
        </div>
        )}

        {workspaceTab === "build" && mode === "browse" && (
          <div className="qbank-page-stage">
            <button className="qbank-back-btn" onClick={() => setMode("home")}><ChevronLeft size={15} /> Back to builder</button>
            <div className="qbank-list-card">
              <div style={{ ...row, justifyContent: "space-between", marginBottom: 14 }}>
                <strong>Browse Questions</strong>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{total.toLocaleString()} matching clean questions in {bankLabel}</span>
              </div>
              <div className="qbank-browse-grid">
                {browse.map(item => (
                  <button key={item.id} className="qbank-browser-row" onClick={() => startSession(item)}>
                    <div style={{ ...row, justifyContent: "space-between", marginBottom: 6 }}>
                      <strong>{item.title || `Question ${item.id}`}</strong>
                      <span className="tag tag-blue">QID {item.id}</span>
                    </div>
                    <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 8 }}>{item.stem.slice(0, 220)}{item.stem.length > 220 ? "..." : ""}</p>
                    <div style={{ ...row, flexWrap: "wrap" }}>
                      <span className="tag tag-gray">{item.subject}</span>
                      {item.media.length > 0 && <span className="tag tag-amber"><ImageIcon size={10} /> {item.media.length}</span>}
                      {item.answer_stats?.percent_correct != null && <span className="tag tag-green">{item.answer_stats.percent_correct}% correct</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {workspaceTab === "review" && (
          <div className="qbank-page-stage">
            <div className="qbank-review-toolbar">
              <div>
                <strong>Q-bank performance</strong>
                <span>{reviewDbFilter === "all" ? "All daily Q-banks" : prettyDbLabel(reviewDbFilter)}</span>
              </div>
              <label className="qbank-select-field">
                <span>Stats for</span>
                <select value={reviewDbFilter} onChange={event => setReviewDbFilter(event.target.value as DB | "all")}>
                  <option value="all">All daily Q-banks</option>
                  {reviewBankOptions.map(key => (
                    <option key={key} value={key}>{prettyDbLabel(key)}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="qbank-page-statgrid">
              <div className="qbank-bigstat">
                <b>{reviewStats.overall.total}{reviewAvailable ? <span className="qbank-bigstat-of"> / {reviewAvailable.toLocaleString()}</span> : null}</b>
                <em>{reviewAvailable ? "questions used" : "questions finished"}</em>
              </div>
              <div className="qbank-bigstat"><b>{reviewStats.overall.correct}</b><em>correct</em></div>
              <div className="qbank-bigstat"><b>{reviewStats.overall.wrong}</b><em>wrong</em></div>
              <div className="qbank-bigstat"><b>{reviewStats.overall.accuracy}%</b><em>accuracy · {reviewAvgTime}</em></div>
            </div>

            <p className="qbank-review-explainer">
              <Info size={13} />
              <span>
                Every finished question is scored against its answer key the moment you submit, then rolled up by Q-bank, subject, organ system and topic.
                {reviewAvailable
                  ? ` You've used ${reviewStats.overall.total.toLocaleString()} of ${reviewAvailable.toLocaleString()} questions in scope — ${reviewPending.toLocaleString()} still pending.`
                  : " Pending and usage counts appear once bank totals load."}
                {" "}Switch the <b>Stats for</b> selector to focus a single bank, or keep <b>All</b> to combine AMBOSS and UWorld.
              </span>
            </p>

            {reviewStats.banks.length > 0 && (
              <div className="qbank-list-card">
                <div style={{ ...row, justifyContent: "space-between", marginBottom: 12 }}>
                  <div style={{ ...row }}><Database size={16} color="var(--accent)" /><strong>Q-bank usage and accuracy</strong></div>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{reviewStats.banks.length} active banks</span>
                </div>
                <div className="qbank-review-bankgrid">
                  {reviewStats.banks.map(bank => {
                    const used = usedIdsByDb[bank.db || bank.key]?.length || bank.total;
                    const totalBank = stats?.[bank.db || bank.key]?.valid_count || used || bank.total;
                    const pctUsed = totalBank ? Math.round((used / totalBank) * 100) : 0;
                    return (
                      <div key={bank.key} className="qbank-review-bankcard">
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                          <strong>{prettyDbLabel(bank.db || bank.key)}</strong>
                          <span>{bank.accuracy}%</span>
                        </div>
                        <div className="qbank-used-meter" aria-hidden="true"><span style={{ width: `${pctUsed}%` }} /></div>
                        <small>{bank.correct} correct · {bank.wrong} wrong · {bank.total} done · {formatQuestionTime(bank.avgSec)} avg</small>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="qbank-list-card">
              <div style={{ ...row, justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ ...row }}><BarChart3 size={16} color="var(--green)" /><strong>Past tests</strong></div>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{reviewStats.tests.length} completed blocks</span>
              </div>
              {reviewStats.tests.length ? (
                <>
                  {(() => {
                    const tests = reviewStats.tests.slice(0, 14).reverse();
                    const W = 620, H = 190, padL = 30, padB = 24, padT = 12;
                    const xAt = (i: number) => tests.length === 1 ? W / 2 : padL + (i * (W - padL - 12)) / (tests.length - 1);
                    const yAt = (pctValue: number) => padT + (1 - pctValue / 100) * (H - padT - padB);
                    const line = tests.map((t, i) => `${xAt(i).toFixed(1)},${yAt(t.accuracy).toFixed(1)}`).join(" ");
                    return (
                      <svg className="qbank-prog-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Performance by test">
                        {[0, 50, 75, 100].map(v => (
                          <g key={v}>
                            <line x1={padL} x2={W - 6} y1={yAt(v)} y2={yAt(v)} stroke="#eef2f8" strokeWidth={1} />
                            <text x={2} y={yAt(v) + 3} fontSize={9} fill="#94a3b8">{v}</text>
                          </g>
                        ))}
                        {tests.length > 1 && <polyline points={line} fill="none" stroke="#cbd5e1" strokeWidth={2} />}
                        {tests.map((test, i) => (
                          <g key={test.id}>
                            <circle cx={xAt(i)} cy={yAt(test.accuracy)} r={4.5} fill={bankGraphColor(test.db)} />
                            <text x={xAt(i)} y={yAt(test.accuracy) - 9} fontSize={11} fontWeight={800} textAnchor="middle" fill={bankGraphColor(test.db)}>{test.accuracy}%</text>
                            <text x={xAt(i)} y={H - 8} fontSize={9} textAnchor="middle" fill="#94a3b8">{test.completedAt ? new Date(test.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</text>
                          </g>
                        ))}
                      </svg>
                    );
                  })()}
                  {(() => {
                    const families = Array.from(new Set(reviewStats.tests.map(t => isAmbossDb(t.db || t.key) ? "amboss" : "uworld")));
                    if (families.length < 2) return null;
                    return (
                      <div className="qbank-graph-legend">
                        {families.includes("uworld") && <span><i style={{ background: bankGraphColor("step1") }} /> UWorld</span>}
                        {families.includes("amboss") && <span><i style={{ background: bankGraphColor("amboss1") }} /> AMBOSS</span>}
                      </div>
                    );
                  })()}
                  <div className="qbank-history-list">
                    {reviewStats.tests.slice(0, 20).map(test => (
                      <div key={test.id} className="qbank-session-row qbank-session-card">
                        <button
                          className="qbank-session-main"
                          onClick={() => {
                            const session = dailyQbankCompletedSessions.find(item => item.id === test.id);
                            if (session) { applyActiveSession(session); setMode("results"); }
                          }}
                        >
                          <div style={{ ...row, justifyContent: "space-between" }}>
                            <strong>{test.accuracy}% · {prettyDbLabel(test.db || test.key)}</strong>
                            <span>{test.correct}/{test.total} correct</span>
                          </div>
                          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{test.label} · {formatQuestionTime(test.avgSec)} avg time</p>
                          <small>Completed {formatShortDate(test.completedAt)}</small>
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              ) : <p className="qbank-empty-note">Finish UWorld or AMBOSS blocks and performance by test appears here.</p>}
            </div>

            <div className="qbank-list-card">
              <div style={{ ...row, justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                <div style={{ ...row }}><ListFilter size={16} color="var(--accent)" /><strong>Progression breakdown</strong></div>
                <div className="qbank-breakdown-tabs" role="tablist" aria-label="Progression breakdown axis">
                  {breakdownTabs.map(tab => (
                    <button
                      key={tab.key}
                      role="tab"
                      aria-selected={reviewBreakdownTab === tab.key}
                      className={reviewBreakdownTab === tab.key ? "is-active" : ""}
                      onClick={() => setReviewBreakdownTab(tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {breakdownRows.length ? (
                <div className="qbank-prog-table">
                  <div className="qbank-prog-thead" aria-hidden="true">
                    <span>{activeBreakdown.label.replace(/s$/, "")}</span>
                    <span>Usage</span>
                    <span>Correct</span>
                    <span>Incorrect</span>
                    <span>Omitted</span>
                    <span>Accuracy</span>
                  </div>
                  {breakdownRows.slice(0, 40).map(row2 => {
                    const label = reviewBreakdownTab === "banks" ? prettyDbLabel(row2.db || row2.key) : row2.label;
                    const usagePct = row2.available ? clampNumber(Math.round((row2.total / row2.available) * 100), 0, 100) : 0;
                    return (
                      <div key={row2.key} className="qbank-prog-trow">
                        <div className="qbank-prog-name">
                          <strong>{label}</strong>
                          {row2.available ? (
                            <small>{row2.total.toLocaleString()} / {row2.available.toLocaleString()} used · {row2.pending.toLocaleString()} pending</small>
                          ) : (
                            <small>{row2.total.toLocaleString()} done · {formatQuestionTime(row2.avgSec)} avg</small>
                          )}
                          <div className="qbank-prog-usage" aria-hidden="true">
                            <span className="is-done" style={{ width: `${usagePct}%` }} />
                          </div>
                          <div className="qbank-review-stack" aria-hidden="true">
                            <span className="is-correct" style={{ width: `${row2.total ? (row2.correct / row2.total) * 100 : 0}%` }} />
                            <span className="is-wrong" style={{ width: `${row2.total ? (row2.wrong / row2.total) * 100 : 0}%` }} />
                          </div>
                        </div>
                        <span className="qbank-prog-cell" data-label="Usage">{row2.available ? `${usagePct}%` : "—"}</span>
                        <span className="qbank-prog-cell is-correct-text" data-label="Correct">{row2.correct}</span>
                        <span className="qbank-prog-cell is-wrong-text" data-label="Incorrect">{row2.wrong}</span>
                        <span className="qbank-prog-cell" data-label="Omitted">{row2.omitted}</span>
                        <span className="qbank-prog-cell qbank-prog-acc" data-label="Accuracy">{row2.answered ? `${row2.accuracy}%` : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="qbank-empty-note">No {activeBreakdown.label.toLowerCase()} data yet — finish a block to populate this breakdown.</p>
              )}
            </div>

            <div className="qbank-list-card">
              <div style={{ ...row, marginBottom: 12 }}><Sparkles size={16} color="var(--accent)" /><strong>Focused Review — {bankLabel}</strong></div>
              <div className="qbank-review-actions">
                <button onClick={() => startQuestionIdBlock(db, markedIdsByDb[db] || [], "Marked review")} disabled={!markedCount || loading}>
                  <Flag size={14} />
                  <span><b>Marked</b><em>{markedCount} QIDs</em></span>
                </button>
                <button onClick={() => startQuestionIdBlock(db, incorrectIds, "Incorrects review")} disabled={!incorrectIds.length || loading}>
                  <RotateCcw size={14} />
                  <span><b>Incorrects</b><em>{incorrectIds.length} QIDs</em></span>
                </button>
              </div>
            </div>

            <details className="qbank-list-card qbank-review-secondary">
              <summary><BarChart3 size={16} /> Assessments and memory sync</summary>
              {examHistory.length > 0 ? (
                <div className="qbank-prog-list" style={{ marginTop: 12 }}>
                  {examHistory.slice(0, 10).map(e => (
                    <div key={e.id} className="qbank-prog-row">
                      <div className="qbank-prog-meta">
                        <strong>{e.label}</strong>
                        <small>{new Date(e.completedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · {e.correct}/{e.totalQuestions} correct{e.complete ? "" : " · ended early"}</small>
                      </div>
                      <span className="qbank-prog-score">{e.predictedScore != null ? e.predictedScore : `${e.percentCorrect}%`}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="qbank-empty-note" style={{ marginTop: 10 }}>NBME/CMS progression appears here after assessment blocks.</p>}
              {progression?.anki && (
                <p className="qbank-memory-note" style={{ marginTop: 12 }}>
                  Anki: {progression.anki.seen.toLocaleString()} seen · {progression.anki.mature.toLocaleString()} mature · {progression.anki.due.toLocaleString()} due
                </p>
              )}
            </details>

            {activeSessions.length > 0 && (
              <div className="qbank-list-card">
                <div style={{ ...row, marginBottom: 12 }}><History size={16} color="var(--accent)" /><strong>Continue where you left off</strong></div>
                <div className="qbank-history-list">
                  {activeSessions.map(s => (
                    <div key={s.id} className="qbank-session-row qbank-session-card">
                      <button className="qbank-session-main" onClick={() => { applyActiveSession(s); setMode("quiz"); }}>
                        <div style={{ ...row, justifyContent: "space-between" }}><strong>{s.blockLabel || `${s.questions.length} questions`}</strong><span>{Object.keys(s.answers).length}/{s.questions.length}</span></div>
                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{prettyDbLabel(s.db)} · {summarizeFilters(s)}</p>
                        <small>Updated {formatShortDate(s.updatedAt)}</small>
                      </button>
                      <div className="qbank-session-actions">
                        <button onClick={() => regenerateSession(s)} title="Regenerate same block filters"><RotateCcw size={13} /></button>
                        <button onClick={() => deleteSavedSession(s)} title="Delete this block"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="qbank-list-card">
              <div style={{ ...row, marginBottom: 12 }}><BarChart3 size={16} color="var(--green)" /><strong>Completed blocks — {bankLabel}</strong></div>
              {completedSessions.length ? (
                <div className="qbank-history-list">
                  {completedSessions.map(s => (
                    <div key={s.id} className="qbank-session-row qbank-session-card">
                      <button className="qbank-session-main" onClick={() => { applyActiveSession(s); setMode("results"); }}>
                        <div style={{ ...row, justifyContent: "space-between" }}><strong>{weightedPerformance(s).normalized}% adjusted</strong><span>{pct(s)}% raw · {s.questions.length} Qs</span></div>
                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{summarizeFilters(s)}</p>
                        <small>Completed {formatShortDate(s.completedAt)}</small>
                      </button>
                      <div className="qbank-session-actions">
                        <button onClick={() => regenerateSession(s)} title="Regenerate same block filters"><RotateCcw size={13} /></button>
                        <button onClick={() => deleteSavedSession(s)} title="Delete this block"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <p className="qbank-empty-note">No completed blocks yet for {bankLabel}. Finish a block and it lands here.</p>}
            </div>

            <div className="qbank-list-card">
              <div style={{ ...row, justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ ...row }}>
                  <Database size={16} color="var(--accent)" /><strong>Bank progress — {bankLabel}</strong>
                  <span className={memoryReady ? "tag tag-green" : "tag tag-amber"} style={{ marginLeft: 8 }}>{memoryReady ? "Synced" : "Local"}</span>
                </div>
                <button className="qbank-status-reset" onClick={resetCurrentQbankProgress} title={`Reset ${bankLabel}`}><RotateCcw size={13} /> Reset</button>
              </div>
              <div className="qbank-used-meter" aria-hidden="true"><span style={{ width: `${usedPercent}%` }} /></div>
              <p className="qbank-memory-note">{usedCount.toLocaleString()} used · {unusedLabel} unused · {cleanLabel} clean · last activity {formatShortDate(latestSession?.updatedAt || latestSession?.createdAt)}{persistentStorage ? ` · ${persistentStorage}` : ""}</p>
            </div>

            <div className="qbank-clean-card">
              <div style={{ ...row, marginBottom: 8 }}><Shuffle size={16} color="var(--accent)" /><strong>Clean Bank Mode</strong></div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.65 }}>Questions with invisible or incomplete answer choices are filtered out automatically. Media attached to questions is shown inline, and derived tags make the bank searchable by subject, system, and concept.</p>
            </div>
          </div>
        )}

        {workspaceTab === "custom" && (
          <div className="qbank-page-stage qbank-page-stage-custom">
            <SessionLibrary
              sessions={customSessions}
              activeSessionId={active?.id}
              labelForDb={prettyDbLabel}
              onOpen={openSavedSession}
              onRename={renameSavedSession}
              onDelete={deleteSavedSession}
              onRegenerate={session => void regenerateSession(session)}
            />
          </div>
        )}

        {workspaceTab === "partner" && (
          <div className="qbank-page-stage qbank-page-stage-partner">
            <div className="qbank-partner-card">
              <div className="qbank-partner-hero">
                <span className="qbank-partner-mark"><Users size={18} /></span>
                <div>
                  <h2>Partner session</h2>
                  <p>Paste the code your partner copied from <strong>Share</strong> and start the exact same block — same questions, same order, same mode.</p>
                </div>
              </div>
              <label className="qbank-partner-field">
                <span>Enter your partner session here</span>
                <textarea
                  value={partnerCode}
                  onChange={event => {
                    setPartnerCode(event.target.value);
                    if (partnerError) setPartnerError("");
                  }}
                  placeholder="MEDOS-QBANK-SESSION:1:…"
                  spellCheck={false}
                  rows={6}
                />
              </label>
              {partnerError && (
                <p className="qbank-partner-error"><AlertTriangle size={14} /> {partnerError}</p>
              )}
              <div className="qbank-partner-actions">
                <button
                  className="btn-primary"
                  onClick={() => void startSharedSession(partnerCode)}
                  disabled={partnerBusy || !partnerCode.trim()}
                >
                  {partnerBusy ? <span className="loader" style={{ width: 13, height: 13 }} /> : <Play size={14} />}
                  {partnerBusy ? "Preparing…" : "Start partner block"}
                </button>
                <button
                  className="btn-ghost"
                  onClick={async () => {
                    try {
                      const text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : "";
                      if (text) { setPartnerCode(text); setPartnerError(""); }
                    } catch { /* clipboard unavailable */ }
                  }}
                >
                  Paste from clipboard
                </button>
              </div>
              <p className="qbank-partner-note">
                Your own answers, marks, notes, and highlights are not shared. The block starts fresh on your side, so your progress stays yours.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── QBank concept chips ─────────────────────────────────────────────────── */

interface QBankConcept {
  cui: string;
  preferred_name: string;
  semantic_group: string;
  matched_term: string;
  hit_count: number;
  href: string;
}

const _CHIP_SEM_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  disease:   { bg: "rgba(239,68,68,0.08)",   fg: "#b91c1c", border: "rgba(239,68,68,0.25)" },
  finding:   { bg: "rgba(245,158,11,0.08)",  fg: "#92400e", border: "rgba(245,158,11,0.25)" },
  pathology: { bg: "rgba(220,38,38,0.08)",   fg: "#991b1b", border: "rgba(220,38,38,0.25)" },
  drug:      { bg: "rgba(107,114,128,0.08)", fg: "#374151", border: "rgba(107,114,128,0.22)" },
  substance: { bg: "rgba(107,114,128,0.08)", fg: "#374151", border: "rgba(107,114,128,0.22)" },
  procedure: { bg: "rgba(124,58,237,0.08)",  fg: "#5b21b6", border: "rgba(124,58,237,0.22)" },
  lab:       { bg: "rgba(8,145,178,0.08)",   fg: "#155e75", border: "rgba(8,145,178,0.22)" },
  anatomy:   { bg: "rgba(168,85,247,0.08)",  fg: "#6b21a8", border: "rgba(168,85,247,0.22)" },
  gene:      { bg: "rgba(15,118,110,0.08)",  fg: "#0f766e", border: "rgba(15,118,110,0.22)" },
};
const _CHIP_DEFAULT = { bg: "rgba(99,102,241,0.08)", fg: "#4338ca", border: "rgba(99,102,241,0.22)" };

// Compact 2-letter, colour-coded source badges for the concept article list —
// mirrors the hover-card badges so a UWorld-library row reads the same everywhere.
const HUB_SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  uworld:     { label: "UL", color: "#4338ca" },  // UWorld Library
  qbank:      { label: "UW", color: "#92400e" },  // UWorld Q-bank
  amboss:     { label: "AB", color: "#0369a1" },
  utd:        { label: "UT", color: "#166534" },
  firstaid:   { label: "FA", color: "#9f241d" },
  diseases:   { label: "Dx", color: "#7e22ce" },
  cliniccons: { label: "CC", color: "#9a3412" },
  books:      { label: "Bk", color: "#7c5e2e" },
  drugs:      { label: "Rx", color: "#374151" },
};
function hubSourceBadge(source: string) {
  return HUB_SOURCE_BADGE[source] || { label: "Lk", color: "#475569" };
}

function QBankConceptChips({ questionId, db, onOpenConcept }: { questionId: number; db: string; onOpenConcept: (cui: string, name: string) => void }) {
  const [concepts, setConcepts] = useState<QBankConcept[]>([]);
  const [loaded, setLoaded] = useState(false);
  const backend = getBackendUrl();

  useEffect(() => {
    setConcepts([]);
    setLoaded(false);
    let cancelled = false;
    fetch(`${backend}/umls/qbank-concepts?question_id=${questionId}&db=${encodeURIComponent(db)}&limit=16`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: { concepts: QBankConcept[] }) => {
        if (!cancelled) { setConcepts(data.concepts || []); setLoaded(true); }
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [questionId, db, backend]);

  if (!loaded || concepts.length === 0) return null;

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
      <div style={{
        fontSize: 9, fontWeight: 800, letterSpacing: "0.10em", textTransform: "uppercase",
        color: "var(--text-muted)", marginBottom: 8,
      }}>
        Concepts in this question
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {concepts.map(c => {
          const palette = _CHIP_SEM_COLORS[c.semantic_group?.toLowerCase() || ""] || _CHIP_DEFAULT;
          return (
            <a
              key={c.cui}
              href={c.href}
              onClick={(e) => {
                // Modifier-click keeps the power-user escape: open the full UMLS hub
                // page in a new tab. Plain click shows the concept's cross-database
                // articles in the right side panel.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpenConcept(c.cui, c.preferred_name);
              }}
              title={`${c.preferred_name} (${c.cui}) · ${c.semantic_group} — open articles across your libraries`}
              style={{
                fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 5,
                background: palette.bg, color: palette.fg,
                border: `1px solid ${palette.border}`,
                textDecoration: "none", whiteSpace: "nowrap",
              }}
            >
              {c.preferred_name}
            </a>
          );
        })}
      </div>
    </div>
  );
}
