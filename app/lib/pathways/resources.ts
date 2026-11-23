/* Pathways resource routing + specialty visual identity. */

import type { PathwayResource } from "./types";

/* What a resource chip should DO when clicked. */
export type ResourceAction =
  | { kind: "route"; href: string }          // internal Next route (/uptodate?t=, /drugs?q=, /pathways?p=)
  | { kind: "graphic"; graphicId: number }   // open the UpToDate GraphicDrawer
  | { kind: "external"; href: string }        // external guideline URL (new tab)
  | { kind: "inline" }                        // info/authors — show inlineHtml in a popover
  | { kind: "none" };

export function resourceAction(res: PathwayResource): ResourceAction {
  if (res.type === "graphic" && res.route?.startsWith("graphic:")) {
    const id = Number(res.route.slice("graphic:".length));
    return Number.isFinite(id) ? { kind: "graphic", graphicId: id } : { kind: "none" };
  }
  if (res.type === "info" || res.type === "authors") {
    return res.inlineHtml ? { kind: "inline" } : { kind: "none" };
  }
  if (!res.route) return res.inlineHtml ? { kind: "inline" } : { kind: "none" };
  if (/^https?:\/\//i.test(res.route)) return { kind: "external", href: res.route };
  return { kind: "route", href: res.route };
}

/* Icon + short tag per resource type (Material Symbols). */
export const RES_META: Record<string, { glyph: string; tag: string }> = {
  topic: { glyph: "clinical_notes", tag: "UpToDate" },
  drug: { glyph: "medication", tag: "Drug" },
  graphic: { glyph: "image", tag: "Figure" },
  pathway: { glyph: "account_tree", tag: "Pathway" },
  guideline: { glyph: "gavel", tag: "Guideline" },
  info: { glyph: "info", tag: "Note" },
  authors: { glyph: "group", tag: "Authors" },
  ref: { glyph: "link", tag: "Ref" },
};

/* ── Specialty visual identity ──────────────────────────────────────────────
   Each specialty gets a stable accent hue + glyph so the hub and player feel
   like a wayfinding system. Unmatched specialties fall back to the module accent. */
interface SpecVisual { color: string; glyph: string; }

const SPEC_TABLE: { match: RegExp; v: SpecVisual }[] = [
  { match: /cardio/i, v: { color: "#e11d48", glyph: "cardiology" } },
  { match: /emergency/i, v: { color: "#f97316", glyph: "e911_emergency" } },
  { match: /endocrin|diabet/i, v: { color: "#d946ef", glyph: "glucose" } },
  { match: /family|primary care|general prac/i, v: { color: "#0ea5e9", glyph: "stethoscope" } },
  { match: /gastro|hepat/i, v: { color: "#ca8a04", glyph: "gastroenterology" } },
  { match: /surg/i, v: { color: "#0d9488", glyph: "surgical" } },
  { match: /hematolog/i, v: { color: "#dc2626", glyph: "bloodtype" } },
  { match: /hospital/i, v: { color: "#6366f1", glyph: "local_hospital" } },
  { match: /infect/i, v: { color: "#16a34a", glyph: "coronavirus" } },
  { match: /nephro|hypertens/i, v: { color: "#0891b2", glyph: "nephrology" } },
  { match: /neuro/i, v: { color: "#7c3aed", glyph: "neurology" } },
  { match: /obstet|gynec|women/i, v: { color: "#db2777", glyph: "pregnancy" } },
  { match: /oncolog/i, v: { color: "#9333ea", glyph: "oncology" } },
  { match: /psych/i, v: { color: "#2563eb", glyph: "psychology" } },
  { match: /pulmon|critical/i, v: { color: "#0284c7", glyph: "pulmonology" } },
  { match: /radiolog/i, v: { color: "#475569", glyph: "radiology" } },
  { match: /rheumat/i, v: { color: "#ea580c", glyph: "orthopedics" } },
  { match: /anesthes/i, v: { color: "#64748b", glyph: "vaccines" } },
];

export function specialtyVisual(name: string | null | undefined): SpecVisual {
  if (name) {
    for (const { match, v } of SPEC_TABLE) if (match.test(name)) return v;
  }
  return { color: "var(--mod-pathways)", glyph: "account_tree" };
}
