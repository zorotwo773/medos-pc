"use client";
import Link from "next/link";
import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { getBackendUrl } from "@/lib/api";
import { useRouter } from "next/navigation";
import { recordRecent, useRecent, type RecentEntry } from "@/lib/useRecent";
import { useResume, getAutoJump, setAutoJump, recordSearch } from "@/lib/activity";
import { useScrollRestore } from "@/lib/useScrollRestore";
import AnkiFlipWidget from "@/components/dashboard/AnkiFlipWidget";
import { isCalculatorResult, openCalculatorResult } from "@/lib/calculatorLaunch";
import { openFirstAid } from "@/components/firstaid/FirstAidSnippet";
import { useDarkMode } from "@/components/common/useDarkMode";
import DrugClinicalPopup from "@/components/drugs/DrugClinicalPopup";
import type { DrugPopup } from "@/types/drugs";

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface SearchResult {
  id: string | number;
  title: string;
  subtitle: string;
  href: string;
  scope: string;
  kind: string;
  score: number;
  preview?: SearchPreview;
  firstaid_refs?: FirstAidRef[];
  umls?: UmlsContext;
  icd10cm_codes?: UmlsCode[];
  has_black_box?: boolean;
}
interface DrugGroupItem { kind: "drug-group"; items: SearchResult[]; }
interface UWorldGroupItem { kind: "uworld-group"; title: string; subtitle: string; items: SearchResult[]; }
interface SourcePairItem { kind: "source-pair"; title: string; items: SearchResult[]; }
type DisplayItem = { kind: "single"; result: SearchResult } | DrugGroupItem | UWorldGroupItem | SourcePairItem;
interface UmlsCode {
  code: string;
  term?: string;
}
interface UmlsContext {
  cui: string;
  preferred_name: string;
  semantic_group?: string;
  definition?: string;
  href?: string;
  icd10cm_codes?: UmlsCode[];
}
interface FirstAidRef {
  heading_id: number;
  title: string;
  page?: number;
  hierarchy?: string;
}
interface SearchPreview {
  type: "image" | "html" | "frame";
  title?: string;
  url?: string;
  html?: string;
  caption?: string;
  source?: string;
}
interface GlossaryDef {
  term: string;
  expansion: string;
  definition: string;
  source: string;
  source_id?: string;
  cui?: string;
  href?: string;
  source_label?: string;
  semantic_group?: string;
  icd10cm_codes?: UmlsCode[];
}
interface FanTile {
  tag: string;
  name: string;
  meta: string;
  href: string;
}
interface ModuleDef {
  id: string;
  label: string;
  stat: string;
  desc: string;
  href: string;
  mc: string;
  icon: React.ReactNode;
  fans: FanTile[];
}
interface PulseEntry {
  tag: string;
  mc: string;
  txt: string;
  ts: string;
  href: string;
  animKey?: number;
}
/* ─── Constants ───────────────────────────────────────────────────────────── */

const MODULES: ModuleDef[] = [
  {
    id: "databases", label: "Databases", stat: "UpToDate · AMBOSS · UMLS",
    desc: "UpToDate · AMBOSS · UMLS concepts.",
    href: "/uptodate", mc: "var(--mod-uptodate)",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>,
    fans: [
      { tag: "UTD", name: "UpToDate",  meta: "Clinical topics",   href: "/uptodate" },
      { tag: "AMB", name: "AMBOSS",    meta: "Clinical articles", href: "/amboss" },
      { tag: "DIS", name: "Diseases",  meta: "Reference index",  href: "/diseases" },
      { tag: "UMLS", name: "Medical Concepts", meta: "Concepts · synonyms", href: "/umls" },
    ],
  },
  {
    id: "library", label: "Library", stat: "203 books",
    desc: "203 textbooks indexed for search.",
    href: "/library", mc: "var(--mod-library)",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 4h5v16H4z"/><path d="M10 4h4v16h-4z"/><path d="m15 5 4 1-3 15-4-1z"/></svg>,
    fans: [
      { tag: "HPM", name: "Harrison's",  meta: "Internal medicine", href: "/library?book=harrisons" },
      { tag: "FA",  name: "First Aid",   meta: "Step 1 · Step 2",  href: "/library?book=firstaid" },
      { tag: "ALL", name: "Browse all",  meta: "203 titles",       href: "/library" },
    ],
  },
  {
    id: "qbank", label: "Q-Bank", stat: "Step 1 · 2 · 3",
    desc: "Step 1 · 2 CK · 3 · timed mode.",
    href: "/qbank", mc: "var(--mod-qbank)",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>,
    fans: [
      { tag: "S1",  name: "Step 1",     meta: "2,800 questions", href: "/qbank?step=1" },
      { tag: "CK",  name: "Step 2 CK",  meta: "3,400 questions", href: "/qbank?step=2" },
      { tag: "S3",  name: "Step 3",     meta: "2,100 questions", href: "/qbank?step=3" },
    ],
  },
  {
    id: "acls", label: "Emergency · ACLS", stat: "Code timers · 2025",
    desc: "Walkable ACLS algorithms with live code timers.",
    href: "/acls", mc: "var(--mod-acls)",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>,
    fans: [
      { tag: "CODE", name: "Cardiac Arrest", meta: "Live code mode",  href: "/acls?algo=cardiac-arrest" },
      { tag: "BRAD", name: "Bradycardia",    meta: "Walkable guide",  href: "/acls?algo=bradycardia" },
      { tag: "TACH", name: "Tachycardia",    meta: "Walkable guide",  href: "/acls?algo=tachycardia" },
      { tag: "ROSC", name: "Post-Arrest",    meta: "After ROSC",      href: "/acls?algo=post-arrest" },
    ],
  },
  {
    id: "drugs", label: "Drug Reference", stat: "Dosing · safety",
    desc: "Search drugs, classes, interactions, and warnings.",
    href: "/drugs", mc: "var(--mod-drugs)",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M10.5 4.5 4.5 10.5a4.24 4.24 0 0 0 6 6l6-6a4.24 4.24 0 0 0-6-6Z"/><path d="m8 7 9 9"/><path d="M14.5 13.5 19 18"/></svg>,
    fans: [
      { tag: "DRG", name: "Open Drug Ref", meta: "Search index", href: "/drugs" },
      { tag: "CLS", name: "Drug Classes", meta: "Browse by class", href: "/drugs" },
      { tag: "LEX", name: "Lexicomp", meta: "Calculators", href: "/lexi" },
    ],
  },
  {
    id: "tools", label: "Clinical Tools", stat: "Calc · Lexi · Meds",
    desc: "Calculators, lexicon, and dosing tools.",
    href: "/calculators", mc: "var(--mod-calculators)",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8 7h8M8 11h3M13 11h3M8 15h3M13 15h3"/></svg>,
    fans: [
      { tag: "MDC", name: "MDCalc",   meta: "820 calculators", href: "/calculators" },
      { tag: "LEX", name: "Lexicomp", meta: "Drug reference",  href: "/lexi" },
      { tag: "DRG", name: "Drug Ref", meta: "Dosing · safety", href: "/drugs" },
    ],
  },
  {
    id: "atlas", label: "3D Atlas", stat: "7 systems",
    desc: "Seven anatomical systems, drillable.",
    href: "/anatomy", mc: "var(--mod-anatomy)",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3 3 7l9 4 9-4-9-4z"/><path d="m3 12 9 4 9-4"/></svg>,
    fans: [
      { tag: "CV",  name: "Cardiovascular", meta: "Heart · vessels",  href: "/anatomy?system=cardiovascular" },
      { tag: "NS",  name: "Nervous",        meta: "CNS · PNS",        href: "/anatomy?system=nervous" },
      { tag: "MSK", name: "Musculoskeletal",meta: "Bones · muscles",  href: "/anatomy?system=musculoskeletal" },
      { tag: "RES", name: "Respiratory",    meta: "Lungs · airways",  href: "/anatomy?system=respiratory" },
    ],
  },
];

const ALL_SEARCH_SCOPES = [
  "firstaid", "uptodate", "amboss", "uworld", "books", "drugs", "calc",
  "lexi", "qbank", "anatomy", "diseases", "sanford", "utdddx",
] as const;

type SearchScope = typeof ALL_SEARCH_SCOPES[number];

const SCOPE_PRESETS: Array<{ label: string; values: readonly SearchScope[] }> = [
  { label: "All", values: ALL_SEARCH_SCOPES },
  { label: "Databases", values: ["sanford", "firstaid", "uptodate", "amboss", "uworld", "utdddx", "books", "diseases"] },
  { label: "Clinical Tools", values: ["drugs", "calc", "lexi", "anatomy"] },
];

const SCOPE_FILTERS: Array<{ label: string; value: SearchScope; mc: string }> = [
  { label: "Sanford", value: "sanford", mc: "var(--mod-sanford)" },
  { label: "First Aid", value: "firstaid", mc: "#c6362a" },
  { label: "UTD", value: "uptodate", mc: "var(--mod-uptodate)" },
  { label: "UTD DDx", value: "utdddx", mc: "var(--mod-utdddx)" },
  { label: "AMBOSS", value: "amboss", mc: "var(--mod-amboss)" },
  { label: "UWorld", value: "uworld", mc: "var(--mod-qbank)" },
  { label: "Books", value: "books", mc: "var(--mod-library)" },
  { label: "Drugs", value: "drugs", mc: "var(--mod-drugs)" },
  { label: "Calc", value: "calc", mc: "var(--mod-calculators)" },
  { label: "Lexi", value: "lexi", mc: "var(--mod-calculators)" },
  { label: "Q-Bank", value: "qbank", mc: "var(--mod-qbank)" },
  { label: "Anatomy", value: "anatomy", mc: "var(--mod-anatomy)" },
  { label: "Diseases", value: "diseases", mc: "var(--mod-diseases)" },
];

const SCOPE_LABEL: Record<string, string> = {
  uptodate: "UTD", utd: "UTD", amboss: "AMB", uworld: "UW", books: "BOOK",
  anatomy: "ANAT", calc: "CALC", meds: "MED", diseases: "DIS",
  drugs: "DRUG", lexi: "LEXI", qbank: "QB", firstaid: "FA", umls: "UMLS",
  differential: "DX", sanford: "SG", utdddx: "DDX",
};

const SOURCE_META: Record<string, { tag: string; label: string; mc: string }> = {
  uptodate:    { tag: "UTD",   label: "UpToDate",      mc: "var(--mod-uptodate)" },
  amboss:      { tag: "AMB",   label: "AMBOSS",        mc: "var(--mod-amboss)" },
  diseases:    { tag: "DIS",   label: "Diseases",      mc: "var(--mod-diseases)" },
  qbank:       { tag: "QB",    label: "Q-Bank",        mc: "var(--mod-qbank)" },
  library:     { tag: "BOOK",  label: "Library",       mc: "var(--mod-library)" },
  drugs:       { tag: "DRUG",  label: "Drug Ref",      mc: "var(--mod-drugs)" },
  calculators: { tag: "CALC",  label: "Calculators",   mc: "var(--mod-calculators)" },
  anatomy:     { tag: "ANAT",  label: "Anatomy",       mc: "var(--mod-anatomy)" },
  ortho:       { tag: "ORTHO", label: "Ortho",         mc: "var(--mod-anatomy)" },
};

