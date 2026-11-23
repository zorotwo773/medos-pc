"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBackendUrl } from "@/lib/api";
import MediaViewer from "@/components/common/MediaViewer";
import { isCalculatorResult, openCalculatorResult } from "@/lib/calculatorLaunch";
import { openFirstAid } from "@/components/firstaid/FirstAidSnippet";
import DrugClinicalPopup from "@/components/drugs/DrugClinicalPopup";
import {
  readReferenceLayerMode,
  setReferenceLayerMode,
  type ReferenceMode,
} from "@/components/common/useReferenceLayerEnabled";
import { useDarkMode } from "@/components/common/useDarkMode";
import { usePackSources, sourceAvailable } from "@/lib/usePackSources";
import { dispatchLibraryPdfActivation } from "@/lib/pdfNavigation";
import { advanceCommandShortcut } from "@/lib/commandShortcutState.mjs";
import { useTouchInteraction } from "@/components/touch/TouchInteractionProvider";
import {
  buildPreviewSearchParams,
  createSearchInteractionState,
  reduceSearchInteraction,
  resolveSearchEnter,
} from "@/lib/searchInteraction.mjs";
import type { DrugPopup } from "@/types/drugs";

type Panel = "commands" | "calculators" | "labs" | "search" | "help" | null;

const LAB_GROUPS = [
  {
    name: "Serum",
    subtitle: "Chemistry, liver, lipids, iron, endocrine, immunoglobulins",
    items: [
      ["Sodium", "135-145 mEq/L"], ["Potassium", "3.5-5.0 mEq/L"], ["Chloride", "98-106 mEq/L"],
      ["Bicarbonate", "22-28 mEq/L"], ["BUN", "7-20 mg/dL"], ["Creatinine", "0.6-1.3 mg/dL"],
      ["Glucose fasting", "70-99 mg/dL"], ["Calcium", "8.5-10.5 mg/dL"], ["Magnesium", "1.7-2.2 mg/dL"],
      ["AST", "10-40 U/L"], ["ALT", "7-56 U/L"], ["Alkaline phosphatase", "44-147 U/L"],
      ["Total bilirubin", "0.1-1.2 mg/dL"], ["Albumin", "3.5-5.0 g/dL"], ["TSH", "0.4-4.0 mIU/L"],
    ],
  },
  {
    name: "Blood Gases & CSF",
    subtitle: "Arterial blood on room air plus cerebrospinal fluid",
    items: [
      ["Arterial pH", "7.35-7.45"], ["PaCO2", "35-45 mm Hg"], ["PaO2", "80-100 mm Hg"],
      ["HCO3", "22-28 mEq/L"], ["O2 saturation", "95-100%"], ["CSF opening pressure", "70-180 mm H2O"],
      ["CSF WBC", "0-5/uL"], ["CSF protein", "15-45 mg/dL"], ["CSF glucose", "40-70 mg/dL"],
    ],
  },
  {
    name: "Hematologic & Coagulation",
    subtitle: "CBC, differential, red cell indices, coagulation",
    items: [
      ["Hemoglobin male", "13.5-17.5 g/dL"], ["Hemoglobin female", "12.0-15.5 g/dL"],
      ["WBC", "4.0-11.0 x10^3/uL"], ["Platelets", "150-400 x10^3/uL"], ["MCV", "80-100 fL"],
      ["ANC", ">1500/uL"], ["PT", "11-13.5 sec"], ["INR", "0.8-1.1"], ["aPTT", "25-35 sec"],
      ["Fibrinogen", "200-400 mg/dL"], ["D-dimer", "<500 ng/mL FEU"],
    ],
  },
  {
    name: "Urine & Body Measures",
    subtitle: "Urine studies and BMI",
    items: [
      ["Urine specific gravity", "1.003-1.030"], ["Urine osmolality", "50-1200 mOsm/kg"],
      ["Urine sodium", "variable, often 20-40 mEq/L"], ["Urine protein", "<150 mg/day"],
      ["Albumin/creatinine ratio", "<30 mg/g"], ["FeNa prerenal", "<1%"], ["BMI normal", "18.5-24.9 kg/m2"],
    ],
  },
];

