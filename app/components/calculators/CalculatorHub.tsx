"use client";
import { useState, useMemo, useEffect } from "react";
import type { ReactNode } from "react";
import { Calculator, Copy, Database, Keyboard, Maximize2, Minimize2, Search, Star, X, ChevronRight } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { getBackendUrl } from "@/lib/api";
import { recordRecent } from "@/lib/useRecent";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Field {
  id: string;
  label: string;
  type: "number" | "select";
  variant?: "toggle" | "select";
  unit?: string;
  unitOptions?: UnitOption[];
  options?: { value: number; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  default?: number;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  conditionality?: string;
  section?: string;
  sectionNote?: string;
}

interface UnitOption {
  value: string;
  label: string;
  factor: number;
}

interface CalcDetails {
  usedFor?: string;
  usedForHtml?: string;
  interpretation?: string;
  interpretationHtml?: string;
  cautions?: string[];
  cautionsHtml?: string;
  formula?: string;
  formulaHtml?: string;
  evidenceHtml?: string;
  moreInfoHtml?: string;
  references?: MdCalcReferenceGroups;
  creators?: { name?: string; qa?: string }[];
  contributors?: string[];
  instructionsHtml?: string;
}

interface MdCalcReference {
  text?: string;
  href?: string;
}

interface MdCalcReferenceGroups {
  primary_references?: MdCalcReference[];
  validation?: MdCalcReference[];
  validations?: MdCalcReference[];
  outcomes?: MdCalcReference[];
  other_references?: MdCalcReference[];
  clinical_practice_guidelines?: MdCalcReference[];
  manufacturer_website?: MdCalcReference[];
}

interface MdCalcLiveDetails {
  beforeUse?: string;
  instructions?: string;
  whenToUse?: string;
  pearlsPitfalls?: string;
  advice?: string;
  management?: string;
  criticalActions?: string;
  moreInfo?: string;
  evidence?: string;
  creators?: { name?: string; qa?: string }[];
  contributors?: string[];
}

interface ResultBand {
  min?: number;
  max?: number;
  label: string;
  color: "green" | "amber" | "red" | "blue" | "purple";
}

interface CalcDef {
  id: string;
  name: string;
  category: string;
  description: string;
  fields: Field[];
  compute: (vals: Record<string, number>) => { value: number | string; unit?: string; label?: string };
  bands?: ResultBand[];
  reference?: string;
  details?: CalcDetails;
  layout?: "standard" | "criteria";
}

interface LexiCalc {
  id: string;
  title: string;
  category: string;
  categories: string[];
  subtitle: string;
  description?: string;
  inputs?: LiveCalcInput[];
  formula?: string;
  equationLogicText?: string;
  details?: MdCalcLiveDetails | null;
  references?: MdCalcReferenceGroups | null;
  source?: string;
}

interface LiveCalcInput {
  name: string;
  type: string;
  dataType?: string;
  label: string;
  unit?: string;
  unitSi?: string;
  unitUs?: string;
  normalMin?: number;
  normalMax?: number;
  warnMin?: number;
  warnMax?: number;
  errorMin?: number;
  errorMax?: number;
  hint?: string;
  optional?: boolean;
  default?: number;
  conditionality?: string;
  showPoints?: boolean;
  options?: { value: number; label: string }[];
}

type CalcWindowMode = "dock" | "expanded" | "minimized";
type CalcGuideTab = "calculator" | "next" | "evidence" | "creator";

interface CombinedCalc {
  key: string;
  title: string;
  category: string;
  categories: string[];
  description: string;
  native?: CalcDef;
  lexi?: LexiCalc;
}

type ShortcutTarget = string;

function scoreBand(v: number, bands: ResultBand[]): ResultBand | undefined {
  return bands.find(b =>
    (b.min === undefined || v >= b.min) &&
    (b.max === undefined || v < b.max)
  );
}

// ─── Calculators ─────────────────────────────────────────────────────────────

const BASE_CALCULATORS: CalcDef[] = [
  {
    id: "bmi", name: "BMI", category: "Body Metrics",
    description: "Body Mass Index — weight (kg) / height² (m²)",
    fields: [
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 1, max: 500, step: 0.1, required: true },
      { id: "height", label: "Height", type: "number", unit: "cm", min: 50, max: 250, step: 0.1, required: true },
    ],
    compute: ({ weight, height }) => ({ value: +(weight / Math.pow(height / 100, 2)).toFixed(1), unit: "kg/m²" }),
    bands: [
      { max: 18.5, label: "Underweight", color: "blue" },
      { min: 18.5, max: 25, label: "Normal", color: "green" },
      { min: 25, max: 30, label: "Overweight", color: "amber" },
      { min: 30, label: "Obese", color: "red" },
    ],
  },
  {
    id: "ibw", name: "Ideal Body Weight", category: "Body Metrics",
    description: "Devine formula for adult drug dosing",
    fields: [
      { id: "height", label: "Height", type: "number", unit: "cm", min: 100, max: 250, required: true },
      { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
    ],
    compute: ({ height, sex }) => {
      const in_ = height / 2.54;
      const base = sex === 1 ? 50 : 45.5;
      return { value: +Math.max(base + 2.3 * (in_ - 60), base).toFixed(1), unit: "kg" };
    },
  },
  {
    id: "bsa", name: "Body Surface Area", category: "Body Metrics",
    description: "Mosteller formula — chemotherapy / paediatric dosing",
    fields: [
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 1, max: 500, step: 0.1, required: true },
      { id: "height", label: "Height", type: "number", unit: "cm", min: 50, max: 250, step: 0.1, required: true },
    ],
    compute: ({ weight, height }) => ({ value: +Math.sqrt((height * weight) / 3600).toFixed(2), unit: "m²" }),
  },
  {
    id: "egfr", name: "eGFR (CKD-EPI)", category: "Renal",
    description: "CKD-EPI equations for GFR using creatinine, cystatin C, or both",
    fields: [
      { id: "calc", label: "Equation", type: "select", options: [
        { value: 3, label: "2021 CKD-EPI Creatinine" },
        { value: 4, label: "2021 CKD-EPI Creatinine-Cystatin C" },
        { value: 0, label: "2009 CKD-EPI Creatinine" },
        { value: 1, label: "2012 CKD-EPI Cystatin C" },
        { value: 2, label: "2012 CKD-EPI Creatinine-Cystatin C" },
      ] },
      { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      { id: "age", label: "Age", type: "number", unit: "years", min: 18, max: 120, required: true },
      { id: "creatinine", label: "Serum creatinine", type: "number", unit: "mg/dL", min: 0.1, max: 30, step: 0.01, hint: "Required for creatinine equations." },
      { id: "cystatin", label: "Serum cystatin C", type: "number", unit: "mg/L", min: 0.1, max: 20, step: 0.01, hint: "Required for cystatin C equations." },
      { id: "race", label: "Race for older equations", type: "select", options: [{ value: 2, label: "Non-black / not used" }, { value: 1, label: "Black" }] },
    ],
    compute: ({ calc, creatinine: cr, cystatin, age, sex, race }) => {
      const needsCr = calc === 0 || calc === 2 || calc === 3 || calc === 4;
      const needsCys = calc === 1 || calc === 2 || calc === 4;
      if ((needsCr && !cr) || (needsCys && !cystatin)) {
        return { value: "Enter required lab values", unit: "", label: needsCr && needsCys ? "This equation requires creatinine and cystatin C." : needsCr ? "This equation requires creatinine." : "This equation requires cystatin C." };
      }
      const black = race === 1;
      const k = sex === 1 ? 0.9 : 0.7;
      let egfr = 0;
      let label = "2021 CKD-EPI Creatinine";
      if (calc === 3) {
        const a = sex === 1 ? -0.302 : -0.241;
        const x = cr / k;
        egfr = 142 * Math.pow(Math.min(x, 1), a) * Math.pow(Math.max(x, 1), -1.2) * Math.pow(0.9938, age) * (sex === 0 ? 1.012 : 1);
      } else if (calc === 4) {
        const scrA = sex === 1 ? (cr <= 0.9 ? -0.144 : -0.544) : (cr <= 0.7 ? -0.219 : -0.544);
        const scysA = cystatin <= 0.8 ? -0.323 : -0.778;
        egfr = 135 * Math.pow(cr / k, scrA) * Math.pow(cystatin / 0.8, scysA) * Math.pow(0.9961, age) * (sex === 0 ? 0.963 : 1);
        label = "2021 CKD-EPI Creatinine-Cystatin C";
      } else if (calc === 0) {
        const a = sex === 1 ? (cr <= 0.9 ? -0.411 : -1.209) : (cr <= 0.7 ? -0.329 : -1.209);
        egfr = (sex === 1 ? 141 : 144) * Math.pow(cr / k, a) * Math.pow(0.993, age) * (black ? 1.159 : 1);
        label = "2009 CKD-EPI Creatinine";
      } else if (calc === 1) {
        egfr = 133 * Math.pow(cystatin / 0.8, cystatin <= 0.8 ? -0.499 : -1.328) * Math.pow(0.996, age) * (sex === 0 ? 0.932 : 1);
        label = "2012 CKD-EPI Cystatin C";
      } else {
        const scrA = sex === 1 ? (cr <= 0.9 ? -0.207 : -0.601) : (cr <= 0.7 ? -0.248 : -0.601);
        const scysA = cystatin <= 0.8 ? -0.375 : -0.711;
        egfr = (sex === 1 ? 135 : 130) * Math.pow(cr / k, scrA) * Math.pow(cystatin / 0.8, scysA) * Math.pow(0.995, age) * (black ? 1.08 : 1);
        label = "2012 CKD-EPI Creatinine-Cystatin C";
      }
      return { value: +egfr.toFixed(0), unit: "mL/min/1.73m²", label };
    },
    bands: [
      { min: 90, label: "G1 — Normal", color: "green" },
      { min: 60, max: 90, label: "G2 — Mildly decreased", color: "green" },
      { min: 45, max: 60, label: "G3a — Mild–moderate", color: "amber" },
      { min: 30, max: 45, label: "G3b — Moderate–severe", color: "amber" },
      { min: 15, max: 30, label: "G4 — Severely decreased", color: "red" },
      { max: 15, label: "G5 — Kidney failure", color: "red" },
    ],
  },
  {
    id: "cockcroft", name: "Creatinine Clearance", category: "Renal",
    description: "Cockcroft-Gault — for drug dosing adjustments",
    fields: [
      { id: "creatinine", label: "Serum Creatinine", type: "number", unit: "mg/dL", min: 0.1, max: 30, step: 0.01, required: true },
      { id: "age", label: "Age", type: "number", unit: "years", min: 18, max: 120, required: true },
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 1, max: 500, step: 0.1, required: true },
      { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
    ],
    compute: ({ creatinine, age, weight, sex }) => {
      let cl = ((140 - age) * weight) / (72 * creatinine);
      if (sex === 0) cl *= 0.85;
      return { value: +cl.toFixed(0), unit: "mL/min" };
    },
  },
  {
    id: "anion_gap", name: "Anion Gap", category: "Acid-Base",
    description: "Na⁺ − (Cl⁻ + HCO₃⁻) with albumin correction",
    fields: [
      { id: "na",      label: "Sodium (Na⁺)",   type: "number", unit: "mEq/L", min: 100, max: 180, required: true },
      { id: "cl",      label: "Chloride (Cl⁻)", type: "number", unit: "mEq/L", min: 50,  max: 150, required: true },
      { id: "bicarb",  label: "HCO₃⁻",          type: "number", unit: "mEq/L", min: 1,   max: 60,  required: true },
      { id: "albumin", label: "Albumin (optional)", type: "number", unit: "g/dL", min: 0, max: 6, step: 0.1, default: 4 },
    ],
    compute: ({ na, cl, bicarb, albumin = 4 }) => {
      const ag = na - (cl + bicarb);
      const corr = ag + 2.5 * (4 - albumin);
      return { value: +corr.toFixed(1), unit: "mEq/L", label: `Raw AG = ${ag.toFixed(1)}, Corrected = ${corr.toFixed(1)}` };
    },
    bands: [
      { max: 12, label: "Normal (3–11 mEq/L)", color: "green" },
      { min: 12, label: "Elevated — consider MUDPILES", color: "red" },
    ],
  },
  {
    id: "anc", name: "Absolute Neutrophil Count", category: "Hematology / Coagulation",
    description: "Calculates ANC from WBC count and neutrophil percentages",
    fields: [
      { id: "wbc", label: "WBC count", type: "number", unit: "10^3/uL", min: 0, max: 500, step: 0.1, required: true },
      { id: "neutrophils", label: "Segmented neutrophils", type: "number", unit: "%", min: 0, max: 100, step: 1, required: true },
      { id: "bands", label: "Bands", type: "number", unit: "%", min: 0, max: 100, step: 1, default: 0 },
    ],
    compute: ({ wbc, neutrophils, bands = 0 }) => ({ value: Math.round(wbc * 1000 * ((neutrophils + bands) / 100)), unit: "cells/uL" }),
    bands: [
      { min: 1500, label: "Normal or not neutropenic", color: "green" },
      { min: 1000, max: 1500, label: "Mild neutropenia", color: "amber" },
      { min: 500, max: 1000, label: "Moderate neutropenia", color: "amber" },
      { max: 500, label: "Severe neutropenia", color: "red" },
    ],
  },
  {
    id: "four_t", name: "4T Score", category: "Hematology / Coagulation",
    description: "Pretest probability score for heparin-induced thrombocytopenia",
    fields: [
      { id: "thrombocytopenia", label: "Thrombocytopenia", type: "select", options: [
        {value:0,label:"0 — Platelet fall <30% or nadir <10"},
        {value:1,label:"1 — Fall 30-50% or nadir 10-19"},
        {value:2,label:"2 — Fall >50% and nadir >=20"},
      ]},
      { id: "timing", label: "Timing of platelet fall", type: "select", options: [
        {value:0,label:"0 — <4 days without recent heparin"},
        {value:1,label:"1 — Unclear or >10 days"},
        {value:2,label:"2 — Days 5-10 or <=1 day with recent exposure"},
      ]},
      { id: "thrombosis", label: "Thrombosis or sequelae", type: "select", options: [
        {value:0,label:"0 — None"},
        {value:1,label:"1 — Progressive/recurrent thrombosis or skin lesions"},
        {value:2,label:"2 — New thrombosis, skin necrosis, or acute systemic reaction"},
      ]},
      { id: "other", label: "Other causes of thrombocytopenia", type: "select", options: [
        {value:0,label:"0 — Definite other cause"},
        {value:1,label:"1 — Possible other cause"},
        {value:2,label:"2 — No apparent other cause"},
      ]},
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "points" }),
    bands: [
      { max: 4, label: "Low probability of HIT", color: "green" },
      { min: 4, max: 6, label: "Intermediate probability of HIT", color: "amber" },
      { min: 6, label: "High probability of HIT", color: "red" },
    ],
  },
  {
    id: "winters", name: "Winter's Formula", category: "Acid-Base",
    description: "Expected pCO₂ for metabolic acidosis",
    fields: [{ id: "bicarb", label: "Serum HCO₃⁻", type: "number", unit: "mEq/L", min: 1, max: 40, required: true }],
    compute: ({ bicarb }) => {
      const low  = +(1.5 * bicarb + 6).toFixed(0);
      const high = +(1.5 * bicarb + 10).toFixed(0);
      return { value: `${low}–${high}`, unit: "mmHg (expected pCO₂)" };
    },
  },
  {
    id: "aa_gradient", name: "A-a Gradient", category: "Acid-Base",
    description: "Alveolar-arterial O₂ gradient — detects lung pathology",
    fields: [
      { id: "fio2",  label: "FiO₂", type: "number", unit: "%",    min: 21, max: 100, default: 21, required: true },
      { id: "paco2", label: "PaCO₂", type: "number", unit: "mmHg", min: 10, max: 100, required: true },
      { id: "pao2",  label: "PaO₂",  type: "number", unit: "mmHg", min: 10, max: 700, required: true },
    ],
    compute: ({ fio2, paco2, pao2 }) => {
      const pao2_alv = ((fio2 / 100) * (760 - 47)) - (paco2 / 0.8);
      return { value: +(pao2_alv - pao2).toFixed(1), unit: "mmHg" };
    },
    bands: [
      { max: 15, label: "Normal (< 15 mmHg on room air)", color: "green" },
      { min: 15, label: "Elevated — intrinsic lung disease or shunt", color: "red" },
    ],
  },
  {
    id: "cha2ds2", name: "CHA₂DS₂-VASc", category: "Cardiology",
    description: "Stroke risk in non-valvular atrial fibrillation",
    fields: [
      { id: "chf",    label: "CHF / LV dysfunction",      type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "htn",    label: "Hypertension",               type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "age75",  label: "Age ≥ 75",                   type: "select", options: [{value:0,label:"No"},{value:2,label:"Yes"}] },
      { id: "dm",     label: "Diabetes mellitus",          type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "stroke", label: "Prior stroke / TIA / TE",    type: "select", options: [{value:0,label:"No"},{value:2,label:"Yes"}] },
      { id: "vasc",   label: "Vascular disease",           type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "age65",  label: "Age 65–74",                  type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "female", label: "Female sex",                 type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "points" }),
    bands: [
      { max: 1, label: "Low — anticoagulation not recommended", color: "green" },
      { min: 1, max: 2, label: "Consider anticoagulation", color: "amber" },
      { min: 2, label: "High — anticoagulation recommended", color: "red" },
    ],
    reference: "Lip GY et al. Chest 2010",
  },
  {
    id: "qtc", name: "Corrected QT (QTc)", category: "Cardiology",
    description: "QT interval corrected for heart rate using multiple formulas",
    fields: [
      { id: "formula", label: "Formula", type: "select", options: [{ value: 0, label: "Bazett" }, { value: 1, label: "Fridericia" }, { value: 2, label: "Framingham" }, { value: 3, label: "Hodges" }, { value: 4, label: "Rautaharju" }] },
      { id: "heart_rate", label: "Heart rate / pulse", type: "number", unit: "bpm", min: 20, max: 300, required: true },
      { id: "qt", label: "QT interval", type: "number", unit: "ms",  min: 100, max: 800, required: true },
    ],
    compute: ({ formula, heart_rate, qt }) => {
      const rr = 60 / heart_rate;
      const results = [
        qt / Math.sqrt(rr),
        qt / Math.pow(rr, 1 / 3),
        qt + 154 * (1 - rr),
        qt + 1.75 * (heart_rate - 60),
        qt * (120 + heart_rate) / 180,
      ];
      const names = ["Bazett", "Fridericia", "Framingham", "Hodges", "Rautaharju"];
      return { value: +results[formula].toFixed(0), unit: "ms", label: `${names[formula]} formula; RR ${rr.toFixed(2)} sec.` };
    },
    bands: [
      { max: 440, label: "Normal (men <440 ms)", color: "green" },
      { min: 440, max: 460, label: "Borderline", color: "amber" },
      { min: 460, label: "Prolonged — torsades risk", color: "red" },
    ],
  },
  {
    id: "timi_stemi", name: "TIMI Score (STEMI)", category: "Cardiology",
    description: "30-day mortality in ST-elevation MI",
    fields: [
      { id: "age75",    label: "Age ≥ 75",                     type: "select", options: [{value:0,label:"No"},{value:3,label:"Yes"}] },
      { id: "age65",    label: "Age 65–74",                    type: "select", options: [{value:0,label:"No"},{value:2,label:"Yes"}] },
      { id: "htn_dm",   label: "HTN, DM, or angina",          type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "sbp",      label: "SBP < 100 mmHg",              type: "select", options: [{value:0,label:"No"},{value:3,label:"Yes"}] },
      { id: "hr100",    label: "HR > 100 bpm",                type: "select", options: [{value:0,label:"No"},{value:2,label:"Yes"}] },
      { id: "killip",   label: "Killip class II–IV",          type: "select", options: [{value:0,label:"No"},{value:2,label:"Yes"}] },
      { id: "weight",   label: "Weight < 67 kg",              type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "anterior", label: "Anterior STE or LBBB",        type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "time",     label: "Time to treatment > 4 h",     type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "points" }),
    bands: [
      { max: 3, label: "Low mortality (≤3%)", color: "green" },
      { min: 3, max: 5, label: "Moderate risk (4–8%)", color: "amber" },
      { min: 5, label: "High risk (>8%)", color: "red" },
    ],
  },
  {
    id: "gcs", name: "Glasgow Coma Scale", category: "Neurology",
    description: "Consciousness assessment — Eye + Verbal + Motor",
    fields: [
      { id: "eye", label: "Eye Opening", type: "select", options: [
        {value:4,label:"4 — Spontaneous"},{value:3,label:"3 — To voice"},
        {value:2,label:"2 — To pain"},{value:1,label:"1 — None"},
      ]},
      { id: "verbal", label: "Verbal Response", type: "select", options: [
        {value:5,label:"5 — Oriented"},{value:4,label:"4 — Confused"},
        {value:3,label:"3 — Inappropriate words"},{value:2,label:"2 — Sounds"},{value:1,label:"1 — None"},
      ]},
      { id: "motor", label: "Motor Response", type: "select", options: [
        {value:6,label:"6 — Obeys commands"},{value:5,label:"5 — Localises pain"},
        {value:4,label:"4 — Withdraws"},{value:3,label:"3 — Abnormal flexion"},
        {value:2,label:"2 — Extension"},{value:1,label:"1 — None"},
      ]},
    ],
    compute: ({ eye, verbal, motor }) => ({ value: eye + verbal + motor, unit: "/ 15" }),
    bands: [
      { min: 13, label: "Mild (13–15)", color: "green" },
      { min: 9, max: 13, label: "Moderate (9–12)", color: "amber" },
      { max: 9, label: "Severe (≤8) — consider intubation", color: "red" },
    ],
  },
  {
    id: "nihss", name: "NIH Stroke Scale", category: "Neurology",
    description: "NIHSS neurologic deficit score for acute stroke severity",
    fields: [
      { id: "loc", label: "1a. Level of consciousness", type: "select", options: [
        {value:0,label:"0 — Alert"},{value:1,label:"1 — Not alert, arousable"},
        {value:2,label:"2 — Requires repeated stimulation"},{value:3,label:"3 — Coma / unresponsive"},
      ]},
      { id: "loc_questions", label: "1b. LOC questions", type: "select", options: [
        {value:0,label:"0 — Both correct"},{value:1,label:"1 — One correct"},{value:2,label:"2 — Neither correct"},
      ]},
      { id: "loc_commands", label: "1c. LOC commands", type: "select", options: [
        {value:0,label:"0 — Both correct"},{value:1,label:"1 — One correct"},{value:2,label:"2 — Neither correct"},
      ]},
      { id: "gaze", label: "2. Best gaze", type: "select", options: [
        {value:0,label:"0 — Normal"},{value:1,label:"1 — Partial gaze palsy"},{value:2,label:"2 — Forced deviation"},
      ]},
      { id: "visual", label: "3. Visual fields", type: "select", options: [
        {value:0,label:"0 — No visual loss"},{value:1,label:"1 — Partial hemianopia"},
        {value:2,label:"2 — Complete hemianopia"},{value:3,label:"3 — Bilateral hemianopia / blindness"},
      ]},
      { id: "facial", label: "4. Facial palsy", type: "select", options: [
        {value:0,label:"0 — Normal"},{value:1,label:"1 — Minor"},{value:2,label:"2 — Partial"},{value:3,label:"3 — Complete"},
      ]},
      { id: "arm_left", label: "5a. Motor arm — left", type: "select", options: [
        {value:0,label:"0 — No drift"},{value:1,label:"1 — Drift"},{value:2,label:"2 — Some effort against gravity"},
        {value:3,label:"3 — No effort against gravity"},{value:4,label:"4 — No movement"},
      ]},
      { id: "arm_right", label: "5b. Motor arm — right", type: "select", options: [
        {value:0,label:"0 — No drift"},{value:1,label:"1 — Drift"},{value:2,label:"2 — Some effort against gravity"},
        {value:3,label:"3 — No effort against gravity"},{value:4,label:"4 — No movement"},
      ]},
      { id: "leg_left", label: "6a. Motor leg — left", type: "select", options: [
        {value:0,label:"0 — No drift"},{value:1,label:"1 — Drift"},{value:2,label:"2 — Some effort against gravity"},
        {value:3,label:"3 — No effort against gravity"},{value:4,label:"4 — No movement"},
      ]},
      { id: "leg_right", label: "6b. Motor leg — right", type: "select", options: [
        {value:0,label:"0 — No drift"},{value:1,label:"1 — Drift"},{value:2,label:"2 — Some effort against gravity"},
        {value:3,label:"3 — No effort against gravity"},{value:4,label:"4 — No movement"},
      ]},
      { id: "ataxia", label: "7. Limb ataxia", type: "select", options: [
        {value:0,label:"0 — Absent"},{value:1,label:"1 — Present in one limb"},{value:2,label:"2 — Present in two limbs"},
      ]},
      { id: "sensory", label: "8. Sensory", type: "select", options: [
        {value:0,label:"0 — Normal"},{value:1,label:"1 — Mild-to-moderate loss"},{value:2,label:"2 — Severe-to-total loss"},
      ]},
      { id: "language", label: "9. Best language", type: "select", options: [
        {value:0,label:"0 — No aphasia"},{value:1,label:"1 — Mild-to-moderate aphasia"},
        {value:2,label:"2 — Severe aphasia"},{value:3,label:"3 — Mute/global aphasia"},
      ]},
      { id: "dysarthria", label: "10. Dysarthria", type: "select", options: [
        {value:0,label:"0 — Normal"},{value:1,label:"1 — Mild-to-moderate"},{value:2,label:"2 — Severe"},
      ]},
      { id: "extinction", label: "11. Extinction / inattention", type: "select", options: [
        {value:0,label:"0 — None"},{value:1,label:"1 — Visual/tactile/auditory/spatial/personal inattention"},
        {value:2,label:"2 — Profound hemi-inattention or extinction"},
      ]},
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "/ 42" }),
    bands: [
      { max: 1, label: "0 — no stroke symptoms", color: "green" },
      { min: 1, max: 5, label: "1–4 — minor stroke", color: "green" },
      { min: 5, max: 16, label: "5–15 — moderate stroke", color: "amber" },
      { min: 16, max: 21, label: "16–20 — moderate to severe stroke", color: "red" },
      { min: 21, label: "21–42 — severe stroke", color: "red" },
    ],
    reference: "NIH Stroke Scale",
  },
  {
    id: "wells_dvt", name: "Wells Score (DVT)", category: "Haematology / Vascular",
    description: "Pre-test probability for deep vein thrombosis",
    fields: [
      { id: "cancer",    label: "Active cancer",                             type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "paralysis", label: "Paralysis / paresis / recent cast",         type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "bedridden", label: "Bedridden >3d or surgery within 12 wk",    type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "tenderness",label: "Localised tenderness along deep veins",     type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "swelling",  label: "Entire leg swollen",                        type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "calf",      label: "Calf swelling >3 cm (symptomatic side)",   type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "pitting",   label: "Pitting oedema (symptomatic leg only)",     type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "collateral",label: "Non-varicose collateral superficial veins", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "alt_dx",    label: "Alternative diagnosis as likely or more",   type: "select", options: [{value:0,label:"No"},{value:-2,label:"Yes"}] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "points" }),
    bands: [
      { max: 1, label: "Low (~3%)", color: "green" },
      { min: 1, max: 3, label: "Moderate (~17%)", color: "amber" },
      { min: 3, label: "High (~75%)", color: "red" },
    ],
  },
  {
    id: "wells_pe", name: "Wells Score (PE)", category: "Pulmonology",
    description: "Pre-test probability for pulmonary embolism",
    fields: [
      { id: "dvt_sx",   label: "Clinical signs of DVT",                      type: "select", options: [{value:0,label:"No"},{value:3,label:"Yes"}] },
      { id: "alt_dx",   label: "PE more likely than alternative dx",         type: "select", options: [{value:0,label:"No"},{value:3,label:"Yes"}] },
      { id: "hr100",    label: "HR > 100 bpm",                               type: "select", options: [{value:0,label:"No"},{value:1.5,label:"Yes"}] },
      { id: "immob",    label: "Immobilisation ≥3d or surgery in 4 wk",     type: "select", options: [{value:0,label:"No"},{value:1.5,label:"Yes"}] },
      { id: "prev_dvt", label: "Previous DVT / PE",                         type: "select", options: [{value:0,label:"No"},{value:1.5,label:"Yes"}] },
      { id: "haemop",   label: "Haemoptysis",                                type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "cancer",   label: "Active malignancy",                         type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "points" }),
    bands: [
      { max: 2, label: "Low (~2%)", color: "green" },
      { min: 2, max: 6, label: "Moderate (~18%)", color: "amber" },
      { min: 6, label: "High (~65%)", color: "red" },
    ],
  },
  {
    id: "curb65", name: "CURB-65", category: "Pulmonology",
    description: "Severity scoring for community-acquired pneumonia",
    fields: [
      { id: "confusion", label: "Confusion (new)",       type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "bun",       label: "BUN > 19 mg/dL",        type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "rr",        label: "RR ≥ 30/min",           type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "bp",        label: "SBP < 90 or DBP ≤ 60",  type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "age65",     label: "Age ≥ 65",              type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "points" }),
    bands: [
      { max: 1, label: "Low — outpatient", color: "green" },
      { min: 1, max: 3, label: "Moderate — hospital", color: "amber" },
      { min: 3, label: "Severe — consider ICU", color: "red" },
    ],
  },
  {
    id: "child_pugh", name: "Child-Pugh Score", category: "Gastroenterology",
    description: "Liver disease severity and surgical risk",
    fields: [
      { id: "bilirubin",      label: "Bilirubin (mg/dL)", type: "select", options: [{value:1,label:"<2"},{value:2,label:"2–3"},{value:3,label:">3"}] },
      { id: "albumin",        label: "Albumin (g/dL)",    type: "select", options: [{value:1,label:">3.5"},{value:2,label:"2.8–3.5"},{value:3,label:"<2.8"}] },
      { id: "pt_inr",         label: "INR",               type: "select", options: [{value:1,label:"<1.7"},{value:2,label:"1.7–2.3"},{value:3,label:">2.3"}] },
      { id: "ascites",        label: "Ascites",           type: "select", options: [{value:1,label:"None"},{value:2,label:"Mild–moderate"},{value:3,label:"Severe"}] },
      { id: "encephalopathy", label: "Encephalopathy",    type: "select", options: [{value:1,label:"None"},{value:2,label:"Grade I–II"},{value:3,label:"Grade III–IV"}] },
    ],
    compute: (v) => {
      const s = Object.values(v).reduce((a,b)=>a+b,0);
      const cls = s <= 6 ? "A" : s <= 9 ? "B" : "C";
      return { value: s, unit: `pts (Class ${cls})` };
    },
    bands: [
      { max: 7,  label: "Class A (5–6) — well compensated, 100% 1-yr survival", color: "green" },
      { min: 7,  max: 10, label: "Class B (7–9) — significant dysfunction, 81%", color: "amber" },
      { min: 10, label: "Class C (10–15) — decompensated, 45%", color: "red" },
    ],
  },
  {
    id: "meld", name: "MELD Score", category: "Gastroenterology",
    description: "Model for End-Stage Liver Disease — transplant priority",
    fields: [
      { id: "creatinine", label: "Creatinine", type: "number", unit: "mg/dL", min: 0.1, max: 30, step: 0.01, required: true },
      { id: "bilirubin",  label: "Bilirubin",  type: "number", unit: "mg/dL", min: 0.1, max: 50, step: 0.01, required: true },
      { id: "inr",        label: "INR",         type: "number", unit: "",      min: 0.5, max: 20, step: 0.01, required: true },
      { id: "dialysis",   label: "On dialysis", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
    ],
    compute: ({ creatinine, bilirubin, inr, dialysis }) => {
      const cr  = dialysis ? 4.0 : Math.max(1, Math.min(creatinine, 4));
      const bil = Math.max(1, bilirubin);
      const meld = 3.78 * Math.log(bil) + 11.2 * Math.log(inr) + 9.57 * Math.log(cr) + 6.43;
      return { value: +Math.round(meld), unit: "points" };
    },
    bands: [
      { max: 10, label: "< 10 — ~2% 90-day mortality",   color: "green" },
      { min: 10, max: 20, label: "10–19 — ~6%",          color: "amber" },
      { min: 20, max: 30, label: "20–29 — ~20%",         color: "amber" },
      { min: 30, label: "≥ 30 — ~53% mortality",         color: "red" },
    ],
  },
  {
    id: "sofa", name: "SOFA Score", category: "Critical Care",
    description: "Sequential Organ Failure Assessment — ICU mortality predictor",
    fields: [
      { id: "pf",   label: "PaO₂/FiO₂ ratio",  type: "select", options: [{value:0,label:"0 — ≥400"},{value:1,label:"1 — 300–399"},{value:2,label:"2 — 200–299"},{value:3,label:"3 — 100–199 (MV)"},{value:4,label:"4 — <100 (MV)"}] },
      { id: "plt",  label: "Platelets ×10³/μL", type: "select", options: [{value:0,label:"0 — ≥150"},{value:1,label:"1 — 100–149"},{value:2,label:"2 — 50–99"},{value:3,label:"3 — 20–49"},{value:4,label:"4 — <20"}] },
      { id: "bil",  label: "Bilirubin mg/dL",   type: "select", options: [{value:0,label:"0 — <1.2"},{value:1,label:"1 — 1.2–1.9"},{value:2,label:"2 — 2.0–5.9"},{value:3,label:"3 — 6.0–11.9"},{value:4,label:"4 — ≥12"}] },
      { id: "cv",   label: "Cardiovascular",    type: "select", options: [{value:0,label:"0 — MAP≥70"},{value:1,label:"1 — MAP<70"},{value:2,label:"2 — Dopamine≤5 or dobutamine"},{value:3,label:"3 — Dopamine5–15"},{value:4,label:"4 — Dopamine>15"}] },
      { id: "gcs",  label: "GCS",               type: "select", options: [{value:0,label:"0 — 15"},{value:1,label:"1 — 13–14"},{value:2,label:"2 — 10–12"},{value:3,label:"3 — 6–9"},{value:4,label:"4 — <6"}] },
      { id: "cr",   label: "Creatinine mg/dL",  type: "select", options: [{value:0,label:"0 — <1.2"},{value:1,label:"1 — 1.2–1.9"},{value:2,label:"2 — 2.0–3.4"},{value:3,label:"3 — 3.5–4.9"},{value:4,label:"4 — >5.0"}] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "points" }),
    bands: [
      { max: 7,  label: "< 7 — mortality < 10%",  color: "green" },
      { min: 7,  max: 11, label: "7–10 — 15–20%", color: "amber" },
      { min: 11, label: "≥ 11 — >40%",             color: "red" },
    ],
  },
  {
    id: "apache2", name: "APACHE II Score", category: "Critical Care",
    description: "Critical illness severity score using acute physiology, age, and chronic health points",
    fields: [
      { id: "organ_insufficiency", label: "Severe organ failure or immunocompromise", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "surgery", label: "Type of surgery", type: "select", options: [{value:0,label:"Emergency"},{value:1,label:"Elective"},{value:2,label:"Nonoperative"}] },
      { id: "age", label: "Age", type: "number", unit: "years", min: 0, max: 130, required: true },
      { id: "temperature", label: "Temperature", type: "number", unit: "°C", min: 20, max: 45, step: 0.1, required: true },
      { id: "map", label: "Mean arterial pressure", type: "number", unit: "mmHg", min: 0, max: 300, required: true },
      { id: "ph", label: "Arterial pH", type: "number", min: 6.5, max: 8, step: 0.01, required: true },
      { id: "heart_rate", label: "Heart rate", type: "number", unit: "bpm", min: 0, max: 300, required: true },
      { id: "respiratory_rate", label: "Respiratory rate", type: "number", unit: "/min", min: 0, max: 100, required: true },
      { id: "sodium", label: "Sodium", type: "number", unit: "mEq/L", min: 80, max: 220, required: true },
      { id: "potassium", label: "Potassium", type: "number", unit: "mEq/L", min: 0, max: 12, step: 0.1, required: true },
      { id: "creatinine", label: "Creatinine", type: "number", unit: "mg/dL", min: 0, max: 20, step: 0.01, required: true },
      { id: "acute_renal_failure", label: "Acute renal failure", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "hematocrit", label: "Hematocrit", type: "number", unit: "%", min: 0, max: 80, step: 0.1, required: true },
      { id: "wbc", label: "White blood cell count", type: "number", unit: "10^3/uL", min: 0, max: 100, step: 0.1, required: true },
      { id: "gcs", label: "Glasgow Coma Scale", type: "number", min: 3, max: 15, step: 1, required: true },
      { id: "fio2", label: "FiO2", type: "select", options: [{value:0,label:"<50% or non-intubated"},{value:1,label:">=50%"}] },
      { id: "pao2", label: "PaO2 if FiO2 <50%", type: "select", options: [{value:0,label:">70"},{value:1,label:"61-70"},{value:3,label:"55-60"},{value:4,label:"<55"}] },
      { id: "aa_grad", label: "A-a gradient if FiO2 >=50%", type: "select", options: [{value:0,label:"<200"},{value:2,label:"200-349"},{value:3,label:"350-499"},{value:4,label:">499"}] },
    ],
    compute: ({ organ_insufficiency, surgery, age, temperature, map, ph, heart_rate, respiratory_rate, sodium, potassium, creatinine, acute_renal_failure, hematocrit, wbc, gcs, fio2, pao2, aa_grad }) => {
      const tempPts = temperature >= 41 ? 4 : temperature >= 39 ? 3 : temperature >= 38.5 ? 1 : temperature >= 36 ? 0 : temperature >= 34 ? 1 : temperature >= 32 ? 2 : temperature >= 30 ? 3 : 4;
      const mapPts = map >= 160 ? 4 : map >= 130 ? 3 : map >= 110 ? 2 : map >= 70 ? 0 : map >= 50 ? 2 : 4;
      const phPts = ph >= 7.7 ? 4 : ph >= 7.6 ? 3 : ph >= 7.5 ? 1 : ph >= 7.33 ? 0 : ph >= 7.25 ? 2 : ph >= 7.15 ? 3 : 4;
      const hrPts = heart_rate >= 180 ? 4 : heart_rate >= 140 ? 3 : heart_rate >= 110 ? 2 : heart_rate >= 70 ? 0 : heart_rate >= 55 ? 2 : heart_rate >= 40 ? 3 : 4;
      const rrPts = respiratory_rate >= 50 ? 4 : respiratory_rate >= 35 ? 3 : respiratory_rate >= 25 ? 1 : respiratory_rate >= 12 ? 0 : respiratory_rate >= 10 ? 1 : respiratory_rate >= 6 ? 2 : 4;
      const naPts = sodium >= 180 ? 4 : sodium >= 160 ? 3 : sodium >= 155 ? 2 : sodium >= 150 ? 1 : sodium >= 130 ? 0 : sodium >= 120 ? 2 : sodium >= 111 ? 3 : 4;
      const kPts = potassium >= 7 ? 4 : potassium >= 6 ? 3 : potassium >= 5.5 ? 1 : potassium >= 3.5 ? 0 : potassium >= 3 ? 1 : potassium >= 2.5 ? 2 : 4;
      let crPts = creatinine >= 3.5 ? 4 : creatinine >= 2 ? 3 : creatinine >= 1.5 ? 2 : creatinine >= 0.6 ? 0 : 2;
      if (acute_renal_failure && creatinine >= 1.5) crPts *= 2;
      const hctPts = hematocrit >= 60 ? 4 : hematocrit >= 50 ? 2 : hematocrit >= 46 ? 1 : hematocrit >= 30 ? 0 : hematocrit >= 20 ? 2 : 4;
      const wbcPts = wbc >= 40 ? 4 : wbc >= 20 ? 2 : wbc >= 15 ? 1 : wbc >= 3 ? 0 : wbc >= 1 ? 2 : 4;
      const agePts = age >= 75 ? 6 : age >= 65 ? 5 : age >= 55 ? 3 : age >= 45 ? 2 : 0;
      const chronicPts = organ_insufficiency ? (surgery === 1 ? 2 : 5) : 0;
      const oxygenPts = fio2 === 0 ? pao2 : aa_grad;
      const value = tempPts + mapPts + phPts + hrPts + rrPts + naPts + kPts + crPts + hctPts + wbcPts + Math.max(0, 15 - gcs) + agePts + chronicPts + oxygenPts;
      return { value, unit: "points", label: `Physiology ${value - agePts - chronicPts}; age ${agePts}; chronic health ${chronicPts}.` };
    },
    bands: [
      { max: 10, label: "Lower acute illness severity", color: "green" },
      { min: 10, max: 20, label: "Moderate acute illness severity", color: "amber" },
      { min: 20, label: "High acute illness severity / mortality risk", color: "red" },
    ],
  },
  {
    id: "apgar", name: "APGAR Score", category: "Obstetrics / Neonatology",
    description: "Neonatal wellbeing at 1 and 5 minutes",
    fields: [
      { id: "activity",    label: "Activity (Tone)",   type: "select", options: [{value:0,label:"0 — Absent"},{value:1,label:"1 — Some flexion"},{value:2,label:"2 — Active"}] },
      { id: "pulse",       label: "Pulse",             type: "select", options: [{value:0,label:"0 — Absent"},{value:1,label:"1 — <100"},{value:2,label:"2 — ≥100"}] },
      { id: "grimace",     label: "Grimace (Reflex)",  type: "select", options: [{value:0,label:"0 — None"},{value:1,label:"1 — Grimace"},{value:2,label:"2 — Cry"}] },
      { id: "appearance",  label: "Colour",            type: "select", options: [{value:0,label:"0 — Blue/pale"},{value:1,label:"1 — Blue extremities"},{value:2,label:"2 — Pink"}] },
      { id: "respiration", label: "Respiration",       type: "select", options: [{value:0,label:"0 — Absent"},{value:1,label:"1 — Weak/irregular"},{value:2,label:"2 — Strong cry"}] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "/ 10" }),
    bands: [
      { min: 7,  label: "Normal (7–10)", color: "green" },
      { min: 4,  max: 7,  label: "Moderate concern (4–6) — stimulate, O₂", color: "amber" },
      { max: 4,  label: "Severely depressed (0–3) — resuscitation", color: "red" },
    ],
  },
  {
    id: "glasgow_blatchford", name: "Glasgow-Blatchford Score", category: "Gastroenterology",
    description: "Upper GI bleed risk — need for intervention",
    fields: [
      { id: "bun",     label: "BUN (mg/dL)",       type: "select", options: [{value:0,label:"<18.2"},{value:2,label:"18.2–22.3"},{value:3,label:"22.4–27.9"},{value:4,label:"28–70"},{value:6,label:"≥70"}] },
      { id: "sex",     label: "Sex",               type: "select", options: [{value:0,label:"Female"},{value:1,label:"Male"}] },
      { id: "hgb",     label: "Hemoglobin",        type: "number", unit: "g/dL", min: 1, max: 25, step: 0.1, required: true, hint: "Sex-specific scoring is applied." },
      { id: "sbp",     label: "SBP (mmHg)",         type: "select", options: [{value:0,label:"≥110"},{value:1,label:"100–109"},{value:2,label:"90–99"},{value:3,label:"<90"}] },
      { id: "pulse",   label: "Pulse ≥ 100 bpm",   type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "melaena", label: "Melaena",            type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "syncope", label: "Syncope",            type: "select", options: [{value:0,label:"No"},{value:2,label:"Yes"}] },
      { id: "liver",   label: "Liver disease",      type: "select", options: [{value:0,label:"No"},{value:2,label:"Yes"}] },
      { id: "chf",     label: "Heart failure",      type: "select", options: [{value:0,label:"No"},{value:2,label:"Yes"}] },
    ],
    compute: ({ bun, sex, hgb, sbp, pulse, melaena, syncope, liver, chf }) => {
      const hgbPoints = sex === 1
        ? hgb < 10 ? 6 : hgb < 12 ? 3 : hgb < 13 ? 1 : 0
        : hgb < 10 ? 6 : hgb < 12 ? 1 : 0;
      return { value: bun + hgbPoints + sbp + pulse + melaena + syncope + liver + chf, unit: "points", label: `Hemoglobin contributes ${hgbPoints} point${hgbPoints === 1 ? "" : "s"}.` };
    },
    bands: [
      { max: 2,  label: "Score 0-1 — very low risk; outpatient management may be considered", color: "green" },
      { min: 2,  max: 6, label: "2-5 — increased risk; monitor and plan endoscopy based on context", color: "amber" },
      { min: 6,  label: "High — urgent endoscopy",                color: "red" },
    ],
  },
  {
    id: "news2", name: "NEWS2 Score", category: "Critical Care",
    description: "National Early Warning Score 2 — clinical deterioration",
    fields: [
      { id: "rr",    label: "Resp rate (/min)",  type: "select", options: [{value:3,label:"≤8"},{value:1,label:"9–11"},{value:0,label:"12–20"},{value:2,label:"21–24"},{value:3,label:"≥25"}] },
      { id: "failure", label: "Hypercapnic respiratory failure", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "spo2",  label: "SpO2 scale 1",          type: "select", options: [{value:3,label:"≤91"},{value:2,label:"92–93"},{value:1,label:"94–95"},{value:0,label:"≥96"}] },
      { id: "spo2_scale2", label: "SpO2 scale 2", type: "select", options: [{value:3,label:"≤83"},{value:2,label:"84–85"},{value:1,label:"86–87"},{value:0,label:"88–92 or ≥93 on room air"},{value:1,label:"93–94 on O2"},{value:2,label:"95–96 on O2"},{value:3,label:"≥97 on O2"}] },
      { id: "oxygen", label: "Room air or supplemental O2", type: "select", options: [{value:0,label:"Room air"},{value:2,label:"Supplemental O2"}] },
      { id: "sbp",   label: "SBP (mmHg)",         type: "select", options: [{value:3,label:"≤90"},{value:2,label:"91–100"},{value:1,label:"101–110"},{value:0,label:"111–219"},{value:3,label:"≥220"}] },
      { id: "pulse", label: "Pulse (bpm)",         type: "select", options: [{value:3,label:"≤40"},{value:1,label:"41–50"},{value:0,label:"51–90"},{value:1,label:"91–110"},{value:2,label:"111–130"},{value:3,label:"≥131"}] },
      { id: "temp",  label: "Temp (°C)",           type: "select", options: [{value:3,label:"≤35.0"},{value:1,label:"35.1–36.0"},{value:0,label:"36.1–38.0"},{value:1,label:"38.1–39.0"},{value:2,label:"≥39.1"}] },
      { id: "acvpu", label: "ACVPU (consciousness)", type: "select", options: [{value:0,label:"Alert"},{value:3,label:"Confusion / V / P / U"}] },
    ],
    compute: ({ rr, failure, spo2, spo2_scale2, oxygen, sbp, pulse, temp, acvpu }) => {
      const value = rr + (failure ? spo2_scale2 : spo2) + oxygen + sbp + pulse + temp + acvpu;
      return { value, unit: "points", label: failure ? "Using NEWS2 SpO2 scale 2 for hypercapnic respiratory failure." : "Using NEWS2 SpO2 scale 1." };
    },
    bands: [
      { max: 1,  label: "Low — 4–6h observations",      color: "green" },
      { min: 1,  max: 5, label: "Low–medium — 1h obs",  color: "amber" },
      { min: 5,  max: 7, label: "Medium — urgent review", color: "amber" },
      { min: 7,  label: "High — emergency team",         color: "red" },
    ],
  },
  {
    id: "framingham", name: "Framingham Risk Score", category: "Cardiology",
    description: "10-year hard coronary heart disease risk using Framingham coefficients",
    fields: [
      { id: "age",    label: "Age",             type: "number", unit: "years", min: 30, max: 79, required: true },
      { id: "sex",    label: "Sex",             type: "select", options: [{value:0,label:"Female"},{value:1,label:"Male"}] },
      { id: "tc",     label: "Total Cholesterol", type: "number", unit: "mg/dL", min: 100, max: 400, required: true },
      { id: "hdl",    label: "HDL Cholesterol",   type: "number", unit: "mg/dL", min: 20,  max: 150, required: true },
      { id: "sbp",    label: "Systolic BP",        type: "number", unit: "mmHg", min: 90,  max: 200, required: true },
      { id: "smoker", label: "Current smoker",    type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "tx_bp",  label: "On BP treatment",   type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
    ],
    compute: ({ age, sex, tc, hdl, sbp, smoker, tx_bp }) => {
      if (age < 30 || age > 79) return { value: "N/A", unit: "", label: "Framingham hard CHD equation is for ages 30-79." };
      const lnAge = Math.log(age);
      const lnTc = Math.log(tc);
      const lnHdl = Math.log(hdl);
      const lnSbp = Math.log(sbp);
      const smokerAge = smoker ? Math.log(Math.min(age, sex === 1 ? 70 : 78)) : 0;
      const isMale = sex === 1;
      const sum = isMale
        ? 52.00961 * lnAge + 20.014077 * lnTc - 0.905964 * lnHdl + 1.305784 * lnSbp + 0.241549 * tx_bp + 12.096316 * smoker - 4.605038 * lnAge * lnTc - 2.84367 * smokerAge - 2.93323 * lnAge * lnAge - 172.300168
        : 31.764001 * lnAge + 22.465206 * lnTc - 1.187731 * lnHdl + 2.552905 * lnSbp + 0.420251 * tx_bp + 13.07543 * smoker - 5.060998 * lnAge * lnTc - 2.996945 * smokerAge - 146.5933061;
      const baseline = isMale ? 0.9402 : 0.98767;
      const risk = (1 - Math.pow(baseline, Math.exp(sum))) * 100;
      return { value: +risk.toFixed(1), unit: "% (10-yr hard CHD risk)" };
    },
    bands: [
      { max: 10, label: "Low risk (< 10%)",     color: "green" },
      { min: 10, max: 20, label: "Intermediate (10–20%)", color: "amber" },
      { min: 20, label: "High risk (> 20%)",    color: "red" },
    ],
  },
  {
    id: "acetaminophen_toxicity", name: "Acetaminophen Toxicity Assessment", category: "Toxicology",
    description: "Screens acetaminophen exposure by dose and timed concentration against treatment thresholds",
    fields: [
      { id: "dose", label: "Estimated ingestion dose", type: "number", unit: "mg/kg", min: 0, max: 1000, required: true },
      { id: "hours", label: "Hours since ingestion", type: "number", unit: "hours", min: 0, max: 72, step: 0.1, required: true },
      { id: "level", label: "Acetaminophen concentration", type: "number", unit: "mcg/mL", min: 0, max: 1000, step: 1, required: true },
    ],
    compute: ({ dose, hours, level }) => {
      const threshold = hours >= 4 ? 150 * Math.pow(0.5, (hours - 4) / 4) : 150;
      const highDose = dose >= 150;
      const aboveLine = hours >= 4 && level >= threshold;
      return { value: aboveLine || highDose ? "Treat / toxic risk" : "Below treatment line", unit: "", label: `Nomogram threshold at ${hours} h: ${threshold.toFixed(0)} mcg/mL` };
    },
  },
  {
    id: "als_adult", name: "Advanced Life Support: Adult", category: "Critical Care / Emergency",
    description: "Weight-based adult resuscitation medication support",
    fields: [
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 20, max: 300, required: true },
      { id: "scenario", label: "Scenario", type: "select", options: [
        {value:0,label:"Cardiac arrest"},
        {value:1,label:"Bradycardia"},
        {value:2,label:"Narrow-complex tachycardia"},
        {value:3,label:"Anaphylaxis IM epinephrine"},
      ] },
    ],
    compute: ({ weight, scenario }) => {
      const lines = [
        "Epinephrine 1 mg IV/IO every 3-5 min",
        "Atropine 1 mg IV every 3-5 min, max 3 mg; consider pacing/pressor infusion",
        "Adenosine 6 mg rapid IV, then 12 mg if needed",
        `Epinephrine IM 0.3-0.5 mg adult dose; weight entered ${weight} kg`,
      ];
      return { value: lines[scenario] || lines[0], unit: "", label: "Verify against local ACLS protocol and patient context." };
    },
  },
  {
    id: "fracture_index_no_bmd", name: "Fracture Index without known BMD", category: "Orthopedics / Bone",
    description: "Estimates osteoporotic fracture risk when bone mineral density is unavailable",
    fields: [
      { id: "age", label: "Age", type: "select", options: [{value:0,label:"<65"},{value:1,label:"65-69"},{value:2,label:"70-74"},{value:3,label:"75-79"},{value:4,label:">=80"}] },
      { id: "prior", label: "Prior fracture after age 50", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "mother", label: "Maternal hip fracture", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "weight", label: "Weight <57 kg", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "smoker", label: "Current smoker", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
      { id: "arms", label: "Needs arms to rise from chair", type: "select", options: [{value:0,label:"No"},{value:1,label:"Yes"}] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a,b)=>a+b,0), unit: "points" }),
    bands: [
      { max: 2, label: "Lower fracture risk", color: "green" },
      { min: 2, max: 4, label: "Intermediate fracture risk", color: "amber" },
      { min: 4, label: "Higher fracture risk", color: "red" },
    ],
  },
  {
    id: "meld_na", name: "MELD-Na Score", category: "Gastroenterology",
    description: "Model for End-Stage Liver Disease with sodium correction for cirrhosis prognosis",
    fields: [
      { id: "creatinine", label: "Creatinine", type: "number", unit: "mg/dL", min: 0.1, max: 30, step: 0.01, required: true },
      { id: "bilirubin", label: "Bilirubin", type: "number", unit: "mg/dL", min: 0.1, max: 50, step: 0.01, required: true },
      { id: "inr", label: "INR", type: "number", min: 0.5, max: 20, step: 0.01, required: true },
      { id: "sodium", label: "Sodium", type: "number", unit: "mEq/L", min: 100, max: 180, step: 1, required: true },
      { id: "dialysis", label: "On dialysis", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: ({ creatinine, bilirubin, inr, sodium, dialysis }) => {
      const cr = dialysis ? 4 : Math.max(1, Math.min(creatinine, 4));
      const bil = Math.max(1, bilirubin);
      const meld = 3.78 * Math.log(bil) + 11.2 * Math.log(Math.max(1, inr)) + 9.57 * Math.log(cr) + 6.43;
      const na = Math.max(125, Math.min(140, sodium));
      const meldNa = Math.max(6, Math.min(40, meld - na - 0.025 * meld * (140 - na) + 140));
      return { value: Math.round(meldNa), unit: "points", label: `MELD component ${Math.round(meld)}; sodium capped to ${na} mEq/L` };
    },
    bands: [
      { max: 10, label: "<10 — lower short-term mortality", color: "green" },
      { min: 10, max: 20, label: "10-19 — moderate risk", color: "amber" },
      { min: 20, max: 30, label: "20-29 — high risk", color: "red" },
      { min: 30, label: ">=30 — very high risk", color: "red" },
    ],
  },
  {
    id: "has_bled", name: "HAS-BLED", category: "Cardiology",
    description: "Major bleeding risk screen for anticoagulated atrial fibrillation patients",
    fields: [
      { id: "htn", label: "Uncontrolled hypertension", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "renal", label: "Abnormal renal function", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "liver", label: "Abnormal liver function", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "stroke", label: "Prior stroke", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "bleeding", label: "Bleeding history or predisposition", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "inr", label: "Labile INR", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "elderly", label: "Age >65", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "drugs", label: "Drugs predisposing to bleeding", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "alcohol", label: "Alcohol use", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    bands: [
      { max: 3, label: "0-2 — lower bleeding risk", color: "green" },
      { min: 3, label: ">=3 — high bleeding risk; review modifiable factors", color: "red" },
    ],
  },
  {
    id: "chads2", name: "CHADS2 Score", category: "Cardiology",
    description: "Stroke risk score for atrial fibrillation",
    fields: [
      { id: "chf", label: "Congestive heart failure", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "htn", label: "Hypertension", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "age", label: "Age >=75", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "dm", label: "Diabetes mellitus", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "stroke", label: "Prior stroke or TIA", type: "select", options: [{ value: 0, label: "No" }, { value: 2, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    bands: [
      { max: 1, label: "0 — low annual stroke risk", color: "green" },
      { min: 1, max: 2, label: "1 — intermediate risk", color: "amber" },
      { min: 2, label: ">=2 — higher risk", color: "red" },
    ],
  },
  {
    id: "steroid_conversion", name: "Steroid Conversion", category: "Drug Dosing",
    description: "Converts common systemic corticosteroids to prednisone-equivalent dose",
    fields: [
      { id: "dose", label: "Current steroid dose", type: "number", unit: "mg", min: 0, max: 10000, step: 0.1, required: true },
      { id: "equivalent", label: "Steroid", type: "select", options: [
        { value: 20, label: "Hydrocortisone" },
        { value: 25, label: "Cortisone" },
        { value: 5, label: "Prednisone / prednisolone" },
        { value: 4, label: "Methylprednisolone / triamcinolone" },
        { value: 0.75, label: "Dexamethasone" },
        { value: 0.6, label: "Betamethasone" },
      ] },
    ],
    compute: ({ dose, equivalent }) => ({ value: +(dose * (5 / equivalent)).toFixed(2), unit: "mg prednisone equivalent" }),
  },
  {
    id: "opioid_mme", name: "Morphine Milligram Equivalents", category: "Drug Dosing",
    description: "Estimates total daily opioid dose in oral morphine milligram equivalents",
    fields: [
      { id: "dailyDose", label: "Total daily dose", type: "number", unit: "mg/day or mcg/hr patch", min: 0, max: 10000, step: 0.1, required: true },
      { id: "factor", label: "Opioid", type: "select", options: [
        { value: 1, label: "Morphine PO / hydrocodone PO" },
        { value: 1.5, label: "Oxycodone PO" },
        { value: 4, label: "Hydromorphone PO" },
        { value: 3, label: "Oxymorphone PO" },
        { value: 0.15, label: "Codeine PO" },
        { value: 0.1, label: "Tramadol PO" },
        { value: 0.4, label: "Tapentadol PO" },
        { value: 2.4, label: "Fentanyl transdermal mcg/hr" },
      ] },
    ],
    compute: ({ dailyDose, factor }) => ({ value: +(dailyDose * factor).toFixed(1), unit: "MME/day", label: "Use as a safety screen; conversion tables vary by opioid and route." }),
  },
  {
    id: "calvert_carboplatin", name: "Carboplatin Dose (Calvert)", category: "Oncology",
    description: "Carboplatin dose from target AUC and GFR/CrCl",
    fields: [
      { id: "auc", label: "Target AUC", type: "number", unit: "mg/mL/min", min: 1, max: 10, step: 0.1, required: true },
      { id: "gfr", label: "GFR or CrCl", type: "number", unit: "mL/min", min: 0, max: 200, step: 1, required: true },
    ],
    compute: ({ auc, gfr }) => ({ value: Math.round(auc * (gfr + 25)), unit: "mg", label: "Dose = target AUC x (GFR + 25)." }),
  },
  {
    id: "maintenance_fluids", name: "Maintenance Fluids", category: "Drug Dosing",
    description: "4-2-1 hourly maintenance fluid estimate",
    fields: [
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 0.5, max: 300, step: 0.1, required: true },
    ],
    compute: ({ weight }) => {
      const hourly = weight <= 10 ? 4 * weight : weight <= 20 ? 40 + 2 * (weight - 10) : 60 + weight - 20;
      return { value: Math.round(hourly), unit: "mL/hr", label: `${Math.round(hourly * 24)} mL/day by 4-2-1 rule` };
    },
  },
  {
    id: "corrected_calcium", name: "Corrected Calcium", category: "Endocrine / Metabolic",
    description: "Albumin-corrected serum calcium",
    fields: [
      { id: "calcium", label: "Measured calcium", type: "number", unit: "mg/dL", min: 0, max: 30, step: 0.01, required: true },
      { id: "albumin", label: "Albumin", type: "number", unit: "g/dL", min: 0, max: 8, step: 0.1, required: true },
    ],
    compute: ({ calcium, albumin }) => ({ value: +(calcium + 0.8 * (4 - albumin)).toFixed(2), unit: "mg/dL" }),
  },
  {
    id: "corrected_sodium", name: "Corrected Sodium", category: "Endocrine / Metabolic",
    description: "Sodium correction for hyperglycemia",
    fields: [
      { id: "sodium", label: "Measured sodium", type: "number", unit: "mEq/L", min: 90, max: 180, required: true },
      { id: "glucose", label: "Glucose", type: "number", unit: "mg/dL", min: 0, max: 2000, required: true },
      { id: "factor", label: "Correction per 100 mg/dL glucose above 100", type: "select", options: [{ value: 1.6, label: "1.6 mEq/L" }, { value: 2.4, label: "2.4 mEq/L" }] },
    ],
    compute: ({ sodium, glucose, factor }) => ({ value: +(sodium + factor * (Math.max(0, glucose - 100) / 100)).toFixed(1), unit: "mEq/L" }),
  },
  {
    id: "serum_osmolality", name: "Serum Osmolality", category: "Endocrine / Metabolic",
    description: "Calculated serum osmolality with optional osmolar gap",
    fields: [
      { id: "sodium", label: "Sodium", type: "number", unit: "mEq/L", min: 90, max: 180, required: true },
      { id: "glucose", label: "Glucose", type: "number", unit: "mg/dL", min: 0, max: 2000, required: true },
      { id: "bun", label: "BUN", type: "number", unit: "mg/dL", min: 0, max: 300, required: true },
      { id: "ethanol", label: "Ethanol", type: "number", unit: "mg/dL", min: 0, max: 1000, default: 0 },
      { id: "measured", label: "Measured osmolality", type: "number", unit: "mOsm/kg", min: 0, max: 500, default: 0 },
    ],
    compute: ({ sodium, glucose, bun, ethanol = 0, measured = 0 }) => {
      const calculated = 2 * sodium + glucose / 18 + bun / 2.8 + ethanol / 3.7;
      return measured ? { value: +(measured - calculated).toFixed(1), unit: "mOsm/kg gap", label: `Calculated osmolality ${calculated.toFixed(1)} mOsm/kg` } : { value: +calculated.toFixed(1), unit: "mOsm/kg" };
    },
  },
  {
    id: "fena", name: "Fractional Excretion of Sodium", category: "Renal",
    description: "FENa from urine/plasma sodium and creatinine",
    fields: [
      { id: "una", label: "Urine sodium", type: "number", unit: "mEq/L", min: 0, max: 300, required: true },
      { id: "pna", label: "Plasma sodium", type: "number", unit: "mEq/L", min: 90, max: 180, required: true },
      { id: "ucr", label: "Urine creatinine", type: "number", min: 0.1, max: 10000, step: 0.1, required: true },
      { id: "pcr", label: "Plasma creatinine", type: "number", min: 0.1, max: 30, step: 0.01, required: true },
    ],
    compute: ({ una, pna, ucr, pcr }) => ({ value: +(((una * pcr) / (pna * ucr)) * 100).toFixed(2), unit: "%" }),
    bands: [
      { max: 1, label: "<1% — often prerenal physiology", color: "green" },
      { min: 1, max: 2, label: "1-2% — indeterminate", color: "amber" },
      { min: 2, label: ">2% — often intrinsic renal injury", color: "red" },
    ],
  },
  {
    id: "mdrd", name: "MDRD GFR", category: "Renal",
    description: "IDMS-traceable MDRD estimated GFR",
    fields: [
      { id: "creatinine", label: "Serum creatinine", type: "number", unit: "mg/dL", min: 0.1, max: 30, step: 0.01, required: true },
      { id: "age", label: "Age", type: "number", unit: "years", min: 18, max: 120, required: true },
      { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      { id: "black", label: "Black race coefficient", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: ({ creatinine, age, sex, black }) => ({ value: Math.round(175 * Math.pow(creatinine, -1.154) * Math.pow(age, -0.203) * (sex === 0 ? 0.742 : 1) * (black ? 1.212 : 1)), unit: "mL/min/1.73m²" }),
  },
  {
    id: "schwartz", name: "Schwartz GFR", category: "Renal",
    description: "Pediatric bedside Schwartz estimated GFR",
    fields: [
      { id: "height", label: "Height", type: "number", unit: "cm", min: 20, max: 250, step: 0.1, required: true },
      { id: "creatinine", label: "Serum creatinine", type: "number", unit: "mg/dL", min: 0.1, max: 20, step: 0.01, required: true },
      { id: "k", label: "Schwartz constant", type: "select", options: [{ value: 0.413, label: "0.413 bedside Schwartz" }, { value: 0.55, label: "0.55 child/adolescent female" }, { value: 0.7, label: "0.70 adolescent male" }] },
    ],
    compute: ({ height, creatinine, k }) => ({ value: Math.round((k * height) / creatinine), unit: "mL/min/1.73m²" }),
  },
  {
    id: "mean_arterial_pressure", name: "Mean Arterial Pressure", category: "Cardiology",
    description: "MAP from systolic and diastolic blood pressure",
    fields: [
      { id: "sbp", label: "Systolic BP", type: "number", unit: "mmHg", min: 40, max: 300, required: true },
      { id: "dbp", label: "Diastolic BP", type: "number", unit: "mmHg", min: 20, max: 200, required: true },
    ],
    compute: ({ sbp, dbp }) => ({ value: Math.round((sbp + 2 * dbp) / 3), unit: "mmHg" }),
    bands: [
      { max: 65, label: "<65 mmHg — low perfusion pressure", color: "red" },
      { min: 65, max: 105, label: "Typical target range", color: "green" },
      { min: 105, label: "Elevated MAP", color: "amber" },
    ],
  },
  {
    id: "shock_index", name: "Shock Index", category: "Critical Care / Emergency",
    description: "Heart rate divided by systolic blood pressure",
    fields: [
      { id: "hr", label: "Heart rate", type: "number", unit: "bpm", min: 20, max: 300, required: true },
      { id: "sbp", label: "Systolic BP", type: "number", unit: "mmHg", min: 40, max: 300, required: true },
    ],
    compute: ({ hr, sbp }) => ({ value: +(hr / sbp).toFixed(2), unit: "" }),
    bands: [
      { max: 0.7, label: "Lower shock index", color: "green" },
      { min: 0.7, max: 0.9, label: "Borderline", color: "amber" },
      { min: 0.9, label: "Elevated — consider shock physiology", color: "red" },
    ],
  },
  {
    id: "parkland", name: "Parkland Formula", category: "Critical Care / Emergency",
    description: "Initial burn resuscitation crystalloid estimate",
    fields: [
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 1, max: 300, step: 0.1, required: true },
      { id: "tbsa", label: "Burn size", type: "number", unit: "% TBSA", min: 0, max: 100, step: 0.1, required: true },
    ],
    compute: ({ weight, tbsa }) => {
      const total = 4 * weight * tbsa;
      return { value: Math.round(total), unit: "mL in first 24 h", label: `${Math.round(total / 2)} mL first 8 h, ${Math.round(total / 2)} mL next 16 h` };
    },
  },
  {
    id: "bicarbonate_deficit", name: "Bicarbonate Deficit", category: "Acid-Base",
    description: "Estimated bicarbonate replacement deficit",
    fields: [
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 1, max: 300, step: 0.1, required: true },
      { id: "current", label: "Current bicarbonate", type: "number", unit: "mEq/L", min: 0, max: 60, step: 0.1, required: true },
      { id: "target", label: "Target bicarbonate", type: "number", unit: "mEq/L", min: 0, max: 60, step: 0.1, default: 24 },
      { id: "volume", label: "Distribution volume", type: "select", options: [{ value: 0.5, label: "0.5 x weight" }, { value: 0.4, label: "0.4 x weight" }, { value: 0.6, label: "0.6 x weight" }] },
    ],
    compute: ({ weight, current, target = 24, volume }) => ({ value: Math.max(0, Math.round(volume * weight * (target - current))), unit: "mEq", label: "Estimate only; reassess with serial blood gases/chemistry." }),
  },
  {
    id: "heart_score", name: "HEART Score", category: "Cardiology",
    description: "Major adverse cardiac event risk score for emergency chest pain evaluation",
    fields: [
      { id: "history", label: "History", type: "select", options: [{ value: 0, label: "Slightly suspicious" }, { value: 1, label: "Moderately suspicious" }, { value: 2, label: "Highly suspicious" }] },
      { id: "ecg", label: "ECG", type: "select", options: [{ value: 0, label: "Normal" }, { value: 1, label: "Nonspecific repolarization disturbance" }, { value: 2, label: "Significant ST depression" }] },
      { id: "age", label: "Age", type: "select", options: [{ value: 0, label: "<45" }, { value: 1, label: "45-64" }, { value: 2, label: ">=65" }] },
      { id: "risk", label: "Risk factors", type: "select", options: [{ value: 0, label: "No known risk factors" }, { value: 1, label: "1-2 risk factors" }, { value: 2, label: ">=3 risk factors or atherosclerotic disease" }] },
      { id: "troponin", label: "Troponin", type: "select", options: [{ value: 0, label: "Normal" }, { value: 1, label: "1-3x normal limit" }, { value: 2, label: ">3x normal limit" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    bands: [
      { max: 4, label: "0-3 — low risk", color: "green" },
      { min: 4, max: 7, label: "4-6 — moderate risk", color: "amber" },
      { min: 7, label: "7-10 — high risk", color: "red" },
    ],
  },
  {
    id: "perc", name: "PERC Rule", category: "Pulmonology",
    description: "Pulmonary Embolism Rule-out Criteria for very low-risk patients",
    fields: [
      { id: "age50", label: "Age >=50", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "hr100", label: "Heart rate >=100", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "spo2", label: "O2 saturation <95%", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "leg", label: "Unilateral leg swelling", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "hemoptysis", label: "Hemoptysis", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "surgery", label: "Recent surgery or trauma", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "prior", label: "Prior PE or DVT", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "hormone", label: "Hormone use", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: (v) => {
      const count = Object.values(v).reduce((a, b) => a + b, 0);
      return { value: count === 0 ? "PERC negative" : "PERC positive", unit: "", label: `${count} criteria present` };
    },
  },
  {
    id: "geneva_pe", name: "Revised Geneva Score", category: "Pulmonology",
    description: "Objective pulmonary embolism pretest probability score",
    fields: [
      { id: "age65", label: "Age >65", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "prior", label: "Previous DVT or PE", type: "select", options: [{ value: 0, label: "No" }, { value: 3, label: "Yes" }] },
      { id: "surgery", label: "Surgery or fracture within 1 month", type: "select", options: [{ value: 0, label: "No" }, { value: 2, label: "Yes" }] },
      { id: "cancer", label: "Active malignancy", type: "select", options: [{ value: 0, label: "No" }, { value: 2, label: "Yes" }] },
      { id: "leg_pain", label: "Unilateral lower limb pain", type: "select", options: [{ value: 0, label: "No" }, { value: 3, label: "Yes" }] },
      { id: "hemoptysis", label: "Hemoptysis", type: "select", options: [{ value: 0, label: "No" }, { value: 2, label: "Yes" }] },
      { id: "heart_rate", label: "Heart rate", type: "select", options: [{ value: 0, label: "<75" }, { value: 3, label: "75-94" }, { value: 5, label: ">=95" }] },
      { id: "edema", label: "Pain on palpation and unilateral edema", type: "select", options: [{ value: 0, label: "No" }, { value: 4, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    bands: [
      { max: 4, label: "Low PE probability", color: "green" },
      { min: 4, max: 11, label: "Intermediate PE probability", color: "amber" },
      { min: 11, label: "High PE probability", color: "red" },
    ],
  },
  {
    id: "qsofa", name: "qSOFA", category: "Critical Care / Emergency",
    description: "Quick sepsis-associated organ dysfunction screen",
    fields: [
      { id: "rr", label: "Respiratory rate >=22/min", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "mental", label: "Altered mentation", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "sbp", label: "Systolic BP <=100 mmHg", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    bands: [
      { max: 2, label: "0-1 — lower qSOFA risk", color: "green" },
      { min: 2, label: ">=2 — higher risk; evaluate for sepsis/organ dysfunction", color: "red" },
    ],
  },
  {
    id: "sirs", name: "SIRS Criteria", category: "Critical Care / Emergency",
    description: "Systemic inflammatory response screen",
    fields: [
      { id: "temp", label: "Temp >38 C or <36 C", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "hr", label: "Heart rate >90/min", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "resp", label: "RR >20/min or PaCO2 <32", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "wbc", label: "WBC >12k, <4k, or bands >10%", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "criteria" }),
    bands: [
      { max: 2, label: "0-1 — SIRS not met", color: "green" },
      { min: 2, label: ">=2 — SIRS met", color: "red" },
    ],
  },
  {
    id: "centor_mcisaac", name: "Centor / McIsaac Score", category: "Infectious Disease",
    description: "Strep pharyngitis prediction score",
    fields: [
      { id: "fever", label: "Fever history or temp >38 C", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "cough", label: "Absence of cough", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "nodes", label: "Tender anterior cervical adenopathy", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "exudate", label: "Tonsillar swelling or exudate", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "age", label: "Age adjustment", type: "select", options: [{ value: 1, label: "3-14 years" }, { value: 0, label: "15-44 years" }, { value: -1, label: ">=45 years" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    bands: [
      { max: 2, label: "Low probability", color: "green" },
      { min: 2, max: 4, label: "Intermediate probability", color: "amber" },
      { min: 4, label: "Higher probability", color: "red" },
    ],
  },
  {
    id: "stop_bang", name: "STOP-BANG", category: "Pulmonology",
    description: "Obstructive sleep apnea screening score",
    fields: [
      { id: "snore", label: "Snoring", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "tired", label: "Tired/daytime sleepiness", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "observed", label: "Observed apnea", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "pressure", label: "Hypertension", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "bmi", label: "BMI >35", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "age", label: "Age >50", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "neck", label: "Neck circumference >40 cm", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "sex", label: "Male sex", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    bands: [
      { max: 3, label: "0-2 — low OSA risk", color: "green" },
      { min: 3, max: 5, label: "3-4 — intermediate OSA risk", color: "amber" },
      { min: 5, label: "5-8 — high OSA risk", color: "red" },
    ],
  },
  {
    id: "rcri", name: "Revised Cardiac Risk Index", category: "Cardiology",
    description: "Preoperative cardiac risk estimate",
    fields: [
      { id: "surgery", label: "High-risk surgery", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "ihd", label: "Ischemic heart disease", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "chf", label: "Congestive heart failure", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "stroke", label: "Cerebrovascular disease", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "insulin", label: "Diabetes on insulin", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "creatinine", label: "Creatinine >2 mg/dL", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "risk factors" }),
    bands: [
      { max: 1, label: "0 — lowest RCRI class", color: "green" },
      { min: 1, max: 2, label: "1 — elevated risk", color: "amber" },
      { min: 2, label: ">=2 — higher perioperative cardiac risk", color: "red" },
    ],
  },
  {
    id: "bisap", name: "BISAP Score", category: "Gastroenterology",
    description: "Early pancreatitis mortality risk score",
    fields: [
      { id: "bun", label: "BUN >25 mg/dL", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "mental", label: "Impaired mental status", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "sirs", label: "SIRS present", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "age", label: "Age >60", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "effusion", label: "Pleural effusion", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    bands: [
      { max: 3, label: "0-2 — lower mortality risk", color: "green" },
      { min: 3, label: ">=3 — higher mortality risk", color: "red" },
    ],
  },
  {
    id: "cage", name: "CAGE Questions", category: "Psychiatry",
    description: "Alcohol use disorder screening questions",
    fields: [
      { id: "cut", label: "Need to Cut down", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "annoyed", label: "Annoyed by criticism", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "guilty", label: "Guilty about drinking", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      { id: "eye", label: "Eye-opener drink", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
    ],
    compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "positive answers" }),
    bands: [
      { max: 2, label: "0-1 — screen negative", color: "green" },
      { min: 2, label: ">=2 — screen positive", color: "red" },
    ],
  },
  {
    id: "audit_c", name: "AUDIT-C", category: "Psychiatry",
    description: "Brief alcohol use screen",
    fields: [
      { id: "frequency", label: "How often drink alcohol", type: "select", options: [{ value: 0, label: "Never" }, { value: 1, label: "Monthly or less" }, { value: 2, label: "2-4 times/month" }, { value: 3, label: "2-3 times/week" }, { value: 4, label: ">=4 times/week" }] },
      { id: "quantity", label: "Typical drinks per drinking day", type: "select", options: [{ value: 0, label: "1-2" }, { value: 1, label: "3-4" }, { value: 2, label: "5-6" }, { value: 3, label: "7-9" }, { value: 4, label: ">=10" }] },
      { id: "binge", label: "Six or more drinks on one occasion", type: "select", options: [{ value: 0, label: "Never" }, { value: 1, label: "Less than monthly" }, { value: 2, label: "Monthly" }, { value: 3, label: "Weekly" }, { value: 4, label: "Daily or almost daily" }] },
    ],
    compute: ({ frequency, quantity, binge }) => {
      const score = frequency + quantity + binge;
      const onlyQuestionOne = quantity + binge === 0 && frequency > 0;
      const msg = score < 3
        ? "Scores <3 are consistent with normal alcohol consumption."
        : score === 3
          ? "For females: score >=3 is consistent with alcohol misuse. For males: normal alcohol consumption."
          : score === 4
            ? "For females: score >=3 is consistent with alcohol misuse. For males: score >=4 is consistent with alcohol misuse."
            : "Scores >=5 are consistent with alcohol misuse and possible liver damage.";
      return { value: score, unit: "points", label: `${msg}${onlyQuestionOne ? " Review intake if points only come from question 1." : ""}` };
    },
    bands: [
      { max: 3, label: "0-2 — normal alcohol consumption", color: "green" },
      { min: 3, max: 4, label: "3 — alcohol misuse for females only", color: "amber" },
      { min: 4, max: 5, label: "4 — alcohol misuse", color: "amber" },
      { min: 5, label: ">=5 — alcohol misuse and possible liver damage", color: "red" },
    ],
  },
  {
    id: "ldl_calculated", name: "LDL Calculated", category: "Endocrine / Metabolic",
    description: "Friedewald estimated LDL cholesterol",
    fields: [
      { id: "tc", label: "Total cholesterol", type: "number", unit: "mg/dL", min: 0, max: 1000, required: true },
      { id: "hdl", label: "HDL cholesterol", type: "number", unit: "mg/dL", min: 0, max: 300, required: true },
      { id: "tg", label: "Triglycerides", type: "number", unit: "mg/dL", min: 0, max: 1000, required: true },
    ],
    compute: ({ tc, hdl, tg }) => ({ value: +(tc - hdl - tg / 5).toFixed(1), unit: "mg/dL", label: tg >= 400 ? "Friedewald estimate is unreliable when triglycerides are >=400 mg/dL." : "Friedewald equation." }),
  },
  {
    id: "free_water_deficit", name: "Free Water Deficit", category: "Endocrine / Metabolic",
    description: "Estimated free water deficit in hypernatremia",
    fields: [
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 1, max: 300, step: 0.1, required: true },
      { id: "sodium", label: "Current sodium", type: "number", unit: "mEq/L", min: 100, max: 200, required: true },
      { id: "target", label: "Target sodium", type: "number", unit: "mEq/L", min: 120, max: 160, default: 140 },
      { id: "tbw", label: "TBW fraction", type: "select", options: [{ value: 0.6, label: "0.6 adult male / child" }, { value: 0.5, label: "0.5 adult female / older male" }, { value: 0.45, label: "0.45 older female" }] },
    ],
    compute: ({ weight, sodium, target = 140, tbw }) => ({ value: Math.max(0, +(tbw * weight * ((sodium / target) - 1)).toFixed(2)), unit: "L" }),
  },
  {
    id: "sodium_deficit", name: "Sodium Deficit", category: "Endocrine / Metabolic",
    description: "Estimated sodium deficit in hyponatremia",
    fields: [
      { id: "weight", label: "Weight", type: "number", unit: "kg", min: 1, max: 300, step: 0.1, required: true },
      { id: "current", label: "Current sodium", type: "number", unit: "mEq/L", min: 90, max: 180, required: true },
      { id: "target", label: "Target sodium", type: "number", unit: "mEq/L", min: 90, max: 180, default: 135 },
      { id: "tbw", label: "TBW fraction", type: "select", options: [{ value: 0.6, label: "0.6 adult male / child" }, { value: 0.5, label: "0.5 adult female / older male" }, { value: 0.45, label: "0.45 older female" }] },
    ],
    compute: ({ weight, current, target = 135, tbw }) => ({ value: Math.max(0, Math.round((target - current) * weight * tbw)), unit: "mEq Na" }),
  },
  {
    id: "fib4", name: "FIB-4 Index", category: "Gastroenterology",
    description: "Noninvasive estimate of liver fibrosis using age, AST, ALT, and platelet count",
    fields: [
      { id: "age", label: "Age", type: "number", unit: "years", min: 0, max: 120, step: 1, required: true, hint: "Less reliable at age extremes; interpret cautiously." },
      { id: "ast", label: "AST", type: "number", unit: "U/L", min: 1, max: 10000, step: 1, required: true, hint: "Aspartate aminotransferase." },
      { id: "alt", label: "ALT", type: "number", unit: "U/L", min: 1, max: 25000, step: 1, required: true, hint: "Alanine aminotransferase." },
      { id: "platelets", label: "Platelet count", type: "number", unit: "10^3/uL", min: 1, max: 3200, step: 1, required: true, unitOptions: [{ value: "10^3/uL", label: "10^3/uL", factor: 1 }, { value: "10^9/L", label: "10^9/L", factor: 1 }] },
    ],
    compute: ({ age, ast, alt, platelets }) => {
      const score = (age * ast) / (platelets * Math.sqrt(alt));
      const label = age <= 35
        ? "Use alternative fibrosis assessment; FIB-4 is less reliable in patients <=35 years old."
        : age < 65
          ? score < 1.3 ? "Advanced fibrosis excluded." : score <= 2.67 ? "Further investigation needed." : "Advanced fibrosis likely."
          : score < 2.0 ? "Advanced fibrosis excluded." : score <= 2.67 ? "Further investigation needed." : "Advanced fibrosis likely.";
      return { value: +score.toFixed(2), unit: "points", label };
    },
    bands: [
      { max: 1.45, label: "<1.45 — approximate Ishak 0-1 by original validation", color: "green" },
      { min: 1.45, max: 3.25, label: "1.45-3.25 — indeterminate by original validation", color: "amber" },
      { min: 3.25, label: ">3.25 — approximate Ishak 4-6 by original validation", color: "red" },
    ],
    details: {
      usedFor: "Risk stratifies chronic liver disease patients for advanced fibrosis using routine labs.",
      interpretation: "Low scores help exclude advanced fibrosis; high scores support additional fibrosis assessment or referral depending on local pathway.",
      cautions: ["Less reliable in acute hepatitis, marked transaminase flares, thrombocytopenia from non-hepatic causes, and age extremes.", "Do not use alone to diagnose cirrhosis."],
      formula: "FIB-4 = age x AST / (platelets x square root of ALT).",
    },
  },
];

const STANDARD_UNIT_SETS = {
  weightKg: [
    { value: "kg", label: "kg", factor: 1 },
    { value: "lb", label: "lb", factor: 0.45359237 },
  ],
  heightCm: [
    { value: "cm", label: "cm", factor: 1 },
    { value: "in", label: "in", factor: 2.54 },
  ],
  creatinine: [
    { value: "mg/dL", label: "mg/dL", factor: 1 },
    { value: "umol/L", label: "umol/L", factor: 1 / 88.4 },
  ],
  bilirubin: [
    { value: "mg/dL", label: "mg/dL", factor: 1 },
    { value: "umol/L", label: "umol/L", factor: 1 / 17.1 },
  ],
  glucose: [
    { value: "mg/dL", label: "mg/dL", factor: 1 },
    { value: "mmol/L", label: "mmol/L", factor: 18.0182 },
  ],
  bun: [
    { value: "mg/dL", label: "mg/dL", factor: 1 },
    { value: "mmol/L urea", label: "mmol/L", factor: 2.8 },
  ],
  calcium: [
    { value: "mg/dL", label: "mg/dL", factor: 1 },
    { value: "mmol/L", label: "mmol/L", factor: 4.008 },
  ],
  albumin: [
    { value: "g/dL", label: "g/dL", factor: 1 },
    { value: "g/L", label: "g/L", factor: 0.1 },
  ],
  cholesterol: [
    { value: "mg/dL", label: "mg/dL", factor: 1 },
    { value: "mmol/L", label: "mmol/L", factor: 38.67 },
  ],
  triglycerides: [
    { value: "mg/dL", label: "mg/dL", factor: 1 },
    { value: "mmol/L", label: "mmol/L", factor: 88.57 },
  ],
  electrolytes: [
    { value: "mEq/L", label: "mEq/L", factor: 1 },
    { value: "mmol/L", label: "mmol/L", factor: 1 },
  ],
};

function fieldText(field: Field): string {
  return `${field.id} ${field.label} ${field.unit || ""}`.toLowerCase();
}

function normalGuideForField(field: Field): string | undefined {
  if (field.type !== "number") return undefined;
  const text = fieldText(field);
  if (/\bbun\b/.test(text)) return "8.0 - 20.0";
  if (text.includes("hemoglobin") || /\bhgb\b/.test(text)) return "12.0 - 17.0";
  if (text.includes("systolic") || /\bsbp\b/.test(text)) return "100.0 - 120.0";
  if (text.includes("creatinine")) return "0.7 - 1.3";
  if (text.includes("cystatin")) return "0.51 - 0.98";
  if (/\bast\b/.test(text)) return "15.0 - 41.0";
  if (/\balt\b/.test(text)) return "1.0 - 35.0";
  if (text.includes("platelet")) return "150.0 - 350.0";
  if (text.includes("glucose")) return "70.0 - 100.0";
  if (text.includes("albumin")) return "3.5 - 5.0";
  if (text.includes("sodium")) return "135.0 - 145.0";
  if (text.includes("potassium")) return "3.5 - 5.0";
  if (text.includes("calcium")) return "8.5 - 10.5";
  if (text.includes("heart rate") || /\bpulse\b/.test(text)) return "60.0 - 100.0";
  if (text.includes("respiratory rate") || text.includes("resp rate")) return "12.0 - 20.0";
  if (text.includes("temperature")) return "36.1 - 38.0";
  return undefined;
}

function standardUnitOptions(field: Field): UnitOption[] | undefined {
  if (field.unitOptions || field.type !== "number") return field.unitOptions;
  const text = fieldText(field);
  if (field.unit === "kg" || /\bweight\b/.test(text)) return STANDARD_UNIT_SETS.weightKg;
  if (field.unit === "cm" || /\bheight\b/.test(text) || /\bneck\b/.test(text)) return STANDARD_UNIT_SETS.heightCm;
  if (text.includes("creatinine")) return STANDARD_UNIT_SETS.creatinine;
  if (text.includes("bilirubin")) return STANDARD_UNIT_SETS.bilirubin;
  if (text.includes("glucose")) return STANDARD_UNIT_SETS.glucose;
  if (/\bbun\b/.test(text)) return STANDARD_UNIT_SETS.bun;
  if (text.includes("calcium")) return STANDARD_UNIT_SETS.calcium;
  if (text.includes("albumin")) return STANDARD_UNIT_SETS.albumin;
  if (text.includes("triglyceride")) return STANDARD_UNIT_SETS.triglycerides;
  if (text.includes("cholesterol") || field.id === "tc" || field.id === "hdl") return STANDARD_UNIT_SETS.cholesterol;
  if (field.unit === "mEq/L" && /(sodium|chloride|hco|bicarbonate|potassium|infusate)/.test(text)) return STANDARD_UNIT_SETS.electrolytes;
  return undefined;
}

function enhanceCalculator(calc: CalcDef): CalcDef {
  return {
    ...calc,
    fields: calc.fields.map(field => ({
      ...field,
      placeholder: field.placeholder ?? normalGuideForField(field),
      unitOptions: standardUnitOptions(field),
    })),
    details: calc.details ?? clinicalDetailsFor(calc),
  };
}

function clinicalDetailsFor(calc: CalcDef): CalcDetails {
  const bandText = calc.bands?.map(b => `${b.min ?? "<"}${b.min !== undefined || b.max !== undefined ? "-" : ""}${b.max ?? ">"}: ${b.label}`).join("; ");
  const formula = calc.fields
    .filter(field => field.type === "number")
    .map(field => `${field.label}${field.unit ? ` (${field.unit})` : ""}`)
    .join(", ");
  return {
    usedFor: calc.description,
    interpretation: bandText || "The result should be interpreted with the clinical context, trend, and local protocol.",
    cautions: [
      "Decision support only; do not use as the sole basis for diagnosis, triage, treatment, or dosing.",
      "Confirm input units, timing, and patient population before acting on the result.",
    ],
    formula: formula ? `Inputs used: ${formula}.` : undefined,
  };
}

const CALCULATORS: CalcDef[] = BASE_CALCULATORS.map(enhanceCalculator);

const SHORTCUT_IDS = [
  "egfr",
  "cockcroft",
  "anion_gap",
  "aa_gradient",
  "cha2ds2",
  "wells_pe",
  "curb65",
  "meld",
  "gcs",
  "bmi",
];

const SHORTCUT_STORAGE_KEY = "medos.calc.shortcuts.v1";
const DEFAULT_SHORTCUT_TARGETS = SHORTCUT_IDS.map(id => `native:${id}`);

// ─── Single Calculator View ───────────────────────────────────────────────────

function initialCalcValues(calc: CalcDef): Record<string, number> {
  const init: Record<string, number> = {};
  calc.fields.forEach(f => {
    if (f.default !== undefined) init[f.id] = f.default;
    else if (f.type === "select" && f.options?.length) init[f.id] = f.options[0].value;
  });
  return init;
}

function initialUnitSelections(calc: CalcDef): Record<string, string> {
  const init: Record<string, string> = {};
  calc.fields.forEach(f => {
    if (f.unitOptions?.length) init[f.id] = f.unitOptions[0].value;
  });
  return init;
}

function selectedUnitOption(field: Field, units: Record<string, string>): UnitOption | undefined {
  if (!field.unitOptions?.length) return undefined;
  return field.unitOptions.find(option => option.value === units[field.id]) || field.unitOptions[0];
}

function fieldVisibilityContext(calc: CalcDef, vals: Record<string, number>): Record<string, number> {
  const context: Record<string, number> = {};
  calc.fields.forEach(field => {
    context[field.id] = vals[field.id] ?? field.default ?? (field.type === "select" ? field.options?.[0]?.value ?? 0 : 0);
  });
  return context;
}

function fieldVisible(field: Field, calc: CalcDef, vals: Record<string, number>): boolean {
  const expr = field.conditionality?.trim();
  if (!expr) return true;
  if (!/^[\w\s.$=!<>&|()+\-*/%?:'"]+$/.test(expr)) return true;
  const context = fieldVisibilityContext(calc, vals);
  const names = Object.keys(context).filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
  try {
    const fn = new Function(...names, `return Boolean(${expr});`);
    return Boolean(fn(...names.map(name => context[name] ?? 0)));
  } catch {
    return true;
  }
}

function visibleCalcFields(calc: CalcDef, vals: Record<string, number>): Field[] {
  return calc.fields.filter(field => fieldVisible(field, calc, vals));
}

function convertedCalcValues(calc: CalcDef, vals: Record<string, number>, units: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = { ...vals };
  calc.fields.forEach(field => {
    if (!fieldVisible(field, calc, vals)) {
      out[field.id] = 0;
      return;
    }
    const raw = vals[field.id];
    const unit = selectedUnitOption(field, units);
    if (field.type === "number" && unit && raw !== undefined) out[field.id] = raw * unit.factor;
  });
  return out;
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function fieldPlaceholder(field: Field): string {
  if (field.placeholder) return field.placeholder;
  if (field.default !== undefined) return String(field.default);
  if (field.min !== undefined && field.max !== undefined && !field.required) {
    const low = field.min < 1 ? field.min : Math.round(field.min);
    const high = field.max > 1000 ? field.max : Math.round(field.max);
    return `${low} - ${high}`;
  }
  if (field.hint) return field.hint.length > 34 ? field.hint.slice(0, 34) : field.hint;
  return field.required ? "Enter value" : "optional";
}

function groupedDisplayFields(fields: Field[]): { name: string; note?: string; fields: Field[] }[] {
  const groups: { name: string; note?: string; fields: Field[] }[] = [];
  fields.forEach(field => {
    const name = field.section || "Inputs";
    let group = groups.find(item => item.name === name);
    if (!group) {
      group = { name, note: field.sectionNote, fields: [] };
      groups.push(group);
    }
    if (!group.note && field.sectionNote) group.note = field.sectionNote;
    group.fields.push(field);
  });
  return groups;
}

function toggleOptionLabel(label: string): string {
  return cleanLiveText(label).replace(/^\d+\s*[-–—]\s*/, "");
}

function CalcReferenceBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-secondary)" }}>{children}</div>
    </section>
  );
}

function decodeHtmlEntities(input?: string): string {
  return String(input || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&le;/gi, "≤")
    .replace(/&ge;/gi, "≥")
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&plusmn;/gi, "±")
    .replace(/&times;/gi, "×")
    .replace(/&radic;/gi, "sqrt")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"');
}

function sanitizeMdCalcHtml(input?: string): string {
  const decoded = String(input || "")
    .replace(/&lt;(\/?(?:p|br|ul|ol|li|strong|b|em|i|u|table|thead|tbody|tr|td|th|colgroup|col|span|abbr|a|img|div|calculator)\b[^&]*?)&gt;/gi, "<$1>")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&le;/gi, "<=")
    .replace(/&ge;/gi, ">=")
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&plusmn;/gi, "+/-")
    .replace(/&times;/gi, "x")
    .replace(/&radic;/gi, "sqrt")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"');
  if (!decoded.trim()) return "";
  return decoded
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/\s+style\s*=\s*(['"]).*?\1/gi, "")
    .replace(/\s+id\s*=\s*(['"])docs-internal-[\s\S]*?\1/gi, "")
    .replace(/<calculator\b[^>]*>([\s\S]*?)<\/calculator>/gi, "$1")
    .replace(/<a\b([^>]*)>/gi, (_match, attrs: string) => {
      const hrefMatch = String(attrs).match(/\shref\s*=\s*(['"])(.*?)\1/i);
      const href = hrefMatch?.[2] || "";
      if (!/^https?:\/\//i.test(href)) return "<span>";
      return `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">`;
    })
    .replace(/<\/a>/gi, "</a>")
    .replace(/<(?!\/?(p|br|ul|ol|li|strong|b|em|i|u|table|thead|tbody|tr|td|th|colgroup|col|span|abbr|a|img)\b)[^>]+>/gi, " ")
    .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
      const srcMatch = String(attrs).match(/\ssrc\s*=\s*(['"])(.*?)\1/i);
      const altMatch = String(attrs).match(/\salt\s*=\s*(['"])(.*?)\1/i);
      const src = srcMatch?.[2] || "";
      if (!/^https?:\/\//i.test(src) && !src.startsWith("/")) return "";
      const alt = altMatch?.[2] || "";
      return `<img src="${src.replace(/"/g, "&quot;")}" alt="${alt.replace(/"/g, "&quot;")}" loading="lazy">`;
    })
    .replace(/<p>\s*<\/p>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pointHtml(input?: string): string {
  const html = sanitizeMdCalcHtml(input);
  if (!html) return "";
  if (/<(ul|ol|table)\b/i.test(html)) return html;
  const items = splitMdCalcBullets(html);
  if (items.length > 1 || /^<p\b/i.test(html)) {
    return `<ul>${(items.length ? items : [cleanLiveText(html)]).map(item => `<li>${item}</li>`).join("")}</ul>`;
  }
  return html;
}

function SafeHtml({ html }: { html?: string }) {
  const safe = sanitizeMdCalcHtml(html);
  if (!safe) return null;
  return <div className="calc-md-html" dangerouslySetInnerHTML={{ __html: safe }} />;
}

function DetailContent({ html, fallback }: { html?: string; fallback?: ReactNode }) {
  const safe = pointHtml(html);
  if (safe) return <SafeHtml html={safe} />;
  return <>{fallback}</>;
}

function ReferenceList({ references }: { references?: MdCalcReferenceGroups }) {
  const groups: { key: keyof MdCalcReferenceGroups; label: string }[] = [
    { key: "primary_references", label: "Primary References" },
    { key: "validation", label: "Validation" },
    { key: "validations", label: "Validations" },
    { key: "outcomes", label: "Outcomes" },
    { key: "other_references", label: "Other References" },
    { key: "clinical_practice_guidelines", label: "Guidelines" },
    { key: "manufacturer_website", label: "Manufacturer Website" },
  ];
  const visible = groups
    .map(group => ({ ...group, refs: references?.[group.key] || [] }))
    .filter(group => group.refs.length);
  if (!visible.length) return <span>No source references are available for this calculator.</span>;
  return (
    <div className="calc-reference-list">
      {visible.map(group => (
        <section key={group.key}>
          <h4>{group.label}</h4>
          <ol>
            {group.refs.map((ref, index) => (
              <li key={`${group.key}-${index}`}>
                {ref.href ? <a href={ref.href} target="_blank" rel="noopener noreferrer">{cleanLiveText(ref.text) || ref.href}</a> : cleanLiveText(ref.text)}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function FullCalculatorGuide({
  calc,
  onBack,
  isFavorite,
  onToggleFavorite,
  onPopOut,
}: {
  calc: CalcDef;
  onBack: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onPopOut?: () => void;
}) {
  const [tab, setTab] = useState<CalcGuideTab>("calculator");
  const details = calc.details ?? clinicalDetailsFor(calc);
  const tabs: { id: CalcGuideTab; label: string }[] = [
    { id: "calculator", label: "Calculator" },
    { id: "next", label: "Next Steps" },
    { id: "evidence", label: "Evidence" },
    { id: "creator", label: "Creator" },
  ];

  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--bg-base)" }}>
      <div style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--bg-card)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px" }}>
          <button onClick={onBack} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>‹ Back</button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)" }}>{calc.name}</h2>
            <p style={{ margin: "3px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{calc.description}</p>
          </div>
          {onToggleFavorite && (
            <button title={isFavorite ? "Remove favorite" : "Add favorite"} onClick={onToggleFavorite} style={{ width: 34, height: 34, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-base)", color: isFavorite ? "var(--amber)" : "var(--text-muted)", cursor: "pointer" }}>
              <Star size={16} fill={isFavorite ? "currentColor" : "none"} />
            </button>
          )}
          {onPopOut && (
            <button title="Open compact calculator" onClick={onPopOut} style={{ width: 34, height: 34, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-base)", color: "var(--text-muted)", cursor: "pointer" }}>
              <Maximize2 size={15} />
            </button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", borderTop: "1px solid var(--border)" }}>
          {tabs.map(item => (
            <button key={item.id} onClick={() => setTab(item.id)} style={{ padding: "12px 8px", border: 0, borderBottom: tab === item.id ? "3px solid var(--accent)" : "3px solid transparent", background: "transparent", color: tab === item.id ? "var(--text-primary)" : "var(--text-muted)", fontSize: 12, fontWeight: 900, cursor: "pointer", textTransform: "uppercase" }}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "calculator" ? (
        <CalcView calc={calc} onBack={onBack} isFavorite={isFavorite} onToggleFavorite={onToggleFavorite} onPopOut={onPopOut} compact />
      ) : (
        <div style={{ maxWidth: 860, padding: "22px 24px", display: "grid", gap: 14 }}>
          {tab === "next" && (
            <>
              <CalcReferenceBox title="Result Use">
                <DetailContent html={details.usedForHtml} fallback={details.usedFor || "Use the score as decision support, document the inputs and result, then match the interpretation to the patient’s disease state, acuity, and local pathway."} />
              </CalcReferenceBox>
              <CalcReferenceBox title="Next Steps">
                <DetailContent html={details.interpretationHtml} fallback={details.interpretation || "Review the result band, reassess clinical context, and use local specialty guidance for action thresholds."} />
              </CalcReferenceBox>
              <CalcReferenceBox title="Pitfalls">
                <DetailContent
                  html={details.cautionsHtml}
                  fallback={<ul style={{ margin: 0, paddingLeft: 18 }}>{(details.cautions || []).map((item, index) => <li key={index}>{item}</li>)}</ul>}
                />
              </CalcReferenceBox>
            </>
          )}
          {tab === "evidence" && (
            <>
              <CalcReferenceBox title="Formula / Data">
                <DetailContent html={details.formulaHtml} fallback={details.formula || `Inputs used: ${calc.fields.map(field => field.label).join(", ")}.`} />
              </CalcReferenceBox>
              {(details.evidenceHtml || details.moreInfoHtml) && (
                <CalcReferenceBox title={details.evidenceHtml ? "Evidence" : "More Information"}>
                  <SafeHtml html={details.evidenceHtml || details.moreInfoHtml} />
                </CalcReferenceBox>
              )}
              <CalcReferenceBox title="Interpretation Bands">
                {details.moreInfoHtml ? (
                  <SafeHtml html={details.moreInfoHtml} />
                ) : calc.bands?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{calc.bands.map((band, index) => <li key={index}><u>{band.label}</u></li>)}</ul>
                ) : "No fixed interpretation bands are defined for this calculator."}
              </CalcReferenceBox>
              <CalcReferenceBox title="References">
                <ReferenceList references={details.references} />
              </CalcReferenceBox>
            </>
          )}
          {tab === "creator" && (
            <>
              <CalcReferenceBox title="Creators">
                {details.creators?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {details.creators.map((creator, index) => <li key={index}>{cleanLiveText(creator.name)}{creator.qa ? ` - ${cleanLiveText(creator.qa)}` : ""}</li>)}
                  </ul>
                ) : "Creator information is not available for this calculator."}
              </CalcReferenceBox>
              <CalcReferenceBox title="Contributors">
                {details.contributors?.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {details.contributors.map((contributor, index) => <li key={index}>{cleanLiveText(contributor)}</li>)}
                  </ul>
                ) : "No contributor list is available."}
              </CalcReferenceBox>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CalcView(props: {
  calc: CalcDef;
  onBack: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onPopOut?: () => void;
  compact?: boolean;
}) {
  if (!props.compact) {
    return <FullCalculatorGuide calc={props.calc} onBack={props.onBack} isFavorite={props.isFavorite} onToggleFavorite={props.onToggleFavorite} onPopOut={props.onPopOut} />;
  }
  return <CompactCalcView {...props} />;
}

function CompactCalcView({
  calc,
  onBack,
  isFavorite,
  onToggleFavorite,
  onPopOut,
  compact = false,
}: {
  calc: CalcDef;
  onBack: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  onPopOut?: () => void;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [vals, setVals] = useState<Record<string, number>>(() => initialCalcValues(calc));
  const [units, setUnits] = useState<Record<string, string>>(() => initialUnitSelections(calc));
  const [detailsTab, setDetailsTab] = useState<"when" | "pitfalls" | "why">("when");

  useEffect(() => {
    setCopied(false);
    setVals(initialCalcValues(calc));
    setUnits(initialUnitSelections(calc));
    setDetailsTab("when");
  }, [calc]);

  const visibleFields = useMemo(() => visibleCalcFields(calc, vals), [calc, vals]);
  const computeVals = useMemo(() => convertedCalcValues(calc, vals, units), [calc, vals, units]);
  const details = calc.details ?? clinicalDetailsFor(calc);
  const filled   = visibleFields.every(f => !f.required || vals[f.id] !== undefined);
  const result   = filled ? (() => { try { return calc.compute(computeVals); } catch { return null; } })() : null;
  const resultN  = result && typeof result.value === "number" ? result.value : null;
  const resBand  = resultN !== null && calc.bands ? scoreBand(resultN, calc.bands) : undefined;
  const bandColor: Record<string, string> = {
    green: "var(--green)", amber: "var(--amber)", red: "var(--red)",
    blue: "var(--accent)", purple: "#a855f7",
  };
  const noteText = result ? [
    `${calc.name}`,
    ...visibleFields.map(f => {
      const raw = vals[f.id];
      const selected = f.type === "select" ? f.options?.find(o => o.value === raw)?.label : undefined;
      const unit = selectedUnitOption(f, units);
      const base = computeVals[f.id];
      const converted = unit && f.unit && unit.value !== f.unit && base !== undefined ? ` (${compactNumber(base)} ${f.unit})` : "";
      const value = selected ?? (raw !== undefined ? `${raw}${unit ? ` ${unit.label}` : f.unit ? ` ${f.unit}` : ""}${converted}` : "not entered");
      return `${f.label}: ${value}`;
    }),
    ...(details.usedFor ? [`Used for: ${details.usedFor}`] : []),
    `Result: ${result.value}${result.unit ? ` ${result.unit}` : ""}`,
    ...(result.label ? [`Detail: ${result.label}`] : []),
    ...(resBand ? [`Interpretation: ${resBand.label}`] : []),
  ].join("\n") : "";

  async function copyNote() {
    if (!noteText) return;
    await copyTextToClipboard(noteText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function renderField(f: Field, criteriaMode: boolean) {
    const label = (
      <label style={{ display: "block", marginBottom: 6 }}>
        <span style={{ display: "block", fontSize: criteriaMode ? 13 : 12, color: "var(--text-primary)", fontWeight: 800, lineHeight: 1.35 }}>
          {f.label}{!f.unitOptions && f.unit ? ` (${f.unit})` : ""}
        </span>
        {f.hint && (
          <span style={{ display: "block", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.4, fontStyle: "italic", marginTop: 3 }}>
            {f.hint}
          </span>
        )}
      </label>
    );

    if (f.type === "select" && f.variant === "toggle" && f.options?.length) {
      return (
        <div key={f.id} style={{ display: criteriaMode ? "grid" : "block", gridTemplateColumns: criteriaMode ? "minmax(0,1fr) minmax(150px,220px)" : undefined, gap: criteriaMode ? 14 : undefined, alignItems: "start", padding: criteriaMode ? "12px 14px" : "0 0 14px", borderBottom: criteriaMode ? "1px solid var(--border)" : undefined }}>
          <div>{label}</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${f.options.length}, minmax(0, 1fr))`, border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", background: "var(--bg-base)" }}>
            {f.options.map(option => {
              const active = (vals[f.id] ?? f.options?.[0]?.value) === option.value;
              return (
                <button
                  key={`${f.id}-${option.value}`}
                  type="button"
                  onClick={() => setVals(prev => ({ ...prev, [f.id]: option.value }))}
                  style={{
                    minHeight: 34,
                    border: 0,
                    borderLeft: option === f.options?.[0] ? 0 : "1px solid var(--border)",
                    background: active ? "var(--accent)" : "transparent",
                    color: active ? "white" : "var(--text-secondary)",
                    fontSize: 12,
                    fontWeight: active ? 900 : 700,
                    cursor: "pointer",
                  }}
                >
                  {toggleOptionLabel(option.label)}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    return (
      <div key={f.id} style={{ marginBottom: criteriaMode ? 0 : 14, padding: criteriaMode ? "12px 14px" : undefined, borderBottom: criteriaMode ? "1px solid var(--border)" : undefined }}>
        {label}
        {f.type === "select" ? (
          <select value={vals[f.id] ?? ""} onChange={e => setVals(p => ({ ...p, [f.id]: Number(e.target.value) }))} style={{ width: "100%", padding: "8px 10px", fontSize: 13 }}>
            {f.options!.map(o => <option key={`${o.value}-${o.label}`} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: f.unitOptions?.length ? "minmax(0,1fr) 112px" : "1fr", gap: 8 }}>
            <input type="number" value={vals[f.id] ?? ""} min={f.unitOptions ? undefined : f.min} max={f.unitOptions ? undefined : f.max} step={f.step ?? "any"}
              onChange={e => setVals(p => {
                const next = { ...p };
                if (e.target.value === "") delete next[f.id];
                else next[f.id] = Number(e.target.value);
                return next;
              })}
              style={{ width: "100%", padding: "8px 10px", fontSize: 13 }}
              placeholder={fieldPlaceholder(f)} />
            {f.unitOptions?.length ? (
              <select value={units[f.id] || f.unitOptions[0].value} onChange={e => setUnits(p => ({ ...p, [f.id]: e.target.value }))} style={{ width: "100%", padding: "8px 8px", fontSize: 13 }}>
                {f.unitOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  function renderFieldGroups() {
    const criteriaMode = calc.layout === "criteria" || visibleFields.some(field => field.section);
    if (!criteriaMode) {
      return (
        <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
          {visibleFields.map(f => renderField(f, false))}
        </div>
      );
    }
    return (
      <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        {groupedDisplayFields(visibleFields).map(group => (
          <section key={group.name} style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", overflow: "hidden" }}>
            <header style={{ padding: "12px 14px", background: group.name.toLowerCase().includes("major") ? "rgba(15, 118, 110, 0.78)" : group.name.toLowerCase().includes("minor") ? "rgba(71, 85, 105, 0.72)" : "rgba(59, 130, 246, 0.08)", color: group.name.toLowerCase().includes("major") || group.name.toLowerCase().includes("minor") ? "white" : "var(--text-primary)" }}>
              <div style={{ fontSize: 13, fontWeight: 900 }}>{group.name}</div>
              {group.note && <div style={{ fontSize: 12, marginTop: 4, opacity: 0.9, fontStyle: "italic" }}>{group.note}</div>}
            </header>
            <div>{group.fields.map(field => renderField(field, true))}</div>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: compact ? "16px 18px" : "24px 28px" }}>
      <div style={{ maxWidth: 520 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, padding: 0, fontSize: 12 }}>
            <ChevronRight size={12} style={{ transform: "rotate(180deg)" }} /> Back
          </button>
          <div style={{ flex: 1 }} />
          {onToggleFavorite && (
            <button title={isFavorite ? "Remove favorite" : "Add favorite"} onClick={onToggleFavorite} style={{ width: 30, height: 30, display: "grid", placeItems: "center", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", color: isFavorite ? "var(--amber)" : "var(--text-muted)" }}>
              <Star size={15} fill={isFavorite ? "currentColor" : "none"} />
            </button>
          )}
          {onPopOut && (
            <button title="Open as overlay" onClick={onPopOut} style={{ width: 30, height: 30, display: "grid", placeItems: "center", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", color: "var(--text-muted)" }}>
              <Maximize2 size={14} />
            </button>
          )}
        </div>
        <h2 style={{ fontSize: compact ? 16 : 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>{calc.name}</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>{calc.description}</p>
        {details.instructionsHtml && (
          <div style={{ border: "1px solid rgba(59,130,246,.18)", borderRadius: 8, background: "rgba(59,130,246,.10)", padding: "11px 13px", marginBottom: 12, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.45 }}>
            <div style={{ fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--accent)", marginBottom: 5 }}>Instructions</div>
            <SafeHtml html={details.instructionsHtml} />
          </div>
        )}

        <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", marginBottom: 12, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", borderBottom: "1px solid var(--border)" }}>
            {[
              ["when", "When"],
              ["pitfalls", "Pitfalls"],
              ["why", "Why"],
            ].map(([id, label]) => (
              <button key={id} type="button" onClick={() => setDetailsTab(id as "when" | "pitfalls" | "why")} style={{ border: 0, borderBottom: detailsTab === id ? "2px solid var(--accent)" : "2px solid transparent", background: detailsTab === id ? "rgba(59,130,246,.06)" : "transparent", color: detailsTab === id ? "var(--text-primary)" : "var(--text-muted)", padding: "8px 4px", fontSize: 11, fontWeight: 900, cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ padding: "10px 12px", fontSize: 11, lineHeight: 1.45, color: "var(--text-secondary)" }}>
            {detailsTab === "when" && <DetailContent html={details.usedForHtml} fallback={details.usedFor || calc.description} />}
            {detailsTab === "why" && <DetailContent html={details.interpretationHtml} fallback={details.interpretation || "Use the result to support risk stratification and documentation."} />}
            {detailsTab === "pitfalls" && (
              <DetailContent
                html={details.cautionsHtml}
                fallback={
                  <ul style={{ margin: 0, paddingLeft: 17 }}>
                    {(details.cautions?.length ? details.cautions : ["Confirm units, timing, and patient population before acting."]).map((item, index) => <li key={index}>{item}</li>)}
                  </ul>
                }
              />
            )}
          </div>
        </div>

        {renderFieldGroups()}

        {result && (
          <div style={{
            background: resBand ? `${bandColor[resBand.color]}18` : "var(--bg-card)",
            border: `1px solid ${resBand ? bandColor[resBand.color] : "var(--border)"}`,
            borderRadius: 10, padding: "16px 20px",
          }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: resBand ? bandColor[resBand.color] : "var(--text-primary)" }}>
              {result.value}
              {result.unit && <span style={{ fontSize: 14, fontWeight: 500, marginLeft: 8, color: "var(--text-secondary)" }}>{result.unit}</span>}
            </div>
            {result.label && <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{result.label}</p>}
            {resBand && <p style={{ fontSize: 14, fontWeight: 600, color: bandColor[resBand.color], marginTop: 8 }}>{resBand.label}</p>}
            <button
              type="button"
              onClick={copyNote}
              style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-card)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, fontWeight: 700 }}
            >
              <Copy size={13} /> {copied ? "Copied" : "Copy note"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Hub ─────────────────────────────────────────────────────────────────────

function readStoredSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(window.localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}

function readShortcutTargets(): ShortcutTarget[] {
  if (typeof window === "undefined") return [...DEFAULT_SHORTCUT_TARGETS];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SHORTCUT_STORAGE_KEY) || "null");
    if (Array.isArray(parsed)) {
      return DEFAULT_SHORTCUT_TARGETS.map((fallback, index) => {
        const value = parsed[index];
        if (typeof value !== "string" || !value) return fallback;
        return value.includes(":") ? value : `native:${value}`;
      });
    }
  } catch {}
  return [...DEFAULT_SHORTCUT_TARGETS];
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function normalizeCalcText(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function cleanLiveText(input?: string): string {
  return decodeHtmlEntities(input)
    .replace(/<calculator\b[^>]*>(.*?)<\/calculator>/gi, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUnitText(input?: string): string {
  return cleanLiveText(input)
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/[×x]/g, "x")
    .replace(/\s+/g, "")
    .replace("mmhg", "mmhg");
}

function liveUnitFactor(input: LiveCalcInput, label: string, fromUnit?: string, toUnit?: string): number {
  const from = normalizeUnitText(fromUnit);
  const to = normalizeUnitText(toUnit);
  if (!from || !to || from === to) return 1;
  const text = normalizeCalcText(`${input.name} ${label} ${fromUnit} ${toUnit}`);
  if (from.includes("umol/l") && to.includes("mg/dl") && text.includes("creatinine")) return 1 / 88.4;
  if (from.includes("umol/l") && to.includes("mg/dl") && text.includes("bilirubin")) return 1 / 17.104;
  if (from.includes("mmol/l") && to.includes("mg/dl") && text.includes("glucose")) return 18.0182;
  if (from.includes("mmol/l") && to.includes("mg/dl") && /\bbun\b/.test(text)) return 2.8;
  if (from.includes("g/l") && to.includes("g/dl")) return 0.1;
  if (from.includes("mmol/l") && to.includes("mg/dl") && text.includes("cholesterol")) return 38.67;
  if (from.includes("mmol/l") && to.includes("mg/dl") && text.includes("triglyceride")) return 88.57;
  if ((from.includes("10^9/l") || from.includes("10⁹/l")) && (to.includes("10^3/ul") || to.includes("10³/ul"))) return 1;
  return 1;
}

function liveUnitOptions(input: LiveCalcInput, label: string): UnitOption[] | undefined {
  const us = cleanLiveText(input.unitUs || input.unit);
  const si = cleanLiveText(input.unitSi);
  const base = us || cleanLiveText(input.unit) || si;
  if (!base || !si || normalizeUnitText(base) === normalizeUnitText(si)) return undefined;
  return [
    { value: base, label: base, factor: 1 },
    { value: si, label: si, factor: liveUnitFactor(input, label, si, base) },
  ];
}

function isCompactToggle(input: LiveCalcInput): boolean {
  if (!["toggle", "radio"].includes(input.type || "")) return false;
  const labels = (input.options || []).map(option => cleanLiveText(option.label));
  return labels.length === 2 && labels.every(label => label.length > 0 && label.length <= 18);
}

function criteriaSectionFor(title: string, input: LiveCalcInput, currentSection: string, currentNote?: string): { section?: string; note?: string } {
  const n = normalizeCalcText(title);
  const id = normalizeCalcText(input.name);

  if (n.includes("framingham heart failure")) {
    if (["ape", "cardiomegaly", "hepjug", "nvd", "dysporth", "rales", "s3", "weightloss"].includes(id)) {
      return { section: "Major Criteria", note: "2+ required for positive diagnosis (or 1 major plus 2 minor criteria)." };
    }
    if (["edema", "dyspexert", "hepatomegaly", "noccough", "pleff", "tachy"].includes(id)) {
      return { section: "Minor Criteria", note: "Select minor criteria only if they cannot be explained by another comorbidity." };
    }
  }

  if (n.includes("jones criteria")) {
    if (/^req/.test(id)) return { section: "Evidence of Preceding GAS Infection", note: "At least one evidence criterion is required before applying the diagnostic criteria." };
    if (["history", "pop"].includes(id)) return { section: "Patient Context", note: "Risk population changes which joint and fever criteria apply." };
    if (["carditis", "arth1", "arth2", "chorea", "em", "nodules"].includes(id)) return { section: "Major Criteria" };
    return { section: "Minor Criteria" };
  }

  if (n.includes("duke") && n.includes("criteria")) {
    if (["microorganisms", "lesions"].includes(id)) return { section: "Pathologic Criteria" };
    if (["endocarditis", "evidence endocardial"].includes(id)) return { section: "Major Criteria" };
    if (/^q[1-5]$/.test(id)) return { section: "Major Criteria - Microbiology" };
    if (/^q[6-9]$/.test(id)) return { section: "Major Criteria - Imaging" };
    if (id === "q10") return { section: "Major Criteria - Surgical Evidence" };
    return { section: "Minor Criteria" };
  }

  if (n.includes("brugada criteria")) {
    return { section: "Stepwise ECG Criteria", note: "Answer from top to bottom; later criteria are shown when earlier criteria are not met." };
  }

  if (n.includes("criteria") || n.includes("rule")) return { section: currentSection || "Criteria", note: currentNote };
  return { section: currentSection || undefined, note: currentNote };
}

function sectionMetaForTitle(title: string, index: number, rawLabel?: string): { section: string; note?: string } {
  const n = normalizeCalcText(title);
  const label = cleanLiveText(rawLabel);
  if (label) return { section: label };
  if (n.includes("framingham heart failure")) {
    return [
      { section: "Major Criteria", note: "2+ required for positive diagnosis (or 1 major plus 2 minor criteria)." },
      { section: "Minor Criteria", note: "Select minor criteria only if they cannot be explained by another comorbidity." },
    ][index] || { section: `Criteria Group ${index + 1}` };
  }
  if (n.includes("jones criteria")) {
    return [
      { section: "Evidence of Preceding GAS Infection", note: "At least one evidence criterion is required before applying the diagnostic criteria." },
      { section: "Major Criteria" },
      { section: "Minor Criteria" },
    ][index] || { section: `Criteria Group ${index + 1}` };
  }
  if (n.includes("duke") && n.includes("criteria")) {
    return [
      { section: "Pathologic Criteria" },
      { section: "Major Criteria - Microbiology" },
      { section: "Major Criteria - Imaging" },
      { section: "Major Criteria - Surgical Evidence" },
      { section: "Minor Criteria" },
    ][index] || { section: `Criteria Group ${index + 1}` };
  }
  return { section: `Criteria Group ${index + 1}` };
}

function clinicalCategoryLabel(value: string): string {
  return value ? value.toLowerCase() : "clinical";
}

function findNativeMatch(title: string): CalcDef | undefined {
  const n = normalizeCalcText(title);
  if (n.includes("absolute neutrophil") || /\banc\b/.test(n)) return CALCULATORS.find(c => c.id === "anc");
  if (n.includes("4t score") || /\b4t\b/.test(n)) return CALCULATORS.find(c => c.id === "four_t");
  if (n.includes("acetaminophen") && n.includes("toxicity")) return CALCULATORS.find(c => c.id === "acetaminophen_toxicity");
  if (n.includes("advanced life support") && n.includes("adult")) return CALCULATORS.find(c => c.id === "als_adult");
  if (n.includes("apache ii") && !n.includes("by diagnosis")) return CALCULATORS.find(c => c.id === "apache2");
  if (n.includes("fracture index") && n.includes("without")) return CALCULATORS.find(c => c.id === "fracture_index_no_bmd");
  if (n.includes("framingham") && !n.includes("stroke")) return CALCULATORS.find(c => c.id === "framingham");
  if (n.includes("cockcroft gault") && !n.includes("with ibw")) return CALCULATORS.find(c => c.id === "cockcroft");
  if (n.includes("calvert") || n.includes("carboplatin")) return CALCULATORS.find(c => c.id === "calvert_carboplatin");
  if (n.includes("steroid conversion") || n.includes("corticosteroid conversion")) return CALCULATORS.find(c => c.id === "steroid_conversion");
  if (n.includes("morphine milligram") || n.includes("mme calculator")) return CALCULATORS.find(c => c.id === "opioid_mme");
  if (n.includes("maintenance fluid")) return CALCULATORS.find(c => c.id === "maintenance_fluids");
  if (n.includes("calcium correction")) return CALCULATORS.find(c => c.id === "corrected_calcium");
  if (n.includes("sodium correction") && n.includes("hyperglycemia")) return CALCULATORS.find(c => c.id === "corrected_sodium");
  if (n.includes("serum osmolality") || n.includes("serum osmolarity")) return CALCULATORS.find(c => c.id === "serum_osmolality");
  if (n.includes("fractional excretion of sodium") || /\bfena\b/.test(n)) return CALCULATORS.find(c => c.id === "fena");
  if (n.includes("mdrd")) return CALCULATORS.find(c => c.id === "mdrd");
  if (n.includes("schwartz") && n.includes("gfr")) return CALCULATORS.find(c => c.id === "schwartz");
  if (n.includes("mean arterial pressure") || /\bmap\b/.test(n)) return CALCULATORS.find(c => c.id === "mean_arterial_pressure");
  if (n.includes("shock index")) return CALCULATORS.find(c => c.id === "shock_index");
  if (n.includes("parkland")) return CALCULATORS.find(c => c.id === "parkland");
  if (n.includes("bicarbonate deficit")) return CALCULATORS.find(c => c.id === "bicarbonate_deficit");
  if (n.includes("heart score") || n.includes("heart pathway")) return CALCULATORS.find(c => c.id === "heart_score");
  if (n.includes("perc rule")) return CALCULATORS.find(c => c.id === "perc");
  if (n.includes("geneva") && n.includes("pulmonary embolism")) return CALCULATORS.find(c => c.id === "geneva_pe");
  if (n.includes("qsofa")) return CALCULATORS.find(c => c.id === "qsofa");
  if (n.includes("sirs") && !n.includes("pediatric")) return CALCULATORS.find(c => c.id === "sirs");
  if (n.includes("centor") || n.includes("mcisaac")) return CALCULATORS.find(c => c.id === "centor_mcisaac");
  if (n.includes("stop bang")) return CALCULATORS.find(c => c.id === "stop_bang");
  if (n.includes("revised cardiac risk") || /\brcri\b/.test(n)) return CALCULATORS.find(c => c.id === "rcri");
  if (n.includes("bisap")) return CALCULATORS.find(c => c.id === "bisap");
  if (n.includes("cage questions")) return CALCULATORS.find(c => c.id === "cage");
  if (n.includes("audit c")) return CALCULATORS.find(c => c.id === "audit_c");
  if (n.includes("ldl calculated")) return CALCULATORS.find(c => c.id === "ldl_calculated");
  if (n.includes("free water deficit") || n.includes("water deficit")) return CALCULATORS.find(c => c.id === "free_water_deficit");
  if (n.includes("sodium deficit")) return CALCULATORS.find(c => c.id === "sodium_deficit");
  if (n.includes("fib 4") || n.includes("fibrosis 4")) return CALCULATORS.find(c => c.id === "fib4");
  if ((n.includes("body mass index") || /\bbmi\b/.test(n)) && !n.includes("for age")) return CALCULATORS.find(c => c.id === "bmi");
  if ((n.includes("body surface area") || /\bbsa\b/.test(n)) && !n.includes("gehan") && !n.includes("du bois")) return CALCULATORS.find(c => c.id === "bsa");
  if (n === "anion gap" || n.includes("anion gap in hypoalbumin")) return CALCULATORS.find(c => c.id === "anion_gap");
  if (n.includes("a a gradient")) return CALCULATORS.find(c => c.id === "aa_gradient");
  if (n.includes("has bled")) return CALCULATORS.find(c => c.id === "has_bled");
  if (n.includes("chads2") || n.includes("chads 2")) return CALCULATORS.find(c => c.id === "chads2");
  if (n.includes("cha2ds2") || n.includes("cha2ds2 vasc") || n.includes("chads vasc")) return CALCULATORS.find(c => c.id === "cha2ds2");
  if (n.includes("apgar")) return CALCULATORS.find(c => c.id === "apgar");
  if (n.includes("child pugh")) return CALCULATORS.find(c => c.id === "child_pugh");
  if (n.includes("meldna") || n.includes("meld na") || n.includes("combined meld")) return CALCULATORS.find(c => c.id === "meld_na");
  if (n === "meld score" || n === "meld score si units") return CALCULATORS.find(c => c.id === "meld");
  if (n.includes("glasgow blatchford") || n.includes("blatchford bleeding") || /\bgbs\b/.test(n)) return CALCULATORS.find(c => c.id === "glasgow_blatchford");
  if (n.includes("glasgow coma")) return CALCULATORS.find(c => c.id === "gcs");
  if (n.includes("nih") && (n.includes("stroke") || n.includes("scale") || n.includes("score"))) return CALCULATORS.find(c => c.id === "nihss");
  if (n.includes("wells") && n.includes("pulmonary")) return CALCULATORS.find(c => c.id === "wells_pe");
  if (n.includes("wells") && n.includes("dvt")) return CALCULATORS.find(c => c.id === "wells_dvt");
  if (n.includes("curb")) return CALCULATORS.find(c => c.id === "curb65");
  return CALCULATORS.find(c => normalizeCalcText(c.name) === n);
}

function liveInputsToFields(inputs: LiveCalcInput[], title = ""): Field[] {
  const fields: Field[] = [];
  let sectionIndex = -1;
  let activeSection = "";
  let activeSectionNote: string | undefined;
  for (const input of inputs.slice(0, 40)) {
    if (input.type === "subheading") {
      sectionIndex += 1;
      const meta = sectionMetaForTitle(title, sectionIndex, input.label);
      activeSection = meta.section;
      activeSectionNote = meta.note;
      continue;
    }
    if (!input.name || !input.label) continue;
      const id = input.name.replace(/[^a-z0-9_]/gi, "_");
      const label = cleanLiveText(input.label) || input.name;
      const section = criteriaSectionFor(title, input, activeSection, activeSectionNote);
      if (input.options?.length) {
        fields.push({
          id,
          label,
          type: "select",
          variant: isCompactToggle(input) ? "toggle" : "select",
          options: input.options.map(option => ({ value: Number(option.value || 0), label: `${option.value} - ${cleanLiveText(option.label) || option.value}` })),
          required: !input.optional,
          hint: cleanLiveText(input.hint) || undefined,
          conditionality: input.conditionality || undefined,
          section: section.section,
          sectionNote: section.note,
        } satisfies Field);
        continue;
      }
      const normalRange = input.normalMin !== undefined && input.normalMax !== undefined && (input.normalMin > 0 || input.normalMax > 0)
        ? `${input.normalMin.toFixed(1)} - ${input.normalMax.toFixed(1)}`
        : undefined;
      fields.push({
        id,
        label,
        type: "number",
        unit: cleanLiveText(input.unitUs || input.unit) || undefined,
        min: input.errorMin ?? input.warnMin,
        max: input.errorMax ?? input.warnMax,
        step: 0.01,
        required: !input.optional,
        hint: cleanLiveText(input.hint) || undefined,
        placeholder: normalRange || undefined,
        unitOptions: liveUnitOptions(input, label),
        conditionality: input.conditionality || undefined,
        section: section.section,
        sectionNote: section.note,
      } satisfies Field);
  }
  return fields;
}

function splitMdCalcBullets(value?: string): string[] {
  const cleaned = cleanLiveText(value);
  if (!cleaned) return [];
  return cleaned
    .split(/(?:\n|•|;\s+(?=[A-Z]))/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function mdcalcDetailsFor(lexi: LexiCalc): CalcDetails | undefined {
  const details = lexi.details;
  const usedFor = cleanLiveText(details?.whenToUse || details?.beforeUse || details?.instructions || lexi.description);
  const interpretation = cleanLiveText(details?.management || details?.advice || details?.criticalActions || details?.moreInfo);
  const cautions = splitMdCalcBullets(details?.pearlsPitfalls);
  const formula = cleanLiveText(lexi.formula);
  const usedForHtml = pointHtml(details?.whenToUse || details?.beforeUse || details?.instructions || lexi.description);
  const interpretationHtml = pointHtml(details?.management || details?.advice || details?.criticalActions || details?.moreInfo);
  const cautionsHtml = pointHtml(details?.pearlsPitfalls);
  const formulaHtml = sanitizeMdCalcHtml(lexi.formula);
  const evidenceHtml = sanitizeMdCalcHtml(details?.evidence);
  const moreInfoHtml = sanitizeMdCalcHtml(details?.moreInfo);
  const instructionsHtml = pointHtml(details?.instructions);
  if (!usedFor && !interpretation && cautions.length === 0 && !formula && !evidenceHtml && !moreInfoHtml) return undefined;
  return {
    usedFor: usedFor || undefined,
    usedForHtml: usedForHtml || undefined,
    interpretation: interpretation || undefined,
    interpretationHtml: interpretationHtml || undefined,
    cautions: cautions.length ? cautions : undefined,
    cautionsHtml: cautionsHtml || undefined,
    formula: formula || undefined,
    formulaHtml: formulaHtml || undefined,
    evidenceHtml: evidenceHtml || undefined,
    moreInfoHtml: moreInfoHtml || undefined,
    references: lexi.references || undefined,
    creators: details?.creators || undefined,
    contributors: details?.contributors || undefined,
    instructionsHtml: instructionsHtml || undefined,
  };
}

function executeMdCalcLogic(lexi: LexiCalc, vals: Record<string, number>) {
  const logic = lexi.equationLogicText;
  if (!logic) return null;
  const params: string[] = [];
  const args: number[] = [];
  (lexi.inputs || []).forEach(input => {
    const name = input.name;
    if (!/^[A-Za-z_$][\w$]*$/.test(name || "")) return;
    const id = name.replace(/[^a-z0-9_]/gi, "_");
    if (params.includes(name)) return;
    params.push(name);
    args.push(vals[id] ?? input.default ?? 0);
  });
  try {
    const fn = new Function(...params, "UOMSYSTEM", `${logic}\nreturn typeof calc_output !== "undefined" ? calc_output : [];`);
    const output = fn(...args, true);
    if (!Array.isArray(output) || output.length === 0) return null;
    const mini = output.find(item => String(item?.name || "").toLowerCase() === "mini") || output[0];
    const valueRaw = mini?.value ?? "";
    const numeric = typeof valueRaw === "number" ? valueRaw : Number(String(valueRaw).replace(/,/g, ""));
    const resultValue = Number.isFinite(numeric) && String(valueRaw).trim() !== "" ? numeric : String(valueRaw || "Calculated");
    const labelParts = output
      .map(item => cleanLiveText([item?.message, item?.value && item !== mini ? item.value : ""].filter(Boolean).join(" ")))
      .filter(Boolean);
    return {
      value: typeof resultValue === "number" ? +resultValue.toFixed(Number.isInteger(resultValue) ? 0 : 2) : resultValue,
      unit: cleanLiveText(mini?.value_text) || undefined,
      label: labelParts.slice(0, 3).join(" "),
    };
  } catch {
    return null;
  }
}

function generatedLexiCalculator(lexi: LexiCalc): CalcDef {
  const title = lexi.title;
  const n = normalizeCalcText(title);
  const id = `lexi_${String(lexi.id || n).replace(/[^a-z0-9_]/gi, "_")}`;
  const category = lexi.category || "Lexi Calculator";
  const description = cleanLiveText(lexi.description) || `${title} calculator for ${clinicalCategoryLabel(category)} support.`;
  const liveFields = liveInputsToFields(lexi.inputs || [], title);
  const details = mdcalcDetailsFor(lexi);

  if (lexi.equationLogicText && liveFields.length) {
    return {
      id, name: title, category, description,
      layout: liveFields.some(field => field.section) || n.includes("criteria") ? "criteria" : "standard",
      fields: liveFields,
      compute: vals => executeMdCalcLogic(lexi, vals) || {
        value: "No result",
        unit: "",
        label: "The equation could not be evaluated for this input combination — check that all required fields are filled.",
      },
      details,
    };
  }

  if (n.includes("unit conversion") || n.includes("si unit conversions")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "value", label: "Value", type: "number", required: true, step: 0.01 },
        { id: "factor", label: "Conversion factor", type: "number", required: true, step: 0.0001, default: 1 },
      ],
      compute: ({ value, factor }) => ({ value: +(value * factor).toFixed(4), unit: "converted units", label: "Enter the source-to-target factor for the specific Lexi conversion." }),
    };
  }

  if (n.includes("calcium correction")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "calcium", label: "Measured calcium", type: "number", unit: n.includes("si units") ? "mmol/L" : "mg/dL", required: true, step: 0.01 },
        { id: "albumin", label: "Albumin", type: "number", unit: n.includes("si units") ? "g/L" : "g/dL", required: true, step: 0.1 },
      ],
      compute: ({ calcium, albumin }) => {
        if (n.includes("si units")) {
          const corrected = calcium + 0.02 * (40 - albumin);
          return { value: +corrected.toFixed(2), unit: "mmol/L", label: "Corrected Ca = Ca + 0.02 x (40 - albumin g/L)" };
        }
        const corrected = calcium + 0.8 * (4 - albumin);
        return { value: +corrected.toFixed(2), unit: "mg/dL", label: "Corrected Ca = Ca + 0.8 x (4 - albumin g/dL)" };
      },
    };
  }

  if (n.includes("sodium correction in hyperglycemia")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "sodium", label: "Measured sodium", type: "number", unit: "mEq/L", required: true },
        { id: "glucose", label: "Glucose", type: "number", unit: "mg/dL", required: true },
        { id: "factor", label: "Correction per 100 mg/dL glucose above 100", type: "select", options: [{ value: 1.6, label: "1.6 mEq/L" }, { value: 2.4, label: "2.4 mEq/L" }] },
      ],
      compute: ({ sodium, glucose, factor }) => ({ value: +(sodium + factor * (Math.max(0, glucose - 100) / 100)).toFixed(1), unit: "mEq/L", label: "Corrected sodium in hyperglycemia." }),
    };
  }

  if (n.includes("anion gap") && (n.includes("delta delta") || n.includes("delta ratio") || n.includes("delta gradient"))) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "na", label: "Sodium", type: "number", unit: "mEq/L", required: true },
        { id: "cl", label: "Chloride", type: "number", unit: "mEq/L", required: true },
        { id: "bicarb", label: "HCO3", type: "number", unit: "mEq/L", required: true },
      ],
      compute: ({ na, cl, bicarb }) => {
        const ag = na - cl - bicarb;
        const deltaAg = ag - 12;
        const deltaBicarb = 24 - bicarb;
        if (n.includes("ratio")) {
          return { value: +(deltaAg / deltaBicarb).toFixed(2), unit: "ratio", label: `AG ${ag.toFixed(1)}; delta AG ${deltaAg.toFixed(1)}; delta HCO3 ${deltaBicarb.toFixed(1)}` };
        }
        return { value: +(deltaAg - deltaBicarb).toFixed(1), unit: "mEq/L", label: `AG ${ag.toFixed(1)}; delta-delta gradient = (AG-12) - (24-HCO3)` };
      },
    };
  }

  if (n.includes("sodium deficit")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "weight", label: "Weight", type: "number", unit: "kg", required: true },
        { id: "current", label: "Current sodium", type: "number", unit: "mEq/L", required: true },
        { id: "target", label: "Target sodium", type: "number", unit: "mEq/L", required: true, default: 135 },
        { id: "tbw", label: "TBW fraction", type: "select", options: [{ value: 0.6, label: "0.6 adult male / child" }, { value: 0.5, label: "0.5 adult female / older male" }, { value: 0.45, label: "0.45 older female" }] },
      ],
      compute: ({ weight, current, target, tbw }) => ({ value: +((target - current) * weight * tbw).toFixed(0), unit: "mEq Na", label: "Na deficit = TBW x (target Na - current Na)." }),
    };
  }

  if (n.includes("hyponatremia correction infusate rate")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "weight", label: "Weight", type: "number", unit: "kg", required: true },
        { id: "current", label: "Current sodium", type: "number", unit: "mEq/L", required: true },
        { id: "infusate", label: "Infusate sodium", type: "number", unit: "mEq/L", required: true, default: 513 },
        { id: "rate", label: "Infusion rate", type: "number", unit: "mL/hr", required: true },
        { id: "tbw", label: "TBW fraction", type: "select", options: [{ value: 0.6, label: "0.6 adult male / child" }, { value: 0.5, label: "0.5 adult female / older male" }, { value: 0.45, label: "0.45 older female" }] },
      ],
      compute: ({ weight, current, infusate, rate, tbw }) => {
        const changePerLiter = (infusate - current) / (tbw * weight + 1);
        return { value: +(changePerLiter * (rate / 1000)).toFixed(2), unit: "mEq/L/hr", label: "Adrogue-Madias estimate per entered infusion rate." };
      },
    };
  }

  if (n.includes("water deficit") || n.includes("hypernatremia")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "weight", label: "Weight", type: "number", unit: "kg", required: true },
        { id: "sodium", label: "Current sodium", type: "number", unit: "mEq/L", required: true },
        { id: "target", label: "Target sodium", type: "number", unit: "mEq/L", required: true, default: 140 },
        { id: "tbw", label: "TBW fraction", type: "select", options: [{ value: 0.6, label: "0.6 adult male / child" }, { value: 0.5, label: "0.5 adult female / older male" }, { value: 0.45, label: "0.45 older female" }] },
      ],
      compute: ({ weight, sodium, target, tbw }) => ({ value: +(tbw * weight * ((sodium / target) - 1)).toFixed(2), unit: "L free water", label: "Water deficit = TBW x weight x ((Na/target Na)-1)." }),
    };
  }

  if (n.includes("osmolal gap") || n.includes("osmolality estimator")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "sodium", label: "Sodium", type: "number", unit: "mEq/L", required: true },
        { id: "glucose", label: "Glucose", type: "number", unit: "mg/dL", required: true },
        { id: "bun", label: "BUN", type: "number", unit: "mg/dL", required: true },
        { id: "ethanol", label: "Ethanol", type: "number", unit: "mg/dL", default: 0 },
        { id: "measured", label: "Measured osmolality", type: "number", unit: "mOsm/kg", default: 0 },
      ],
      compute: ({ sodium, glucose, bun, ethanol = 0, measured = 0 }) => {
        const calc = 2 * sodium + glucose / 18 + bun / 2.8 + ethanol / 3.7;
        const gap = measured > 0 ? measured - calc : 0;
        return { value: measured > 0 ? +gap.toFixed(1) : +calc.toFixed(1), unit: measured > 0 ? "mOsm/kg gap" : "mOsm/kg", label: measured > 0 ? `Calculated osmolality ${calc.toFixed(1)}` : "Calculated serum osmolality." };
      },
    };
  }

  if (n.includes("fractional excretion of sodium")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "una", label: "Urine sodium", type: "number", unit: "mEq/L", required: true },
        { id: "pna", label: "Plasma sodium", type: "number", unit: "mEq/L", required: true },
        { id: "ucr", label: "Urine creatinine", type: "number", required: true },
        { id: "pcr", label: "Plasma creatinine", type: "number", required: true },
      ],
      compute: ({ una, pna, ucr, pcr }) => ({ value: +(((una * pcr) / (pna * ucr)) * 100).toFixed(2), unit: "%", label: "FENa = (UNa x PCr)/(PNa x UCr) x 100." }),
    };
  }

  if (n.includes("transtubular potassium gradient")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "urineK", label: "Urine potassium", type: "number", unit: "mEq/L", required: true },
        { id: "serumK", label: "Serum potassium", type: "number", unit: "mEq/L", required: true },
        { id: "urineOsm", label: "Urine osmolality", type: "number", unit: "mOsm/kg", required: true },
        { id: "serumOsm", label: "Serum osmolality", type: "number", unit: "mOsm/kg", required: true },
      ],
      compute: ({ urineK, serumK, urineOsm, serumOsm }) => ({ value: +((urineK / serumK) / (urineOsm / serumOsm)).toFixed(1), unit: "", label: "TTKG = (urine K / serum K) / (urine Osm / serum Osm)." }),
    };
  }

  if (n.includes("fractional excretion of urate")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "uurate", label: "Urine urate", type: "number", required: true },
        { id: "purate", label: "Plasma urate", type: "number", required: true },
        { id: "ucr", label: "Urine creatinine", type: "number", required: true },
        { id: "pcr", label: "Plasma creatinine", type: "number", required: true },
      ],
      compute: ({ uurate, purate, ucr, pcr }) => ({ value: +(((uurate * pcr) / (purate * ucr)) * 100).toFixed(2), unit: "%", label: "FE urate = (U urate x P creatinine)/(P urate x U creatinine) x 100." }),
    };
  }

  if (n.includes("creatinine clearance measured")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "urineCr", label: "Urine creatinine", type: "number", required: true },
        { id: "volume", label: "Urine volume", type: "number", unit: "mL", required: true },
        { id: "serumCr", label: "Serum creatinine", type: "number", required: true },
        { id: "minutes", label: "Collection duration", type: "number", unit: "minutes", required: true, default: 1440 },
      ],
      compute: ({ urineCr, volume, serumCr, minutes }) => ({ value: +((urineCr * volume) / (serumCr * minutes)).toFixed(1), unit: "mL/min", label: "Measured CrCl = UCr x volume / (SCr x collection minutes)." }),
    };
  }

  if (n.includes("cockcroft") && n.includes("with ibw")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "creatinine", label: "Serum creatinine", type: "number", unit: n.includes("si units") ? "umol/L" : "mg/dL", required: true, step: 0.01 },
        { id: "age", label: "Age", type: "number", unit: "years", required: true },
        { id: "height", label: "Height", type: "number", unit: "cm", required: true },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      ],
      compute: ({ creatinine, age, height, sex }) => {
        const cr = n.includes("si units") ? creatinine / 88.4 : creatinine;
        const inches = height / 2.54;
        const ibw = (sex === 1 ? 50 : 45.5) + 2.3 * Math.max(0, inches - 60);
        const cl = ((140 - age) * ibw * (sex === 0 ? 0.85 : 1)) / (72 * cr);
        return { value: +cl.toFixed(0), unit: "mL/min", label: `IBW ${ibw.toFixed(1)} kg used in Cockcroft-Gault.` };
      },
    };
  }

  if (n.includes("cystatin c") && !n.includes("w cystatin")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "cystatin", label: "Cystatin C", type: "number", unit: "mg/L", required: true, step: 0.01 },
        { id: "age", label: "Age", type: "number", unit: "years", required: true },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      ],
      compute: ({ cystatin, age, sex }) => {
        const x = cystatin / 0.8;
        const egfr = 133 * Math.pow(Math.min(x, 1), -0.499) * Math.pow(Math.max(x, 1), -1.328) * Math.pow(0.996, age) * (sex === 0 ? 0.932 : 1);
        return { value: +egfr.toFixed(0), unit: "mL/min/1.73m²", label: "CKD-EPI 2012 cystatin C equation." };
      },
    };
  }

  if (n.includes("w cystatin")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "creatinine", label: "Serum creatinine", type: "number", unit: "mg/dL", required: true, step: 0.01 },
        { id: "cystatin", label: "Cystatin C", type: "number", unit: "mg/L", required: true, step: 0.01 },
        { id: "age", label: "Age", type: "number", unit: "years", required: true },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      ],
      compute: ({ creatinine: cr, cystatin, age, sex }) => {
        const k = sex === 1 ? 0.9 : 0.7;
        const a = sex === 1 ? -0.219 : -0.248;
        const scr = cr / k;
        const scys = cystatin / 0.8;
        const egfr = 135 * Math.pow(Math.min(scr, 1), a) * Math.pow(Math.max(scr, 1), -0.544) * Math.pow(Math.min(scys, 1), -0.323) * Math.pow(Math.max(scys, 1), -0.778) * Math.pow(0.9961, age) * (sex === 0 ? 0.963 : 1);
        return { value: +egfr.toFixed(0), unit: "mL/min/1.73m²", label: "CKD-EPI 2021 creatinine-cystatin C equation." };
      },
    };
  }

  if ((n.includes("ckd epi") || n.includes("glomerular filtration rate by ckd")) && !n.includes("cystatin")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "creatinine", label: "Serum creatinine", type: "number", unit: "mg/dL", required: true, step: 0.01 },
        { id: "age", label: "Age", type: "number", unit: "years", required: true },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      ],
      compute: ({ creatinine: cr, age, sex }) => {
        const k = sex === 1 ? 0.9 : 0.7;
        const a = sex === 1 ? -0.302 : -0.241;
        const x = cr / k;
        const egfr = 142 * Math.pow(Math.min(x, 1), a) * Math.pow(Math.max(x, 1), -1.2) * Math.pow(0.9938, age) * (sex === 0 ? 1.012 : 1);
        return { value: +egfr.toFixed(0), unit: "mL/min/1.73m²", label: "2021 CKD-EPI creatinine equation." };
      },
    };
  }

  if (n.includes("mdrd")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "creatinine", label: "Serum creatinine", type: "number", unit: "mg/dL", required: true, step: 0.01 },
        { id: "age", label: "Age", type: "number", unit: "years", required: true },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
        { id: "black", label: "Black race coefficient", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      ],
      compute: ({ creatinine, age, sex, black }) => ({ value: +(175 * Math.pow(creatinine, -1.154) * Math.pow(age, -0.203) * (sex === 0 ? 0.742 : 1) * (black ? 1.212 : 1)).toFixed(0), unit: "mL/min/1.73m²", label: "MDRD IDMS-traceable equation." }),
    };
  }

  if (n.includes("schwartz")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "height", label: "Height", type: "number", unit: "cm", required: true },
        { id: "creatinine", label: "Serum creatinine", type: "number", unit: "mg/dL", required: true, step: 0.01 },
        { id: "k", label: "Schwartz constant", type: "select", options: [{ value: 0.413, label: "0.413 bedside Schwartz" }, { value: 0.55, label: "0.55 child/adolescent female" }, { value: 0.7, label: "0.70 adolescent male" }] },
      ],
      compute: ({ height, creatinine, k }) => ({ value: +((k * height) / creatinine).toFixed(0), unit: "mL/min/1.73m²", label: "Schwartz eGFR = k x height / SCr." }),
    };
  }

  if (n.includes("adjusted body weight")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "actual", label: "Actual body weight", type: "number", unit: "kg", required: true },
        { id: "ideal", label: "Ideal body weight", type: "number", unit: "kg", required: true },
        { id: "factor", label: "Correction factor", type: "select", options: [{ value: 0.4, label: "0.4 common dosing factor" }, { value: 0.3, label: "0.3" }, { value: 0.5, label: "0.5" }] },
      ],
      compute: ({ actual, ideal, factor }) => ({ value: +(ideal + factor * (actual - ideal)).toFixed(1), unit: "kg", label: "AdjBW = IBW + factor x (actual - IBW)." }),
    };
  }

  if (n.includes("basal energy")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "weight", label: "Weight", type: "number", unit: "kg", required: true },
        { id: "height", label: "Height", type: "number", unit: "cm", required: true },
        { id: "age", label: "Age", type: "number", unit: "years", required: true },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      ],
      compute: ({ weight, height, age, sex }) => {
        const kcal = sex === 1 ? 88.362 + 13.397 * weight + 4.799 * height - 5.677 * age : 447.593 + 9.247 * weight + 3.098 * height - 4.33 * age;
        return { value: +kcal.toFixed(0), unit: "kcal/day", label: "Harris-Benedict basal energy estimate." };
      },
    };
  }

  if ((n.includes("ideal body weight") || n.includes("dosing weight")) && !n.includes("pediatric")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "height", label: "Height", type: "number", unit: "cm", required: true },
        { id: "actual", label: "Actual body weight", type: "number", unit: "kg", default: 0 },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      ],
      compute: ({ height, actual = 0, sex }) => {
        const inches = height / 2.54;
        const ibw = (sex === 1 ? 50 : 45.5) + 2.3 * Math.max(0, inches - 60);
        const pct = actual > 0 ? (actual / ibw) * 100 : 0;
        return { value: +ibw.toFixed(1), unit: "kg IBW", label: actual > 0 ? `Actual body weight is ${pct.toFixed(0)}% of IBW.` : "Devine adult IBW." };
      },
    };
  }

  if (n.includes("lean body weight")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "weight", label: "Weight", type: "number", unit: "kg", required: true },
        { id: "height", label: "Height", type: "number", unit: "cm", required: true },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      ],
      compute: ({ weight, height, sex }) => {
        const bmi = weight / Math.pow(height / 100, 2);
        const lbw = sex === 1 ? (9270 * weight) / (6680 + 216 * bmi) : (9270 * weight) / (8780 + 244 * bmi);
        return { value: +lbw.toFixed(1), unit: "kg", label: "Janmahasatian lean body weight estimate." };
      },
    };
  }

  if (n.includes("du bois")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "weight", label: "Weight", type: "number", unit: "kg", required: true },
        { id: "height", label: "Height", type: "number", unit: "cm", required: true },
      ],
      compute: ({ weight, height }) => ({ value: +(0.007184 * Math.pow(weight, 0.425) * Math.pow(height, 0.725)).toFixed(2), unit: "m²", label: "Du Bois BSA formula." }),
    };
  }

  if (n.includes("gehan")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "weight", label: "Weight", type: "number", unit: "kg", required: true },
        { id: "height", label: "Height", type: "number", unit: "cm", required: true },
      ],
      compute: ({ weight, height }) => ({ value: +(0.0235 * Math.pow(height, 0.42246) * Math.pow(weight, 0.51456)).toFixed(2), unit: "m²", label: "Gehan and George BSA formula." }),
    };
  }

  if (n.includes("maintenance fluid")) {
    return {
      id, name: title, category, description,
      fields: [{ id: "weight", label: "Weight", type: "number", unit: "kg", required: true }],
      compute: ({ weight }) => {
        const hourly = weight <= 10 ? 4 * weight : weight <= 20 ? 40 + 2 * (weight - 10) : 60 + weight - 20;
        return { value: +hourly.toFixed(0), unit: "mL/hr", label: `${(hourly * 24).toFixed(0)} mL/day by 4-2-1 rule.` };
      },
    };
  }

  if (n.includes("dose") || n.includes("dosing") || n.includes("infusion") || n.includes("drip") || n.includes("weight based") || category.includes("Dosing")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "weight", label: "Weight", type: "number", unit: "kg", required: true },
        { id: "dose", label: "Ordered dose", type: "number", unit: "mcg/kg/min", required: true },
        { id: "concentration", label: "Concentration", type: "number", unit: "mg/mL", required: true },
      ],
      compute: ({ weight, dose, concentration }) => ({ value: +((dose * weight * 60) / (concentration * 1000)).toFixed(2), unit: "mL/hr", label: "Rate for mcg/kg/min order with mg/mL concentration. Adjust units before use." }),
    };
  }

  if (n.includes("pharmacokinetic") || n.includes("level prediction") || n.includes("peak") || n.includes("trough") || n.includes("aminoglycoside") || n.includes("vancomycin")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "peak", label: "Peak level", type: "number", required: true },
        { id: "trough", label: "Trough level", type: "number", required: true },
        { id: "hours", label: "Hours between levels", type: "number", unit: "hours", required: true },
      ],
      compute: ({ peak, trough, hours }) => {
        const ke = Math.log(peak / trough) / hours;
        return { value: +(0.693 / ke).toFixed(2), unit: "hours half-life", label: `Elimination rate constant ${ke.toFixed(4)} hr^-1.` };
      },
    };
  }

  if (n.includes("chads2")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "chf", label: "CHF", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
        { id: "htn", label: "Hypertension", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
        { id: "age", label: "Age >=75", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
        { id: "dm", label: "Diabetes", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
        { id: "stroke", label: "Prior stroke/TIA", type: "select", options: [{ value: 0, label: "No" }, { value: 2, label: "Yes" }] },
      ],
      compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points" }),
    };
  }

  if (n.includes("has bled")) {
    return {
      id, name: title, category, description,
      fields: ["Hypertension", "Abnormal renal/liver function", "Stroke", "Bleeding", "Labile INR", "Elderly", "Drugs/alcohol"].map((label, index) => ({
        id: `risk${index}`, label, type: "select" as const, options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }],
      })),
      compute: (v) => ({ value: Object.values(v).reduce((a, b) => a + b, 0), unit: "points", label: "Higher scores indicate higher bleeding risk." }),
    };
  }

  if (n.includes("henderson")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "bicarb", label: "Bicarbonate", type: "number", unit: "mEq/L", required: true },
        { id: "pco2", label: "pCO2", type: "number", unit: "mmHg", required: true },
      ],
      compute: ({ bicarb, pco2 }) => ({ value: +(6.1 + Math.log10(bicarb / (0.03 * pco2))).toFixed(2), unit: "pH", label: "Henderson-Hasselbalch: pH = 6.1 + log(HCO3/(0.03 x pCO2))." }),
    };
  }

  if (n.includes("phenytoin") && n.includes("free")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "total", label: "Total phenytoin", type: "number", unit: "mcg/mL", required: true },
        { id: "albumin", label: "Albumin", type: "number", unit: "g/dL", required: true, step: 0.1 },
        { id: "renal", label: "Renal failure/uremia", type: "select", options: [{ value: 0, label: "No" }, { value: 1, label: "Yes" }] },
      ],
      compute: ({ total, albumin, renal }) => {
        const corrected = total / ((renal ? 0.1 : 0.2) * albumin + 0.1);
        return { value: +corrected.toFixed(1), unit: "mcg/mL corrected total", label: "Sheiner-Tozer correction." };
      },
    };
  }

  if (n.includes("protein excretion")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "protein", label: "Urine protein", type: "number", unit: "mg/dL", required: true },
        { id: "creatinine", label: "Urine creatinine", type: "number", unit: "mg/dL", required: true },
      ],
      compute: ({ protein, creatinine }) => ({ value: +((protein / creatinine) * 1000).toFixed(0), unit: "mg/g creatinine", label: "Spot urine protein/creatinine estimate." }),
    };
  }

  if (n.includes("temperature")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "value", label: "Temperature", type: "number", required: true, step: 0.1 },
        { id: "direction", label: "Convert", type: "select", options: [{ value: 0, label: "C to F" }, { value: 1, label: "F to C" }] },
      ],
      compute: ({ value, direction }) => direction === 0 ? { value: +((value * 9) / 5 + 32).toFixed(1), unit: "°F" } : { value: +(((value - 32) * 5) / 9).toFixed(1), unit: "°C" },
    };
  }

  if (n === "unit conversions length") {
    return { id, name: title, category, description, fields: [{ id: "cm", label: "Centimeters", type: "number", unit: "cm", required: true }], compute: ({ cm }) => ({ value: +(cm / 2.54).toFixed(2), unit: "inches" }) };
  }

  if (n === "unit conversions weight") {
    return { id, name: title, category, description, fields: [{ id: "kg", label: "Kilograms", type: "number", unit: "kg", required: true }], compute: ({ kg }) => ({ value: +(kg * 2.20462).toFixed(2), unit: "lb" }) };
  }

  if (n.includes("growth") || n.includes("percentile") || n.includes("who ") || n.includes("cdc ")) {
    return {
      id, name: title, category, description,
      fields: [
        { id: "age", label: "Age", type: "number", unit: "months", required: true },
        { id: "measurement", label: "Measurement", type: "number", required: true },
        { id: "sex", label: "Sex", type: "select", options: [{ value: 0, label: "Female" }, { value: 1, label: "Male" }] },
      ],
      compute: ({ age, measurement }) => ({ value: `${measurement} at ${age} months`, unit: "", label: "Growth percentile lookup tables are not embedded; value is captured for note export." }),
    };
  }

  if (liveFields.length > 0) {
    return {
      id, name: title, category, description,
      layout: liveFields.some(field => field.section) || n.includes("criteria") ? "criteria" : "standard",
      fields: liveFields,
      compute: (vals) => {
        const entered = liveFields
          .filter(field => vals[field.id] !== undefined)
          .map(field => `${field.label}: ${vals[field.id]}${field.unit ? ` ${field.unit}` : ""}`)
          .join("; ");
        return { value: "Reference only", unit: "", label: entered ? `No equation embedded. Inputs: ${entered}` : "This catalog entry has no embedded equation — the worksheet captures values for note export only." };
      },
      details: {
        usedFor: description,
        interpretation: "This live catalog entry has its original input structure available, but its equation is not yet implemented as a native MedOS calculator.",
        cautions: ["Use this worksheet for structured note capture only until a native equation is added."],
        formula: "Native equation pending.",
      },
    };
  }

  return {
    id, name: title, category, description,
    fields: [
      { id: "input1", label: "Primary value", type: "number", required: true, step: 0.01 },
      { id: "input2", label: "Secondary value", type: "number", default: 0, step: 0.01 },
    ],
    compute: () => ({ value: "Reference only", unit: "", label: "No equation embedded — this worksheet captures values for note export only." }),
  };
}

function CalcComposeWindow({
  calc,
  mode,
  onMode,
  onClose,
  onOpenFull,
}: {
  calc: CalcDef;
  mode: CalcWindowMode;
  onMode: (mode: CalcWindowMode) => void;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  if (mode === "minimized") {
    return (
      <button
        className="calc-compose-minimized"
        onClick={() => onMode("dock")}
        style={{
          position: "fixed",
          right: 22,
          bottom: 0,
          zIndex: 120,
          width: "min(360px, calc(100vw - 92px))",
          height: 42,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 12px",
          background: "var(--text-primary)",
          color: "var(--bg-base)",
          border: "1px solid var(--text-primary)",
          borderRadius: "8px 8px 0 0",
          boxShadow: "0 -8px 28px rgba(15,23,42,0.18)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <Calculator size={15} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 700 }}>
          {calc.name}
        </span>
        <Maximize2 size={14} />
      </button>
    );
  }

  const expanded = mode === "expanded";
  return (
    <div
      className={`calc-compose-window ${expanded ? "is-expanded" : "is-docked"}`}
      role="dialog"
      aria-modal={expanded}
      style={{
        position: "fixed",
        zIndex: 120,
        right: expanded ? 84 : 84,
        bottom: expanded ? 18 : 18,
        width: expanded ? "min(920px, calc(100vw - 120px))" : "min(460px, calc(100vw - 120px))",
        height: expanded ? "min(760px, calc(100vh - 58px))" : "auto",
        maxHeight: "calc(100vh - 58px)",
        background: "var(--bg-base)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 24px 70px rgba(15,23,42,0.28)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ height: 44, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", background: "var(--text-primary)", color: "var(--bg-base)", flexShrink: 0 }}>
        <Calculator size={15} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{calc.name}</span>
        <button title="Open full guide" onClick={onOpenFull} style={{ width: 48, height: 28, display: "grid", placeItems: "center", background: "rgba(255,255,255,0.10)", border: "none", borderRadius: 6, cursor: "pointer", color: "inherit", fontSize: 11, fontWeight: 900 }}>
          Guide
        </button>
        <button title="Minimize" onClick={() => onMode("minimized")} style={{ width: 28, height: 28, display: "grid", placeItems: "center", background: "transparent", border: "none", borderRadius: 6, cursor: "pointer", color: "inherit" }}>
          <Minimize2 size={14} />
        </button>
        <button title={expanded ? "Dock bottom right" : "Expand"} onClick={() => onMode(expanded ? "dock" : "expanded")} style={{ width: 28, height: 28, display: "grid", placeItems: "center", background: "transparent", border: "none", borderRadius: 6, cursor: "pointer", color: "inherit" }}>
          <Maximize2 size={14} />
        </button>
        <button title="Close" onClick={onClose} style={{ width: 28, height: 28, display: "grid", placeItems: "center", background: "transparent", border: "none", borderRadius: 6, cursor: "pointer", color: "inherit" }}>
          <X size={15} />
        </button>
      </div>
      <CalcView calc={calc} onBack={onClose} compact />
    </div>
  );
}

export default function CalculatorHub({ initialLexiCalcs = [] }: { initialLexiCalcs?: LexiCalc[] }) {
  const searchParams = useSearchParams();
  const [activeCalc, setActiveCalc] = useState<CalcDef | null>(null);
  const [guideCalc, setGuideCalc] = useState<CalcDef | null>(null);
  const [calcWindowMode, setCalcWindowMode] = useState<CalcWindowMode>("dock");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [nativeFavorites, setNativeFavorites] = useState<Set<string>>(new Set());
  const [lexiFavorites, setLexiFavorites] = useState<Set<string>>(new Set());
  const [shortcutTargets, setShortcutTargets] = useState<ShortcutTarget[]>(DEFAULT_SHORTCUT_TARGETS);
  const [lexiCalcs, setLexiCalcs] = useState<LexiCalc[]>(initialLexiCalcs);
  const [lexiLoading, setLexiLoading] = useState(initialLexiCalcs.length === 0);

  function openCalc(calc: CalcDef, mode: CalcWindowMode = "dock") {
    setActiveCalc(calc);
    setCalcWindowMode(mode);
    recordRecent({
      tag: "CALC",
      label: calc.name,
      href: `/calculators?q=${encodeURIComponent(calc.name)}`,
      source: "calculators",
      kind: "calculator",
      detail: calc.category,
    });
  }

  function openGuide(calc: CalcDef) {
    setGuideCalc(calc);
    recordRecent({
      tag: "CALC",
      label: `${calc.name} guide`,
      href: `/calculators?calc=${encodeURIComponent(calc.id)}`,
      source: "calculators",
      kind: "calculator-guide",
      detail: calc.category,
    });
  }

  useEffect(() => {
    const initial = searchParams.get("q");
    if (initial) setSearch(initial);
  }, [searchParams]);

  useEffect(() => {
    setNativeFavorites(readStoredSet("medos.calc.nativeFavorites"));
    setLexiFavorites(readStoredSet("medos.calc.lexiFavorites"));
    setShortcutTargets(readShortcutTargets());
  }, []);

  useEffect(() => {
    function syncShortcuts() {
      setShortcutTargets(readShortcutTargets());
    }
    window.addEventListener("medos:calc-shortcuts-changed", syncShortcuts);
    return () => window.removeEventListener("medos:calc-shortcuts-changed", syncShortcuts);
  }, []);

  useEffect(() => {
    function syncFavorites() {
      setNativeFavorites(readStoredSet("medos.calc.nativeFavorites"));
      setLexiFavorites(readStoredSet("medos.calc.lexiFavorites"));
    }
    window.addEventListener("medos:calc-favorites-changed", syncFavorites);
    return () => window.removeEventListener("medos:calc-favorites-changed", syncFavorites);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadLexiCalcs() {
      if (initialLexiCalcs.length > 0) return;
      setLexiLoading(true);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      try {
        let r = await fetch(`/api/lexi-calc/list?limit=1500`, { cache: "no-store", signal: controller.signal });
        if (!r.ok) {
          r = await fetch(`${getBackendUrl()}/lexi/calc/list?limit=1000`, { cache: "no-store", signal: controller.signal });
        }
        const d = await r.json();
        if (!cancelled) setLexiCalcs(d?.results || []);
      } catch {
        if (!cancelled) setLexiCalcs([]);
      } finally {
        window.clearTimeout(timeout);
        if (!cancelled) setLexiLoading(false);
      }
    }
    loadLexiCalcs();
    return () => { cancelled = true; };
  }, [initialLexiCalcs.length]);

  function toggleNativeFavorite(id: string) {
    setNativeFavorites(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      window.localStorage.setItem("medos.calc.nativeFavorites", JSON.stringify([...next]));
      window.dispatchEvent(new CustomEvent("medos:calc-favorites-changed"));
      return next;
    });
  }

  function toggleLexiFavorite(id: string) {
    setLexiFavorites(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      window.localStorage.setItem("medos.calc.lexiFavorites", JSON.stringify([...next]));
      window.dispatchEvent(new CustomEvent("medos:calc-favorites-changed"));
      return next;
    });
  }

  function toggleCombinedFavorite(item: CombinedCalc) {
    if (item.lexi) toggleLexiFavorite(item.lexi.id);
    else if (item.native) toggleNativeFavorite(item.native.id);
  }

  function setShortcutTarget(index: number, target: string) {
    setShortcutTargets(prev => {
      const next = DEFAULT_SHORTCUT_TARGETS.map((fallback, i) => prev[i] || fallback);
      next[index] = target;
      window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(next.slice(0, 10)));
      window.dispatchEvent(new CustomEvent("medos:calc-shortcuts-changed"));
      return next;
    });
  }

  const combinedCalcs = useMemo<CombinedCalc[]>(() => {
    const usedNative = new Set<string>();
    const rows: CombinedCalc[] = lexiCalcs.map(lexi => {
      const mdcalcGenerated = lexi.source === "mdcalc-live" && lexi.equationLogicText
        ? enhanceCalculator(generatedLexiCalculator(lexi))
        : undefined;
      const native = mdcalcGenerated || findNativeMatch(lexi.title) || enhanceCalculator(generatedLexiCalculator(lexi));
      if (native) usedNative.add(native.id);
      const categories = [...new Set([
        ...(lexi.categories?.length ? lexi.categories : [lexi.category || "Lexi Calculator"]),
        native.category,
      ].filter(Boolean))];
      return {
        key: `lexi:${lexi.id}`,
        title: lexi.title,
        category: lexi.category || native.category || "Lexi Calculator",
        categories,
        description: native.description,
        native,
        lexi,
      };
    });

    CALCULATORS.forEach(native => {
      if (usedNative.has(native.id)) return;
      rows.push({
        key: `native:${native.id}`,
        title: native.name,
        category: native.category,
        categories: [native.category],
        description: native.description,
        native,
      });
    });

    return rows.sort((a, b) => a.title.localeCompare(b.title));
  }, [lexiCalcs]);

  useEffect(() => {
    const calcParam = searchParams.get("calc");
    if (!calcParam || combinedCalcs.length === 0) return;
    const normalized = normalizeCalcText(calcParam);
    const item = combinedCalcs.find(row =>
      row.native?.id === calcParam ||
      normalizeCalcText(row.title) === normalized ||
      normalizeCalcText(row.native?.name || "") === normalized
    );
    if (item?.native) setGuideCalc(item.native);
  }, [combinedCalcs, searchParams]);

  const categoryOptions = useMemo(() => {
    const names = new Set<string>();
    combinedCalcs.forEach(c => c.categories.forEach(cat => cat && names.add(cat)));
    return ["All", ...[...names].sort((a, b) => a.localeCompare(b))];
  }, [combinedCalcs]);

  const filteredCombined = useMemo(() => {
    const q = normalizeCalcText(search);
    const tokens = q.split(" ").filter(Boolean);
    const score = (c: CombinedCalc) => {
      const title = normalizeCalcText(c.title);
      if (!q) return 0;
      if (title === q) return 0;
      if (title.includes(q)) return 1;
      if (tokens.length && tokens.every(token => title.includes(token))) return 2;
      if (tokens.length && tokens.some(token => title.includes(token))) return 3;
      return 4;
    };
    return combinedCalcs.filter(c => {
      const categoryMatch = category === "All" || c.categories.includes(category) || c.category === category;
      const text = normalizeCalcText([c.title, c.description, c.category, ...c.categories].join(" "));
      const searchMatch = !q || tokens.every(token => text.includes(token));
      return categoryMatch && searchMatch;
    }).sort((a, b) => score(a) - score(b) || a.title.localeCompare(b.title));
  }, [combinedCalcs, search, category]);

  const groupedFiltered = useMemo(() => {
    const groups = new Map<string, CombinedCalc[]>();
    filteredCombined.forEach(item => {
      const groupName = category === "All" ? (item.category || item.categories[0] || "General / Other") : category;
      const items = groups.get(groupName) || [];
      items.push(item);
      groups.set(groupName, items);
    });
    return [...groups.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredCombined, category]);

  const favoriteCalcs = useMemo(() =>
    combinedCalcs.filter(c =>
      (c.lexi && lexiFavorites.has(c.lexi.id)) ||
      (!c.lexi && c.native && nativeFavorites.has(c.native.id))
    ),
  [combinedCalcs, lexiFavorites, nativeFavorites]);

  const targetByKey = useMemo(() => {
    const map = new Map<string, CombinedCalc>();
    combinedCalcs.forEach(item => {
      if (item.lexi) map.set(`lexi:${item.lexi.id}`, item);
      if (item.native) map.set(`native:${item.native.id}`, item);
    });
    return map;
  }, [combinedCalcs]);

  const shortcutOptions = useMemo(() => {
    const favorites = combinedCalcs.filter(item =>
      (item.lexi && lexiFavorites.has(item.lexi.id)) ||
      (!item.lexi && item.native && nativeFavorites.has(item.native.id))
    );
    const rest = combinedCalcs.filter(item => !favorites.includes(item));
    return [...favorites, ...rest];
  }, [combinedCalcs, lexiFavorites, nativeFavorites]);

  function openShortcutTarget(target: string) {
    const item = targetByKey.get(target);
    if (item?.native) openCalc(item.native);
  }

  function renderCombinedCard(item: CombinedCalc) {
    const isFavorite = item.lexi ? lexiFavorites.has(item.lexi.id) : !!item.native && nativeFavorites.has(item.native.id);
    return (
      <div
        key={item.key}
        data-mcalc-page-card="combined"
        data-mcalc-page-category-value={item.categories.join("|||")}
        data-mcalc-page-search-text={`${item.title} ${item.description} ${item.category} ${item.categories.join(" ")}`}
        data-medos-calc={undefined}
        data-medos-lexi-calc={!item.native && item.lexi ? item.lexi.id : undefined}
        data-medos-lexi-title={item.lexi?.title}
        data-medos-lexi-subtitle={item.lexi?.subtitle}
        data-medos-lexi-category={item.lexi?.category}
        data-medos-lexi-description={item.lexi?.description}
        role="button"
        tabIndex={0}
        onClick={() => item.native && openGuide(item.native)}
        onKeyDown={e => {
          if (!item.native) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openGuide(item.native);
          }
        }}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "14px 16px",
          cursor: item.native ? "pointer" : "default",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
          {item.native ? <Calculator size={15} color="var(--accent)" style={{ marginTop: 1, flexShrink: 0 }} /> : <Database size={15} color="var(--accent)" style={{ marginTop: 1, flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.25 }}>{item.title}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
              {item.native ? "Executable calculator" : "Lexi database entry"}
            </div>
          </div>
          <button
            data-medos-favorite-button="true"
            title={isFavorite ? "Remove favorite" : "Add favorite"}
            onClick={e => {
              e.stopPropagation();
              toggleCombinedFavorite(item);
            }}
            style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: "transparent", border: "none", cursor: "pointer", color: isFavorite ? "var(--amber)" : "var(--text-muted)" }}
          >
            <Star size={14} fill={isFavorite ? "currentColor" : "none"} />
          </button>
        </div>
        <span className="tag tag-gray" style={{ fontSize: 10, marginBottom: 6 }}>{item.category}</span>
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45, marginTop: 6 }}>{item.description}</p>
        {item.native && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); openGuide(item.native!); }}
              style={{ flex: 1, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--text-primary)", color: "var(--bg-base)", fontSize: 11, fontWeight: 900, cursor: "pointer" }}
            >
              Guide
            </button>
            <button
              type="button"
              data-medos-calc={item.native.id}
              onClick={e => { e.stopPropagation(); openCalc(item.native!); }}
              style={{ flex: 1, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: 11, fontWeight: 900, cursor: "pointer" }}
            >
              Quick
            </button>
          </div>
        )}
      </div>
    );
  }

  if (guideCalc) {
    const isFavorite = nativeFavorites.has(guideCalc.id);
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <FullCalculatorGuide
          calc={guideCalc}
          onBack={() => setGuideCalc(null)}
          isFavorite={isFavorite}
          onToggleFavorite={() => toggleNativeFavorite(guideCalc.id)}
          onPopOut={() => openCalc(guideCalc)}
        />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", background: "var(--bg-card)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Calculator size={16} color="var(--accent)" />
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Medical Calculators</h2>
          <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>
            {combinedCalcs.length} total · {lexiCalcs.length} from live catalogs
          </span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1, position: "relative" }}>
            <Search size={13} color="var(--text-muted)" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
            <input data-mcalc-page-search value={search} onChange={e => setSearch(e.target.value)} placeholder="Search all calculators..."
              style={{ width: "100%", padding: "7px 10px 7px 30px", fontSize: 13 }} />
            {search && (
              <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}>
                <X size={12} />
              </button>
            )}
          </div>
          <select data-mcalc-page-category value={category} onChange={e => setCategory(e.target.value)} style={{ padding: "7px 10px", fontSize: 13 }}>
            {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8, marginBottom: 10 }}>
          {DEFAULT_SHORTCUT_TARGETS.map((_, i) => {
            const target = shortcutTargets[i] || DEFAULT_SHORTCUT_TARGETS[i];
            const item = targetByKey.get(target);
            return (
            <button
              key={`${i}:${target}`}
              data-medos-calc={item?.native?.id}
              data-medos-lexi-calc={!item?.native && item?.lexi ? item.lexi.id : undefined}
              data-medos-lexi-title={item?.lexi?.title}
              data-medos-lexi-subtitle={item?.lexi?.subtitle}
              data-medos-lexi-category={item?.lexi?.category}
              data-medos-lexi-description={item?.lexi?.description}
              onClick={() => openShortcutTarget(target)}
              title={`Ctrl+Alt+${i === 9 ? 0 : i + 1} or Alt+Shift+${i === 9 ? 0 : i + 1}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minHeight: 42,
                padding: "9px 10px",
                textAlign: "left",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              <Keyboard size={14} color="var(--accent)" />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item?.title || "Calculator"}</span>
              <kbd style={{ fontSize: 10, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 5px", background: "var(--bg-base)" }}>
                {i === 9 ? "0" : i + 1}
              </kbd>
            </button>
          );})}
        </div>

        <details style={{ marginBottom: 16, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", padding: "9px 12px" }}>
          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 800, color: "var(--text-secondary)" }}>Customize the 10 global shortcut slots</summary>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 8, marginTop: 10 }}>
            {DEFAULT_SHORTCUT_TARGETS.map((_, i) => (
              <label key={i} style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr)", alignItems: "center", gap: 6 }}>
                <kbd style={{ fontSize: 10, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 6px", background: "var(--bg-base)", textAlign: "center" }}>{i === 9 ? "0" : i + 1}</kbd>
                <select
                  value={shortcutTargets[i] || DEFAULT_SHORTCUT_TARGETS[i]}
                  onChange={e => setShortcutTarget(i, e.target.value)}
                  style={{ width: "100%", minWidth: 0, padding: "7px 9px", fontSize: 12 }}
                >
                  {shortcutOptions.map(item => {
                    const value = item.lexi ? `lexi:${item.lexi.id}` : `native:${item.native?.id}`;
                    return <option key={value} value={value}>{item.title}</option>;
                  })}
                </select>
              </label>
            ))}
          </div>
        </details>

        {favoriteCalcs.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, color: "var(--text-secondary)", fontSize: 12, fontWeight: 700 }}>
              <Star size={13} fill="currentColor" color="var(--amber)" /> Favorites
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {favoriteCalcs.map(item => (
                <button
                  key={item.key}
                  data-medos-calc={item.native?.id}
                  data-medos-lexi-calc={!item.native && item.lexi ? item.lexi.id : undefined}
                  data-medos-lexi-title={item.lexi?.title}
                  data-medos-lexi-subtitle={item.lexi?.subtitle}
                  data-medos-lexi-category={item.lexi?.category}
                  data-medos-lexi-description={item.lexi?.description}
                  onClick={() => item.native && openCalc(item.native)}
                  style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-card)", cursor: "pointer", fontSize: 12 }}
                >
                  {item.title}
                </button>
              ))}
            </div>
          </div>
        )}

        {lexiLoading ? (
          <p style={{ fontSize: 14, color: "var(--text-muted)", textAlign: "center", marginTop: 40 }}>Loading calculators from Lexi database...</p>
        ) : filteredCombined.length === 0 ? (
          <p style={{ fontSize: 14, color: "var(--text-muted)", textAlign: "center", marginTop: 40 }}>
            No calculators found for &ldquo;{search}&rdquo;
          </p>
        ) : (
          <div style={{ display: "grid", gap: 22 }}>
            {groupedFiltered.map(group => (
              <section key={group.name}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 9 }}>
                  <h3 style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)" }}>{group.name}</h3>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{group.items.length} calculators</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", gap: 10 }}>
                  {group.items.map(item => renderCombinedCard(item))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      {activeCalc && (
        <CalcComposeWindow
          calc={activeCalc}
          mode={calcWindowMode}
          onMode={setCalcWindowMode}
          onClose={() => setActiveCalc(null)}
          onOpenFull={() => {
            openGuide(activeCalc);
            setActiveCalc(null);
          }}
        />
      )}
    </div>
  );
}