const SEARCH_SOURCE_META: Record<string, { tag: string; label: string; mc: string; soft: string }> = {
  firstaid: { tag: "FA", label: "First Aid", mc: "#c6362a", soft: "rgba(198,54,42,0.10)" },
  uptodate: { tag: "UTD", label: "UpToDate", mc: "var(--mod-uptodate)", soft: "rgba(0,133,124,0.10)" },
  utd:      { tag: "UTD", label: "UpToDate", mc: "var(--mod-uptodate)", soft: "rgba(0,133,124,0.10)" },
  amboss:   { tag: "AMB", label: "AMBOSS", mc: "var(--mod-amboss)", soft: "rgba(13,191,143,0.10)" },
  uworld:   { tag: "UW", label: "UWorld", mc: "var(--mod-qbank)", soft: "rgba(239,68,68,0.10)" },
  books:    { tag: "BOOK", label: "Books", mc: "var(--mod-library)", soft: "rgba(99,102,241,0.10)" },
  calc:     { tag: "CALC", label: "Calculators", mc: "var(--mod-calculators)", soft: "rgba(245,158,11,0.12)" },
  lexi:     { tag: "LEXI", label: "Lexicomp", mc: "var(--mod-calculators)", soft: "rgba(245,158,11,0.12)" },
  drugs:    { tag: "DRUG", label: "Drug Ref", mc: "var(--mod-drugs)", soft: "rgba(14,165,164,0.11)" },
  anatomy:  { tag: "ANAT", label: "Anatomy", mc: "var(--mod-anatomy)", soft: "rgba(168,85,247,0.11)" },
  diseases: { tag: "DIS", label: "Diseases", mc: "var(--mod-diseases)", soft: "rgba(16,185,129,0.11)" },
  sanford:  { tag: "SG", label: "Sanford Guide", mc: "var(--mod-sanford)", soft: "rgba(192,38,211,0.11)" },
  utdddx:   { tag: "DDX", label: "UpToDate DDx", mc: "var(--mod-utdddx)", soft: "rgba(8,145,178,0.11)" },
  umls:     { tag: "UMLS", label: "UMLS", mc: "#0f766e", soft: "rgba(20,184,166,0.12)" },
  differential: { tag: "DX", label: "Differential", mc: "#7c3aed", soft: "rgba(124,58,237,0.10)" },
  qbank:    { tag: "QB", label: "Q-Bank", mc: "var(--mod-qbank)", soft: "rgba(239,68,68,0.10)" },
  clinic_image: { tag: "IMG", label: "Disease Image", mc: "var(--mod-diseases)", soft: "rgba(16,185,129,0.11)" },
  uworld_table: { tag: "UW TBL", label: "UWorld Table", mc: "var(--mod-qbank)", soft: "rgba(239,68,68,0.10)" },
  abbrev:   { tag: "ABBR", label: "Abbrev", mc: "var(--accent)", soft: "rgba(15,118,110,0.10)" },
};

const PULSE_ENTRIES: PulseEntry[] = [
  { tag: "UTD",   mc: "var(--mod-uptodate)",    txt: "Open a random UpToDate chapter on acute dyspnea",           ts: "random", href: "/uptodate?q=acute%20dyspnea" },
  { tag: "UTD",   mc: "var(--mod-uptodate)",    txt: "UpToDate: initial evaluation of pulmonary embolism",       ts: "random", href: "/uptodate?q=pulmonary%20embolism%20diagnosis" },
  { tag: "UTD",   mc: "var(--mod-uptodate)",    txt: "UpToDate: acute decompensated heart failure",              ts: "random", href: "/uptodate?q=acute%20decompensated%20heart%20failure" },
  { tag: "UTD",   mc: "var(--mod-uptodate)",    txt: "UpToDate: fever in the returning traveler",                ts: "random", href: "/uptodate?q=fever%20returning%20traveler" },
  { tag: "AMB",   mc: "var(--mod-amboss)",      txt: "AMBOSS article: aortic stenosis pathophysiology",           ts: "random", href: "/amboss" },
  { tag: "DIS",   mc: "var(--mod-diseases)",    txt: "Disease reference: compare SLE criteria and organ systems", ts: "random", href: "/diseases?search=lupus" },
  { tag: "DRUG",  mc: "var(--mod-drugs)",       txt: "Drug check: apixaban renal dosing and bleeding risk",       ts: "random", href: "/drugs?q=apixaban" },
  { tag: "QB",    mc: "var(--mod-qbank)",       txt: "UWorld-style block: cardiology, timed mode",                ts: "random", href: "/qbank?step=2&mode=timed&topic=cardiology" },
  { tag: "QB",    mc: "var(--mod-qbank)",       txt: "UWorld-style block: renal acid-base questions",             ts: "random", href: "/qbank?step=2&mode=timed&topic=renal" },
  { tag: "UW TBL",mc: "var(--mod-qbank)",       txt: "UWorld table review: murmurs, maneuvers, and exam clues",   ts: "random", href: "/qbank?db=step2&q=murmur%20table" },
  { tag: "BOOK",  mc: "var(--mod-library)",     txt: "Random book dive: Harrison's internal medicine chapter",    ts: "random", href: "/library" },
  { tag: "CALC",  mc: "var(--mod-calculators)", txt: "Calculator drill: MELD-Na, Child-Pugh, and GI bleeding",    ts: "random", href: "/calculators?q=meld" },
  { tag: "ANAT",  mc: "var(--mod-anatomy)",     txt: "3D atlas: coronary circulation and cardiac chambers",       ts: "random", href: "/anatomy?system=cardiovascular" },
  { tag: "ORTHO", mc: "var(--mod-anatomy)",     txt: "Ortho mode: proximal humerus classification overview",     ts: "random", href: "/anatomy?ortho=1&slug=proximal-humerus" },
  { tag: "LEXI",  mc: "var(--mod-calculators)", txt: "Lexi calculator: dosing worksheet or interaction check",    ts: "random", href: "/lexi" },
];

const UTD_PICKS = [
  "Approach to the patient with chest pain",
  "Management of acute decompensated heart failure",
  "Initial evaluation of atrial fibrillation",
  "Diagnostic approach to community-acquired pneumonia",
  "Evaluation of acute kidney injury in adults",
  "Evaluation of syncope in adults",
  "Sepsis syndromes — early management",
  "Diagnosis and management of acute pancreatitis",
  "Approach to upper gastrointestinal bleeding",
  "Initial evaluation of pulmonary embolism",
  "Diabetic ketoacidosis and hyperosmolar state",
  "Approach to thrombocytopenia in adults",
  "Workup of new-onset seizures in adults",
  "Initial management of acute ischemic stroke",
];

const QB_BLOCKS = [
  { label: "Cardiology · 40 Qs · timed",      href: "/qbank?step=2&mode=timed&topic=cardiology" },
  { label: "Pulmonology · 40 Qs · timed",     href: "/qbank?step=2&mode=timed&topic=pulmonology" },
  { label: "Nephrology · 40 Qs · timed",      href: "/qbank?step=2&mode=timed&topic=nephrology" },
  { label: "GI / Hepatology · 40 Qs · timed", href: "/qbank?step=2&mode=timed&topic=gi" },
  { label: "Neurology · 40 Qs · timed",       href: "/qbank?step=2&mode=timed&topic=neurology" },
  { label: "Endocrine / DM · 40 Qs · timed",  href: "/qbank?step=2&mode=timed&topic=endocrine" },
  { label: "Hematology · 40 Qs · timed",      href: "/qbank?step=2&mode=timed&topic=hematology" },
  { label: "Infectious Disease · 40 Qs",      href: "/qbank?step=2&mode=timed&topic=id" },
  { label: "OB/GYN · 40 Qs · timed",          href: "/qbank?step=2&mode=timed&topic=obgyn" },
  { label: "Psychiatry · 40 Qs · timed",      href: "/qbank?step=2&mode=timed&topic=psych" },
  { label: "Biostatistics · 40 Qs",           href: "/qbank?step=2&mode=timed&topic=biostats" },
  { label: "Dermatology · 40 Qs · timed",     href: "/qbank?step=2&mode=timed&topic=derm" },
];

const DEFAULT_PICK_TITLE = UTD_PICKS[0];
const DEFAULT_QB_BLOCK = QB_BLOCKS[0];
const DEFAULT_PULSE_LIST = PULSE_ENTRIES.slice(0, 5).map((entry, i) => ({ ...entry, animKey: i }));
const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

let workingSearchBase: string | null = null;

async function fetchWithTimeout(url: string, outerSignal: AbortSignal, timeoutMs = 900) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  const timer = window.setTimeout(abort, timeoutMs);
  outerSignal.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    window.clearTimeout(timer);
    outerSignal.removeEventListener("abort", abort);
  }
}