interface SearchResult {
  id: string | number;
  title: string;
  subtitle?: string;
  href?: string;
  scope?: string;
  kind?: string;
  firstaid_refs?: FirstAidRef[];
  umls?: UmlsContext;
  icd10cm_codes?: UmlsCode[];
  preview?: SearchPreview;
  has_black_box?: boolean;
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

function firstAidHeadingIds(item: SearchResult) {
  const refIds = item.firstaid_refs?.map(ref => Number(ref.heading_id)).filter(id => Number.isFinite(id) && id > 0) || [];
  if (refIds.length) return refIds;
  const raw = `${item.href || ""} ${item.id || ""}`;
  const headingId = Number(raw.match(/firstaid-(\d+)/)?.[1] || raw.match(/heading_id=(\d+)/)?.[1] || (item.scope === "firstaid" ? item.id : ""));
  return Number.isFinite(headingId) && headingId > 0 ? [headingId] : [];
}

function selectedText() {
  if (typeof window === "undefined") return "";
  return String(window.getSelection?.() || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function icdCodesFor(item: SearchResult) {
  return (item.icd10cm_codes?.length ? item.icd10cm_codes : item.umls?.icd10cm_codes) || [];
}

function icdInline(codes: UmlsCode[], max = 3) {
  const values = codes.slice(0, max).map(code => code.code).filter(Boolean);
  return values.length ? `(${values.join(", ")})` : "";
}

function isEditableTarget(target: EventTarget | null) {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable || !!el.closest("[contenteditable='true']");
}

/* ── Search scopes + result processing (mirrors the dashboard search) ──────── */
const ALL_SEARCH_SCOPES = [
  "firstaid", "uptodate", "amboss", "uworld", "books", "drugs", "calc",
  "lexi", "qbank", "anatomy", "diseases", "sanford", "utdddx"
] as const;
type SearchScope = typeof ALL_SEARCH_SCOPES[number];

const SCOPE_FILTERS: Array<{ label: string; value: SearchScope; mc: string }> = [
  { label: "First Aid", value: "firstaid", mc: "#c6362a" },
  { label: "UTD", value: "uptodate", mc: "var(--mod-uptodate)" },
  { label: "AMBOSS", value: "amboss", mc: "var(--mod-amboss)" },
  { label: "UWorld", value: "uworld", mc: "var(--mod-qbank)" },
  { label: "Books", value: "books", mc: "var(--mod-library)" },
  { label: "Drugs", value: "drugs", mc: "var(--mod-drugs)" },
  { label: "Sanford", value: "sanford", mc: "#d946ef" },
  { label: "UTD DDx", value: "utdddx", mc: "var(--mod-uptodate)" },
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
  sanford:  { tag: "SG", label: "Sanford Guide", mc: "#d946ef", soft: "rgba(217,70,239,0.11)" },
  utdddx:   { tag: "DDX", label: "UpToDate DDx", mc: "var(--mod-uptodate)", soft: "rgba(0,133,124,0.10)" },
  anatomy:  { tag: "ANAT", label: "Anatomy", mc: "var(--mod-anatomy)", soft: "rgba(168,85,247,0.11)" },
  diseases: { tag: "DIS", label: "Diseases", mc: "var(--mod-diseases)", soft: "rgba(16,185,129,0.11)" },
  umls:     { tag: "UMLS", label: "UMLS", mc: "#0f766e", soft: "rgba(20,184,166,0.12)" },
  differential: { tag: "DX", label: "Differential", mc: "#7c3aed", soft: "rgba(124,58,237,0.10)" },
  qbank:    { tag: "QB", label: "Q-Bank", mc: "var(--mod-qbank)", soft: "rgba(239,68,68,0.10)" },
  uworld_table: { tag: "UW TBL", label: "UWorld Table", mc: "var(--mod-qbank)", soft: "rgba(239,68,68,0.10)" },
  abbrev:   { tag: "ABBR", label: "Abbrev", mc: "var(--accent)", soft: "rgba(15,118,110,0.10)" },
};

function sameScopeSet(set: Set<SearchScope>, values: readonly SearchScope[]) {
  return set.size === values.length && values.every(value => set.has(value));
}
function scopesParam(set: Set<SearchScope>) {
  return sameScopeSet(set, ALL_SEARCH_SCOPES) ? "all" : [...set].join(",");
}
function searchSourceMeta(scope = "") {
  return SEARCH_SOURCE_META[scope] || { tag: SCOPE_LABEL[scope] || "APP", label: scope || "MedOS", mc: "var(--accent)", soft: "rgba(15,118,110,0.10)" };
}

function commandBadgeInk(sourceOrTag = "") {
  const key = sourceOrTag.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return key === "fa" || key === "firstaid" ? "#fff" : "var(--accent-ink)";
}

function defIcdCodes(item: GlossaryDef | null | undefined) {
  return (item?.icd10cm_codes?.length ? item.icd10cm_codes : []) || [];
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

// Consolidate raw results into display rows: group drugs into one badge row,
// group UWorld tables, and drop the noisy per-synonym UMLS rows (the single
// definition card carries the concept instead).
function processResultsForDisplay(results: SearchResult[]): DisplayItem[] {
  const drugItems: SearchResult[] = [];
  const tableItems: SearchResult[] = [];
  for (const r of results) {
    // Sanford antimicrobials have kind==="drug" but stay first-class Sanford results.
    if ((r.scope === "drugs" || r.kind === "drug") && r.scope !== "sanford") { drugItems.push(r); continue; }
    if (r.kind === "uworld_table") tableItems.push(r);
  }
  const display: DisplayItem[] = [];
  let drugInserted = false;
  let tableInserted = false;
  const articlePairs = pairedArticleResults(results);
  const insertedArticlePairs = new Set<string>();
  for (const r of results) {
    if (r.scope === "umls") continue;
    const titleLC = (r.title || "").toLowerCase();
    if ((r.scope === "utd" || r.scope === "uptodate") &&
        (titleLC.startsWith("patient education:") || titleLC.startsWith("patient perspective:"))) continue;
    if ((r.scope === "drugs" || r.kind === "drug") && r.scope !== "sanford") {
      if (!drugInserted && drugItems.length > 0) { drugInserted = true; display.push({ kind: "drug-group", items: drugItems }); }
      continue;
    }
    if (r.kind === "uworld_table") {
      if (!tableInserted && tableItems.length > 0) { tableInserted = true; display.push({ kind: "uworld-group", title: "UWorld Tables", subtitle: "", items: tableItems }); }
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

// Ghost-text autocomplete: the first result/suggestion title that extends the
// typed query (used to render the dimmed completion and accept on Tab/→).
function searchCompletion(query: string, results: SearchResult[], suggestion: string | null): string | null {
  const raw = query;
  const trimmed = raw.trim();
  if (!trimmed || raw !== trimmed) return null;
  const lower = trimmed.toLowerCase();
  const resultTitles = results.flatMap(r => {
    const titles = [r.title];
    const withoutSource = r.title.replace(/^first aid:\s*/i, "").trim();
    if (withoutSource && withoutSource !== r.title) titles.push(withoutSource);
    r.firstaid_refs?.forEach(ref => { if (ref.title) titles.push(ref.title); });
    return titles;
  });
  const pool = [...(suggestion ? [suggestion] : []), ...resultTitles];
  const seen = new Set<string>();
  for (const title of pool) {
    const clean = (title || "").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    if (clean.length > trimmed.length && clean.toLowerCase().startsWith(lower)) return clean;
  }
  return null;
}

export default function GlobalCommandCenter() {
  const router = useRouter();
  const touchInteraction = useTouchInteraction();
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState("");
  const [labQuery, setLabQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [definition, setDefinition] = useState<GlossaryDef | null>(null);
  const [activeScopes, setActiveScopes] = useState<Set<SearchScope>>(() => new Set(ALL_SEARCH_SCOPES));
  const packSources = usePackSources();
  const visibleScopeFilters = useMemo(
    () => SCOPE_FILTERS.filter((s) => sourceAvailable(packSources, s.value)),
    [packSources],
  );
  const [status, setStatus] = useState("Type a term to search");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // Non-null = an expansion suggestion (the zone above results) is highlighted.
  const [selectedSuggestion, setSelectedSuggestion] = useState<number | null>(null);
  const [mediaPreview, setMediaPreview] = useState<{ kind: "frame" | "image"; url: string; title?: string; source?: string } | null>(null);
  const [calcSlots, setCalcSlots] = useState<{ target: string; label: string }[]>([]);
  const [calcQuery, setCalcQuery] = useState("");
  const [calcResults, setCalcResults] = useState<SearchResult[]>([]);
  const [calcStatus, setCalcStatus] = useState("Search all MDCalc/Lexi calculators");
  const [refMode, setRefMode] = useState<ReferenceMode>("full");
  const [darkModeOn, setDarkModeOn] = useDarkMode();
  const [drugPopup, setDrugPopup] = useState<DrugPopup | null>(null);
  const sequenceRef = useRef<string[]>([]);
  const sequenceTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRowRefs = useRef<(HTMLElement | null)[]>([]);
  const searchInteractionRef = useRef(createSearchInteractionState());

  // Load the shared reference-layer preference from localStorage on mount.
  useEffect(() => {
    setRefMode(readReferenceLayerMode());
  }, []);

  const changeRefMode = useCallback((next: ReferenceMode) => {
    setRefMode(next);
    setReferenceLayerMode(next);
  }, []);

  function clearSequence() {
    sequenceRef.current = [];
    if (sequenceTimerRef.current) window.clearTimeout(sequenceTimerRef.current);
    sequenceTimerRef.current = null;
  }

  const openRoute = useCallback((href: string, title: string) => {
    // UWorld exhibit tables and clinical images are backend asset URLs with no
    // frontend route — show them in the standardized in-app viewer instead of a
    // new browser tab (or a 404 from router.push).
    if (/^\/(?:qbank\/(?:exhibit|media)|cliniccons\/image)\//.test(href)) {
      const isImg = /\/(?:qbank\/media|cliniccons\/image)\//.test(href);
      setMediaPreview({
        kind: isImg ? "image" : "frame",
        url: `${getBackendUrl()}${href}`,
        title,
        source: href.startsWith("/qbank/") ? "UWorld" : "Clinical image",
      });
      setPanel(null);
      return;
    }
    dispatchLibraryPdfActivation(href, "search");
    window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href, title } }));
    router.push(href);
    setPanel(null);
  }, [router]);

  const openDrugPopup = useCallback(async (item: SearchResult) => {
    const drugId = Number(item.id);
    if (!Number.isFinite(drugId) || drugId <= 0) {
      if (item.href) openRoute(item.href, item.title);
      return;
    }
    setPanel(null);
    try {
      const res = await fetch(`${getBackendUrl()}/drugs/popup/${drugId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDrugPopup(await res.json());
    } catch {
      if (item.href) openRoute(item.href, item.title);
    }
  }, [openRoute]);

  const openSearch = useCallback((initial = "") => {
    searchInteractionRef.current = reduceSearchInteraction(searchInteractionRef.current, "query-reset");
    setQuery(initial);
    setResults([]);
    setStatus(initial ? "Press Enter to search" : "Type a term and press Enter");
    setPanel("search");
  }, []);

  const createAnkiCard = useCallback(() => {
    window.dispatchEvent(new CustomEvent("medos:create-anki-card"));
    setPanel(null);
  }, []);

  const readCalcSlots = useCallback(() => {
    const defaults = ["egfr", "cockcroft", "anion_gap", "aa_gradient", "cha2ds2", "wells_pe", "curb65", "meld", "gcs", "bmi"].map(id => `native:${id}`);
    const targets = window.medosCalc?.readShortcutTargets?.() || (() => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem("medos.calc.shortcuts.v1") || "null");
        return Array.isArray(parsed) ? defaults.map((fallback, i) => typeof parsed[i] === "string" && parsed[i] ? parsed[i] : fallback) : defaults;
      } catch {
        return defaults;
      }
    })();
    setCalcSlots(targets.slice(0, 10).map((target, index) => ({
      target,
      label: window.medosCalc?.targetLabel?.(target) || `Calculator ${index === 9 ? 0 : index + 1}`,
    })));
  }, []);

  const openCalculators = useCallback(() => {
    readCalcSlots();
    setPanel("calculators");
  }, [readCalcSlots]);

  const openCalcResultAndClose = useCallback((item: SearchResult) => {
    setPanel(null);
    openCalculatorResult({ ...item, scope: item.scope || "calc", kind: item.kind || "calculator" });
  }, []);

  const commands = useMemo(() => [
    { id: "search", label: "Global search", keys: "/", run: () => openSearch(selectedText()) },
    { id: "settings", label: "Settings", keys: "g s", run: () => window.dispatchEvent(new CustomEvent("medos:open-settings")) },
    { id: "dashboard", label: "Open dashboard", keys: "g d", run: () => openRoute("/", "Dashboard") },
    { id: "anki", label: "Open Anki", keys: "g n", run: () => openRoute("/anki", "Anki") },
    { id: "anki-card", label: "Add Anki card", keys: "g m", run: createAnkiCard },
    { id: "calculators", label: "Clinical calculators", keys: "g c", run: openCalculators },
    { id: "chat", label: "Open Chat", keys: "g h", run: () => openRoute("/chat", "Chat") },
    { id: "library", label: "Open Library", keys: "g i", run: () => openRoute("/library", "Library") },
    { id: "content", label: "Open Content Manager", keys: "g o", run: () => openRoute("/content", "Content Manager") },
    { id: "media-tray", label: "Open Media Tray", keys: "g t", run: () => { setPanel(null); touchInteraction.openTray(); } },
    { id: "lexi", label: "Open Lexi", keys: "g y", run: () => openRoute("/lexi", "Lexi") },
    { id: "labs", label: "Labs reference", keys: "g l", run: () => setPanel("labs") },
    { id: "uptodate", label: "Open UpToDate", keys: "g u", run: () => openRoute("/uptodate", "UpToDate") },
    { id: "sanford", label: "Open Sanford Guide", keys: "g v", run: () => openRoute("/sanford", "Sanford Guide") },
    { id: "utdddx", label: "Open UTD DDx", keys: "g j", aliases: ["g x d"], run: () => openRoute("/utdddx", "UTD DDx") },
    { id: "amboss", label: "Open AMBOSS", keys: "g a", run: () => openRoute("/amboss", "AMBOSS") },
    { id: "uworld-library", label: "Open UWorld Library", keys: "g w", run: () => openRoute("/library/uworld", "UWorld Library") },
    { id: "qbank", label: "Open Q-Bank", keys: "g q", run: () => openRoute("/qbank", "Q-Bank") },
    { id: "umls", label: "UMLS concept lookup", keys: "g x", run: () => openRoute("/umls", "UMLS") },
    { id: "differential", label: "Build a differential", keys: "g f", run: () => openRoute("/differential", "Differential") },
    { id: "loinc", label: "Browse LOINC lab panels", keys: "g b", run: () => openRoute("/labs", "Lab Panels") },
    { id: "graph", label: "Explore concept graph", keys: "g g", run: () => openRoute("/graph", "Concept Graph") },
    { id: "center", label: "Command center", keys: "g k", run: () => setPanel("commands") },
    { id: "help", label: "Shortcut help", keys: "?", run: () => setPanel("help") },
  ], [createAnkiCard, openCalculators, openRoute, openSearch, touchInteraction]);

  const runSearch = useCallback(async (term = query) => {
    const q = term.trim();
    if (!q) return;
    setStatus("Searching…");
    try {
      const params = buildPreviewSearchParams(q, scopesParam(activeScopes));
      const data = await fetch(`${getBackendUrl()}/search?${params}`, { cache: "no-store" }).then(r => r.json());
      const next: SearchResult[] = Array.isArray(data.results) ? data.results : [];
      setResults(next);
      setDefinition(data.definition || null);
      setSuggestion(data.suggestion || null);
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      const shown = processResultsForDisplay(next).length + (data.definition ? 1 : 0);
      setStatus(shown ? `${shown} result${shown === 1 ? "" : "s"}` : "No results");
    } catch {
      setResults([]);
      setDefinition(null);
      setSuggestion(null);
      setSuggestions([]);
      setStatus("Search backend unavailable");
    }
  }, [query, activeScopes]);

  const displayItems = useMemo(() => processResultsForDisplay(results), [results]);
  const navSuggestions = useMemo(() => suggestions.slice(0, 5), [suggestions]);
  const sugCount = navSuggestions.length;

  // Ghost-text completion + keyboard navigation (mirrors the dashboard search).
  const completion = useMemo(() => searchCompletion(query, results, suggestion), [query, results, suggestion]);
  const completionSuffix = completion && completion.length > query.length && completion.toLowerCase().startsWith(query.toLowerCase())
    ? completion.slice(query.length)
    : "";

  useEffect(() => {
    searchInteractionRef.current = reduceSearchInteraction(searchInteractionRef.current, "query-reset");
    setSelectedIndex(0);
    setSelectedSuggestion(null);
  }, [query]);
  useEffect(() => {
    resultRowRefs.current = resultRowRefs.current.slice(0, displayItems.length);
    setSelectedIndex(i => (displayItems.length ? Math.min(Math.max(i, 0), displayItems.length - 1) : 0));
  }, [displayItems.length]);
  useEffect(() => {
    setSelectedSuggestion(s => (s !== null && s >= sugCount ? (sugCount > 0 ? sugCount - 1 : null) : s));
  }, [sugCount]);

  const moveSelected = useCallback((delta: number) => {
    setSelectedIndex(i => {
      if (!displayItems.length) return 0;
      const next = Math.max(0, Math.min(displayItems.length - 1, i + delta));
      window.requestAnimationFrame(() => resultRowRefs.current[next]?.scrollIntoView({ block: "nearest" }));
      return next;
    });
  }, [displayItems.length]);

  const toggleScope = useCallback((value: SearchScope) => {
    setActiveScopes(prev => {
      // From "all", a single click narrows to just that scope; toggling the
      // last one back off returns to "all" (matches the dashboard behavior).
      if (sameScopeSet(prev, ALL_SEARCH_SCOPES)) return new Set([value]);
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      if (next.size === 0) return new Set(ALL_SEARCH_SCOPES);
      return next;
    });
  }, []);

  const openSearchItem = useCallback((item: SearchResult) => {
    const headingIds = firstAidHeadingIds(item);
    if (headingIds.length) { setPanel(null); openFirstAid(headingIds[0], headingIds, item.title); return; }
    if (isCalculatorResult(item)) { setPanel(null); openCalculatorResult(item); return; }
    if ((item.scope === "drugs" || item.kind === "drug") && item.scope !== "sanford") { void openDrugPopup(item); return; }
    if ((item.scope === "differential" || item.kind === "phenotype_bundle") && item.href) { openRoute(item.href, item.title || "Differential"); return; }
    if (item.scope === "umls" && item.href) { setPanel(null); openRoute(item.href, item.title); return; }
    if (item.href) openRoute(item.href, item.title);
  }, [openDrugPopup, openRoute]);

  const openSelected = useCallback(() => {
    // An expansion suggestion is highlighted → search that full term.
    if (selectedSuggestion !== null) {
      const sug = navSuggestions[selectedSuggestion];
      if (sug) { setQuery(sug); setSelectedSuggestion(null); setSelectedIndex(0); inputRef.current?.focus(); }
      return;
    }
    if (!displayItems.length) { void runSearch(); return; }
    const chosen = displayItems[Math.min(selectedIndex, displayItems.length - 1)];
    if (!chosen) return;
    if (chosen.kind === "single") openSearchItem(chosen.result);
    else if (chosen.kind === "drug-group") { if (chosen.items[0]) void openDrugPopup(chosen.items[0]); }
    else if (chosen.kind === "uworld-group") { const t = chosen.items[0]; if (t?.href) openRoute(t.href, t.title); }
    else if (chosen.kind === "source-pair") { const t = chosen.items[0]; if (t) openSearchItem(t); }
  }, [selectedSuggestion, navSuggestions, displayItems, selectedIndex, openSearchItem, openDrugPopup, openRoute, runSearch]);

  useEffect(() => {
    const handleOpenSearch = (event: Event) => {
      const detail = (event as CustomEvent<{ query?: string; run?: boolean }>).detail ?? {};
      const q = (detail.query ?? selectedText()).trim();
      openSearch(q);
      if (q && detail.run !== false) void runSearch(q);
    };
    window.addEventListener("medos:open-search", handleOpenSearch);
    return () => window.removeEventListener("medos:open-search", handleOpenSearch);
  }, [openSearch, runSearch]);

  // The sidebar's command-center button opens the commands panel (the floating
  // ⌘ launcher now lives in the sidebar).
  useEffect(() => {
    const handler = () => setPanel("commands");
    window.addEventListener("medos:open-command-center", handler);
    return () => window.removeEventListener("medos:open-command-center", handler);
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("medos:command-center-state", {
      detail: { open: Boolean(panel) },
    }));
  }, [panel]);

  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent("medos:command-center-state", {
      detail: { open: false },
    }));
  }, []);

  // Desktop Command Center occupies the same reserved shell column as the
  // sidebar. The application content reflows beside it instead of being
  // covered by a fixed overlay. Phones retain a dismissible full-width sheet.
  useEffect(() => {
    const root = document.documentElement;
    const desktop = window.matchMedia("(min-width: 641px)");
    const syncDockWidth = () => {
      if (!panel || !desktop.matches) {
        root.style.removeProperty("--command-center-w");
        return;
      }
      const rail = Number.parseFloat(getComputedStyle(root).getPropertyValue("--rail-w")) || 56;
      const available = Math.max(0, window.innerWidth - rail);
      const width = Math.min(400, available, Math.max(280, available - 480));
      root.style.setProperty("--command-center-w", `${Math.max(0, width)}px`);
    };
    syncDockWidth();
    window.addEventListener("resize", syncDockWidth);
    desktop.addEventListener("change", syncDockWidth);
    return () => {
      window.removeEventListener("resize", syncDockWidth);
      desktop.removeEventListener("change", syncDockWidth);
      root.style.removeProperty("--command-center-w");
    };
  }, [panel]);

  // Live search: run the query as the user types (debounced) so results feel
  // immediate and stable — no need to press Enter or click a button.
  useEffect(() => {
    if (panel !== "search") return;
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      setStatus(q ? "Keep typing…" : "Type a term to search");
      return;
    }
    const t = window.setTimeout(() => { void runSearch(q); }, 180);
    return () => window.clearTimeout(t);
  }, [query, panel, runSearch]);

  useEffect(() => {
    if (panel === "search" || panel === "commands" || panel === "calculators" || panel === "labs") {
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [panel]);

  useEffect(() => {
    readCalcSlots();
    const removeLauncher = () => document.getElementById("medos-calc-launcher")?.remove();
    removeLauncher();
    const sync = () => readCalcSlots();
    window.addEventListener("medos:calc-runtime-ready", sync);
    window.addEventListener("medos:calc-shortcuts-changed", sync);
    const observer = new MutationObserver(removeLauncher);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("medos:calc-runtime-ready", sync);
      window.removeEventListener("medos:calc-shortcuts-changed", sync);
      observer.disconnect();
    };
  }, [readCalcSlots]);

  useEffect(() => {
    if (panel !== "calculators") return;
    const q = calcQuery.trim();
    if (q.length < 2) {
      setCalcResults([]);
      setCalcStatus(q ? "Type at least 2 characters" : "Search all MDCalc/Lexi calculators");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCalcStatus("Searching calculators...");
      try {
        const params = new URLSearchParams({ q, limit: "8" });
        const data = await fetch(`/api/lexi-calc/list?${params}`, { cache: "no-store", signal: controller.signal }).then(r => r.json());
        const next = Array.isArray(data.results) ? data.results : [];
        setCalcResults(next);
        setCalcStatus(next.length ? `${next.length} calculator matches` : "No calculator matches");
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setCalcResults([]);
          setCalcStatus("Calculator search unavailable");
        }
      }
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [calcQuery, panel]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.key === "Escape" && panel) {
        event.preventDefault();
        setPanel(null);
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      const key = event.key === "?" ? "?" : String(event.key || "").toLowerCase();
      if (key === "/") {
        event.preventDefault();
        openSearch(selectedText());
        return;
      }
      if (key === "?") {
        event.preventDefault();
        setPanel("help");
        return;
      }
      const transition = advanceCommandShortcut(sequenceRef.current, key, commands);
      if (!transition.consumed) return;
      event.preventDefault();
      if (sequenceTimerRef.current) window.clearTimeout(sequenceTimerRef.current);
      sequenceTimerRef.current = null;
      sequenceRef.current = transition.buffer;

      if (transition.runId) {
        const command = commands.find(candidate => candidate.id === transition.runId);
        clearSequence();
        command?.run();
        return;
      }
      if (transition.buffer.length) {
        const pendingId = transition.pendingId;
        sequenceTimerRef.current = window.setTimeout(() => {
          const command = pendingId ? commands.find(candidate => candidate.id === pendingId) : null;
          clearSequence();
          command?.run();
        }, pendingId ? 650 : 1200);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearSequence();
    };
  }, [commands, openSearch, panel]);

  const filteredLabs = LAB_GROUPS.map(group => ({
    ...group,
    items: group.items.filter(([name, range]) => `${name} ${range}`.toLowerCase().includes(labQuery.toLowerCase())),
  })).filter(group => group.items.length);

  return (
    <>
      <style>{`
        #medos-calc-launcher{display:none!important}
        .global-command-launcher { display: none !important; }
      `}</style>
      <button className="global-command-launcher" type="button" onClick={() => setPanel("commands")} title="Command center" style={launcherStyle}>
        ⌘
      </button>
      {panel && (
        <section className="medos-command-center-panel" style={windowStyle}>
          <div style={titleStyle}>
            <strong style={titleTextStyle}>{panel === "calculators" ? "Calculators" : panel === "labs" ? "Labs" : panel === "search" ? "Search" : panel === "help" ? "Shortcuts" : "Command center"}</strong>
            <button onClick={() => setPanel(null)} style={titleButtonStyle} title="Close (Esc)">×</button>
          </div>
          <div style={bodyStyle}>
            {panel === "commands" && (
              <>
                <div style={searchRowStyle}>
                  <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { setPanel("search"); runSearch(query); } }} placeholder="Search MedOS, or choose a command" style={inputStyle} />
                  <button onClick={() => { setPanel("search"); runSearch(query); }} style={primaryButtonStyle}>Search</button>
                </div>
                <div style={gridStyle}>
                  {commands.map(command => (
                    <button key={command.id} onClick={command.run} style={commandButtonStyle}>
                      <span>{command.label}</span><kbd style={kbdStyle}>{command.keys}</kbd>
                    </button>
                  ))}
                </div>
                <div style={settingsPanelStyle}>
                  <div style={settingRowStyle}>
                    <div>
                      <span style={settingLabelStyle}>Dark mode</span>
                      <span style={settingHintStyle}>Use dark surfaces across the MedOS workspace</span>
                    </div>
                    <Switch checked={darkModeOn} onChange={setDarkModeOn} />
                  </div>
                  {/* Reference hover tooltip mode */}
                  <div style={settingRowStyle}>
                    <div>
                      <span style={settingLabelStyle}>Reference hover tooltips</span>
                      <span style={settingHintStyle}>Highlight medical terms and open quick reference cards. Lite is instant on slower computers; Full also live-scans for extra terms.</span>
                    </div>
                    <div role="group" aria-label="Reference hover mode" style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", flexShrink: 0 }}>
                      {([
                        { key: "off",  label: "Off" },
                        { key: "lite", label: "Lite" },
                        { key: "full", label: "Full" },
                      ] as { key: ReferenceMode; label: string }[]).map(opt => {
                        const activeMode = refMode === opt.key;
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => changeRefMode(opt.key)}
                            aria-pressed={activeMode}
                            style={{
                              padding: "5px 12px", fontSize: 12, fontWeight: 700,
                              border: "none",
                              borderLeft: opt.key !== "off" ? "1px solid var(--border)" : "none",
                              background: activeMode ? "var(--accent, #0ea5e9)" : "transparent",
                              color: activeMode ? "#fff" : "var(--text-secondary)",
                              cursor: "pointer",
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {/* Help & documentation — the shipped README + User Guide, in-app */}
                  <div style={settingRowStyle}>
                    <div>
                      <span style={settingLabelStyle}>Help &amp; documentation</span>
                      <span style={settingHintStyle}>The full User Guide and README, read them right inside MedOS.</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => openRoute("/help", "Help & Documentation")}
                      style={{ padding: "6px 14px", fontSize: 12, fontWeight: 700, border: "1px solid var(--border)", borderRadius: 8, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", flexShrink: 0 }}
                    >
                      Open
                    </button>
                  </div>
                </div>
              </>
            )}
            {panel === "search" && (
              <>
                <div style={{ position: "relative" }}>
                  {completionSuffix && (
                    <div aria-hidden style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", padding: "10px 12px", fontSize: 14, whiteSpace: "pre", pointerEvents: "none", overflow: "hidden" }}>
                      <span style={{ color: "transparent" }}>{query}</span>
                      <span style={{ color: "var(--text-muted)", opacity: 0.75 }}>{completionSuffix}</span>
                    </div>
                  )}
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search UpToDate, AMBOSS, UWorld, books, Q-Bank..."
                    autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                    style={{ ...inputStyle, width: "100%", position: "relative", background: "transparent", zIndex: 1 }}
                    onKeyDown={e => {
                      if ((e.key === "Tab" || e.key === "ArrowRight") && completion) {
                        if (e.key === "ArrowRight" && (e.currentTarget.selectionStart !== query.length || e.currentTarget.selectionEnd !== query.length)) return;
                        e.preventDefault();
                        setQuery(completion);
                        return;
                      }
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        if (displayItems.length || sugCount > 0) searchInteractionRef.current = reduceSearchInteraction(searchInteractionRef.current, "ArrowDown");
                        if (selectedSuggestion !== null) {
                          if (selectedSuggestion < sugCount - 1) setSelectedSuggestion(selectedSuggestion + 1);
                          else { setSelectedSuggestion(null); setSelectedIndex(0); }
                        } else moveSelected(1);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        if (displayItems.length || sugCount > 0) searchInteractionRef.current = reduceSearchInteraction(searchInteractionRef.current, "ArrowUp");
                        if (selectedSuggestion !== null) setSelectedSuggestion(Math.max(0, selectedSuggestion - 1));
                        else if (sugCount > 0 && (selectedIndex === 0 || !displayItems.length)) setSelectedSuggestion(sugCount - 1);
                        else moveSelected(-1);
                        return;
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const enterIntent = resolveSearchEnter(query, searchInteractionRef.current);
                        if (enterIntent.kind === "full-search" && enterIntent.href) openRoute(enterIntent.href, `Search: ${query.trim()}`);
                        else if (enterIntent.kind === "selected-result") openSelected();
                        return;
                      }
                    }}
                  />
                </div>
                {/* Scope chips */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "10px 0 6px" }}>
                  <button type="button" onClick={() => setActiveScopes(new Set(ALL_SEARCH_SCOPES))} style={scopeChipStyle(activeScopes.size === ALL_SEARCH_SCOPES.length, "var(--accent)", "accent")}>All</button>
                  {visibleScopeFilters.map(s => {
                    const on = activeScopes.size !== ALL_SEARCH_SCOPES.length && activeScopes.has(s.value);
                    return <button key={s.value} type="button" onClick={() => toggleScope(s.value)} style={scopeChipStyle(on, s.mc, s.value)}>{s.label}</button>;
                  })}
                </div>
                <p style={mutedStyle}>{status}</p>

                {/* Consolidated concept definition (one card, not many UMLS rows) */}
                {definition && (() => {
                  const href = definition.href || (definition.cui || definition.source_id ? `/umls?cui=${definition.cui || definition.source_id}` : "");
                  const isExternal = /^https?:\/\//i.test(href);
                  return (
                    <div style={defCardStyle}>
                      <span style={defBadgeStyle}>{definition.source}</span>
                      <div style={{ minWidth: 0 }}>
                        <a
                          href={href || undefined}
                          target={isExternal ? "_blank" : undefined}
                          rel={isExternal ? "noreferrer" : undefined}
                          onClick={event => {
                            if (!href || isExternal) return;
                            event.preventDefault();
                            openRoute(href, definition.term || "UMLS");
                          }}
                          style={{ fontWeight: 700, fontSize: 13, color: "var(--text-primary)", textDecoration: "none" }}
                        >
                          {definition.term}
                        </a>
                        {definition.expansion && definition.expansion !== definition.term && (
                          <span style={{ fontSize: 13, color: "var(--text-muted)", marginLeft: 6 }}>— {definition.expansion}</span>
                        )}
                        {icdInline(defIcdCodes(definition)) && (
                          <span style={icdInlineStyle}>{icdInline(defIcdCodes(definition))}</span>
                        )}
                        {definition.definition && (
                          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>{definition.definition.slice(0, 240)}</div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Expansion suggestions — keyboard-navigable (arrow up from the
                    first result), matches the dashboard search. */}
                {navSuggestions.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-muted)", flexShrink: 0 }}>Search as</span>
                    {navSuggestions.map((item, index) => {
                      const sugActive = selectedSuggestion === index;
                      return (
                        <button
                          key={item}
                          type="button"
                          onMouseEnter={() => setSelectedSuggestion(index)}
                          onClick={() => { setQuery(item); setSelectedSuggestion(null); setSelectedIndex(0); inputRef.current?.focus(); }}
                          title="Search this full term"
                          style={{
                            border: `1px solid ${sugActive ? "var(--accent)" : "rgba(15,118,110,0.28)"}`,
                            borderRadius: 999,
                            background: sugActive ? "var(--accent)" : "var(--bg-card)",
                            color: sugActive ? "var(--accent-ink)" : "var(--text-secondary)",
                            cursor: "pointer", flexShrink: 0, fontSize: 12, fontWeight: 700, padding: "4px 9px",
                          }}
                        >
                          {item}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div style={{ display: "grid", gap: 6 }}>
                  {displayItems.map((item, index) => {
                    const active = selectedSuggestion === null && index === selectedIndex;
                    if (item.kind === "drug-group") {
                      const dm = SEARCH_SOURCE_META.drugs;
                      return (
                        <div key="drug-group" ref={el => { resultRowRefs.current[index] = el; }} onMouseEnter={() => { setSelectedSuggestion(null); setSelectedIndex(index); }} style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", padding: "6px 4px", borderRadius: 8, border: `1px solid ${active ? dm.mc : "transparent"}`, background: active ? dm.soft : "transparent" }}>
                          <span style={{ ...badgePill, color: commandBadgeInk(dm.tag), background: dm.mc }}>DRUG</span>
                          {item.items.slice(0, 8).map(drug => (
                            <button key={drug.id} type="button" onClick={() => void openDrugPopup(drug)} style={drugPillStyle}>
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
                        <div key="uworld-group" ref={el => { resultRowRefs.current[index] = el; }} onMouseEnter={() => { setSelectedSuggestion(null); setSelectedIndex(index); }} style={{ display: "flex", gap: 7, alignItems: "center", padding: "4px 4px", borderRadius: 8, border: `1px solid ${active ? um.mc : "transparent"}`, background: active ? um.soft : "transparent" }}>
                          <span style={{ ...badgePill, color: commandBadgeInk(um.tag), background: um.mc }}>UW TBL</span>
                          <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
                            {item.items.map(tbl => (
                              <button key={tbl.id} type="button" title={tbl.title} onClick={() => { if (tbl.href) openRoute(tbl.href, tbl.title); }} style={uwTablePillStyle}>
                                {tbl.title.length > 28 ? tbl.title.slice(0, 26) + "…" : tbl.title}
                              </button>
                            ))}
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
                        fontFamily: "var(--font-mono)",
                        fontSize: 9,
                        letterSpacing: "0.1em",
                        fontWeight: 900,
                        cursor: "pointer",
                      };
                      return (
                        <div
                          key={`source-pair:${normalizedArticleTitle(item.title)}`}
                          ref={el => { resultRowRefs.current[index] = el; }}
                          onMouseEnter={() => { setSelectedSuggestion(null); setSelectedIndex(index); }}
                          style={{
                            display: "flex", gap: 8, alignItems: "center",
                            padding: "7px 4px", borderRadius: 8,
                            border: `1px solid ${active ? "var(--mod-amboss)" : "transparent"}`,
                            background: active ? "rgba(13,191,143,0.08)" : "transparent",
                          }}
                        >
                          <span style={{ ...badgePill, color: commandBadgeInk("amboss"), background: "var(--mod-amboss)", marginTop: 1 }}>TOPIC</span>
                          <div style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
                            <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 700 }}>{item.title}</div>
                            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>Same title in AMBOSS and UWorld</div>
                          </div>
                          <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                            {ambossItem && (
                              <button
                                type="button"
                                onClick={() => openSearchItem(ambossItem)}
                                style={{ ...sourceButtonStyle, borderColor: "var(--mod-amboss)", color: "var(--mod-amboss)" }}
                              >
                                AMBOSS
                              </button>
                            )}
                            {uworldItem && (
                              <button
                                type="button"
                                onClick={() => openSearchItem(uworldItem)}
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
                    const meta = searchSourceMeta(r.kind === "uworld_table" ? r.kind : (r.scope || ""));
                    const icdCodes = icdCodesFor(r);
                    const concept = r.umls;
                    return (
                      <button key={`${r.scope}:${r.id}:${index}`} type="button" ref={el => { resultRowRefs.current[index] = el; }} onMouseEnter={() => { setSelectedSuggestion(null); setSelectedIndex(index); }} onClick={() => openSearchItem(r)} style={{ ...resultRowStyle, background: active ? meta.soft : "var(--bg-card)", borderColor: active ? meta.mc : "var(--border)" }}>
                        <span style={{ ...badgePill, color: commandBadgeInk(r.scope || meta.tag), background: meta.mc, marginTop: 1 }}>{meta.tag}</span>
                        <div style={{ minWidth: 0, textAlign: "left" }}>
                          <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span>{r.title}</span>
                            {icdInline(icdCodes) && (
                              <span title={icdCodes.map(c => `${c.code}${c.term ? ` ${c.term}` : ""}`).join("\n")} style={icdInlineStyle}>{icdInline(icdCodes)}</span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>{r.subtitle || meta.label}</div>
                          {concept?.definition && (
                            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.35 }}>
                              {concept.preferred_name && concept.preferred_name !== r.title ? `${concept.preferred_name}: ` : ""}
                              {concept.definition.slice(0, 170)}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {panel === "calculators" && (
              <>
                <div style={sectionHeaderStyle}>
                  <span>Open any calculator</span>
                  <button onClick={() => openRoute("/calculators", "Calculators")} style={secondaryButtonStyle}>Manage</button>
                </div>
                <div style={searchRowStyle}>
                  <input
                    ref={inputRef}
                    value={calcQuery}
                    onChange={e => setCalcQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && calcResults[0]) openCalcResultAndClose(calcResults[0]);
                    }}
                    placeholder="Search calculators"
                    style={inputStyle}
                  />
                  <button
                    onClick={() => calcResults[0] ? openCalcResultAndClose(calcResults[0]) : undefined}
                    style={primaryButtonStyle}
                  >
                    Open
                  </button>
                </div>
                <p style={mutedStyle}>{calcStatus}</p>
                {calcResults.length > 0 && (
                  <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
                    {calcResults.map((item, index) => (
                      <button key={`${item.id}:${index}`} onClick={() => openCalcResultAndClose(item)} style={resultButtonStyle}>
                        <strong>{item.title}</strong>
                        <small>{item.subtitle || item.scope || item.kind || "Calculator"}</small>
                      </button>
                    ))}
                  </div>
                )}
                <div style={sectionHeaderStyle}>
                  <span>Calculator shortcuts</span>
                </div>
                <div style={gridStyle}>
                  {calcSlots.map((slot, index) => (
                    <button
                      key={`${slot.target}:${index}`}
                      onClick={() => window.medosCalc?.openTarget?.(slot.target)}
                      style={commandButtonStyle}
                    >
                      <span>{slot.label}</span>
                      <kbd style={kbdStyle}>{index === 9 ? 0 : index + 1}</kbd>
                    </button>
                  ))}
                </div>
                <p style={{ ...mutedStyle, marginTop: 12 }}>
                  Change these 10 slots from the calculator page. The same slots also work with Ctrl+Alt+1 through Ctrl+Alt+0.
                </p>
              </>
            )}
            {panel === "labs" && (
              <>
                <div style={searchRowStyle}>
                  <input ref={inputRef} value={labQuery} onChange={e => setLabQuery(e.target.value)} placeholder="Filter labs" style={inputStyle} />
                  <button onClick={() => navigator.clipboard?.writeText(filteredLabs.flatMap(g => g.items.map(([n, r]) => `${n}: ${r}`)).join("\n"))} style={primaryButtonStyle}>Copy</button>
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {filteredLabs.map(group => (
                    <details key={group.name} open style={labGroupStyle}>
                      <summary style={labSummaryStyle}><strong>{group.name}</strong><small>{group.subtitle}</small></summary>
                      <div style={labGridStyle}>
                        {group.items.map(([name, range]) => <div key={name} style={labItemStyle}><span>{name}</span><b>{range}</b></div>)}
                      </div>
                    </details>
                  ))}
                </div>
              </>
            )}
            {panel === "help" && (
              <div style={{ display: "grid", gap: 18 }}>
                <div>
                  <div style={helpSectionTitleStyle}>Keyboard shortcuts</div>
                  <div style={{ display: "grid", gap: 2 }}>
                    {commands.map(command => <div key={command.id} style={helpRowStyle}><kbd style={kbdStyle}>{command.keys}</kbd><span>{command.label}</span></div>)}
                    <div style={helpRowStyle}><kbd style={kbdStyle}>Ctrl+Alt+1..0</kbd><span>Calculator shortcut slots</span></div>
                  </div>
                </div>
                {GUIDE_SECTIONS.map(section => (
                  <div key={section.title}>
                    <div style={helpSectionTitleStyle}>{section.title}</div>
                    <div style={{ display: "grid", gap: 7 }}>
                      {section.items.map((item, i) => (
                        <div key={i} style={helpTipRowStyle}>
                          <span style={helpBulletStyle} aria-hidden>{"•"}</span>
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  Full manual: <strong>MedOS_USER_GUIDE.md</strong> in your MedOS install folder — install,
                  upgrade, every feature, and the clinical-integration design in detail.
                </div>
              </div>
            )}
          </div>
        </section>
      )}
      {drugPopup && (
        <DrugClinicalPopup
          popup={drugPopup}
          onClose={() => setDrugPopup(null)}
          onOpenFull={(drugId) => {
            const title = drugPopup.drug.generic_name || "Drug Ref";
            setDrugPopup(null);
            openRoute(`/drugs?id=${drugId}`, title);
          }}
        />
      )}
      {mediaPreview && (
        <MediaViewer
          open
          onClose={() => setMediaPreview(null)}
          title={mediaPreview.title}
          source={mediaPreview.source}
          imageUrl={mediaPreview.kind === "image" ? mediaPreview.url : undefined}
          frameUrl={mediaPreview.kind === "frame" ? mediaPreview.url : undefined}
        />
      )}
    </>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label style={toggleWrapStyle} title={checked ? "Turn off" : "Turn on"}>
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
      <span style={{
        ...toggleTrackStyle,
        background: checked ? "var(--accent)" : "var(--border-strong)",
      }}>
        <span style={{
          ...toggleThumbStyle,
          transform: checked ? "translateX(14px)" : "translateX(0)",
        }} />
      </span>
    </label>
  );
}

const launcherStyle: React.CSSProperties = {
  position: "fixed", right: 18, bottom: 18, zIndex: 10020, width: 42, height: 42,
  border: "1px solid rgba(148,163,184,.55)", borderRadius: 999, background: "rgba(15,23,42,.66)", color: "var(--bg-base)",
  fontSize: 18, fontWeight: 900, cursor: "pointer", boxShadow: "0 14px 34px rgba(15,23,42,.18)", opacity: 0.62,
  backdropFilter: "blur(8px)",
};
// Full-height shell-grid sidebar extension. The shell reserves this exact
// width, so the active page reflows and the panel never floats over navigation.
const windowStyle: React.CSSProperties = { gridRow: "1 / span 3", gridColumn: "1", position: "relative", alignSelf: "stretch", justifySelf: "start", marginLeft: "var(--rail-w, 56px)", zIndex: 35, width: "var(--command-center-w, min(400px, calc(100vw - var(--rail-w, 56px))))", minWidth: 0, height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-card)", borderRight: "1px solid var(--border)", overflow: "hidden", animation: "medos-cc-in .18s cubic-bezier(.4,0,.2,1)" };
const titleStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "11px 8px 9px 16px", background: "transparent", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", flexShrink: 0 };
const titleTextStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" };
const titleButtonStyle: React.CSSProperties = { marginLeft: "auto", width: 28, height: 28, border: 0, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 20, borderRadius: 6, lineHeight: 1 };
const bodyStyle: React.CSSProperties = { padding: 14, overflow: "auto", flex: 1, minHeight: 0 };
const searchRowStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, marginBottom: 12 };
const inputStyle: React.CSSProperties = { minWidth: 0, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-card)", color: "var(--text-primary)", fontSize: 14 };
const primaryButtonStyle: React.CSSProperties = { padding: "10px 14px", border: "1px solid var(--text-primary)", borderRadius: 7, background: "var(--text-primary)", color: "var(--bg-base)", cursor: "pointer", fontWeight: 800 };
const secondaryButtonStyle: React.CSSProperties = { padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-card)", color: "var(--text-secondary)", cursor: "pointer", fontWeight: 800, fontSize: 12 };
const sectionHeaderStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, color: "var(--text-secondary)", fontSize: 12, fontWeight: 800 };
const gridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 8 };
const commandButtonStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-card)", color: "var(--text-primary)", cursor: "pointer", textAlign: "left", fontWeight: 800 };
const kbdStyle: React.CSSProperties = { fontSize: 10, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 6px", background: "var(--bg-base)", whiteSpace: "nowrap" };
const mutedStyle: React.CSSProperties = { margin: "0 0 10px", fontSize: 12, color: "var(--text-muted)" };
const resultButtonStyle: React.CSSProperties = { display: "grid", gap: 3, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-card)", color: "var(--text-primary)", cursor: "pointer", textAlign: "left" };
const icdInlineStyle: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10, color: "var(--accent-strong)", marginLeft: 6, fontWeight: 800 };
const badgePill: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--accent-ink)", borderRadius: 999, padding: "3px 6px", flexShrink: 0, fontWeight: 700, lineHeight: 1.5 };
const resultRowStyle: React.CSSProperties = { display: "flex", gap: 10, alignItems: "flex-start", width: "100%", textAlign: "left", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", padding: "9px 11px", cursor: "pointer" };
const drugPillStyle: React.CSSProperties = { border: "1px solid rgba(14,165,164,0.30)", borderRadius: 999, background: "rgba(14,165,164,0.08)", color: "var(--text-primary)", padding: "3px 10px", fontSize: 12, cursor: "pointer", fontWeight: 500, lineHeight: 1.4 };
const uwTablePillStyle: React.CSSProperties = { border: "1px solid rgba(239,68,68,0.28)", borderRadius: 6, background: "rgba(239,68,68,0.06)", color: "var(--text-secondary)", padding: "4px 9px", fontSize: 11.5, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 };
const defCardStyle: React.CSSProperties = { padding: "10px 12px", background: "rgba(15,118,110,0.06)", border: "1px solid var(--border)", borderRadius: 8, display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10 };
const defBadgeStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent-ink)", background: "var(--accent)", padding: "2px 6px", borderRadius: 3, flexShrink: 0, marginTop: 1, fontWeight: 700 };
function scopeChipStyle(active: boolean, mc: string, sourceOrTag = ""): React.CSSProperties {
  return { fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.04em", textTransform: "uppercase", padding: "4px 9px", borderRadius: 999, cursor: "pointer", border: `1px solid ${active ? mc : "var(--border)"}`, background: active ? mc : "transparent", color: active ? commandBadgeInk(sourceOrTag) : "var(--text-muted)", fontWeight: 700, transition: "all .12s" };
}
const labGroupStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", overflow: "hidden" };
const labSummaryStyle: React.CSSProperties = { display: "grid", gap: 3, padding: "13px 14px", cursor: "pointer", color: "var(--text-primary)" };
const labGridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 6, padding: "0 12px 12px" };
const labItemStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-base)", fontSize: 12 };
const helpRowStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)", fontSize: 12 };
const helpSectionTitleStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 700, marginBottom: 8 };
const helpTipRowStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "14px minmax(0,1fr)", gap: 8, alignItems: "start", color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.5 };
const helpBulletStyle: React.CSSProperties = { color: "var(--accent)", fontWeight: 700, lineHeight: 1.5 };

// Native, in-app documentation surfaced under the "?" help panel — the
// practical essentials so users never have to leave the app to learn it. The
// full manual lives in MedOS_USER_GUIDE.md; this is the quick-reference subset.
const GUIDE_SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "Searching",
    items: [
      "Type a drug, disease, lab, calculator, or topic — capitalisation never matters (DKA, dka and Dka all match).",
      "Abbreviations auto-expand: search MI, CHF, COPD or CKD and MedOS resolves the full term and its synonyms.",
      "Drug names jump straight to the drug card — dosing, interactions, black-box warnings and FDA label.",
      "Use the scope chips to narrow results to one source (Databases vs Clinical Tools), then ↑/↓ and Enter to open.",
    ],
  },
  {
    title: "Reading & navigation",
    items: [
      "Hover any underlined term for an instant definition card; click it to open the full source.",
      "Each database reader's right panel has Contents, Outline, Images and Related tabs — navigate with Tab and ↑/↓.",
      "Escape closes any popup, drawer, hover card, or modal.",
      "Results and articles open in MedOS tabs so a running Q-bank block is never lost.",
    ],
  },
  {
    title: "How MedOS connects everything",
    items: [
      "MedOS is an integration platform, not a folder of PDFs: UpToDate, AMBOSS, UWorld, drugs and books are linked by shared UMLS concept pathways.",
      "Every resource works standalone — but the Related tab surfaces the very same concept across all the others.",
      "Hover cards aggregate sources: one term can show its drug card, AMBOSS article, UWorld exhibit and book chapters together.",
    ],
  },
];
const settingsPanelStyle: React.CSSProperties = { display: "grid", gap: 0, marginTop: 14, paddingTop: 4, borderTop: "1px solid var(--border)" };
const settingRowStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "10px 0", borderBottom: "1px solid var(--border)" };
const settingLabelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 };
const settingHintStyle: React.CSSProperties = { display: "block", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 };
const toggleWrapStyle: React.CSSProperties = { position: "relative", display: "inline-flex", alignItems: "center", flexShrink: 0, cursor: "pointer" };
const toggleTrackStyle: React.CSSProperties = { display: "block", width: 32, height: 18, borderRadius: 999, transition: "background 0.18s" };
const toggleThumbStyle: React.CSSProperties = { position: "absolute", top: 3, left: 3, width: 12, height: 12, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.25)", transition: "transform 0.18s" };