async function fetchSearchJson(params: URLSearchParams, signal: AbortSignal, timeoutMs = 900) {
  const bases = workingSearchBase
    ? [workingSearchBase, getBackendUrl(), "http://127.0.0.1:8002", "http://localhost:8002"]
    : [getBackendUrl(), "http://127.0.0.1:8002", "http://localhost:8002"];
  const uniqueBases = Array.from(new Set(bases));
  let lastError: unknown = null;
  for (const base of uniqueBases) {
    try {
      const res = await fetchWithTimeout(`${base}/search?${params}`, signal, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      workingSearchBase = base;
      return await res.json();
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("search failed");
}

function greeting(now: Date | null) {
  if (!now) return "Good day";
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function randomPick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function scopeSet(values: readonly SearchScope[]) {
  return new Set<SearchScope>(values);
}

function sameScopeSet(set: Set<SearchScope>, values: readonly SearchScope[]) {
  return set.size === values.length && values.every(value => set.has(value));
}

function scopesParam(set: Set<SearchScope>) {
  return sameScopeSet(set, ALL_SEARCH_SCOPES) ? "all" : [...set].join(",");
}

function randomSample<T>(arr: readonly T[], count: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  while (pool.length && out.length < count) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function sourceMeta(source = "") {
  return SOURCE_META[source] || { tag: "APP", label: "MedOS", mc: "var(--accent)" };
}

function searchSourceMeta(scope = "") {
  return SEARCH_SOURCE_META[scope] || { tag: SCOPE_LABEL[scope] || "APP", label: scope || "MedOS", mc: "var(--accent)", soft: "rgba(15,118,110,0.10)" };
}

const DASH_BADGE_INK = "#fff";
const DASH_DARK_TEXT_BADGES = new Set([
  "amb", "amboss", "calc", "calculators", "diseases", "dis",
  "drugs", "drug", "lexi", "tools",
]);

function dashboardBadgeInk(sourceOrTag = "") {
  const key = sourceOrTag.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return DASH_DARK_TEXT_BADGES.has(key) ? "#07111f" : DASH_BADGE_INK;
}

function icdCodesFor(item: ({ icd10cm_codes?: UmlsCode[]; umls?: UmlsContext } | GlossaryDef | null | undefined)) {
  const value = item as { icd10cm_codes?: UmlsCode[]; umls?: UmlsContext } | null | undefined;
  return (value?.icd10cm_codes?.length ? value.icd10cm_codes : value?.umls?.icd10cm_codes) || [];
}

function icdInline(codes: UmlsCode[], max = 4) {
  const values = codes.slice(0, max).map(code => code.code).filter(Boolean);
  return values.length ? `(${values.join(", ")})` : "";
}

function backendAssetUrl(value = "") {
  if (!value || /^(?:https?:|data:|blob:)/i.test(value)) return value;
  return value.startsWith("/") ? `${getBackendUrl()}${value}` : value;
}

function withThemeParam(value: string, theme: "light" | "dark") {
  if (!value || /^(?:data:|blob:)/i.test(value)) return value;
  const hashIndex = value.indexOf("#");
  const base = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}theme=${theme}${hash}`;
}

function themedFrameUrl(value: string, theme: "light" | "dark") {
  if (!value) return value;
  return /\/(?:qbank\/exhibit\/|cliniccons\/(?:algorithm|disease)\/|amboss\/article\/|utd\/topic\/)/i.test(value)
    ? withThemeParam(value, theme)
    : value;
}

function backendPreviewHtml(value = "") {
  if (!value) return "";
  const base = getBackendUrl();
  return value.replace(
    /\b(src|href)=(["'])\/(qbank\/media|qbank\/exhibit|cliniccons\/image)([^"']*)\2/gi,
    (_match, attr: string, quote: string, prefix: string, rest: string) => (
      `${attr}=${quote}${base}/${prefix}${rest}${quote}`
    ),
  );
}

function normalizedArticleTitle(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function articlePairSource(item: SearchResult) {
  return item.scope === "amboss" || item.scope === "uworld" ? item.scope : "";
}

function pairedArticleResults(results: SearchResult[]) {
  const byTitle = new Map<string, { title: string; items: SearchResult[]; sources: Set<string> }>();
  for (const item of results) {
    const source = articlePairSource(item);
    const key = source ? normalizedArticleTitle(item.title) : "";
    if (!key) continue;
    const bucket = byTitle.get(key) || { title: item.title, items: [], sources: new Set<string>() };
    if (!bucket.sources.has(source)) {
      bucket.sources.add(source);
      bucket.items.push(item);
    }
    if (source === "amboss") bucket.title = item.title;
    byTitle.set(key, bucket);
  }

  const pairs = new Map<string, SourcePairItem>();
  for (const [key, bucket] of byTitle) {
    if (!bucket.sources.has("amboss") || !bucket.sources.has("uworld")) continue;
    pairs.set(key, {
      kind: "source-pair",
      title: bucket.title,
      items: bucket.items.sort((a, b) => (articlePairSource(a) === "amboss" ? 0 : 1) - (articlePairSource(b) === "amboss" ? 0 : 1)),
    });
  }
  return pairs;
}

function processResultsForDisplay(results: SearchResult[]): DisplayItem[] {
  const drugItems: SearchResult[] = [];
  const tableItems: SearchResult[] = [];
  for (const r of results) {
    // Sanford antimicrobials carry kind==="drug" but must stay first-class Sanford
    // results (its own SG badge + priority), not folded into the generic drug group.
    if ((r.scope === "drugs" || r.kind === "drug") && r.scope !== "sanford") { drugItems.push(r); continue; }
    if (r.kind === "uworld_table") tableItems.push(r);
  }
  const display: DisplayItem[] = [];
  let drugGroupInserted = false;
  let tableGroupInserted = false;
  const articlePairs = pairedArticleResults(results);
  const insertedArticlePairs = new Set<string>();
  for (const r of results) {
    if (r.scope === "umls") continue;
    const titleLC = (r.title || "").toLowerCase();
    if ((r.scope === "utd" || r.scope === "uptodate") &&
        (titleLC.startsWith("patient education:") || titleLC.startsWith("patient perspective:"))) continue;
    if ((r.scope === "drugs" || r.kind === "drug") && r.scope !== "sanford") {
      if (!drugGroupInserted && drugItems.length > 0) {
        drugGroupInserted = true;
        display.push({ kind: "drug-group", items: drugItems });
      }
      continue;
    }
    if (r.kind === "uworld_table") {
      if (!tableGroupInserted && tableItems.length > 0) {
        tableGroupInserted = true;
        display.push({ kind: "uworld-group", title: "UWorld Tables", subtitle: "", items: tableItems });
      }
      continue;
    }
    const articlePairKey = normalizedArticleTitle(r.title);
    if (articlePairSource(r) && articlePairs.has(articlePairKey)) {
      if (!insertedArticlePairs.has(articlePairKey)) {
        insertedArticlePairs.add(articlePairKey);
        display.push(articlePairs.get(articlePairKey)!);
      }
      continue;
    }
    display.push({ kind: "single", result: r });
  }
  return display;
}

function searchCompletion(query: string, results: SearchResult[], suggestion: string | null) {
  const raw = query;
  const trimmed = raw.trim();
  if (!trimmed || raw !== trimmed) return null;
  const lower = trimmed.toLowerCase();
  const resultTitles = results.flatMap(r => {
    const titles = [r.title];
    const withoutSource = r.title.replace(/^first aid:\s*/i, "").trim();
    if (withoutSource && withoutSource !== r.title) titles.push(withoutSource);
    r.firstaid_refs?.forEach(ref => {
      if (ref.title) titles.push(ref.title);
    });
    return titles;
  });
  const pool = [
    ...(suggestion ? [suggestion] : []),
    ...resultTitles,
  ];
  const seen = new Set<string>();
  for (const title of pool) {
    const clean = (title || "").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    if (clean.length > trimmed.length && clean.toLowerCase().startsWith(lower)) {
      return clean;
    }
  }
  return null;
}

const GENERIC_RECENT_LABELS = new Set(MODULES.map(m => m.label).concat(
  MODULES.flatMap(m => m.fans.map(f => f.name))
));

function continueReadingItems(items: RecentEntry[]) {
  const seen = new Set<string>();
  const useful = items.filter(item => item.kind !== "module" && !GENERIC_RECENT_LABELS.has(item.label));
  const pool = useful.length ? useful : items;
  return pool.filter(item => {
    const source = item.source || item.tag;
    if (seen.has(source)) return false;
    seen.add(source);
    return true;
  }).slice(0, 5);
}

function relativeRecentTime(ts: number) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function pulseFromRecent(item: RecentEntry): PulseEntry {
  const meta = sourceMeta(item.source);
  return {
    tag: meta.tag,
    mc: meta.mc,
    txt: item.detail ? `${item.label} · ${item.detail}` : item.label,
    ts: relativeRecentTime(item.ts),
    href: item.href,
  };
}

function pulsePool(items: RecentEntry[]) {
  const recentPulses = continueReadingItems(items).map(pulseFromRecent);
  return [...recentPulses, ...PULSE_ENTRIES];
}

function initialPulseList(items: RecentEntry[] = []) {
  return randomSample(pulsePool(items), 5).map((entry, i) => ({ ...entry, animKey: i }));
}

function firstAidHeadingIds(item: Pick<SearchResult, "id" | "href" | "scope" | "firstaid_refs">) {
  const refIds = item.firstaid_refs?.map(ref => Number(ref.heading_id)).filter(id => Number.isFinite(id) && id > 0) || [];
  if (refIds.length) return refIds;
  const raw = `${item.href || ""} ${item.id || ""}`;
  const headingId = Number(raw.match(/firstaid-(\d+)/)?.[1] || raw.match(/heading_id=(\d+)/)?.[1] || (item.scope === "firstaid" ? item.id : ""));
  return Number.isFinite(headingId) && headingId > 0 ? [headingId] : [];
}

/* ─── AnalogClock ────────────────────────────────────────────────────────── */

function AnalogClock() {
  const hRef = useRef<HTMLSpanElement>(null);
  const mRef = useRef<HTMLSpanElement>(null);
  const sRef = useRef<HTMLSpanElement>(null);
  const dateRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    function tick() {
      const d = new Date();
      if (dateRef.current) dateRef.current.textContent = `${DAYS[d.getDay()]} · ${d.getDate()} ${MONTHS[d.getMonth()]}`;
      if (timeRef.current) timeRef.current.innerHTML = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}<span style="color:var(--accent)">:${String(d.getSeconds()).padStart(2,"0")}</span>`;
      const sec = d.getSeconds() + d.getMilliseconds() / 1000;
      const min = d.getMinutes() + sec / 60;
      const hr  = (d.getHours() % 12) + min / 60;
      if (hRef.current) hRef.current.style.transform = `rotate(${hr * 30}deg)`;
      if (mRef.current) mRef.current.style.transform = `rotate(${min * 6}deg)`;
      if (sRef.current) sRef.current.style.transform = `rotate(${sec * 6}deg)`;
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="dash-clock" style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-muted)", lineHeight: 1.7, flexShrink: 0 }}>
      {/* Analog clock face */}
      <div style={{
        width: 64, height: 64, borderRadius: "50%",
        background: "radial-gradient(circle at 30% 30%, var(--bg-card) 0%, var(--bg-base) 70%)",
        border: "1.5px solid var(--border)",
        boxShadow: "inset 0 1px 4px rgba(15,23,42,0.05), 0 2px 8px rgba(15,23,42,0.04)",
        position: "relative", flexShrink: 0,
      }}>
        {[0,30,60,90,120,150,180,210,240,270,300,330].map(deg => (
          <span key={deg} style={{
            position: "absolute", left: "50%", top: [0,90,180,270].includes(deg) ? 3 : 5,
            width: [0,90,180,270].includes(deg) ? 1.5 : 1,
            height: [0,90,180,270].includes(deg) ? 7 : 5,
            background: [0,90,180,270].includes(deg) ? "var(--text-secondary)" : "var(--text-muted)",
            transform: `translateX(-50%) rotate(${deg}deg)`,
            transformOrigin: `50% ${[0,90,180,270].includes(deg) ? 29 : 27}px`,
          }} />
        ))}
        <span ref={hRef} style={{ position: "absolute", left: "50%", top: "50%", width: 2.5, height: 18, marginLeft: -1.25, marginTop: -18, background: "var(--text-primary)", borderRadius: 2, transformOrigin: "50% 100%" }} />
        <span ref={mRef} style={{ position: "absolute", left: "50%", top: "50%", width: 2, height: 24, marginLeft: -1, marginTop: -24, background: "var(--text-primary)", borderRadius: 2, transformOrigin: "50% 100%" }} />
        <span ref={sRef} style={{ position: "absolute", left: "50%", top: "50%", width: 1, height: 30, marginLeft: -0.5, marginTop: -30, background: "#dc2626", borderRadius: 2, transformOrigin: "50% 100%", boxShadow: "0 0 4px rgba(220,38,38,0.35)" }} />
        <span style={{ position: "absolute", left: "50%", top: "50%", width: 5, height: 5, borderRadius: "50%", background: "#dc2626", transform: "translate(-50%,-50%)", zIndex: 5, boxShadow: "0 0 0 2px var(--bg-card)" }} />
      </div>
      <div style={{ textAlign: "right" }}>
        <b style={{ color: "var(--text-primary)", fontWeight: 500 }}><span ref={dateRef} /></b><br />
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13, color: "var(--text-primary)", letterSpacing: "0.04em" }} ref={timeRef} />
      </div>
    </div>
  );
}

/* ─── ModulesGrid ────────────────────────────────────────────────────────── */

interface LiveModuleStats {
  books?: number;
  qbank?: Record<string, { count: number; valid: number }>;
}

function fmtCount(n: number) {
  return n.toLocaleString("en-US");
}

// Fetch the real library + qbank counts once on mount so the dashboard cards
// show live numbers instead of hardcoded marketing figures. Any failure leaves
// the static MODULES fallback in place (applyLiveStats is a no-op when empty),
// so a slow/offline backend never blanks the cards.
function useLiveModuleStats(): LiveModuleStats {
  const [stats, setStats] = useState<LiveModuleStats>({});
  useEffect(() => {
    const ctrl = new AbortController();
    const base = getBackendUrl();
    (async () => {
      const next: LiveModuleStats = {};
      try {
        const r = await fetch(`${base}/library/books`, { signal: ctrl.signal });
        if (r.ok) {
          const d = await r.json();
          if (typeof d.total === "number") next.books = d.total;
        }
      } catch { /* keep fallback */ }
      try {
        const r = await fetch(`${base}/qbank/stats`, { signal: ctrl.signal });
        if (r.ok) {
          const d = (await r.json()) as Record<string, { count?: number; valid_count?: number }>;
          const qbank: Record<string, { count: number; valid: number }> = {};
          for (const [k, v] of Object.entries(d)) {
            qbank[k] = { count: Number(v?.count) || 0, valid: Number(v?.valid_count) || 0 };
          }
          next.qbank = qbank;
        }
      } catch { /* keep fallback */ }
      if (!ctrl.signal.aborted) setStats(next);
    })();
    return () => ctrl.abort();
  }, []);
  return stats;
}

// Overlay live counts onto the static card definitions. The qbank fan tags
// (S1/CK/S3) map to the backend bank keys; we surface valid_count (questions
// actually answerable in a block) so the dashboard number matches what
// block-making can yield, not an inflated bank-size total.
function applyLiveStats(modules: ModuleDef[], live: LiveModuleStats): ModuleDef[] {
  if (live.books == null && !live.qbank) return modules;
  const stepKeyByTag: Record<string, string> = { S1: "step1", CK: "step2", S3: "step3" };
  return modules.map(mod => {
    if (mod.id === "library" && live.books != null) {
      const b = fmtCount(live.books);
      return {
        ...mod,
        stat: `${b} books`,
        desc: `${b} textbooks indexed for search.`,
        fans: mod.fans.map(f => (f.tag === "ALL" ? { ...f, meta: `${b} titles` } : f)),
      };
    }
    if (mod.id === "qbank" && live.qbank) {
      let total = 0;
      const fans = mod.fans.map(f => {
        const key = stepKeyByTag[f.tag];
        const s = key ? live.qbank![key] : undefined;
        const usable = s ? (s.valid || s.count) : 0;
        if (usable) total += usable;
        return usable ? { ...f, meta: `${fmtCount(usable)} questions` } : f;
      });
      // Headline shows the real total question count (never a fabricated accuracy %).
      return { ...mod, stat: total ? `${fmtCount(total)} questions` : mod.stat, fans };
    }
    return mod;
  });
}

function ModulesGrid() {
  const [fanOpen, setFanOpen] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<Map<string, HTMLElement>>(new Map());
  const router = useRouter();
  const liveStats = useLiveModuleStats();
  const modules = useMemo(() => applyLiveStats(MODULES, liveStats), [liveStats]);

  function computePositions(id: string): Array<{ x: number; y: number; rot: number }> {
    const tile = tileRefs.current.get(id);
    const grid = gridRef.current;
    if (!tile || !grid) return [];
    const tr = tile.getBoundingClientRect();
    const gr = grid.getBoundingClientRect();
    const centerX = tr.left + tr.width / 2 - gr.left;
    const isLeft  = centerX < 220;
    const isRight = centerX > gr.width - 220;
    let start = -110, end = 110;
    if (isLeft)  { start = -40; end = 130; }
    if (isRight) { start = -130; end = 40; }
    const mod = MODULES.find(m => m.id === id);
    const n = mod?.fans.length ?? 0;
    return Array.from({ length: n }, (_, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const deg = start + (end - start) * t;
      const rad = (deg - 90) * Math.PI / 180;
      return { x: Math.cos(rad) * 155, y: Math.sin(rad) * 155, rot: deg * 0.08 };
    });
  }

  const [positions, setPositions] = useState<Record<string, Array<{ x: number; y: number; rot: number }>>>({});

  function open(id: string) {
    const pos = computePositions(id);
    setPositions(prev => ({ ...prev, [id]: pos }));
    setFanOpen(id);
  }
  function close() { setFanOpen(null); }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") close(); }
    function onDoc(e: MouseEvent) {
      const grid = gridRef.current;
      if (grid && !grid.contains(e.target as Node)) close();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("click",   onDoc);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("click", onDoc); };
  }, []);

  useEffect(() => {
    function onResize() { setFanOpen(null); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div
      ref={gridRef}
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, position: "relative" }}
      className={`dash-modules-grid${fanOpen ? " fanning" : ""}`}
    >
      {modules.map(mod => {
        const isOpen = fanOpen === mod.id;
        const pos = positions[mod.id] ?? [];

        return (
          <div
            key={mod.id}
            className="dash-module-card"
            data-fan-state={fanOpen && !isOpen ? "dim" : isOpen ? "open" : "idle"}
            ref={el => { if (el) tileRefs.current.set(mod.id, el); }}
            style={{
              position: "relative",
              background: "var(--bg-card)",
              border: `1px solid ${isOpen ? `color-mix(in srgb, ${mod.mc} 60%, var(--border))` : "var(--border)"}`,
              borderRadius: 14,
              padding: "18px 16px 16px",
              cursor: "pointer",
              display: "flex", flexDirection: "column", gap: 6,
              minHeight: 136,
              transition: "transform .25s cubic-bezier(.2,.7,.2,1), border-color .2s, box-shadow .25s, background .2s",
              overflow: "visible",
              zIndex: isOpen ? 30 : 1,
              transform: fanOpen && !isOpen ? "scale(0.985)" : isOpen ? "translateY(-3px)" : undefined,
              opacity: fanOpen && !isOpen ? 0.35 : 1,
              boxShadow: isOpen ? "0 16px 40px rgba(15,23,42,0.10)" : "0 1px 3px rgba(15,23,42,0.04)",
              pointerEvents: fanOpen && !isOpen ? "none" : "auto",
              backdropFilter: "blur(8px)",
              ["--mc" as string]: mod.mc,
            }}
          >
            <button
              type="button"
              className="dash-module-trigger"
              aria-expanded={isOpen}
              aria-label={`${mod.label}: show shortcuts`}
              onClick={e => {
                e.preventDefault();
                if (isOpen) close();
                else open(mod.id);
              }}
            />
            {/* Top accent bar */}
            <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: 3, background: mod.mc, borderRadius: "14px 14px 0 0", opacity: 0.85 }} />
            {/* Corner glow */}
            <div className="dash-card-glow" style={{ position: "absolute", right: -40, top: -40, width: 120, height: 120, borderRadius: "50%", background: mod.mc, opacity: isOpen ? 0.12 : 0.05, transition: "opacity .3s, transform .3s", transform: isOpen ? "scale(1.2)" : "scale(1)", pointerEvents: "none" }} />

            {/* Icon */}
            <div className="dash-module-icon" style={{ width: 38, height: 38, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${mod.mc} 12%, transparent)`, color: mod.mc, transition: "background .25s" }}>
              {mod.icon}
            </div>
            {/* Text */}
            <div style={{ fontFamily: "var(--font-serif)", fontSize: 19, fontWeight: 500, letterSpacing: "-0.01em", color: "var(--text-primary)", marginTop: 6, lineHeight: 1.15 }}>{mod.label}</div>
            <div className="dash-module-description" style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>{mod.desc}</div>
            {/* Meta */}
            <div style={{ marginTop: "auto", paddingTop: 10, borderTop: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-muted)" }}>
              <b style={{ color: "var(--text-secondary)", fontWeight: 500 }}>{mod.stat}</b>
              <span className="dash-module-arrow" style={{ color: mod.mc, transition: "transform .2s", transform: isOpen ? "rotate(90deg)" : "none", fontSize: 14 }}>→</span>
            </div>
            {/* Close button */}
            {isOpen && (
              <button
                className="close-fan-btn"
                type="button"
                aria-label={`Close ${mod.label} shortcuts`}
                onClick={e => { e.preventDefault(); e.stopPropagation(); close(); }}
                style={{
                  position: "absolute", top: 8, right: 8,
                  width: 22, height: 22, borderRadius: "50%",
                  background: mod.mc, color: dashboardBadgeInk(mod.id),
                  border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, lineHeight: 1, boxShadow: "0 2px 6px rgba(15,23,42,0.18)",
                  zIndex: 35,
                }}
              >×</button>
            )}
            {/* Fan tray */}
            <div className="dash-fan-tray" aria-hidden={!isOpen} inert={!isOpen} style={{ pointerEvents: isOpen ? "auto" : "none" }}>
              {mod.fans.map((ft, i) => {
                const p = pos[i];
                const transform = p
                  ? `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${p.rot.toFixed(1)}deg)`
                  : "translate(-50%,0) scale(0.6)";
                return (
                  <button
                    key={ft.tag}
                    type="button"
                    className={`dash-fan-tile${isOpen ? " open" : ""}`}
                    aria-label={`Open ${ft.name}`}
                    aria-hidden={!isOpen}
                    tabIndex={isOpen ? 0 : -1}
                    style={{
                      transitionDelay: isOpen ? `${i * 40 + 30}ms` : "0ms",
                      transform: isOpen ? `translate(-50%,0) ${transform}` : "translate(-50%,0) scale(0.6)",
                      textDecoration: "none",
                      ["--dash-mc" as string]: mod.mc,
                    }}
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      close();
                      router.push(ft.href);
                    }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.18em", textTransform: "uppercase", color: mod.mc, fontWeight: 600 }}>{ft.tag}</span>
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: 13, color: "var(--text-primary)", fontWeight: 500, letterSpacing: "-0.005em", lineHeight: 1.2 }}>{ft.name}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--text-muted)", letterSpacing: "0.04em" }}>{ft.meta}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Dashboard ──────────────────────────────────────────────────────────── */

export default function Dashboard() {
  const router     = useRouter();
  const [darkModeOn] = useDarkMode();
  const searchRef  = useRef<HTMLInputElement>(null);
  const resultListRef = useRef<HTMLDivElement>(null);
  const resultRowRefs = useRef<Array<HTMLElement | null>>([]);
  const lastLoggedSearchRef = useRef("");
  const recentItems = useRecent();
  const [now, setNow] = useState<Date | null>(null);

  // ── Resume / continue-where-you-were ──────────────────────
  const { target: resumeTarget } = useResume();
  const dashScrollRef = useRef<HTMLDivElement>(null);
  useScrollRestore(dashScrollRef, "/");
  const [autoJump, setAutoJumpState] = useState(false);
  useEffect(() => { setAutoJumpState(getAutoJump()); }, []);

  // Auto-jump to the last place once per app session (app restart), only from
  // the dashboard landing — never re-trap the user when they return home.
  useEffect(() => {
    if (!autoJump || !resumeTarget?.href) return;
    try {
      if (sessionStorage.getItem("medos.resume.autoJumped")) return;
      sessionStorage.setItem("medos.resume.autoJumped", "1");
    } catch { /* ignore */ }
    router.push(resumeTarget.href);
  }, [autoJump, resumeTarget, router]);

  // Search state
  const [activeScopes, setActiveScopes] = useState<Set<SearchScope>>(() => scopeSet(ALL_SEARCH_SCOPES));
  const [query,       setQuery]       = useState("");
  const [results,     setResults]     = useState<SearchResult[]>([]);
  const [definition,  setDefinition]  = useState<GlossaryDef | null>(null);
  const [searching,   setSearching]   = useState(false);
  const [searchStatus, setSearchStatus] = useState("");
  const [suggestion,  setSuggestion]  = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // When non-null, the highlighted item is an expansion suggestion (the zone
  // above the results), not a result. Arrowing up from the first result enters
  // this zone; arrowing down past the last suggestion returns to the results.
  const [selectedSuggestion, setSelectedSuggestion] = useState<number | null>(null);
  const [previewResult, setPreviewResult] = useState<SearchResult | null>(null);
  const [drugPopup, setDrugPopup] = useState<DrugPopup | null>(null);

  // Daily pick
  const [pickTitle, setPickTitle] = useState(DEFAULT_PICK_TITLE);
  const [qbBlock,   setQbBlock]   = useState(DEFAULT_QB_BLOCK);

  // Pulse rotation — track generation so fresh entry gets animation
  const [pulseList, setPulseList] = useState<PulseEntry[]>(DEFAULT_PULSE_LIST);
  const pulseGenRef = useRef(100);
  const activeScopeParam = scopesParam(activeScopes);
  const frameTheme = darkModeOn ? "dark" : "light";
  const displayItems = useMemo(() => processResultsForDisplay(results), [results]);
  const navSuggestions = useMemo(() => suggestions.slice(0, 5), [suggestions]);
  const sugCount = navSuggestions.length;

  useEffect(() => {
    searchRef.current?.focus();
    setPickTitle(randomPick(UTD_PICKS));
    setQbBlock(randomPick(QB_BLOCKS));

    function tick() {
      setNow(new Date());
    }
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setPulseList(initialPulseList(recentItems));
  }, [recentItems]);

  useEffect(() => {
    if (!previewResult) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPreviewResult(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewResult]);

  // Search
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 1) {
      setResults([]); setSuggestion(null); setSuggestions([]); setDefinition(null); setSearchStatus(""); setSearching(false); setSelectedIndex(0);
      return;
    }
    const ctrl  = new AbortController();
    setSearching(true);
    setSelectedIndex(0);
    resultListRef.current?.scrollTo({ top: 0 });

    const runSearch = async (fast: boolean) => {
      const params = new URLSearchParams({
        q: trimmed,
        scopes: activeScopeParam,
        grouped: "false",
        limit: fast ? "12" : "36",
        fast: fast ? "true" : "false",
      });
      const data = await fetchSearchJson(params, ctrl.signal, fast ? 650 : 1800);
      if (ctrl.signal.aborted) return;
      const nextResults = Array.isArray(data.results) ? data.results : [];
      setResults(nextResults);
      setSuggestion(data.suggestion || null);
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      setDefinition(data.definition || null);
      setSearchStatus("");
      setSelectedIndex(index => nextResults.length ? Math.min(index, nextResults.length - 1) : 0);
      setResultsOpen(true);
    };

    const quickTimer = setTimeout(async () => {
      setSearching(true);
      setSearchStatus("");
      try {
        await runSearch(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setSuggestion(null); setSuggestions([]); setDefinition(null); setSearchStatus("Search backend unavailable"); setResultsOpen(true);
        }
      }
    }, 50);

    const fullTimer = setTimeout(async () => {
      try {
        await runSearch(false);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setSearchStatus("Search backend unavailable");
          setResultsOpen(true);
        }
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 280);

    return () => {
      ctrl.abort();
      clearTimeout(quickTimer);
      clearTimeout(fullTimer);
    };
  }, [query, activeScopeParam]);

  useEffect(() => {
    resultRowRefs.current = resultRowRefs.current.slice(0, displayItems.length);
    setSelectedIndex(index => displayItems.length ? Math.min(Math.max(index, 0), displayItems.length - 1) : 0);
  }, [displayItems.length]);

  // The expansion-suggestion highlight resets when the typed query changes and
  // is clamped when the suggestion list shrinks.
  useEffect(() => { setSelectedSuggestion(null); }, [query]);
  useEffect(() => {
    setSelectedSuggestion(s => (s !== null && s >= sugCount ? (sugCount > 0 ? sugCount - 1 : null) : s));
  }, [sugCount]);

  useEffect(() => {
    if (!resultsOpen || !displayItems.length) return;
    const list = resultListRef.current;
    const row = resultRowRefs.current[selectedIndex];
    if (!list || !row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) {
      list.scrollTop -= listRect.top - rowRect.top;
    } else if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    }
  }, [resultsOpen, displayItems.length, selectedIndex]);

  const moveSelectedResult = useCallback((delta: number) => {
    if (!displayItems.length) return;
    setResultsOpen(true);
    setSelectedIndex(index => {
      const next = Math.max(0, Math.min(displayItems.length - 1, index + delta));
      window.requestAnimationFrame(() => {
        const list = resultListRef.current;
        const row = resultRowRefs.current[next];
        if (!list || !row) return;
        const listRect = list.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        if (rowRect.top < listRect.top) {
          list.scrollTop -= listRect.top - rowRect.top;
        } else if (rowRect.bottom > listRect.bottom) {
          list.scrollTop += rowRect.bottom - listRect.bottom;
        }
      });
      return next;
    });
  }, [displayItems.length]);

  // Pulse rotation — slide newest entry in
  useEffect(() => {
    const id = setInterval(() => {
      pulseGenRef.current++;
      const animKey = pulseGenRef.current;
      const entry = randomPick(pulsePool(recentItems));
      setPulseList(prev => [
        { ...entry, animKey },
        ...prev.filter(item => item.href !== entry.href || item.txt !== entry.txt).slice(0, 4),
      ]);
    }, 4000);
    return () => clearInterval(id);
  }, [recentItems]);

  const openResult = useCallback((href: string) => {
    setResultsOpen(false);
    // Backend asset URLs (UWorld exhibit tables, clinical images) have no
    // frontend route — open them on the backend instead of 404-ing.
    if (/^\/(?:qbank\/(?:exhibit|media)|cliniccons\/image)\//.test(href)) {
      window.open(`${getBackendUrl()}${href}`, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(href);
  }, [router]);

  const openDrugPopup = useCallback(async (item: SearchResult) => {
    const drugId = Number(item.id);
    if (!Number.isFinite(drugId) || drugId <= 0) {
      openResult(item.href);
      return;
    }
    setResultsOpen(false);
    try {
      const res = await fetch(`${getBackendUrl()}/drugs/popup/${drugId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const popup = await res.json() as DrugPopup;
      setDrugPopup(popup);
      recordRecent({
        tag: "DRUG",
        label: popup.drug.brand_names?.[0] || popup.drug.generic_name,
        href: `/drugs?id=${popup.drug.drug_id}`,
        source: "drugs",
        kind: "article",
        detail: popup.drug.drug_class?.[0] || popup.drug.generic_name,
      });
    } catch {
      openResult(item.href);
    }
  }, [openResult]);

  const openSearchItem = useCallback((item: SearchResult) => {
    setResultsOpen(false);
    const headingIds = firstAidHeadingIds(item);
    if (headingIds.length) {
      openFirstAid(headingIds[0], headingIds, item.title);
      return;
    }
    if (isCalculatorResult(item)) {
      openCalculatorResult(item);
      return;
    }
    if (item.scope === "drugs" || item.kind === "drug") {
      void openDrugPopup(item);
      return;
    }
    if (item.scope === "differential" || item.kind === "phenotype_bundle") {
      window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href: item.href, title: item.title || "Differential" } }));
      return;
    }
    if (item.scope === "umls" && item.href) {
      const cuiLabel = item.umls?.preferred_name || item.title || "UMLS";
      window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href: item.href, title: cuiLabel } }));
      return;
    }
    if (item.preview) {
      setPreviewResult(item);
      return;
    }
    openResult(item.href);
  }, [openDrugPopup, openResult]);

  // Log a search to the activity ledger when the user acts on a result (high
  // signal: searches that led somewhere). Deduped per query.
  function logSearchIntent() {
    const q = query.trim();
    if (q.length < 2 || q === lastLoggedSearchRef.current) return;
    lastLoggedSearchRef.current = q;
    recordSearch(q, activeScopeParam, results.length);
  }

  function rerollPick() { setPickTitle(randomPick(UTD_PICKS)); }
  function shuffleQb()   { setQbBlock(randomPick(QB_BLOCKS)); }

  function focusSearchAfterScopeChange() {
    setSelectedIndex(0);
    if (query.trim()) setResultsOpen(true);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }

  function applyScopePreset(values: readonly SearchScope[]) {
    setActiveScopes(scopeSet(values));
    focusSearchAfterScopeChange();
  }

  function toggleSearchScope(value: SearchScope) {
    setActiveScopes(prev => {
      if (sameScopeSet(prev, ALL_SEARCH_SCOPES)) {
        return scopeSet([value]);
      }
      const next = new Set(prev);
      if (next.has(value)) {
        if (next.size === 1) return scopeSet(ALL_SEARCH_SCOPES);
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
    focusSearchAfterScopeChange();
  }

  const greet = greeting(now);
  const dateNumber = now ? String(now.getDate()) : "--";
  const dateLabel = now ? `${MONTH_LABELS[now.getMonth()]} · ${DAY_LABELS[now.getDay()]}` : "Today";
  // ── Tokens (teal accent for dashboard) ────────────────────
  const T = {
    bg:      "var(--bg-base)",
    card:    "color-mix(in srgb, var(--bg-card) 92%, transparent)",
    border:  "var(--border)",
    accent:  "var(--dash-accent)",
    ink:     "var(--text-primary)",
    ink2:    "var(--text-secondary)",
    ink3:    "var(--text-muted)",
    ink4:    "var(--text-muted)",
    mono:    "var(--font-mono)",
    serif:   "var(--font-serif)",
    sans:    "'Inter', system-ui, sans-serif",
    shadowSm: "0 1px 2px rgba(15,23,42,0.04)",
    shadowMd: "0 8px 24px rgba(15,23,42,0.06)",
  };
  const completion = searchCompletion(query, results, suggestion);
  const completionSuffix = completion ? completion.slice(query.length) : "";

  return (
    <>
      {/* ── Scrollable canvas ───────────────────────────────── */}
      <div ref={dashScrollRef} className="dash-scroll" style={{ position: "absolute", inset: 0, overflow: "auto", background: T.bg, zIndex: 5 }}>
        <div className="dash-page" style={{
          maxWidth: 1240,
          margin: "0 auto",
          padding: "38px 36px 32px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
          fontFamily: T.sans,
        }}>

          {/* ── 01 · Hero ────────────────────────────────────── */}
          <section>
            {/* Greeting + clock */}
            <div className="dash-hero-row" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap", marginBottom: 18 }}>
              <div>
                <h1 className="dash-hero-title" style={{ fontFamily: T.serif, fontWeight: 500, fontSize: 38, lineHeight: 1.05, letterSpacing: "-0.02em", color: T.ink }}>
                  {greet}, <em style={{ fontStyle: "italic", color: T.accent, fontWeight: 400 }}>Doctor</em>
                </h1>
                {recentItems.length > 0 && (
                  <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.ink3, marginTop: 6 }}>
                    You were reading{" "}
                    <Link href={recentItems[0].href} style={{ color: T.accent, textDecoration: "none", fontStyle: "italic" }}>
                      {recentItems[0].label}
                    </Link>
                  </div>
                )}
              </div>
              <AnalogClock />
            </div>

            {/* Search */}
            <div className="dash-search" style={{ position: "relative", maxWidth: 760 }}>
              <div className="dash-search-shell" style={{
                display: "flex", alignItems: "center", gap: 12,
                background: T.card,
                border: "1.5px solid var(--border)",
                borderRadius: 12, padding: "14px 16px",
                boxShadow: T.shadowSm,
                transition: "border-color .2s, box-shadow .2s, transform .2s",
              }}
                onFocus={() => {}}
                onBlurCapture={() => {}}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.ink4} strokeWidth="2" style={{ flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>
                </svg>
                <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                  {completionSuffix && (
                    <div
                      aria-hidden
                      style={{
                        position: "absolute", inset: 0, display: "flex", alignItems: "center",
                        fontFamily: T.serif, fontStyle: "italic", fontSize: 18,
                        whiteSpace: "pre", pointerEvents: "none", overflow: "hidden",
                      }}
                    >
                      <span style={{ color: "transparent" }}>{query}</span>
                      <span style={{ color: "rgba(91,107,128,0.42)" }}>{completionSuffix}</span>
                    </div>
                  )}
                  <input
                    className="dash-search-input"
                    ref={searchRef}
                    type="text"
                    placeholder="Search across UpToDate, AMBOSS, UWorld, books, drugs, calculators…"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                    style={{
                      width: "100%", border: "none", outline: "none", background: "transparent",
                      fontFamily: T.serif, fontStyle: "italic", fontSize: 18, color: T.ink,
                      position: "relative", zIndex: 1,
                    }}
                    onFocus={() => { if (query.trim()) setResultsOpen(true); }}
                    onBlur={() => { window.setTimeout(() => setResultsOpen(false), 120); }}
                    onKeyDown={e => {
                      if (e.key === "Escape") { setResultsOpen(false); (e.target as HTMLInputElement).blur(); return; }
                      if ((e.key === "Tab" || e.key === "ArrowRight") && completion) {
                        e.preventDefault();
                        setQuery(completion);
                        window.requestAnimationFrame(() => searchRef.current?.focus());
                        return;
                      }
                      if (e.key === "ArrowDown") {
                        if (selectedSuggestion !== null) {
                          e.preventDefault();
                          if (selectedSuggestion < sugCount - 1) setSelectedSuggestion(selectedSuggestion + 1);
                          else { setSelectedSuggestion(null); setResultsOpen(true); setSelectedIndex(0); }
                          return;
                        }
                        if (displayItems.length) { e.preventDefault(); moveSelectedResult(1); return; }
                      }
                      if (e.key === "ArrowUp") {
                        if (selectedSuggestion !== null) {
                          e.preventDefault();
                          setSelectedSuggestion(Math.max(0, selectedSuggestion - 1));
                          return;
                        }
                        // Arrow up from the first result (or with no results) enters the expansion zone.
                        if (sugCount > 0 && (selectedIndex === 0 || !displayItems.length)) {
                          e.preventDefault();
                          setResultsOpen(true);
                          setSelectedSuggestion(sugCount - 1);
                          return;
                        }
                        if (displayItems.length) { e.preventDefault(); moveSelectedResult(-1); return; }
                      }
                      if (e.key === "Home" && displayItems.length) {
                        e.preventDefault();
                        setResultsOpen(true);
                        setSelectedSuggestion(null);
                        setSelectedIndex(0);
                        return;
                      }
                      if (e.key === "End" && displayItems.length) {
                        e.preventDefault();
                        setResultsOpen(true);
                        setSelectedSuggestion(null);
                        setSelectedIndex(displayItems.length - 1);
                        return;
                      }
                      if (e.key === "Enter") {
                        // An expansion is highlighted → search the full term.
                        if (selectedSuggestion !== null) {
                          const sug = navSuggestions[selectedSuggestion];
                          if (sug) {
                            e.preventDefault();
                            setQuery(sug);
                            setSelectedSuggestion(null);
                            setSelectedIndex(0);
                            setResultsOpen(true);
                            window.requestAnimationFrame(() => searchRef.current?.focus());
                          }
                          return;
                        }
                        if (!displayItems.length) return;
                        e.preventDefault();
                        const chosen = displayItems[Math.min(selectedIndex, displayItems.length - 1)];
                        if (!chosen) return;
                        if (chosen.kind !== "single" || chosen.result.scope !== "abbrev") logSearchIntent();
                        if (chosen.kind === "single") {
                          if (chosen.result.scope === "abbrev" && chosen.result.subtitle) { setQuery(chosen.result.subtitle); searchRef.current?.focus(); }
                          else openSearchItem(chosen.result);
                        } else if (chosen.kind === "drug-group") {
                          if (chosen.items[0]) void openDrugPopup(chosen.items[0]);
                        } else if (chosen.kind === "uworld-group") {
                          if (chosen.items[0]) setPreviewResult(chosen.items[0]);
                        } else if (chosen.kind === "source-pair") {
                          const first = chosen.items[0];
                          if (first) openSearchItem(first);
                        }
                      }
                    }}
                  />
                </div>
                <span className="dash-ai-pill" style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.accent, border: "1px solid rgba(15,118,110,0.28)", background: "rgba(15,118,110,0.10)", padding: "3px 8px", borderRadius: 5, flexShrink: 0 }}>AI</span>
                <span className="dash-kbd-hint" style={{ fontFamily: T.mono, fontSize: 9, color: T.ink3, border: "1px solid var(--border)", padding: "2px 6px", borderRadius: 4, background: "var(--bg-subtle)", flexShrink: 0 }}>⌘K</span>
              </div>

              {/* Scope pills */}
              <div className="dash-scope-list" style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {SCOPE_PRESETS.map(({ label, values }) => {
                  const active = sameScopeSet(activeScopes, values);
                  return (
                    <button key={label} className="dash-scope-pill" type="button" onClick={() => applyScopePreset(values)} style={{
                      fontFamily: T.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase",
                      padding: "4px 10px", borderRadius: 999,
                      border: `1px solid ${active ? T.accent : "var(--border)"}`,
                      background: active ? T.accent : "var(--bg-subtle)",
                      color: active ? DASH_BADGE_INK : T.ink3,
                      cursor: "pointer", transition: "all .14s",
                    }}>{label}</button>
                  );
                })}
                <span aria-hidden style={{ width: 1, alignSelf: "stretch", minHeight: 22, background: "var(--border)", margin: "0 3px" }} />
                {SCOPE_FILTERS.map(({ label, value, mc }) => {
                  const active = activeScopes.has(value) && !sameScopeSet(activeScopes, ALL_SEARCH_SCOPES);
                  return (
                    <button key={value} className="dash-scope-pill" type="button" onClick={() => toggleSearchScope(value)} style={{
                      fontFamily: T.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
                      padding: "4px 9px", borderRadius: 999,
                      border: `1px solid ${active ? mc : "var(--border)"}`,
                      background: active ? mc : "var(--bg-subtle)",
                      color: active ? dashboardBadgeInk(value) : T.ink3,
                      cursor: "pointer", transition: "all .14s",
                    }}>{label}</button>
                  );
                })}
              </div>

              {/* Results dropdown */}
              {resultsOpen && query.trim().length >= 1 && (
                <div style={{
                  position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 50,
                  background: T.card,
                  border: "1px solid var(--border)", borderRadius: 10,
                  boxShadow: "0 18px 44px rgba(15,23,42,0.12)",
                  overflow: "hidden", backdropFilter: "blur(8px)",
                }}>
                  {suggestions.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "rgba(248,250,252,0.9)", overflowX: "auto" }}>
                      <span style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink4, flexShrink: 0 }}>Search as</span>
                      {navSuggestions.map((item, index) => {
                        const sugActive = selectedSuggestion === index;
                        return (
                        <button
                          key={item}
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onMouseEnter={() => setSelectedSuggestion(index)}
                          onClick={() => {
                            setQuery(item);
                            setSelectedSuggestion(null);
                            setSelectedIndex(0);
                            setResultsOpen(true);
                            window.requestAnimationFrame(() => searchRef.current?.focus());
                          }}
                          title="Search this full term"
                          style={{
                            border: `1px solid ${sugActive ? T.accent : "rgba(15,118,110,0.28)"}`,
                            borderRadius: 999,
                            background: sugActive ? T.accent : "var(--bg-card)",
                            color: sugActive ? DASH_BADGE_INK : T.ink2,
                            cursor: "pointer",
                            flexShrink: 0,
                            fontSize: 12,
                            fontWeight: 700,
                            padding: "5px 9px",
                          }}
                        >
                          {item}
                        </button>
                        );
                      })}
                    </div>
                  )}
                  {/* Definition chip */}
                  {definition && (() => {
                    const href = definition.href || (definition.cui || definition.source_id ? `/umls?cui=${definition.cui || definition.source_id}` : "");
                    const isExternal = /^https?:\/\//i.test(href);
                    return (
                      <div style={{ padding: "10px 14px", background: "rgba(15,118,110,0.06)", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: "0.16em", textTransform: "uppercase", color: dashboardBadgeInk(definition.source), background: T.accent, padding: "2px 6px", borderRadius: 3, flexShrink: 0, marginTop: 1 }}>{definition.source}</span>
                        <div style={{ minWidth: 0 }}>
                          <a
                            href={href || undefined}
                            target={isExternal ? "_blank" : undefined}
                            rel={isExternal ? "noreferrer" : undefined}
                            onMouseDown={e => e.stopPropagation()}
                            onClick={event => {
                              if (!href || isExternal) return;
                              event.preventDefault();
                              window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href, title: definition.term || "UMLS" } }));
                              setResultsOpen(false);
                            }}
                            style={{ fontWeight: 700, fontSize: 13, color: T.ink, textDecoration: "none" }}
                          >
                            {definition.term}
                          </a>
                          {definition.expansion && definition.expansion !== definition.term && (
                            <span style={{ fontSize: 13, color: T.ink3, marginLeft: 6 }}>— {definition.expansion}</span>
                          )}
                          {icdInline(icdCodesFor(definition)) && (
                            <span style={{ fontFamily: T.mono, fontSize: 10, color: "var(--accent-strong)", marginLeft: 6 }}>
                              {icdInline(icdCodesFor(definition))}
                            </span>
                          )}
                          {definition.definition && (
                            <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>{definition.definition.slice(0, 200)}</div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {searchStatus ? (
                    <div style={{ padding: "14px", fontSize: 12, color: "var(--red, #ef4444)", background: "rgba(239,68,68,0.08)" }}>{searchStatus}</div>
                  ) : displayItems.length > 0 ? (
                    <div ref={resultListRef} role="listbox" style={{ maxHeight: 360, overflowY: "auto" }}>
                      {displayItems.map((item, index) => {
                        const active = selectedSuggestion === null && index === selectedIndex;
                        if (item.kind === "drug-group") {
                          const dm = SEARCH_SOURCE_META.drugs;
                          return (
                            <div
                              className="dash-result-row"
                              key="drug-group"
                              ref={el => { resultRowRefs.current[index] = el; }}
                              role="option"
                              aria-selected={active}
                              onMouseDown={e => e.preventDefault()}
                              onMouseEnter={() => { setSelectedSuggestion(null); setSelectedIndex(index); }}
                              style={{
                                borderBottom: "1px solid var(--border)",
                                background: active ? dm.soft : "transparent",
                                padding: "10px 14px",
                                display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
                              }}
                            >
                              <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.14em", textTransform: "uppercase", color: dashboardBadgeInk(dm.tag), background: dm.mc, borderRadius: 999, padding: "3px 6px", flexShrink: 0 }}>
                                DRUG
                              </span>
                              {item.items.slice(0, 7).map(drug => (
                                <button
                                  key={drug.id}
                                  type="button"
                                  onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                                  onClick={e => { e.stopPropagation(); setResultsOpen(false); void openDrugPopup(drug); }}
                                  style={{
                                    border: "1px solid rgba(14,165,164,0.30)", borderRadius: 999,
                                    background: "rgba(14,165,164,0.08)", color: T.ink,
                                    padding: "3px 10px", fontSize: 12, cursor: "pointer",
                                    fontWeight: 500, lineHeight: 1.4,
                                  }}
                                >
                                  {drug.title}
                                  {drug.has_black_box && <span style={{ color: "#dc2626", marginLeft: 4, fontSize: 8 }}>■</span>}
                                </button>
                              ))}
                            </div>
                          );
                        }
                        if (item.kind === "uworld-group") {
                          const um = SEARCH_SOURCE_META.uworld_table;
                          return (
                            <div
                              className="dash-result-row"
                              key="uworld-group"
                              ref={el => { resultRowRefs.current[index] = el; }}
                              role="option"
                              aria-selected={active}
                              onMouseDown={e => e.preventDefault()}
                              onMouseEnter={() => { setSelectedSuggestion(null); setSelectedIndex(index); }}
                              style={{
                                borderBottom: "1px solid var(--border)",
                                background: active ? um.soft : "transparent",
                                padding: "8px 14px",
                                display: "flex", gap: 8, alignItems: "center",
                              }}
                            >
                              <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.14em", textTransform: "uppercase", color: dashboardBadgeInk(um.tag), background: um.mc, borderRadius: 999, padding: "3px 6px", flexShrink: 0 }}>
                                UW TBL
                              </span>
                              <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
                                {item.items.map(tbl => {
                                  const src = (tbl.subtitle || "").replace(/^UWorld table\s*[·•]\s*/i, "").trim() || String(tbl.id);
                                  const imgUrl = tbl.preview?.type === "image" ? backendAssetUrl(tbl.preview.url || tbl.href) : null;
                                  return (
                                    <button
                                      key={tbl.id}
                                      type="button"
                                      title={tbl.title}
                                      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                                      onClick={e => { e.stopPropagation(); setResultsOpen(false); setPreviewResult(tbl); }}
                                      style={{
                                        position: "relative", flexShrink: 0,
                                        width: 96, height: 64,
                                        border: "1px solid rgba(239,68,68,0.28)", borderRadius: 5,
                                        background: imgUrl ? "var(--bg-subtle)" : "rgba(239,68,68,0.06)",
                                        overflow: "hidden", cursor: "pointer", padding: 0,
                                      }}
                                    >
                                      {imgUrl ? (
                                        <img src={imgUrl} alt={tbl.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                                      ) : (
                                        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: "4px 6px" }}>
                                          <span style={{ fontFamily: T.sans, fontSize: 9.5, color: T.ink2, textAlign: "center", lineHeight: 1.3 }}>
                                            {tbl.title.length > 40 ? tbl.title.slice(0, 38) + "…" : tbl.title}
                                          </span>
                                        </div>
                                      )}
                                      <span style={{
                                        position: "absolute", bottom: 0, right: 0,
                                        fontFamily: T.mono, fontSize: 7.5, letterSpacing: "0.1em",
                                        background: "rgba(239,68,68,0.85)", color: DASH_BADGE_INK,
                                        padding: "1px 5px", borderRadius: "4px 0 0 0",
                                      }}>{src}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        }
                        if (item.kind === "source-pair") {
                          const ambossItem = item.items.find(ref => articlePairSource(ref) === "amboss");
                          const uworldItem = item.items.find(ref => articlePairSource(ref) === "uworld");
                          const sourceButtonStyle = {
                            minHeight: 30,
                            padding: "5px 9px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "var(--bg-card)",
                            fontFamily: T.mono,
                            fontSize: 9,
                            letterSpacing: "0.1em",
                            fontWeight: 900,
                            cursor: "pointer",
                          };
                          return (
                            <div
                              className="dash-result-row"
                              key={`source-pair:${normalizedArticleTitle(item.title)}`}
                              ref={el => { resultRowRefs.current[index] = el; }}
                              role="option"
                              aria-selected={active}
                              onMouseDown={e => e.preventDefault()}
                              onMouseEnter={() => { setSelectedSuggestion(null); setSelectedIndex(index); }}
                              style={{
                                borderBottom: "1px solid var(--border)",
                                background: active ? "rgba(13,191,143,0.08)" : "transparent",
                                padding: "10px 14px",
                                display: "flex", gap: 10, alignItems: "center",
                              }}
                            >
                              <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.14em", textTransform: "uppercase", color: dashboardBadgeInk("amboss"), background: "var(--mod-amboss)", borderRadius: 999, padding: "3px 6px", flexShrink: 0 }}>
                                TOPIC
                              </span>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 13, color: T.ink, fontWeight: 700 }}>{item.title}</div>
                                <div style={{ fontSize: 12, color: T.ink3, marginTop: 1 }}>Same title in AMBOSS and UWorld</div>
                              </div>
                              <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                {ambossItem && (
                                  <button
                                    type="button"
                                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                                    onClick={e => { e.stopPropagation(); logSearchIntent(); openSearchItem(ambossItem); }}
                                    style={{ ...sourceButtonStyle, borderColor: "var(--mod-amboss)", color: "var(--mod-amboss)" }}
                                  >
                                    AMBOSS
                                  </button>
                                )}
                                {uworldItem && (
                                  <button
                                    type="button"
                                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                                    onClick={e => { e.stopPropagation(); logSearchIntent(); openSearchItem(uworldItem); }}
                                    style={{ ...sourceButtonStyle, borderColor: "var(--mod-qbank)", color: "var(--mod-qbank)" }}
                                  >
                                    UWORLD
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        }
                        const r = item.result;
                        const meta = searchSourceMeta(r.kind === "uworld_table" || r.kind === "clinic_image" ? r.kind : r.scope);
                        const icdCodes = icdCodesFor(r);
                        const concept = r.umls;
                        return (
                          <button
                            className="dash-result-row"
                            key={`${r.scope}:${r.id}`}
                            ref={el => { resultRowRefs.current[index] = el; }}
                            type="button"
                            role="option"
                            aria-selected={active}
                            onMouseDown={e => e.preventDefault()}
                            onMouseEnter={() => { setSelectedSuggestion(null); setSelectedIndex(index); }}
                            onClick={() => {
                              if (r.scope === "abbrev" && r.subtitle) { setQuery(r.subtitle); searchRef.current?.focus(); }
                              else { logSearchIntent(); openSearchItem(r); }
                            }}
                            style={{
                              width: "100%", textAlign: "left", border: "none",
                              borderBottom: "1px solid var(--border)",
                              background: active ? meta.soft : "transparent",
                              padding: "10px 14px", cursor: "pointer",
                              display: "flex", gap: 10, alignItems: "flex-start",
                            }}
                          >
                            <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.14em", textTransform: "uppercase", color: dashboardBadgeInk(r.scope || meta.tag), background: meta.mc, borderRadius: 999, padding: "3px 6px", flexShrink: 0, marginTop: 1 }}>
                              {meta.tag}
                            </span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 13, color: T.ink, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span>{r.title}</span>
                                {icdInline(icdCodes) && (
                                  <span title={icdCodes.map(code => `${code.code}${code.term ? ` ${code.term}` : ""}`).join("\n")} style={{ fontFamily: T.mono, fontSize: 10, color: "var(--accent-strong)", fontWeight: 700 }}>
                                    {icdInline(icdCodes)}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 12, color: T.ink3, marginTop: 1 }}>{r.subtitle || meta.label}</div>
                              {concept?.definition && (
                                <div style={{ fontSize: 11.5, color: T.ink3, marginTop: 3, lineHeight: 1.35 }}>
                                  {concept.preferred_name && concept.preferred_name !== r.title ? `${concept.preferred_name}: ` : ""}
                                  {concept.definition.slice(0, 170)}
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : !searching ? (
                    <div style={{ padding: "14px", fontSize: 12, color: T.ink3 }}>No results for &ldquo;{query.trim()}&rdquo;</div>
                  ) : (
                    <div style={{ padding: "14px", fontSize: 12, color: T.ink3 }}>Searching…</div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* ── 01 · Resources ───────────────────────────────── */}
          <section>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
              <div className="dash-section-heading">
                <span className="dash-section-index">01</span> Resources
                <span className="dash-section-hint">Select a card to reveal shortcuts</span>
              </div>
            </div>
            <ModulesGrid />
          </section>

          {/* ── 02 · Today ───────────────────────────────────── */}
          <section>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
              <div className="dash-section-heading">
                <span className="dash-section-index">02</span> Today
                <span className="dash-section-hint">Your clinical starting point</span>
              </div>
            </div>
            <div className="dash-today-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, alignItems: "stretch" }}>

              {/* Daily Pick widget */}
              <div className="dash-widget-card" style={{ background: T.card, border: "1px solid var(--border)", borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 12, backdropFilter: "blur(8px)" }}>
                <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.22em", textTransform: "uppercase", color: T.ink3, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>Daily pick</span>
                  <span className="dash-live-dot" />
                </div>
                {/* Date */}
                <div style={{ fontFamily: T.serif, fontSize: 42, fontWeight: 500, lineHeight: 1, letterSpacing: "-0.03em", color: T.ink, display: "flex", alignItems: "baseline", gap: 10 }}>
                  {dateNumber}
                  <span style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 16, color: T.accent, fontWeight: 400 }}>
                    {dateLabel}
                  </span>
                </div>
                {/* UTD pick card */}
                <Link className="dash-card-link" href={`/uptodate?q=${encodeURIComponent(pickTitle)}`} style={{ textDecoration: "none", display: "block" }}>
                  <div className="dash-pick-card" style={{ borderRadius: 10, padding: "10px 12px", background: "linear-gradient(135deg, rgba(0,133,124,0.10), rgba(0,133,124,0.04))", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6, cursor: "pointer", transition: "border-color .15s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.18em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 4, color: dashboardBadgeInk("uptodate"), background: "var(--mod-uptodate)" }}>UTD</span>
                      <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink3 }}>Clinical chapter</span>
                    </div>
                    <div style={{ fontFamily: T.serif, fontSize: 14, fontWeight: 500, color: T.ink, lineHeight: 1.3, letterSpacing: "-0.01em" }}>{pickTitle}</div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: T.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--mod-uptodate)", marginTop: 2 }}>
                      <span>Open · 12 min read →</span>
                      <button
                        className="dash-icon-button"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); rerollPick(); }}
                        style={{ background: "none", border: "1px dashed var(--border)", color: T.ink3, padding: "2px 7px", borderRadius: 4, cursor: "pointer", fontFamily: T.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase" }}
                      >↻</button>
                    </div>
                  </div>
                </Link>
                {/* QB block pick card */}
                <Link className="dash-card-link" href={qbBlock.href} style={{ textDecoration: "none", display: "block" }}>
                  <div className="dash-pick-card" style={{ borderRadius: 10, padding: "10px 12px", background: "linear-gradient(135deg, rgba(239,68,68,0.09), rgba(239,68,68,0.03))", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6, cursor: "pointer", transition: "border-color .15s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.18em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 4, color: dashboardBadgeInk("qbank"), background: "var(--mod-qbank)" }}>QB</span>
                      <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink3 }}>Start random block</span>
                    </div>
                    <div style={{ fontFamily: T.serif, fontSize: 14, fontWeight: 500, color: T.ink, lineHeight: 1.3, letterSpacing: "-0.01em" }}>{qbBlock.label}</div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: T.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--mod-qbank)", marginTop: 2 }}>
                      <span>Start timed →</span>
                      <button
                        className="dash-icon-button"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); shuffleQb(); }}
                        style={{ background: "none", border: "1px dashed var(--border)", color: T.ink3, padding: "2px 7px", borderRadius: 4, cursor: "pointer", fontFamily: T.mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase" }}
                      >↻</button>
                    </div>
                  </div>
                </Link>
              </div>

              {/* Anki Review widget */}
              <AnkiFlipWidget />

              {/* Pulse widget */}
              <div className="dash-widget-card dash-pulse-card" style={{ background: T.card, border: "1px solid var(--border)", borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 12, backdropFilter: "blur(8px)" }}>
                <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "0.22em", textTransform: "uppercase", color: T.ink3, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>Pulse</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => { const v = !autoJump; setAutoJump(v); setAutoJumpState(v); }}
                      title="When on, MedOS reopens your last page automatically when the app starts"
                      style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, padding: 0, fontFamily: T.mono, fontSize: 8, letterSpacing: "0.12em", textTransform: "uppercase", color: autoJump ? T.accent : T.ink4 }}
                    >
                      <span style={{ width: 13, height: 13, borderRadius: 4, border: `1px solid ${autoJump ? T.accent : "var(--border)"}`, background: autoJump ? T.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: autoJump ? DASH_BADGE_INK : "#fff", fontSize: 9, lineHeight: 1 }}>{autoJump ? "✓" : ""}</span>
                      Auto-resume
                    </button>
                    <span className="dash-live-dot" />
                  </div>
                </div>
                {resumeTarget?.href && (
                  <Link
                    href={resumeTarget.href}
                    className="dash-continue-card"
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "9px 11px", marginBottom: 2,
                      borderRadius: 10, textDecoration: "none",
                      border: "1px solid color-mix(in srgb, var(--dash-accent) 38%, var(--border))",
                      background: "linear-gradient(135deg, color-mix(in srgb, var(--dash-accent) 12%, transparent), transparent)",
                    }}
                  >
                    <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.16em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 4, color: dashboardBadgeInk(resumeTarget.source || ""), background: sourceMeta(resumeTarget.source || "").mc, flexShrink: 0 }}>
                      {resumeTarget.isExam ? "EXAM" : sourceMeta(resumeTarget.source || "").tag}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: "0.16em", textTransform: "uppercase", color: T.accent }}>
                        {resumeTarget.isExam ? "Exam in progress" : "Continue where you were"}
                      </div>
                      <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {resumeTarget.title || "Resume"}
                      </div>
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.accent, flexShrink: 0, whiteSpace: "nowrap" }}>Continue →</span>
                  </Link>
                )}
                <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                  {pulseList.map((entry, i) => (
                    <Link
                      className="dash-pulse-link"
                      key={i === 0 ? entry.animKey : `${entry.txt}-${i}`}
                      href={entry.href}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "8px 0",
                        borderBottom: i < pulseList.length - 1 ? "1px dashed var(--border)" : "none",
                        textDecoration: "none",
                        animation: i === 0 ? "pulse-entry 0.35s ease-out" : undefined,
                      }}
                    >
                      <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: "0.16em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 4, color: dashboardBadgeInk(entry.tag), background: entry.mc, flexShrink: 0 }}>{entry.tag}</span>
                      <span className="dash-pulse-text" style={{ flex: 1, color: T.ink2, fontFamily: T.serif, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.txt}</span>
                      <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.1em", color: T.ink4, flexShrink: 0 }}>{entry.ts}</span>
                    </Link>
                  ))}
                </div>
              </div>

            </div>
          </section>

          {/* ── 03 · Quick actions ───────────────────────────── */}
          <section>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
              <div className="dash-section-heading">
                <span className="dash-section-index">03</span> Quick actions
                <span className="dash-section-hint">Common tasks, one click away</span>
              </div>
            </div>
            <div className="dash-quick-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
              {([
                { icon: <><path d="M12 5v14M5 12h14"/></>, label: "New note", sub: "⌘ N", href: "/chat" },
                { icon: <><path d="M12 3c5 0 9 3.4 9 7.6 0 4.2-4 7.6-9 7.6-1.4 0-2.7-.2-3.9-.7L3 20l1.6-4.2C3.6 14.3 3 12.5 3 10.6 3 6.4 7 3 12 3z"/></>, label: "Ask the assistant", sub: "⌘ J", href: "/chat" },
                { icon: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, label: "Study timer", sub: "Persists across pages", href: "#" },
                { icon: <><path d="M5 3h14v18l-7-4-7 4z"/></>, label: "Bookmarks", sub: "Saved articles", href: "/library" },
              ] as const).map(qa => (
                <Link
                  className="dash-quick-action"
                  key={qa.label}
                  href={qa.href}
                  style={{
                    background: T.card, border: "1px solid var(--border)",
                    borderRadius: 10, padding: "12px 14px",
                    display: "flex", alignItems: "center", gap: 10,
                    cursor: "pointer", textDecoration: "none", color: "inherit",
                    transition: "all .18s",
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth="1.7" style={{ flexShrink: 0 }}>
                    {qa.icon}
                  </svg>
                  <div>
                    <div style={{ fontFamily: T.serif, fontSize: 14, fontWeight: 500, color: T.ink, lineHeight: 1.2 }}>{qa.label}</div>
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: T.ink4, marginTop: 2 }}>{qa.sub}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>

        </div>
      </div>
      {previewResult?.preview && (
        <div
          className="dash-preview-backdrop"
          onMouseDown={() => setPreviewResult(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 120,
            background: "rgba(15,23,42,0.28)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24, backdropFilter: "blur(4px)",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={previewResult.preview.title || previewResult.title}
            onMouseDown={e => e.stopPropagation()}
            style={{
              width: "min(980px, 100%)", maxHeight: "min(86vh, 860px)",
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 12, boxShadow: "0 24px 80px rgba(15,23,42,0.22)",
              display: "flex", flexDirection: "column", overflow: "hidden",
            }}
          >
            <div style={{
              display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
              padding: "14px 16px", borderBottom: "1px solid var(--border)",
              background: "linear-gradient(180deg, var(--bg-card), var(--bg-subtle))",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: T.ink3 }}>
                  {previewResult.preview.source || searchSourceMeta(previewResult.scope).label}
                </div>
                <div style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 600, color: T.ink, marginTop: 3, lineHeight: 1.25 }}>
                  {previewResult.preview.title || previewResult.title}
                </div>
                {previewResult.preview.caption && (
                  <div style={{ fontSize: 12, color: T.ink3, marginTop: 3 }}>{previewResult.preview.caption}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPreviewResult(null)}
                style={{
                  border: "1px solid var(--border)", background: "var(--bg-card)", color: T.ink2,
                  borderRadius: 7, padding: "5px 9px", cursor: "pointer",
                  fontFamily: T.mono, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
                }}
              >
                Close
              </button>
            </div>
            <div style={{ padding: 16, overflow: "auto", background: "var(--bg-subtle)" }}>
              {previewResult.preview.type === "image" ? (
                <img
                  src={backendAssetUrl(previewResult.preview.url || previewResult.href)}
                  alt={previewResult.preview.title || previewResult.title}
                  style={{
                    display: "block", maxWidth: "100%", height: "auto", margin: "0 auto",
                    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6,
                  }}
                />
              ) : previewResult.preview.type === "frame" ? (
                <iframe
                  key={`${previewResult.preview.url || previewResult.href}:${frameTheme}`}
                  src={themedFrameUrl(backendAssetUrl(previewResult.preview.url || previewResult.href), frameTheme)}
                  title={previewResult.preview.title || previewResult.title}
                  style={{
                    width: "100%", height: "min(68vh, 720px)",
                    border: "1px solid var(--border)", borderRadius: 6,
                    background: "var(--bg-card)",
                  }}
                />
              ) : (
                <div
                  className="dash-preview-html"
                  dangerouslySetInnerHTML={{ __html: backendPreviewHtml(previewResult.preview.html || "") }}
                  style={{
                    background: "var(--bg-card)", color: T.ink, border: "1px solid var(--border)",
                    borderRadius: 6, padding: 14, overflowX: "auto",
                    fontSize: 14, lineHeight: 1.45,
                  }}
                />
              )}
            </div>
            <style>{`
              .dash-preview-html table { border-collapse: collapse; width: 100%; min-width: 520px; }
              .dash-preview-html th, .dash-preview-html td { border: 1px solid var(--border-strong); padding: 8px 10px; vertical-align: top; }
              .dash-preview-html th { background: var(--bg-subtle); font-weight: 700; }
              .dash-preview-html img { max-width: 100%; height: auto; }
            `}</style>
          </div>
        </div>
      )}
      {drugPopup && (
        <DrugClinicalPopup
          popup={drugPopup}
          onClose={() => setDrugPopup(null)}
          onOpenFull={(drugId) => {
            setDrugPopup(null);
            router.push(`/drugs?id=${drugId}`);
          }}
        />
      )}
    </>
  );
}
