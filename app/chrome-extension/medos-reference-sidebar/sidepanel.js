const API_BASE = "http://127.0.0.1:8002";
const APP_BASE = "http://127.0.0.1:3000";
const LAST_REFERENCE_KEY = "medos:lastReference";
const LAST_SELECTION_KEY = "medos:lastSelection";
const SESSION_POLL_MS = 4000;   // poll backend session state every 4 s

// ── Lab reference values (matches QBank sidebar) ────────────────────────
const LAB_GROUPS = [
  {
    title: "Serum",
    subtitle: "Chemistry, liver, lipids, iron, endocrine, immunoglobulins",
    values: [
      { name: "Sodium (Na+)",           conventional: "136–146 mEq/L",                              si: "136–146 mmol/L" },
      { name: "Potassium (K+)",          conventional: "3.5–5.0 mEq/L",                              si: "3.5–5.0 mmol/L" },
      { name: "Chloride (Cl−)",          conventional: "95–105 mEq/L",                               si: "95–105 mmol/L" },
      { name: "Bicarbonate (HCO3−)",     conventional: "22–28 mEq/L",                                si: "22–28 mmol/L" },
      { name: "Urea nitrogen (BUN)",     conventional: "7–18 mg/dL",                                 si: "2.5–6.4 mmol/L" },
      { name: "Creatinine",              conventional: "0.6–1.2 mg/dL",                              si: "53–106 µmol/L" },
      { name: "Glucose, fasting",        conventional: "70–100 mg/dL",                               si: "3.8–5.6 mmol/L" },
      { name: "Glucose, random",         conventional: "<140 mg/dL",                                 si: "<7.77 mmol/L" },
      { name: "Calcium",                 conventional: "8.4–10.2 mg/dL",                             si: "2.1–2.6 mmol/L" },
      { name: "Magnesium",               conventional: "1.5–2.0 mg/dL",                              si: "0.75–1.0 mmol/L" },
      { name: "Phosphorus",              conventional: "3.0–4.5 mg/dL",                              si: "1.0–1.5 mmol/L" },
      { name: "ALT",                     conventional: "10–40 U/L",                                  si: "10–40 U/L" },
      { name: "AST",                     conventional: "12–38 U/L",                                  si: "12–38 U/L" },
      { name: "Alkaline phosphatase",    conventional: "25–100 U/L",                                 si: "25–100 U/L" },
      { name: "Bilirubin, total / direct", conventional: "0.1–1.0 / 0.0–0.3 mg/dL",               si: "2–17 / 0–5 µmol/L" },
      { name: "Albumin",                 conventional: "3.5–5.5 g/dL",                              si: "35–55 g/L" },
      { name: "Total cholesterol",       conventional: "Normal <200; high >240 mg/dL",               si: "<5.2; >6.2 mmol/L" },
      { name: "HDL / LDL",              conventional: "40–60 / <160 mg/dL",                         si: "1.0–1.6 / <4.2 mmol/L" },
      { name: "Triglycerides",           conventional: "Normal <150; borderline 151–199 mg/dL",      si: "<1.70; 1.71–2.25 mmol/L" },
      { name: "Ferritin, M / F",        conventional: "20–250 / 10–120 ng/mL",                      si: "20–250 / 10–120 µg/L" },
      { name: "Iron, M / F",            conventional: "65–175 / 50–170 µg/dL",                      si: "11.6–31.3 / 9.0–30.4 µmol/L" },
      { name: "TSH",                     conventional: "0.4–4.0 µU/mL",                             si: "0.4–4.0 mIU/L" },
      { name: "Free T4",                 conventional: "0.9–1.7 ng/dL",                             si: "12.0–21.9 pmol/L" },
      { name: "Intact PTH",              conventional: "10–60 pg/mL",                               si: "10–60 ng/L" },
      { name: "IgA / IgG / IgM",        conventional: "76–390 / 650–1500 / 50–300 mg/dL",          si: "0.76–3.90 / 6.5–15.0 / 0.5–3.0 g/L" },
    ],
  },
  {
    title: "Blood Gases & CSF",
    subtitle: "Arterial blood on room air plus cerebrospinal fluid",
    values: [
      { name: "Po2",              conventional: "75–105 mm Hg",       si: "10.0–14.0 kPa" },
      { name: "Pco2",             conventional: "33–45 mm Hg",        si: "4.4–5.9 kPa" },
      { name: "pH",               conventional: "7.35–7.45",          si: "[H+] 36–44 nmol/L" },
      { name: "CSF cell count",   conventional: "0–5/mm³",            si: "0–5 × 10⁶/L" },
      { name: "CSF chloride",     conventional: "118–132 mEq/L",      si: "118–132 mmol/L" },
      { name: "CSF glucose",      conventional: "40–70 mg/dL",        si: "2.2–3.9 mmol/L" },
      { name: "CSF pressure",     conventional: "70–180 mm H2O",      si: "70–180 mm H2O" },
      { name: "CSF protein",      conventional: "<40 mg/dL",          si: "<0.40 g/L" },
    ],
  },
  {
    title: "Hematologic & Coagulation",
    subtitle: "CBC, differential, red cell indices, coagulation",
    values: [
      { name: "Hematocrit, M / F",          conventional: "41–53% / 36–46%",               si: "0.41–0.53 / 0.36–0.46" },
      { name: "Hemoglobin, M / F",           conventional: "13.5–17.5 / 12.0–16.0 g/dL",  si: "135–175 / 120–160 g/L" },
      { name: "MCV",                         conventional: "80–100 µm³",                   si: "80–100 fL" },
      { name: "MCH",                         conventional: "25–35 pg/cell",                si: "0.39–0.54 fmol/cell" },
      { name: "MCHC",                        conventional: "31–36% Hb/cell",               si: "4.8–5.6 mmol Hb/L" },
      { name: "WBC",                         conventional: "4,500–11,000/mm³",             si: "4.5–11.0 × 10⁹/L" },
      { name: "Neutrophils (seg / bands)",   conventional: "54–62% / 3–5%",               si: "0.54–0.62 / 0.03–0.05" },
      { name: "Lymphocytes / monocytes",     conventional: "25–33% / 3–7%",               si: "0.25–0.33 / 0.03–0.07" },
      { name: "Eosinophils / basophils",     conventional: "1–3% / 0–0.75%",              si: "0.01–0.03 / 0.00–0.0075" },
      { name: "Platelet count",              conventional: "150,000–400,000/mm³",          si: "150–400 × 10⁹/L" },
      { name: "PTT / aPTT",                  conventional: "25–40 s",                      si: "25–40 s" },
      { name: "PT",                          conventional: "11–15 s",                      si: "11–15 s" },
      { name: "D-dimer",                     conventional: "≤250 ng/mL",                  si: "≤1.4 nmol/L" },
      { name: "Reticulocyte count",          conventional: "0.5–1.5%",                    si: "0.005–0.015" },
      { name: "RBC, M / F",                 conventional: "4.3–5.9 / 3.5–5.5 M/mm³",    si: "4.3–5.9 / 3.5–5.5 × 10¹²/L" },
      { name: "ESR, M / F",                 conventional: "0–15 / 0–20 mm/h",             si: "0–15 / 0–20 mm/h" },
      { name: "CD4+ T-lymphocyte",          conventional: "≥500/mm³",                    si: "≥0.5 × 10⁹/L" },
      { name: "Hemoglobin A1c",             conventional: "≤6%",                         si: "≤42 mmol/mol" },
    ],
  },
  {
    title: "Urine & Body Measures",
    subtitle: "Urine studies and BMI",
    values: [
      { name: "Urine calcium",    conventional: "100–300 mg/24 h",       si: "2.5–7.5 mmol/24 h" },
      { name: "Urine osmolality", conventional: "50–1200 mOsmol/kg H2O", si: "50–1200 mOsmol/kg H2O" },
      { name: "Urine oxalate",    conventional: "8–40 µg/mL",            si: "90–445 µmol/L" },
      { name: "Urine proteins",   conventional: "<150 mg/24 h",          si: "<0.15 g/24 h" },
      { name: "BMI, adult",       conventional: "19–25 kg/m²",           si: "19–25 kg/m²" },
    ],
  },
];

const statusEl = document.getElementById("status");
const openAppButton = document.getElementById("openAppButton");
const searchInput = document.getElementById("searchInput");
const searchButton = document.getElementById("searchButton");
const suggestionsEl = document.getElementById("suggestions");
const modeRail = document.getElementById("modeRail");
const contextCard = document.getElementById("contextCard");
const contentHeader = document.getElementById("contentHeader");
const contentEl = document.getElementById("content");

const state = {
  mode: "reference",
  term: "",
  reference: null,
  search: null,
  qbank: null,
  calcIndex: [],
  selectedPayload: null,
  cui: "",
  conceptMedia: null,
};

let suggestTimer = null;
let suggestRequestId = 0;
let renderedSuggestions = [];

const DATABASES = [
  { title: "AMBOSS", subtitle: "Clinical articles", path: "/amboss", mode: "reference" },
  { title: "UpToDate", subtitle: "Topics and graphics", path: "/uptodate", mode: "reference" },
  { title: "QBank", subtitle: "Questions and exhibits", path: "/qbank", mode: "questions" },
  { title: "Drug Ref", subtitle: "Dosing, classes, safety", path: "/drugs", mode: "reference" },
  { title: "Calculators", subtitle: "Scores and clinical tools", path: "/calculators", mode: "calculators" },
  { title: "Lexi", subtitle: "Drug and calculator database", path: "/lexi", mode: "databases" },
  { title: "Diseases", subtitle: "Disease and algorithm library", path: "/diseases", mode: "databases" },
  { title: "Library", subtitle: "Books and PDFs", path: "/library", mode: "databases" },
  { title: "Anatomy", subtitle: "Atlas and references", path: "/anatomy", mode: "databases" },
];

const COMMON_CALCS = [
  { id: "wells_pe", title: "Wells score for PE", subtitle: "Pulmonary embolism probability", search: "wells pe pulmonary embolism" },
  { id: "wells_dvt", title: "Wells score for DVT", subtitle: "DVT probability", search: "wells dvt deep vein thrombosis" },
  { id: "cha2ds2", title: "CHA2DS2-VASc", subtitle: "AF stroke risk", search: "cha2ds2 chads vasc atrial fibrillation stroke" },
  { id: "cockcroft", title: "Creatinine clearance", subtitle: "Cockcroft-Gault CrCl", search: "creatinine clearance cockcroft gault crcl egfr renal dosing" },
  { id: "bmi", title: "BMI", subtitle: "Body mass index", search: "bmi body mass index obesity" },
  { id: "anion_gap", title: "Anion gap", subtitle: "Acid-base support", search: "anion gap metabolic acidosis acid base" },
  { id: "corrected_calcium", title: "Corrected calcium", subtitle: "Albumin-corrected calcium", search: "corrected calcium albumin hypocalcemia hypercalcemia" },
  { id: "four_t", title: "4T score", subtitle: "HIT pretest probability", search: "4t score heparin induced thrombocytopenia hit" },
  { id: "anc", title: "Absolute neutrophil count", subtitle: "ANC", search: "absolute neutrophil count anc neutropenia" },
  { id: "aa_gradient", title: "A-a gradient", subtitle: "Alveolar-arterial oxygen gradient", search: "a-a gradient alveolar arterial oxygen hypoxemia" },
  { id: "nihss", title: "NIH Stroke Scale", subtitle: "Acute stroke severity", search: "nih stroke score scale nihss acute stroke" },
  { id: "gcs", title: "Glasgow Coma Scale", subtitle: "Consciousness assessment", search: "glasgow coma scale gcs consciousness" },
  { id: "egfr", title: "eGFR (CKD-EPI)", subtitle: "Renal function", search: "egfr ckd epi renal kidney creatinine" },
  { id: "curb65", title: "CURB-65", subtitle: "Pneumonia severity", search: "curb 65 pneumonia severity" },
  { id: "meld", title: "MELD Score", subtitle: "Liver disease severity", search: "meld score cirrhosis liver transplant" },
];

const NATIVE_CALCS = {
  bmi: {
    title: "BMI",
    subtitle: "Body mass index",
    fields: [
      { id: "weight", label: "Weight", unit: "kg" },
      { id: "height", label: "Height", unit: "cm" },
    ],
    compute: (v) => {
      const h = Number(v.height) / 100;
      const bmi = Number(v.weight) / (h * h);
      if (!isFinite(bmi)) return null;
      let label = "Normal";
      if (bmi < 18.5) label = "Underweight";
      else if (bmi >= 30) label = "Obesity";
      else if (bmi >= 25) label = "Overweight";
      return { value: bmi.toFixed(1), unit: "kg/m2", label };
    },
  },
  anion_gap: {
    title: "Anion gap",
    subtitle: "Na - (Cl + HCO3)",
    fields: [
      { id: "na", label: "Sodium", unit: "mEq/L" },
      { id: "cl", label: "Chloride", unit: "mEq/L" },
      { id: "hco3", label: "Bicarbonate", unit: "mEq/L" },
    ],
    compute: (v) => {
      const gap = Number(v.na) - Number(v.cl) - Number(v.hco3);
      if (!isFinite(gap)) return null;
      return { value: gap.toFixed(1), unit: "mEq/L", label: gap > 12 ? "Elevated" : "Typical/normal range" };
    },
  },
  corrected_calcium: {
    title: "Corrected calcium",
    subtitle: "Corrected Ca = measured Ca + 0.8 x (4 - albumin)",
    fields: [
      { id: "ca", label: "Measured calcium", unit: "mg/dL" },
      { id: "albumin", label: "Albumin", unit: "g/dL" },
    ],
    compute: (v) => {
      const corrected = Number(v.ca) + 0.8 * (4 - Number(v.albumin));
      if (!isFinite(corrected)) return null;
      return { value: corrected.toFixed(1), unit: "mg/dL", label: corrected < 8.5 ? "Low" : corrected > 10.5 ? "High" : "Normal" };
    },
  },
  cockcroft: {
    title: "Creatinine clearance",
    subtitle: "Cockcroft-Gault estimate",
    fields: [
      { id: "age", label: "Age", unit: "years" },
      { id: "weight", label: "Weight", unit: "kg" },
      { id: "scr", label: "Serum creatinine", unit: "mg/dL" },
      { id: "sex", label: "Sex", type: "select", options: [["male", "Male"], ["female", "Female"]] },
    ],
    compute: (v) => {
      let crcl = ((140 - Number(v.age)) * Number(v.weight)) / (72 * Number(v.scr));
      if (v.sex === "female") crcl *= 0.85;
      if (!isFinite(crcl)) return null;
      return { value: crcl.toFixed(0), unit: "mL/min", label: "Estimated CrCl" };
    },
  },
  cha2ds2: {
    title: "CHA2DS2-VASc",
    subtitle: "Atrial fibrillation stroke risk score",
    fields: [
      { id: "chf", label: "CHF/LV dysfunction", type: "check" },
      { id: "htn", label: "Hypertension", type: "check" },
      { id: "age75", label: "Age >=75", type: "check", points: 2 },
      { id: "dm", label: "Diabetes", type: "check" },
      { id: "stroke", label: "Stroke/TIA/thromboembolism", type: "check", points: 2 },
      { id: "vascular", label: "Vascular disease", type: "check" },
      { id: "age65", label: "Age 65-74", type: "check" },
      { id: "female", label: "Female sex", type: "check" },
    ],
    compute: (v, fields) => {
      const score = fields.reduce((sum, field) => sum + (v[field.id] ? (field.points || 1) : 0), 0);
      return { value: String(score), unit: "points", label: score >= 2 ? "Anticoagulation usually considered" : "Lower risk" };
    },
  },
  wells_pe: {
    title: "Wells score for PE",
    subtitle: "Pulmonary embolism probability",
    fields: [
      { id: "dvt", label: "Clinical signs of DVT", type: "check", points: 3 },
      { id: "alt", label: "PE most likely diagnosis", type: "check", points: 3 },
      { id: "hr", label: "Heart rate >100", type: "check", points: 1.5 },
      { id: "immob", label: "Immobilization/surgery", type: "check", points: 1.5 },
      { id: "prior", label: "Prior DVT/PE", type: "check", points: 1.5 },
      { id: "hemop", label: "Hemoptysis", type: "check", points: 1 },
      { id: "malig", label: "Malignancy", type: "check", points: 1 },
    ],
    compute: (v, fields) => {
      const score = fields.reduce((sum, field) => sum + (v[field.id] ? field.points : 0), 0);
      return { value: score.toFixed(1), unit: "points", label: score > 4 ? "PE likely" : "PE unlikely" };
    },
  },
  wells_dvt: {
    title: "Wells score for DVT",
    subtitle: "DVT probability",
    fields: [
      { id: "cancer", label: "Active cancer", type: "check" },
      { id: "paralysis", label: "Paralysis/paresis/cast", type: "check" },
      { id: "bedridden", label: "Bedridden/surgery", type: "check" },
      { id: "tender", label: "Localized tenderness", type: "check" },
      { id: "leg", label: "Entire leg swollen", type: "check" },
      { id: "calf", label: "Calf swelling >3 cm", type: "check" },
      { id: "edema", label: "Pitting edema", type: "check" },
      { id: "veins", label: "Collateral superficial veins", type: "check" },
      { id: "prior", label: "Prior DVT", type: "check" },
      { id: "alt", label: "Alternative diagnosis at least as likely", type: "check", points: -2 },
    ],
    compute: (v, fields) => {
      const score = fields.reduce((sum, field) => sum + (v[field.id] ? (field.points ?? 1) : 0), 0);
      return { value: String(score), unit: "points", label: score >= 2 ? "DVT likely" : "DVT unlikely" };
    },
  },
  four_t: {
    title: "4T score",
    subtitle: "HIT pretest probability",
    fields: [
      { id: "platelets", label: "Thrombocytopenia", type: "select", options: [["0", "0"], ["1", "1"], ["2", "2"]] },
      { id: "timing", label: "Timing", type: "select", options: [["0", "0"], ["1", "1"], ["2", "2"]] },
      { id: "thrombosis", label: "Thrombosis", type: "select", options: [["0", "0"], ["1", "1"], ["2", "2"]] },
      { id: "other", label: "Other causes absent", type: "select", options: [["0", "0"], ["1", "1"], ["2", "2"]] },
    ],
    compute: (v) => {
      const score = ["platelets", "timing", "thrombosis", "other"].reduce((sum, id) => sum + Number(v[id] || 0), 0);
      return { value: String(score), unit: "points", label: score <= 3 ? "Low probability" : score <= 5 ? "Intermediate probability" : "High probability" };
    },
  },
  anc: {
    title: "Absolute neutrophil count",
    subtitle: "WBC x (%neutrophils + %bands) / 100",
    fields: [
      { id: "wbc", label: "WBC", unit: "cells/uL" },
      { id: "neut", label: "Neutrophils", unit: "%" },
      { id: "bands", label: "Bands", unit: "%", optional: true },
    ],
    compute: (v) => {
      const anc = Number(v.wbc) * ((Number(v.neut) + Number(v.bands || 0)) / 100);
      if (!isFinite(anc)) return null;
      return { value: anc.toFixed(0), unit: "cells/uL", label: anc < 500 ? "Severe neutropenia" : anc < 1500 ? "Neutropenia" : "Normal" };
    },
  },
  aa_gradient: {
    title: "A-a gradient",
    subtitle: "Approximate sea-level room-air equation",
    fields: [
      { id: "fio2", label: "FiO2", unit: "fraction", placeholder: "0.21", optional: true },
      { id: "paco2", label: "PaCO2", unit: "mm Hg" },
      { id: "pao2", label: "PaO2", unit: "mm Hg" },
    ],
    compute: (v) => {
      const fio2 = Number(v.fio2 || 0.21);
      const pao2Alv = fio2 * (760 - 47) - (Number(v.paco2) / 0.8);
      const gradient = pao2Alv - Number(v.pao2);
      if (!isFinite(gradient)) return null;
      return { value: gradient.toFixed(0), unit: "mm Hg", label: "Expected normal roughly age/4 + 4" };
    },
  },
};

Object.assign(NATIVE_CALCS, buildAppNativeCalculators());

const NATIVE_CALC_ALIASES = [
  ["bmi", ["body mass index", "bmi"]],
  ["ibw", ["ideal body weight adult", "ideal body weight"]],
  ["bsa", ["body surface area", "bsa"]],
  ["anc", ["absolute neutrophil", "anc"]],
  ["four_t", ["4t score", "4t", "heparin induced thrombocytopenia", "hit score"]],
  ["acetaminophen_toxicity", ["acetaminophen toxicity", "acetaminophen toxicity assessment"]],
  ["als_adult", ["advanced life support adult", "advanced life support", "acls"]],
  ["apache2", ["apache ii", "apache 2"]],
  ["fracture_index_no_bmd", ["fracture index without known bone mineral density"]],
  ["egfr", ["egfr", "glomerular filtration", "ckd epi"]],
  ["cockcroft", ["cockcroft", "creatinine clearance", "crcl"]],
  ["anion_gap", ["anion gap", "anion gap in hypoalbumin"]],
  ["corrected_calcium", ["corrected calcium", "calcium correction"]],
  ["winters", ["winter", "expected pco2"]],
  ["aa_gradient", ["a a gradient", "alveolar arterial"]],
  ["qtc", ["corrected qt", "qtc", "qt interval"]],
  ["meld", ["meld score", "model for end stage liver"]],
  ["cha2ds2", ["cha2ds2", "cha2ds2 vasc", "chads vasc"]],
  ["gcs", ["glasgow coma", "gcs"]],
  ["nihss", ["nih stroke", "nihss", "nih stroke scale", "nih stroke score"]],
  ["wells_dvt", ["wells dvt", "deep vein thrombosis"]],
  ["wells_pe", ["wells pe", "pulmonary embolism"]],
  ["curb65", ["curb 65", "curb65"]],
  ["child_pugh", ["child pugh"]],
  ["sofa", ["sofa score", "sequential organ"]],
  ["apgar", ["apgar"]],
  ["news2", ["news2", "national early warning"]],
];

function buildAppNativeCalculators() {
  const defs = {};
  const round = (n, places = 0) => {
    const p = Math.pow(10, places);
    return Math.round(n * p) / p;
  };
  const addRuntime = (id, name, desc, fields, compute, bands = []) => {
    defs[id] = makeRuntimeCalculator({ name, desc, fields, compute, bands });
  };
  const addScore = (id, name, desc, rows, bands = []) => {
    addRuntime(
      id,
      name,
      desc,
      rows.map(([fid, label, points]) => ({
        id: fid,
        label,
        type: "select",
        options: Array.isArray(points)
          ? points.map(([value, optionLabel]) => [String(value), `${value} - ${optionLabel}`])
          : [["0", "No"], [String(points), "Yes"]],
      })),
      (v) => [round(Object.keys(v).reduce((sum, key) => sum + Number(v[key] || 0), 0), 1), "points"],
      bands,
    );
  };

  addRuntime("bmi", "BMI", "Body mass index", [
    { id: "weight", label: "Weight", unit: "kg", type: "number" },
    { id: "height", label: "Height", unit: "cm", type: "number" },
  ], (v) => [round(v.weight / Math.pow(v.height / 100, 2), 1), "kg/m2"], [[null, 18.5, "Underweight"], [18.5, 25, "Normal"], [25, 30, "Overweight"], [30, null, "Obese"]]);

  addRuntime("ibw", "Ideal Body Weight", "Devine formula", [
    { id: "height", label: "Height", unit: "cm", type: "number" },
    { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
  ], (v) => {
    const inches = v.height / 2.54;
    const base = v.sex === 1 ? 50 : 45.5;
    return [round(Math.max(base + 2.3 * (inches - 60), base), 1), "kg"];
  });

  addRuntime("bsa", "Body Surface Area", "Mosteller formula", [
    { id: "weight", label: "Weight", unit: "kg", type: "number" },
    { id: "height", label: "Height", unit: "cm", type: "number" },
  ], (v) => [round(Math.sqrt((v.height * v.weight) / 3600), 2), "m2"]);

  addRuntime("egfr", "eGFR (CKD-EPI)", "2021 CKD-EPI", [
    { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number" },
    { id: "age", label: "Age", unit: "years", type: "number" },
    { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
  ], (v) => {
    const k = v.sex === 1 ? 0.9 : 0.7;
    const a = v.sex === 1 ? -0.302 : -0.241;
    const x = v.creatinine / k;
    return [Math.round(142 * Math.pow(Math.min(x, 1), a) * Math.pow(Math.max(x, 1), -1.2) * Math.pow(0.9938, v.age)), "mL/min/1.73m2"];
  }, [[90, null, "G1 - normal kidney function"], [60, 90, "G2 - mildly decreased"], [45, 60, "G3a - mild to moderate decrease"], [30, 45, "G3b - moderate to severe decrease"], [15, 30, "G4 - severely decreased"], [null, 15, "G5 - kidney failure"]]);

  addRuntime("cockcroft", "Creatinine Clearance", "Cockcroft-Gault", [
    { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number" },
    { id: "age", label: "Age", unit: "years", type: "number" },
    { id: "weight", label: "Weight", unit: "kg", type: "number" },
    { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
  ], (v) => [Math.round(((140 - v.age) * v.weight / (72 * v.creatinine)) * (v.sex === 0 ? 0.85 : 1)), "mL/min"]);

  addRuntime("anion_gap", "Anion Gap", "Albumin-corrected anion gap", [
    { id: "na", label: "Sodium", unit: "mEq/L", type: "number" },
    { id: "cl", label: "Chloride", unit: "mEq/L", type: "number" },
    { id: "bicarb", label: "HCO3", unit: "mEq/L", type: "number" },
    { id: "albumin", label: "Albumin", unit: "g/dL", type: "number", value: 4, optional: true },
  ], (v) => {
    const raw = v.na - (v.cl + v.bicarb);
    const corrected = raw + 2.5 * (4 - (v.albumin || 4));
    return [round(corrected, 1), "mEq/L", `Raw AG ${round(raw, 1)}`];
  }, [[null, 12, "Normal anion gap"], [12, null, "Elevated anion gap"]]);

  addRuntime("winters", "Winter's Formula", "Expected pCO2 for metabolic acidosis", [
    { id: "bicarb", label: "Serum HCO3", unit: "mEq/L", type: "number" },
  ], (v) => [`${Math.round(1.5 * v.bicarb + 6)}-${Math.round(1.5 * v.bicarb + 10)}`, "mm Hg"]);

  addRuntime("aa_gradient", "A-a Gradient", "Alveolar-arterial oxygen gradient", [
    { id: "fio2", label: "FiO2", unit: "%", type: "number", value: 21 },
    { id: "paco2", label: "PaCO2", unit: "mm Hg", type: "number" },
    { id: "pao2", label: "PaO2", unit: "mm Hg", type: "number" },
  ], (v) => [round((v.fio2 / 100) * (760 - 47) - (v.paco2 / 0.8) - v.pao2, 1), "mm Hg"], [[null, 15, "Normal on room air"], [15, null, "Elevated"]]);

  addRuntime("qtc", "Corrected QT (QTc)", "Bazett formula", [
    { id: "qt", label: "QT interval", unit: "ms", type: "number" },
    { id: "rr", label: "RR interval", unit: "ms", type: "number" },
  ], (v) => [Math.round(v.qt / Math.sqrt(v.rr / 1000)), "ms"], [[null, 440, "Normal range for men"], [440, 460, "Borderline prolonged"], [460, null, "Prolonged"]]);

  addRuntime("meld", "MELD Score", "Model for End-Stage Liver Disease", [
    { id: "creatinine", label: "Creatinine", unit: "mg/dL", type: "number" },
    { id: "bilirubin", label: "Bilirubin", unit: "mg/dL", type: "number" },
    { id: "inr", label: "INR", type: "number" },
    { id: "dialysis", label: "On dialysis", type: "select", options: [["0", "No"], ["1", "Yes"]] },
  ], (v) => {
    const cr = v.dialysis ? 4 : Math.max(1, Math.min(v.creatinine, 4));
    const bil = Math.max(1, v.bilirubin);
    return [Math.round(3.78 * Math.log(bil) + 11.2 * Math.log(v.inr) + 9.57 * Math.log(cr) + 6.43), "points"];
  }, [[null, 10, "<10 - low short-term mortality"], [10, 20, "10-19 - about 6% 90-day mortality"], [20, 30, "20-29 - about 20% 90-day mortality"], [30, null, ">=30 - high 90-day mortality risk"]]);

  addRuntime("anc", "Absolute Neutrophil Count", "Calculates ANC from WBC and neutrophil percentages", [
    { id: "wbc", label: "WBC count", unit: "10^3/uL", type: "number" },
    { id: "neutrophils", label: "Segmented neutrophils", unit: "%", type: "number" },
    { id: "bands", label: "Bands", unit: "%", type: "number", value: 0, optional: true },
  ], (v) => [Math.round(v.wbc * 1000 * (((v.neutrophils || 0) + (v.bands || 0)) / 100)), "cells/uL"], [[1500, null, "Normal or not neutropenic"], [1000, 1500, "Mild neutropenia"], [500, 1000, "Moderate neutropenia"], [null, 500, "Severe neutropenia"]]);

  addRuntime("acetaminophen_toxicity", "Acetaminophen Toxicity Assessment", "Timed acetaminophen level assessment", [
    { id: "dose", label: "Estimated ingestion dose", unit: "mg/kg", type: "number" },
    { id: "hours", label: "Hours since ingestion", unit: "hours", type: "number" },
    { id: "level", label: "Acetaminophen concentration", unit: "mcg/mL", type: "number" },
  ], (v) => {
    const threshold = v.hours >= 4 ? 150 * Math.pow(0.5, (v.hours - 4) / 4) : 150;
    const treat = (v.hours >= 4 && v.level >= threshold) || v.dose >= 150;
    return [treat ? "Treat / toxic risk" : "Below treatment line", "", `Nomogram threshold at ${v.hours} h: ${Math.round(threshold)} mcg/mL`];
  });

  addRuntime("als_adult", "Advanced Life Support: Adult", "Adult resuscitation medication support", [
    { id: "weight", label: "Weight", unit: "kg", type: "number" },
    { id: "scenario", label: "Scenario", type: "select", options: [["0", "Cardiac arrest"], ["1", "Bradycardia"], ["2", "Narrow-complex tachycardia"], ["3", "Anaphylaxis IM epinephrine"]] },
  ], (v) => {
    const lines = [
      "Epinephrine 1 mg IV/IO every 3-5 min",
      "Atropine 1 mg IV every 3-5 min, max 3 mg; consider pacing/pressor infusion",
      "Adenosine 6 mg rapid IV, then 12 mg if needed",
      `Epinephrine IM 0.3-0.5 mg adult dose; weight entered ${v.weight} kg`,
    ];
    return [lines[v.scenario] || lines[0], "", "Verify against local protocol and patient context."];
  });

  addScore("cha2ds2", "CHA2DS2-VASc", "AF stroke risk", [
    ["chf", "CHF / LV dysfunction", 1], ["htn", "Hypertension", 1], ["age75", "Age >= 75", 2],
    ["dm", "Diabetes mellitus", 1], ["stroke", "Prior stroke / TIA", 2], ["vasc", "Vascular disease", 1],
    ["age65", "Age 65-74", 1], ["female", "Female sex", 1],
  ], [[null, 1, "Low - anticoagulation usually not recommended"], [1, 2, "Intermediate - consider anticoagulation"], [2, null, "High - anticoagulation generally recommended"]]);

  addScore("gcs", "Glasgow Coma Scale", "Eye + Verbal + Motor", [
    ["eye", "Eye opening", [[4, "Spontaneous"], [3, "To voice"], [2, "To pain"], [1, "None"]]],
    ["verbal", "Verbal response", [[5, "Oriented"], [4, "Confused"], [3, "Words"], [2, "Sounds"], [1, "None"]]],
    ["motor", "Motor response", [[6, "Obeys"], [5, "Localizes"], [4, "Withdraws"], [3, "Flexion"], [2, "Extension"], [1, "None"]]],
  ], [[13, null, "Mild impairment"], [9, 13, "Moderate impairment"], [null, 9, "Severe impairment - consider airway protection if <=8"]]);

  addScore("nihss", "NIH Stroke Scale", "Acute stroke severity", [
    ["loc", "1a. Level of consciousness", [[0, "Alert"], [1, "Not alert, arousable"], [2, "Repeated stimulation"], [3, "Coma / unresponsive"]]],
    ["loc_questions", "1b. LOC questions", [[0, "Both correct"], [1, "One correct"], [2, "Neither correct"]]],
    ["loc_commands", "1c. LOC commands", [[0, "Both correct"], [1, "One correct"], [2, "Neither correct"]]],
    ["gaze", "2. Best gaze", [[0, "Normal"], [1, "Partial gaze palsy"], [2, "Forced deviation"]]],
    ["visual", "3. Visual fields", [[0, "No visual loss"], [1, "Partial hemianopia"], [2, "Complete hemianopia"], [3, "Bilateral hemianopia / blindness"]]],
    ["facial", "4. Facial palsy", [[0, "Normal"], [1, "Minor"], [2, "Partial"], [3, "Complete"]]],
    ["arm_left", "5a. Motor arm - left", [[0, "No drift"], [1, "Drift"], [2, "Some effort against gravity"], [3, "No effort against gravity"], [4, "No movement"]]],
    ["arm_right", "5b. Motor arm - right", [[0, "No drift"], [1, "Drift"], [2, "Some effort against gravity"], [3, "No effort against gravity"], [4, "No movement"]]],
    ["leg_left", "6a. Motor leg - left", [[0, "No drift"], [1, "Drift"], [2, "Some effort against gravity"], [3, "No effort against gravity"], [4, "No movement"]]],
    ["leg_right", "6b. Motor leg - right", [[0, "No drift"], [1, "Drift"], [2, "Some effort against gravity"], [3, "No effort against gravity"], [4, "No movement"]]],
    ["ataxia", "7. Limb ataxia", [[0, "Absent"], [1, "One limb"], [2, "Two limbs"]]],
    ["sensory", "8. Sensory", [[0, "Normal"], [1, "Mild-to-moderate loss"], [2, "Severe-to-total loss"]]],
    ["language", "9. Best language", [[0, "No aphasia"], [1, "Mild-to-moderate aphasia"], [2, "Severe aphasia"], [3, "Mute/global aphasia"]]],
    ["dysarthria", "10. Dysarthria", [[0, "Normal"], [1, "Mild-to-moderate"], [2, "Severe"]]],
    ["extinction", "11. Extinction / inattention", [[0, "None"], [1, "Partial inattention"], [2, "Profound hemi-inattention"]]],
  ], [[null, 1, "0 - no stroke symptoms"], [1, 5, "1-4 - minor stroke"], [5, 16, "5-15 - moderate stroke"], [16, 21, "16-20 - moderate to severe stroke"], [21, null, "21-42 - severe stroke"]]);

  addScore("wells_dvt", "Wells Score (DVT)", "DVT pre-test probability", [
    ["cancer", "Active cancer", 1], ["paralysis", "Paralysis / cast", 1], ["bedridden", "Bedridden or surgery", 1],
    ["tenderness", "Deep vein tenderness", 1], ["swelling", "Entire leg swollen", 1], ["calf", "Calf swelling >3 cm", 1],
    ["pitting", "Pitting edema", 1], ["collateral", "Collateral veins", 1], ["alt_dx", "Alternative diagnosis as likely", -2],
  ], [[null, 1, "Low probability"], [1, 3, "Moderate probability"], [3, null, "High probability"]]);

  addScore("wells_pe", "Wells Score (PE)", "PE pre-test probability", [
    ["dvt_sx", "Clinical signs of DVT", 3], ["alt_dx", "PE more likely", 3], ["hr100", "HR > 100", 1.5],
    ["immob", "Immobilization / surgery", 1.5], ["prev_dvt", "Previous DVT / PE", 1.5], ["haemop", "Hemoptysis", 1],
    ["cancer", "Active malignancy", 1],
  ], [[null, 2, "Low probability"], [2, 6, "Moderate probability"], [6, null, "High probability"]]);

  addScore("curb65", "CURB-65", "Pneumonia severity", [
    ["confusion", "Confusion", 1], ["bun", "BUN > 19", 1], ["rr", "RR >= 30", 1], ["bp", "Low BP", 1], ["age65", "Age >= 65", 1],
  ], [[null, 1, "Low severity - outpatient treatment often appropriate"], [1, 3, "Moderate severity - consider hospital assessment"], [3, null, "Severe pneumonia - consider ICU / urgent care"]]);

  addScore("child_pugh", "Child-Pugh Score", "Liver disease severity", [
    ["bilirubin", "Bilirubin", [[1, "<2"], [2, "2-3"], [3, ">3"]]],
    ["albumin", "Albumin", [[1, ">3.5"], [2, "2.8-3.5"], [3, "<2.8"]]],
    ["pt_inr", "INR", [[1, "<1.7"], [2, "1.7-2.3"], [3, ">2.3"]]],
    ["ascites", "Ascites", [[1, "None"], [2, "Mild"], [3, "Severe"]]],
    ["encephalopathy", "Encephalopathy", [[1, "None"], [2, "Grade I-II"], [3, "Grade III-IV"]]],
  ], [[null, 7, "Class A - well compensated"], [7, 10, "Class B - significant dysfunction"], [10, null, "Class C - decompensated disease"]]);

  addScore("sofa", "SOFA Score", "Sequential organ failure", [
    ["pf", "PaO2/FiO2", [[0, ">=400"], [1, "300-399"], [2, "200-299"], [3, "100-199"], [4, "<100"]]],
    ["plt", "Platelets", [[0, ">=150"], [1, "100-149"], [2, "50-99"], [3, "20-49"], [4, "<20"]]],
    ["bil", "Bilirubin", [[0, "<1.2"], [1, "1.2-1.9"], [2, "2-5.9"], [3, "6-11.9"], [4, ">=12"]]],
    ["cv", "Cardiovascular", [[0, "MAP >=70"], [1, "MAP <70"], [2, "Low pressor"], [3, "Moderate pressor"], [4, "High pressor"]]],
    ["gcs", "GCS", [[0, "15"], [1, "13-14"], [2, "10-12"], [3, "6-9"], [4, "<6"]]],
    ["cr", "Creatinine", [[0, "<1.2"], [1, "1.2-1.9"], [2, "2-3.4"], [3, "3.5-4.9"], [4, ">5"]]],
  ], [[null, 7, "Lower organ failure burden"], [7, 11, "Moderate organ failure burden"], [11, null, "High organ failure burden / mortality risk"]]);

  addScore("apgar", "APGAR Score", "Neonatal wellbeing", [
    ["activity", "Activity", [[0, "Absent"], [1, "Some flexion"], [2, "Active"]]],
    ["pulse", "Pulse", [[0, "Absent"], [1, "<100"], [2, ">=100"]]],
    ["grimace", "Grimace", [[0, "None"], [1, "Grimace"], [2, "Cry"]]],
    ["appearance", "Color", [[0, "Blue/pale"], [1, "Blue extremities"], [2, "Pink"]]],
    ["respiration", "Respiration", [[0, "Absent"], [1, "Weak"], [2, "Strong cry"]]],
  ], [[7, null, "Normal transition"], [4, 7, "Moderate concern - stimulate/support"], [null, 4, "Severely depressed - resuscitation likely needed"]]);

  addScore("news2", "NEWS2 Score", "Clinical deterioration", [
    ["rr", "Resp rate", [[3, "<=8"], [1, "9-11"], [0, "12-20"], [2, "21-24"], [3, ">=25"]]],
    ["spo2", "SpO2", [[3, "<=91"], [2, "92-93"], [1, "94-95"], [0, ">=96"]]],
    ["sbp", "SBP", [[3, "<=90"], [2, "91-100"], [1, "101-110"], [0, "111-219"], [3, ">=220"]]],
    ["pulse", "Pulse", [[3, "<=40"], [1, "41-50"], [0, "51-90"], [1, "91-110"], [2, "111-130"], [3, ">=131"]]],
    ["temp", "Temp", [[3, "<=35"], [1, "35.1-36"], [0, "36.1-38"], [1, "38.1-39"], [2, ">=39.1"]]],
    ["acvpu", "ACVPU", [[0, "Alert"], [3, "Confusion / V / P / U"]]],
  ], [[null, 1, "Low risk - routine observations"], [1, 5, "Low-medium risk - increase observation frequency"], [5, 7, "Medium risk - urgent clinical review"], [7, null, "High risk - emergency response"]]);

  addScore("four_t", "4T Score", "Pretest probability of heparin-induced thrombocytopenia", [
    ["thrombocytopenia", "Thrombocytopenia", [[0, "Platelet fall <30% or nadir <10"], [1, "Fall 30-50% or nadir 10-19"], [2, "Fall >50% and nadir >=20"]]],
    ["timing", "Timing of platelet fall", [[0, "<4 days without recent heparin"], [1, "Unclear or >10 days"], [2, "Days 5-10 or <=1 day with recent exposure"]]],
    ["thrombosis", "Thrombosis or sequelae", [[0, "None"], [1, "Progressive/recurrent thrombosis or skin lesions"], [2, "New thrombosis, skin necrosis, or acute systemic reaction"]]],
    ["other", "Other causes of thrombocytopenia", [[0, "Definite other cause"], [1, "Possible other cause"], [2, "No apparent other cause"]]],
  ], [[null, 4, "Low probability of HIT"], [4, 6, "Intermediate probability of HIT"], [6, null, "High probability of HIT"]]);

  addScore("apache2", "APACHE II Score", "Critical illness severity score", [
    ["temperature", "Temperature", [[0, "36-38.4 C"], [1, "34-35.9 or 38.5-38.9"], [2, "32-33.9"], [3, "30-31.9 or 39-40.9"], [4, "<30 or >=41"]]],
    ["map", "Mean arterial pressure", [[0, "70-109"], [2, "50-69 or 110-129"], [3, "130-159"], [4, "<50 or >=160"]]],
    ["heart", "Heart rate", [[0, "70-109"], [2, "55-69 or 110-139"], [3, "40-54 or 140-179"], [4, "<40 or >=180"]]],
    ["resp", "Respiratory rate", [[0, "12-24"], [1, "10-11"], [2, "6-9 or 25-34"], [3, "35-49"], [4, "<6 or >=50"]]],
    ["oxygenation", "Oxygenation abnormality", [[0, "None/mild"], [1, "Mild"], [2, "Moderate"], [3, "Severe"], [4, "Very severe"]]],
    ["arterial_ph", "Arterial pH", [[0, "7.33-7.49"], [1, "7.50-7.59"], [2, "7.25-7.32"], [3, "7.15-7.24 or 7.60-7.69"], [4, "<7.15 or >=7.70"]]],
    ["sodium", "Serum sodium", [[0, "130-149"], [1, "150-154"], [2, "120-129 or 155-159"], [3, "111-119 or 160-179"], [4, "<111 or >=180"]]],
    ["potassium", "Serum potassium", [[0, "3.5-5.4"], [1, "3.0-3.4 or 5.5-5.9"], [2, "2.5-2.9"], [3, "6.0-6.9"], [4, "<2.5 or >=7.0"]]],
    ["creatinine", "Creatinine / renal failure", [[0, "0.6-1.4"], [2, "1.5-1.9"], [3, "2.0-3.4"], [4, "<0.6 or >=3.5"]]],
    ["hematocrit", "Hematocrit", [[0, "30-45.9"], [1, "46-49.9"], [2, "20-29.9 or 50-59.9"], [4, "<20 or >=60"]]],
    ["wbc", "WBC", [[0, "3-14.9"], [1, "15-19.9"], [2, "1-2.9 or 20-39.9"], [4, "<1 or >=40"]]],
    ["gcs_deficit", "GCS deficit", [[0, "GCS 15"], [3, "GCS 12"], [6, "GCS 9"], [9, "GCS 6"], [12, "GCS 3"]]],
    ["age", "Age points", [[0, "<45"], [2, "45-54"], [3, "55-64"], [5, "65-74"], [6, ">=75"]]],
    ["chronic", "Severe chronic organ insufficiency/immunocompromised", [[0, "No"], [2, "Elective postoperative"], [5, "Nonoperative or emergency postoperative"]]],
  ], [[null, 10, "Lower APACHE II severity"], [10, 20, "Moderate APACHE II severity"], [20, 30, "High APACHE II severity"], [30, null, "Very high APACHE II severity"]]);

  addScore("fracture_index_no_bmd", "Fracture Index without known BMD", "Estimates fracture risk when BMD is unavailable", [
    ["age", "Age", [[0, "<65"], [1, "65-69"], [2, "70-74"], [3, "75-79"], [4, ">=80"]]],
    ["prior", "Prior fracture after age 50", 1],
    ["mother", "Maternal hip fracture", 1],
    ["weight", "Weight <57 kg", 1],
    ["smoker", "Current smoker", 1],
    ["arms", "Needs arms to rise from chair", 1],
  ], [[null, 2, "Lower fracture risk"], [2, 4, "Intermediate fracture risk"], [4, null, "Higher fracture risk"]]);

  return defs;
}

function makeRuntimeCalculator(def) {
  return {
    title: def.name,
    subtitle: def.desc,
    fields: def.fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type || "number",
      unit: field.unit || "",
      options: field.options || [],
      value: field.value,
      optional: Boolean(field.optional),
    })),
    compute: (values) => {
      const numericValues = {};
      for (const field of def.fields) {
        const raw = values[field.id];
        numericValues[field.id] = raw === "" || raw === null || raw === undefined ? null : Number(raw);
      }
      const [value, unit, note] = def.compute(numericValues);
      const interpretation = runtimeInterpretation(def.bands || [], value);
      return {
        value: String(value),
        unit: unit || "",
        label: [note, interpretation].filter(Boolean).join(" - "),
      };
    },
  };
}

function runtimeInterpretation(bands, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  const band = bands.find(([min, max]) => (min == null || numeric >= min) && (max == null || numeric < max));
  return band ? band[2] : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function apiUrl(path) {
  if (!path) return API_BASE;
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

function appUrl(path) {
  if (!path) return APP_BASE;
  if (/^https?:\/\//i.test(path)) return path;
  return `${APP_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

function sourceLabel(source) {
  if (source === "qbank") return "UWorld";
  if (source === "utd") return "UTD";
  if (source === "cliniccons") return "ALG";
  if (source === "amboss") return "AMB";
  if (source === "drug") return "DRUG";
  if (source === "calc") return "CALC";
  if (source === "firstaid") return "FA";
  if (source === "umls") return "UMLS";
  if (source === "uworld") return "UWL";
  if (source === "books") return "BOOK";
  if (source === "diseases") return "DIS";
  return "REF";
}

function normalizeSource(source) {
  if (source === "uptodate") return "utd";
  if (source === "calculator") return "calc";
  if (source === "drugs") return "drug";
  if (source === "firstaid_full") return "firstaid";
  if ([
    "amboss", "utd", "qbank", "cliniccons", "drug", "calc",
    "firstaid", "umls", "uworld", "books", "diseases",
  ].includes(source)) return source;
  return "reference";
}

function setStatus(kind, text) {
  statusEl.className = `status status-${kind}`;
  statusEl.textContent = text;
}

function updateModeRail(mode) {
  modeRail.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function setMode(mode) {
  state.mode = mode;
  updateModeRail(mode);
  renderMode();
}

function setHeader(title, actionHtml = "") {
  contentHeader.innerHTML = `
    <h2 class="section-title">${escapeHtml(title)}</h2>
    ${actionHtml}
  `;
}

function setContent(html, empty = false) {
  contentEl.className = empty ? "content empty" : "content";
  contentEl.innerHTML = html;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function checkBackend() {
  try {
    const response = await fetch(`${API_BASE}/health`, { cache: "no-store" });
    setStatus(response.ok ? "ok" : "error", response.ok ? "Online" : "Backend");
  } catch (_error) {
    setStatus("error", "Offline");
  }
}

function openApp(path = "/") {
  chrome.tabs.create({ url: appUrl(path) }).catch(() => {});
}

function rewriteApiRelativeHtml(html) {
  return String(html || "")
    .replaceAll('src="/', `src="${API_BASE}/`)
    .replaceAll("src='/", `src='${API_BASE}/`)
    .replaceAll('href="/', `href="${API_BASE}/`)
    .replaceAll("href='/", `href='${API_BASE}/`);
}

function isDrugReference(data) {
  return data && (data.source === "drug" || data.kind === "drug" || data.drug_card || /medos-drug-card/.test(data.html || ""));
}

function renderDrugCardHtml(data) {
  const card = data && data.drug_card;
  if (!card) return data && data.html ? `<div class="side-drug-card">${data.html}</div>` : "";
  const uses = Array.isArray(card.common_uses) ? card.common_uses.filter(Boolean).slice(0, 5) : [];
  return `
    <div class="side-drug-card">
      ${card.drug_class ? `<section class="side-drug-row side-drug-class"><span>Class</span><strong>${escapeHtml(card.drug_class)}</strong></section>` : ""}
      ${card.adult_dose ? `<section class="side-drug-row side-drug-dose"><span>Adult dose</span><p>${escapeHtml(card.adult_dose)}</p></section>` : ""}
      ${uses.length ? `<section class="side-drug-row side-drug-uses"><span>Common uses</span><ul>${uses.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : ""}
      ${card.has_black_box || card.black_box ? `<section class="side-drug-row side-drug-warning"><span>Black box</span><p>${escapeHtml(card.black_box || "Black-box warning present in the local drug reference database.")}</p></section>` : ""}
    </div>
  `;
}

function renderContext(payload = state.selectedPayload) {
  const term = state.term || (payload && payload.term) || "";
  const data = state.reference;
  if (!term && !data) {
    contextCard.className = "context-card empty";
    contextCard.textContent = "No active reference.";
    return;
  }
  const media = Array.isArray(data && data.media) ? data.media.slice(0, 4) : [];
  const isDrug = isDrugReference(data);
  contextCard.className = "context-card";
  contextCard.innerHTML = `
    <h2 class="context-title">${escapeHtml((data && data.title) || term)}</h2>
    <div class="context-meta">${escapeHtml(term)}${data && data.source ? ` · ${escapeHtml(sourceLabel(data.source))}` : ""}</div>
    ${data && data.abstract && !isDrug ? `<p class="context-abstract">${escapeHtml(data.abstract)}</p>` : ""}
    ${isDrug ? renderDrugCardHtml(data) : ""}
    ${media.length ? `<div class="mini-media-strip">${media.map((item) => `<img src="${escapeHtml(apiUrl(item.url))}" alt="${escapeHtml(item.title || term)}" data-media-url="${escapeHtml(item.url)}">`).join("")}</div>` : ""}
  `;
  contextCard.querySelectorAll("[data-media-url]").forEach((img) => {
    img.addEventListener("click", () => renderImage(img.dataset.mediaUrl, img.alt));
  });
}

function itemCard(match) {
  const source = normalizeSource(match.source || "reference");
  const isDrug = source === "drug" || match.kind === "drug" || (match.href || "").startsWith("/drugs");
  return `
    <button type="button" class="result-card ${isDrug ? "result-card-drug" : ""}" data-open-href="${escapeHtml(match.href || "")}" data-source="${escapeHtml(isDrug ? "drug" : source)}" data-kind="${escapeHtml(match.kind || "")}" data-title="${escapeHtml(match.title || "")}">
      <div class="result-row">
        <span class="badge badge-${escapeHtml(isDrug ? "drug" : source)}">${escapeHtml(sourceLabel(isDrug ? "drug" : source))}</span>
        <span>
          <span class="result-title">${escapeHtml(match.title || match.href || "Open source")}</span>
          <span class="result-subtitle">${escapeHtml(match.subtitle || match.kind || "")}</span>
        </span>
      </div>
    </button>
  `;
}

function cardList(items, emptyText) {
  if (!items.length) return `<div class="content empty">${escapeHtml(emptyText)}</div>`;
  return `<div class="card-list">${items.map(itemCard).join("")}</div>`;
}

function attachOpenHandlers(root = contentEl) {
  root.querySelectorAll("[data-open-href]").forEach((button) => {
    button.addEventListener("click", () => {
      openMatch({
        href: button.dataset.openHref || "",
        source: button.dataset.source || "reference",
        kind: button.dataset.kind || "",
        title: button.dataset.title || "",
      });
    });
  });
}

function shouldShowContextualResults() {
  return Boolean(state.term || state.reference || state.search);
}

function connectedMatches() {
  return Array.isArray(state.reference && state.reference.matches) ? state.reference.matches : [];
}

// Every source group the backend /search returns, in the app's clinical-yield
// order. Each entry maps a backend group key → the extension source slug + the
// human group label shown as a section divider. Keeping this list in one place
// means the sidebar shows exactly what the main app shows (First Aid, UWorld
// Library, Books, Diseases, UMLS and QBank were previously dropped).
const SEARCH_GROUP_ORDER = [
  { key: "firstaid", source: "firstaid", label: "First Aid" },
  { key: "drugs", source: "drug", label: "Drug Reference" },
  { key: "amboss", source: "amboss", label: "AMBOSS" },
  { key: "utd", source: "utd", label: "UpToDate" },
  { key: "uworld", source: "uworld", label: "UWorld Library" },
  { key: "diseases", source: "diseases", label: "Diseases & Algorithms" },
  { key: "qbank", source: "qbank", label: "UWorld QBank" },
  { key: "books", source: "books", label: "Books" },
  { key: "umls", source: "umls", label: "UMLS Concepts" },
];

// Cap each source group so one high-volume source (e.g. books) can't crowd the
// others out of the deduped result list — every source stays represented, the
// way the app's grouped view shows a slice of each.
const PER_GROUP_LIMIT = 6;

function articleMatches() {
  const groups = (state.search && state.search.groups) || {};
  const out = [];
  for (const g of SEARCH_GROUP_ORDER) {
    for (const item of (groups[g.key] || []).slice(0, PER_GROUP_LIMIT)) {
      out.push({ ...item, source: g.source, group: g.label });
    }
  }
  return out;
}

function calculatorMatches() {
  const groups = (state.search && state.search.groups) || {};
  const term = normalizeText(state.term);
  const fromSearch = (groups.calc || [])
    .filter((item) => item && item.title)
    .map((item) => calcMatchFromTitle(item.title, item.subtitle || "MedOS calculator", "Calculator Search", item.href));
  const lexi = (state.calcIndex || [])
    .filter((item) => !term || normalizeText(`${item.title} ${item.subtitle || ""} ${item.description || ""} ${item.searchText || ""}`).includes(term))
    .slice(0, 12)
    .map((item) => calcMatchFromTitle(item.title, item.subtitle || item.category || "Lexi calculator", "Lexi Calculators", `/calculators?q=${encodeURIComponent(item.title)}`));
  const common = commonCalculatorMatches(term);
  return dedupeMatches([...fromSearch, ...lexi, ...common], 24);
}

function commonCalculatorMatches(term = "") {
  return COMMON_CALCS
    .filter((item) => !term || normalizeText(`${item.title} ${item.subtitle} ${item.search}`).includes(term))
    .map((item) => ({
    ...item,
    href: `/native-calc/${item.id}`,
    source: "calc",
    kind: "calculator",
    group: "Common calculators",
  }));
}

function normalizeText(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nativeCalcIdFromTitle(title) {
  const n = normalizeText(title);
  if (!n) return "";
  if (n.includes("for age")) return "";
  if (n.includes("gehan") || n.includes("du bois")) return "";
  if (n.includes("delta")) return "";
  if (n.includes("fracture index") && !n.includes("without")) return "";
  if (n.includes("framingham") && n.includes("stroke")) return "";
  if (n.includes("meldna")) return "";
  if (n.includes("cockcroft") && n.includes("with ibw")) return "";
  if (n.includes("apache ii") && n.includes("by diagnosis")) return "";
  if (n.includes("acc aha")) return "";
  const hit = NATIVE_CALC_ALIASES.find(([, aliases]) => aliases.some((alias) => n.includes(normalizeText(alias))));
  return hit && NATIVE_CALCS[hit[0]] ? hit[0] : "";
}

function calcMatchFromTitle(title, subtitle, group, fallbackHref = "") {
  const id = nativeCalcIdFromTitle(title);
  return {
    id: id || title,
    title,
    subtitle,
    href: id ? `/native-calc/${id}` : (fallbackHref || `/calculators?q=${encodeURIComponent(title)}`),
    source: "calc",
    kind: id ? "native calculator" : "calculator",
    group,
  };
}

function dedupeMatches(items, limit = 80) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = `${normalizeSource(item.source)}|${item.href || ""}|${normalizeText(item.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

function primaryMatches() {
  if (!shouldShowContextualResults()) return [];
  return dedupeMatches([
    ...connectedMatches().map((item) => ({ ...item, group: "Connected References" })),
    ...articleMatches(),
    ...calculatorMatches().slice(0, 8),
  ], 64);
}

function questionMatches() {
  const questions = (state.qbank && state.qbank.questions) || [];
  return questions.map((question) => ({
    id: question.id,
    title: question.title ? `QID ${question.id}: ${question.title}` : `QID ${question.id}`,
    subtitle: `${question.subject || "QBank"}${question.system ? ` · ${question.system}` : ""}`,
    href: `/qbank?db=step2&qid=${question.id}`,
    source: "qbank",
    kind: "question",
  }));
}

function renderGrouped(items, emptyText) {
  if (!items.length) {
    setContent(escapeHtml(emptyText), true);
    return;
  }
  let html = "";
  let group = "";
  for (const item of items) {
    const nextGroup = item.group || "";
    if (nextGroup && nextGroup !== group) {
      html += `<div class="group-label">${escapeHtml(nextGroup)}</div>`;
      group = nextGroup;
    }
    html += itemCard(item);
  }
  setContent(`<div class="card-list">${html}</div>`);
  attachOpenHandlers();
}

function renderMode() {
  renderContext();
  if (state.mode === "reference") {
    setHeader("References, Articles, Calculators");
    renderGrouped(primaryMatches(), "No reference loaded.");
    return;
  }
  if (state.mode === "questions") {
    setHeader("QBank Practice", '<button id="randomQuestionButton" class="small-button" type="button">Random Q</button>');
    renderGrouped(questionMatches(), "No suggested QBank questions.");
    const randomButton = document.getElementById("randomQuestionButton");
    if (randomButton) randomButton.addEventListener("click", loadRandomQuestion);
    return;
  }
  if (state.mode === "labs") {
    setHeader("Lab Reference Values");
    renderLabs();
    return;
  }
  if (state.mode === "media") {
    setHeader("Images, Tables, Algorithms");
    renderMediaMode();
    return;
  }
  if (state.mode === "calculators") {
    setHeader("Calculators");
    const matches = shouldShowContextualResults() ? calculatorMatches() : commonCalculatorMatches();
    renderGrouped(matches, "No matching calculators.");
    return;
  }
  if (state.mode === "databases") {
    setHeader("Databases");
    renderDatabases();
  }
}

function renderLabs() {
  const labsOpenKey = "medos:labsOpen";
  let openGroups = {};
  try { openGroups = JSON.parse(localStorage.getItem(labsOpenKey) || "{}"); } catch { openGroups = {}; }

  const html = `
    <div class="labs-groups">
      ${LAB_GROUPS.map((group, gi) => {
        const isOpen = openGroups[group.title] !== false && (gi === 0 ? true : Boolean(openGroups[group.title]));
        return `
          <div class="labs-group" data-group="${escapeHtml(group.title)}">
            <button type="button" class="labs-group-header" data-labs-toggle="${escapeHtml(group.title)}">
              <span>
                <strong>${escapeHtml(group.title)}</strong>
                <em>${escapeHtml(group.subtitle)}</em>
              </span>
              <span class="labs-chevron${isOpen ? " open" : ""}">›</span>
            </button>
            ${isOpen ? renderLabsTable(group.values) : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
  setContent(html);

  contentEl.querySelectorAll("[data-labs-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupTitle = btn.dataset.labsToggle || "";
      try { openGroups = JSON.parse(localStorage.getItem(labsOpenKey) || "{}"); } catch { openGroups = {}; }
      openGroups[groupTitle] = !openGroups[groupTitle];
      localStorage.setItem(labsOpenKey, JSON.stringify(openGroups));
      renderLabs();
    });
  });
}

function renderLabsTable(values) {
  return `
    <div class="labs-table">
      <div class="labs-table-head">
        <span>Test</span><span>Reference range</span><span>SI</span>
      </div>
      ${values.map((v) => `
        <div class="labs-row">
          <strong>${escapeHtml(v.name)}</strong>
          <span>${escapeHtml(v.conventional)}</span>
          <em>${escapeHtml(v.si)}</em>
        </div>
      `).join("")}
    </div>
  `;
}

function renderMediaMode() {
  // Preferred path: the concept's full media wall (images + tables + diagrams from
  // every source), matching the app's "Images, tables & diagrams" section. Fetched
  // once per term and cached in state.conceptMedia.
  if (state.cui) {
    if (state.conceptMedia === null) {
      setContent("Loading images, tables & diagrams...", true);
      const requestedCui = state.cui;
      fetchJson(`${API_BASE}/umls/concept/${encodeURIComponent(requestedCui)}/media?limit=120`)
        .then((data) => { state.conceptMedia = Array.isArray(data.items) ? data.items : []; })
        .catch(() => { state.conceptMedia = []; })
        .finally(() => { if (state.mode === "media" && state.cui === requestedCui) renderMediaMode(); });
      return;
    }
    if (state.conceptMedia.length) {
      renderConceptMediaGrid(state.conceptMedia, state.term || "");
      return;
    }
    // Concept resolved but had no tagged media — fall through to the local media.
  }
  renderLocalMediaMode();
}

// Fallback media view built only from the current tooltip + connected references
// (used when no UMLS concept resolved for the term).
function renderLocalMediaMode() {
  const media = Array.isArray(state.reference && state.reference.media) ? state.reference.media : [];
  const sourceCards = connectedMatches().filter((match) => (
    match.kind === "exhibit" ||
    match.kind === "image" ||
    match.kind === "algorithm" ||
    /^\/(?:qbank\/exhibit|qbank\/media|amboss\/image|cliniccons\/image|cliniccons\/algorithm|utd\/graphic)\//.test(match.href || "")
  ));
  let html = "";
  if (media.length) {
    html += `<div class="media-grid">${media.map((item) => `
      <button type="button" class="media-card" data-open-media="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title || state.term || "Image")}">
        <img src="${escapeHtml(apiUrl(item.url))}" alt="${escapeHtml(item.title || state.term || "Image")}">
        <span>${escapeHtml(item.title || "Image")}</span>
      </button>
    `).join("")}</div>`;
  }
  if (sourceCards.length) {
    html += `<div class="group-label">Tables and Algorithms</div>${cardList(sourceCards, "")}`;
  }
  if (!html) {
    setContent("No mapped media.", true);
    return;
  }
  setContent(html);
  contentEl.querySelectorAll("[data-open-media]").forEach((button) => {
    button.addEventListener("click", () => renderImage(button.dataset.openMedia || "", button.dataset.title || "Image"));
  });
  attachOpenHandlers();
}

const UNDERLINES_STORAGE_KEY = "medos:underlines";

function renderDatabases() {
  const termParam = state.term ? `?q=${encodeURIComponent(state.term)}` : "";

  // Read current underlines setting from storage, then render
  chrome.storage.local.get([UNDERLINES_STORAGE_KEY], (result) => {
    const underlinesOn = result[UNDERLINES_STORAGE_KEY] !== "off";

    setContent(`
      <div class="database-grid">
        ${DATABASES.map((item) => `
          <button type="button" class="database-card" data-open-app="${escapeHtml(item.path + (["amboss", "uptodate", "lexi", "diseases"].some((part) => item.path.includes(part)) ? termParam : ""))}">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.subtitle)}</span>
          </button>
        `).join("")}
      </div>

      <div class="setting-row">
        <div class="setting-row-text">
          <strong>Term underlines &amp; hover boxes</strong>
          <span>Underline medical terms on web pages with colored links and quick-peek tooltips</span>
        </div>
        <label class="toggle-pill" title="${underlinesOn ? "Turn off" : "Turn on"}">
          <input type="checkbox" id="underlinesToggle" ${underlinesOn ? "checked" : ""}>
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
      </div>
    `);

    contentEl.querySelectorAll("[data-open-app]").forEach((button) => {
      button.addEventListener("click", () => openApp(button.dataset.openApp || "/"));
    });

    const toggle = document.getElementById("underlinesToggle");
    if (toggle) {
      toggle.addEventListener("change", () => {
        const on = toggle.checked;
        chrome.storage.local.set({ [UNDERLINES_STORAGE_KEY]: on ? "on" : "off" });
        // Update the tooltip label on the wrapper
        toggle.closest("label")?.setAttribute("title", on ? "Turn off" : "Turn on");
        // Trigger content scripts on all matching tabs to immediately rescan
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, { type: "MEDOS_RESCAN_PAGE" }).catch(() => {});
            }
          }
        });
      });
    }
  });
}

async function loadTerm(payload, options = {}) {
  const term = (payload && payload.term ? payload.term : "").trim();
  if (!term) return;
  state.term = term;
  state.selectedPayload = payload;
  state.cui = "";
  state.conceptMedia = null;
  searchInput.value = term;
  hideSuggestions();
  contextCard.className = "context-card empty";
  contextCard.textContent = `Searching ${term}...`;
  setContent("Loading MedOS references...", true);

  const referenceUrl = `${API_BASE}/reference/tooltip?${new URLSearchParams({
    term,
    db: payload.db || "step2",
    source: payload.source || "amboss",
    limit: "16",
  }).toString()}`;
  // Grouped search across every source the app indexes — so the sidebar surfaces
  // First Aid, UWorld Library, Books, Diseases, UMLS and QBank alongside the
  // drug/AMBOSS/UTD hits it already showed.
  const searchUrl = `${API_BASE}/search?${new URLSearchParams({
    q: term,
    scopes: "drugs,amboss,uptodate,firstaid,uworld,books,diseases,umls,qbank,calc",
    grouped: "true",
    limit: "60",
  }).toString()}`;
  const qbankUrl = `${API_BASE}/qbank/list?${new URLSearchParams({
    db: payload.db || "step2",
    q: term,
    limit: "8",
    valid_only: "true",
  }).toString()}`;
  const calcUrl = `${API_BASE}/lexi/calc/list?${new URLSearchParams({
    q: term,
    limit: "80",
  }).toString()}`;
  // Resolve the term to a UMLS concept so the Img tab can pull the concept's
  // full media wall (images, tables, diagrams) from every source.
  const cuiUrl = `${API_BASE}/umls/resolve?${new URLSearchParams({ q: term }).toString()}`;

  const [reference, search, qbank, calcs, concept] = await Promise.allSettled([
    fetchJson(referenceUrl),
    fetchJson(searchUrl),
    fetchJson(qbankUrl),
    fetchJson(calcUrl),
    fetchJson(cuiUrl),
  ]);
  state.reference = reference.status === "fulfilled" ? reference.value : null;
  state.search = search.status === "fulfilled" ? search.value : null;
  state.qbank = qbank.status === "fulfilled" ? qbank.value : null;
  state.calcIndex = calcs.status === "fulfilled" ? (calcs.value.results || []) : [];
  state.cui = concept.status === "fulfilled" ? (concept.value.cui || "") : "";
  renderMode();

  const requestedHref = options.href || payload.href || "";
  if (requestedHref) {
    const exact = [...primaryMatches(), ...questionMatches(), ...calculatorMatches()]
      .find((match) => match.href === requestedHref);
    await openMatch(exact || {
      href: requestedHref,
      source: payload.source || "reference",
      kind: payload.kind || "",
      title: term,
    });
  }
}

async function runSearch() {
  const term = searchInput.value.trim();
  if (!term) return;
  await chrome.storage.session.set({
    [LAST_REFERENCE_KEY]: { term, source: "drug", db: "step2", updatedAt: Date.now() },
  });
  await loadTerm({ term, source: "drug", db: "step2" });
}

function hideSuggestions() {
  renderedSuggestions = [];
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
}

function scheduleSuggestions(delay = 180) {
  window.clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(updateSuggestions, delay);
}

async function updateSuggestions() {
  const term = searchInput.value.trim();
  if (term.length < 2) {
    hideSuggestions();
    return;
  }
  const requestId = ++suggestRequestId;
  suggestionsEl.hidden = false;
  suggestionsEl.innerHTML = `<div class="suggestion-loading">Searching MedOS...</div>`;
  try {
    const params = new URLSearchParams({
      q: term,
      scopes: "drugs,amboss,uptodate,firstaid,uworld,books,diseases,umls,qbank,calc",
      grouped: "true",
      limit: "12",
    });
    const calcParams = new URLSearchParams({ q: term, limit: "12" });
    const [search, calcs] = await Promise.allSettled([
      fetchJson(`${API_BASE}/search?${params.toString()}`),
      fetchJson(`${API_BASE}/lexi/calc/list?${calcParams.toString()}`),
    ]);
    if (requestId !== suggestRequestId) return;
    const searchItems = search.status === "fulfilled" ? searchToSuggestionMatches(search.value) : [];
    const calcItems = calcs.status === "fulfilled"
      ? (calcs.value.results || []).map((item) => calcMatchFromTitle(item.title, item.subtitle || item.category || "Lexi calculator", "Lexi Calculators", `/calculators?q=${encodeURIComponent(item.title)}`))
      : [];
    const suggestions = dedupeMatches([
      ...searchItems,
      ...calcItems,
      ...commonCalculatorMatches(normalizeText(term)),
    ], 12);
    renderSuggestions(suggestions, term);
  } catch (_error) {
    if (requestId === suggestRequestId) hideSuggestions();
  }
}

function searchToSuggestionMatches(data) {
  const groups = (data && data.groups) || {};
  const grouped = [];
  for (const g of SEARCH_GROUP_ORDER) {
    for (const item of groups[g.key] || []) {
      grouped.push({ ...item, source: g.source, group: g.label });
    }
  }
  grouped.push(
    ...(groups.calc || [])
      .filter((item) => item && item.title)
      .map((item) => calcMatchFromTitle(item.title, item.subtitle || "MedOS calculator", "Calculator Search", item.href)),
  );
  const flat = Array.isArray(data && data.results)
    ? data.results.map((item) => ({
      title: item.title || item.name || item.label || "",
      subtitle: item.subtitle || item.description || item.kind || "",
      href: item.href || item.url || "",
      source: normalizeSource(item.source || item.scope || item.type || "reference"),
      kind: item.kind || "",
      group: item.group || "",
    })).filter((item) => item.title)
    : [];
  return dedupeMatches([...grouped, ...flat], 16);
}

function renderSuggestions(items, term) {
  renderedSuggestions = items;
  if (!items.length) {
    suggestionsEl.innerHTML = `
      <button type="button" class="suggestion suggestion-search" data-search-term="${escapeHtml(term)}">
        <span class="badge badge-reference">GO</span>
        <span><strong>Search "${escapeHtml(term)}"</strong><span>References, QBank, media, and calculators</span></span>
      </button>
    `;
    suggestionsEl.hidden = false;
    return;
  }
  suggestionsEl.innerHTML = items.map((item, index) => {
    const source = normalizeSource(item.source || "reference");
    return `
      <button type="button" class="suggestion" data-suggestion-index="${index}">
        <span class="badge badge-${escapeHtml(source)}">${escapeHtml(sourceLabel(source))}</span>
        <span>
          <strong>${escapeHtml(item.title || "Open result")}</strong>
          <span>${escapeHtml(item.subtitle || item.group || item.kind || "")}</span>
        </span>
      </button>
    `;
  }).join("");
  suggestionsEl.hidden = false;
}

async function chooseSuggestion(item) {
  if (!item) return;
  hideSuggestions();
  const term = (item.title || searchInput.value || "").trim();
  searchInput.value = term;
  if (item.href && item.href.startsWith("/native-calc/")) {
    renderNativeCalculator(item.href.replace("/native-calc/", ""));
    return;
  }
  if (item.href && item.href.startsWith("/calculators")) {
    const id = nativeCalcIdFromTitle(`${item.title || ""} ${item.subtitle || ""}`);
    if (id) {
      renderNativeCalculator(id);
      return;
    }
  }
  if (item.href) {
    await loadTerm({ term, source: normalizeSource(item.source || "amboss"), db: "step2", kind: item.kind || "", href: item.href }, { href: item.href });
    return;
  }
  await loadTerm({ term, source: "amboss", db: "step2" });
}

function prepareArticleHtml(html, baseUrl, source) {
  const responsiveCss = `
    <style id="medos-extension-reader-css">
      html, body { width: 100% !important; min-width: 0 !important; max-width: 100% !important; margin: 0 !important; overflow-x: hidden !important; background: #fff !important; }
      body { padding: 14px !important; color: #172033 !important; font-size: 15px !important; line-height: 1.55 !important; }
      *, *::before, *::after { box-sizing: border-box !important; }
      body > *, main, article, section, div, p, ul, ol, li { max-width: 100% !important; }
      p, li, td, th, div { overflow-wrap: anywhere !important; }
      table { display: block !important; width: 100% !important; max-width: 100% !important; overflow-x: auto !important; border-collapse: collapse !important; table-layout: auto !important; }
      td, th { min-width: 0 !important; white-space: normal !important; vertical-align: top !important; }
      img, svg, video, canvas { max-width: 100% !important; height: auto !important; }
      pre, code { white-space: pre-wrap !important; }
      .topicOutline, .toc, nav, aside { max-width: 100% !important; }
      ${source === "utd" ? ".utd-header, .header, #header, .footer, #footer { max-width: 100% !important; }" : ""}
    </style>
  `;
  let doc = String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\s(src|href)=["']\/([^"']*)["']/gi, (_m, attr, path) => ` ${attr}="${API_BASE}/${path}"`);
  const base = `<base href="${escapeHtml(baseUrl)}" target="_blank">`;
  if (/<head[^>]*>/i.test(doc)) {
    return doc.replace(/<head([^>]*)>/i, `<head$1>${base}${responsiveCss}`);
  }
  return `<!doctype html><html><head>${base}${responsiveCss}</head><body>${doc}</body></html>`;
}

function renderPreviewFrame(title, srcdoc, openUrl) {
  setHeader("Source Preview", `<button id="backToResults" class="small-button" type="button">Results</button>`);
  setContent(`
    <div class="preview-box">
      <div class="preview-toolbar">
        <span class="preview-title">${escapeHtml(title || "Source")}</span>
        <button id="openSourceTab" class="small-button" type="button">Open</button>
      </div>
      <iframe class="reader-frame" sandbox="allow-same-origin allow-popups allow-forms" srcdoc="${escapeHtml(srcdoc)}"></iframe>
    </div>
  `);
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
  document.getElementById("openSourceTab")?.addEventListener("click", () => chrome.tabs.create({ url: openUrl }).catch(() => {}));
}

async function renderArticleDocument(path, title, source) {
  setContent(`Loading ${escapeHtml(title || "article")}...`, true);
  const absoluteUrl = apiUrl(path);
  const html = await fetchText(absoluteUrl);
  renderPreviewFrame(title, prepareArticleHtml(html, absoluteUrl, source), absoluteUrl);
}

async function renderHtmlFrame(path, title) {
  setContent(`Loading ${escapeHtml(title || "source")}...`, true);
  const absoluteUrl = apiUrl(path);
  const html = await fetchText(absoluteUrl);
  renderPreviewFrame(title, prepareArticleHtml(html, absoluteUrl, "reference"), absoluteUrl);
}

function renderImage(path, title) {
  setHeader("Image Preview", `<button id="backToResults" class="small-button" type="button">Results</button>`);
  setContent(`
    <div class="preview-box">
      <div class="preview-toolbar">
        <span class="preview-title">${escapeHtml(title || "Image")}</span>
        <button id="openSourceTab" class="small-button" type="button">Open</button>
      </div>
      <div class="image-box"><img src="${escapeHtml(apiUrl(path))}" alt="${escapeHtml(title || "Image")}"></div>
    </div>
  `);
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
  document.getElementById("openSourceTab")?.addEventListener("click", () => chrome.tabs.create({ url: apiUrl(path) }).catch(() => {}));
}

// ── Source href parsers (search results → in-panel renderers) ──────────────
function firstaidHeadingFromHref(href) {
  const s = String(href || "");
  const hash = s.match(/#firstaid-(\d+)/);
  if (hash) return hash[1];
  const query = s.match(/[?&]heading_id=(\d+)/);
  if (query) return query[1];
  if (/^\d+$/.test(s)) return s;   // a bare heading id passed as match.id
  return "";
}

function uworldLibraryDocFromHref(href) {
  const s = String(href || "");
  const lib = s.match(/\/library\/uworld\?(?:.*&)?doc=(\d+)/);
  if (lib) return lib[1];
  const art = s.match(/\/uworld-library\/article\/(\d+)/);
  if (art) return art[1];
  return "";
}

function cuiFromHref(href) {
  const m = String(href || "").match(/[?&]cui=(C\d{7})/i);
  return m ? m[1].toUpperCase() : "";
}

// First Aid: show the rendered high-yield snippet image plus its extracted text.
// The snippet image is a pre-rendered crop of the actual First Aid page, so the
// user sees the real page content without loading the whole 1000-page PDF.
async function renderFirstAidSnippet(headingId, fallbackTitle = "") {
  setContent(`Loading First Aid...`, true);
  let region = null;
  try {
    region = await fetchJson(`${API_BASE}/firstaid/snippet?heading_id=${encodeURIComponent(headingId)}`);
  } catch (_error) {
    region = null;
  }
  const title = (region && region.title) || fallbackTitle || "First Aid";
  const hierarchy = (region && region.hierarchy) || "";
  const imageUrl = region && region.image_url
    ? region.image_url
    : `/firstaid/snippet/image?heading_id=${encodeURIComponent(headingId)}&zoom=2`;
  const bodyText = (region && region.body_text) || "";
  const appHref = (region && region.href) || "";
  setHeader("First Aid", `<button id="backToResults" class="small-button" type="button">Results</button>`);
  setContent(`
    <article class="firstaid-view">
      <div class="firstaid-head">
        <span class="badge badge-firstaid">FA</span>
        <div>
          <h3>${escapeHtml(title)}</h3>
          ${hierarchy ? `<p class="firstaid-hierarchy">${escapeHtml(hierarchy)}</p>` : ""}
        </div>
      </div>
      <div class="image-box firstaid-snippet"><img src="${escapeHtml(apiUrl(imageUrl))}" alt="${escapeHtml(title)}"></div>
      ${bodyText ? `<p class="firstaid-text">${escapeHtml(bodyText)}</p>` : ""}
      ${appHref ? `<div class="firstaid-actions"><button id="openFaApp" class="primary-button" type="button">Open the page in MedOS</button></div>` : ""}
    </article>
  `);
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
  document.getElementById("openFaApp")?.addEventListener("click", () => openApp(appHref));
}

// UMLS concept media wall — every image, table and diagram tagged to the concept,
// pulled from Diseases, UpToDate, UWorld Library, AMBOSS and QBank. Mirrors the
// app's "Images, tables & diagrams" wall but stays inside the panel (no whole
// book/article is opened — a click previews just the single image or table).
async function renderConceptMedia(cui, fallbackTitle = "") {
  const value = cuiFromHref(`?cui=${cui}`) || String(cui || "").toUpperCase();
  setHeader("Images, Tables & Diagrams", `<button id="backToResults" class="small-button" type="button">Results</button>`);
  setContent("Loading concept media...", true);
  let items = [];
  try {
    const data = await fetchJson(`${API_BASE}/umls/concept/${encodeURIComponent(value)}/media?limit=120`);
    items = Array.isArray(data.items) ? data.items : [];
  } catch (_error) {
    items = [];
  }
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
  if (!items.length) {
    setContent(`No images, tables or diagrams mapped to ${escapeHtml(fallbackTitle || value)}.`, true);
    return;
  }
  renderConceptMediaGrid(items, fallbackTitle);
}

function renderConceptMediaGrid(items, title) {
  setHeader(
    `Images, Tables & Diagrams${title ? ` · ${title}` : ""}`,
    `<button id="backToResults" class="small-button" type="button">Results</button>`,
  );
  const html = `<div class="media-grid media-grid-concept">${items.map((item, index) => {
    const previewUrl = apiUrl(item.preview_href || item.href);
    const badge = sourceLabel(normalizeSource(item.source));
    const isExhibit = item.media_type === "exhibit";
    return `
      <button type="button" class="media-card${isExhibit ? " media-card-exhibit" : ""}" data-media-index="${index}">
        <span class="media-card-badge badge badge-${escapeHtml(normalizeSource(item.source))}">${escapeHtml(badge)}</span>
        ${isExhibit
          ? `<span class="media-card-table">▦ Table</span>`
          : `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(item.title || "Image")}" loading="lazy">`}
        <span>${escapeHtml(item.title || (isExhibit ? "Table" : "Image"))}</span>
      </button>
    `;
  }).join("")}</div>`;
  setContent(html);
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
  contentEl.querySelectorAll("[data-media-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items[Number(button.dataset.mediaIndex)];
      if (!item) return;
      if (item.media_type === "exhibit") {
        renderHtmlFrame(item.href, item.title || "Table");
      } else {
        renderImage(item.href, item.title || "Image");
      }
    });
  });
}

function renderNativeCalculator(id) {
  const calc = NATIVE_CALCS[id];
  if (!calc) {
    renderCalculatorInfo({
      title: "Calculator",
      subtitle: "This calculator is available in the full MedOS app.",
      href: "/calculators",
    });
    return;
  }
  state.mode = "calculators";
  updateModeRail("calculators");
  setHeader("Calculator", `<button id="backToResults" class="small-button" type="button">Results</button>`);
  setContent(`
    <article class="calc-panel">
      <div class="calc-heading">
        <h3>${escapeHtml(calc.title)}</h3>
        <p>${escapeHtml(calc.subtitle || "")}</p>
      </div>
      <form id="nativeCalcForm" class="calc-form">
        ${calc.fields.map((field) => renderCalcField(field)).join("")}
      </form>
      <div id="calcResult" class="calc-result calc-result-empty">
        <span>Enter values to calculate.</span>
      </div>
    </article>
  `);
  const form = document.getElementById("nativeCalcForm");
  const resultEl = document.getElementById("calcResult");
  const updateResult = () => {
    const values = {};
    for (const field of calc.fields) {
      const input = form.elements[field.id];
      if (field.type === "check") {
        values[field.id] = Boolean(input && input.checked);
      } else {
        const raw = input ? input.value : "";
        values[field.id] = raw === "" ? "" : Number(raw);
      }
    }
    const missingRequired = calc.fields.some((field) => (
      !field.optional &&
      field.type !== "check" &&
      field.type !== "select" &&
      (values[field.id] === "" || values[field.id] === null || Number.isNaN(values[field.id]))
    ));
    if (missingRequired) {
      resultEl.className = "calc-result calc-result-empty";
      resultEl.innerHTML = "<span>Enter values to calculate.</span>";
      return;
    }
    const result = calc.compute(values, calc.fields);
    if (!result) {
      resultEl.className = "calc-result calc-result-empty";
      resultEl.innerHTML = "<span>Enter values to calculate.</span>";
      return;
    }
    resultEl.className = "calc-result";
    resultEl.innerHTML = `
      <strong>${escapeHtml(result.value)} ${escapeHtml(result.unit || "")}</strong>
      <span>${escapeHtml(result.label || "")}</span>
    `;
  };
  form.addEventListener("input", updateResult);
  form.addEventListener("change", updateResult);
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
  updateResult();
}

function renderCalcField(field) {
  if (field.type === "check") {
    const pointText = field.points === undefined ? "+1" : `${field.points > 0 ? "+" : ""}${field.points}`;
    return `
      <label class="calc-check">
        <input type="checkbox" name="${escapeHtml(field.id)}">
        <span>${escapeHtml(field.label)}</span>
        <em>${escapeHtml(pointText)}</em>
      </label>
    `;
  }
  if (field.type === "select") {
    return `
      <div class="calc-field">
        <label for="calc-${escapeHtml(field.id)}">${escapeHtml(field.label)}</label>
        <select id="calc-${escapeHtml(field.id)}" name="${escapeHtml(field.id)}">
          ${(field.options || []).map(([value, label]) => `<option value="${escapeHtml(value)}"${String(field.value ?? "") === String(value) ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
        </select>
      </div>
    `;
  }
  return `
    <div class="calc-field">
      <label for="calc-${escapeHtml(field.id)}">${escapeHtml(field.label)}${field.unit ? ` <span>${escapeHtml(field.unit)}</span>` : ""}</label>
      <input id="calc-${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" type="number" inputmode="decimal" step="any" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(field.placeholder || "")}">
    </div>
  `;
}

function renderCalculatorInfo(match) {
  const href = match.href || "/calculators";
  state.mode = "calculators";
  updateModeRail("calculators");
  setHeader("Calculator", `<button id="backToResults" class="small-button" type="button">Results</button>`);
  setContent(`
    <article class="info-card">
      <span class="badge badge-calc">CALC</span>
      <h3>${escapeHtml(match.title || "Calculator")}</h3>
      <p>${escapeHtml(match.subtitle || "Available in the MedOS calculator database.")}</p>
      <button id="openFullCalculator" class="primary-button" type="button">Open Full Calculator</button>
    </article>
  `);
  document.getElementById("openFullCalculator")?.addEventListener("click", () => openApp(href));
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
}

function compactText(value, max = 520) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function sectionText(profile, key, max = 520) {
  const section = profile && profile.sections && profile.sections[key];
  return compactText(section && section.text, max);
}

async function renderDrugProfileFromHref(href, fallbackTitle = "") {
  const url = new URL(href, API_BASE);
  const id = url.searchParams.get("id") || url.pathname.match(/^\/drugs\/(\d+)/)?.[1];
  if (!id) {
    openApp(href || "/drugs");
    return;
  }
  setContent(`Loading ${escapeHtml(fallbackTitle || "drug reference")}...`, true);
  const profile = await fetchJson(`${API_BASE}/drugs/${encodeURIComponent(id)}`);
  renderDrugProfile(profile);
}

function renderDrugProfile(profile) {
  state.mode = "reference";
  updateModeRail("reference");
  const brands = Array.isArray(profile.brand_names) ? profile.brand_names.filter(Boolean).slice(0, 5) : [];
  const classes = Array.isArray(profile.drug_class) ? profile.drug_class.filter(Boolean).slice(0, 4) : [];
  const indications = sectionText(profile, "indications", 420);
  const dosing = compactText(profile.quick_info?.dose_snippet || sectionText(profile, "adult_dosing", 520), 520);
  const bbw = compactText(profile.quick_info?.bbw_snippet || sectionText(profile, "black_box_warning", 420), 420);
  setHeader("Drug Reference", `<button id="backToResults" class="small-button" type="button">Results</button>`);
  setContent(`
    <article class="drug-profile">
      <div class="drug-profile-head">
        <span class="badge badge-drug">DRUG</span>
        <h3>${escapeHtml(profile.generic_name || "Drug")}${brands.length ? ` <span>(${escapeHtml(brands.join(", "))})</span>` : ""}</h3>
        ${classes.length ? `<p>${escapeHtml(classes.join(" / "))}</p>` : ""}
      </div>
      ${profile.has_black_box || bbw ? `<section class="drug-profile-section drug-profile-warning"><strong>Black box warning</strong><p>${escapeHtml(bbw || "Present in the local drug reference database.")}</p></section>` : ""}
      ${dosing ? `<section class="drug-profile-section"><strong>Dose and frequency</strong><p>${escapeHtml(dosing)}</p></section>` : ""}
      ${indications ? `<section class="drug-profile-section"><strong>Indications</strong><p>${escapeHtml(indications)}</p></section>` : ""}
      <div class="drug-profile-actions">
        <button id="openDrugApp" class="primary-button" type="button">Open Drug Ref</button>
        ${profile.utd_topic_id ? `<button id="openDrugUtd" class="small-button" type="button">Open UTD</button>` : ""}
      </div>
      <div id="doseCalcMount"></div>
    </article>
  `);
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
  document.getElementById("openDrugApp")?.addEventListener("click", () => openApp(`/drugs?id=${encodeURIComponent(profile.drug_id)}`));
  document.getElementById("openDrugUtd")?.addEventListener("click", () => renderArticleDocument(`/utd/topic/${encodeURIComponent(profile.utd_topic_id)}/html`, `${profile.generic_name}: UpToDate`, "utd"));
  const mount = document.getElementById("doseCalcMount");
  if (mount && profile.drug_id) {
    renderDoseCalculator(mount, profile.drug_id).catch(() => {});
  }
}

// ── In-panel Dose Calculator / prescription builder ─────────────────────────
// Mirrors the app's DoseCalculator: indication + weight/age + CrCl/Child-Pugh
// against /drugs/dose, with the renal & hepatic guidance boxes and a copyable
// prescription — so a dose can be checked at the bedside without opening the app.
const GUIDANCE_TONES = {
  avoid: { label: "AVOID", cls: "dc-tone-avoid" },
  no_change: { label: "NO CHANGE", cls: "dc-tone-ok" },
  factor: { label: "DOSE ADJUSTED", cls: "dc-tone-info" },
  day_cap: { label: "DAILY CAP", cls: "dc-tone-info" },
  replace: { label: "USE SOURCE REGIMEN", cls: "dc-tone-info" },
  increase_possible: { label: "MAY NEED MORE", cls: "dc-tone-warn" },
  verify: { label: "VERIFY", cls: "dc-tone-warn" },
  none: { label: "NO DATA", cls: "dc-tone-muted" },
};

function guidanceBoxHtml(title, guidance) {
  if (!guidance) return "";
  const tone = GUIDANCE_TONES[guidance.status] || GUIDANCE_TONES.verify;
  return `
    <div class="dc-guidance ${tone.cls}">
      <div class="dc-guidance-head"><strong>${escapeHtml(title)}</strong><span class="dc-guidance-chip">${escapeHtml(tone.label)}</span></div>
      <div class="dc-guidance-msg">${escapeHtml(guidance.message || "")}</div>
      ${guidance.source_text ? `<div class="dc-guidance-src">Source: “${escapeHtml(guidance.source_text)}”</div>` : ""}
    </div>
  `;
}

async function renderDoseCalculator(mount, drugId) {
  let popup = null;
  try {
    popup = await fetchJson(`${API_BASE}/drugs/popup/${encodeURIComponent(drugId)}`);
  } catch (_error) {
    mount.innerHTML = "";
    return;
  }
  const indications = Array.isArray(popup.indications) ? popup.indications : [];
  const forms = (popup.identity && popup.identity.form_options) || [];
  const defaultWeight = popup.default_weight_kg || 60;
  const defaultIndication = popup.default_indication_id ? String(popup.default_indication_id) : "";

  mount.innerHTML = `
    <section class="dose-calc">
      <div class="dose-calc-title">⌁ Dose Calculator</div>
      <label class="dc-field">
        <span>Indication</span>
        <select data-dc="indication">
          <option value="">Primary source indication</option>
          ${indications.map((i) => `<option value="${escapeHtml(String(i.id))}"${String(i.id) === defaultIndication ? " selected" : ""}>${escapeHtml(i.indication_text)}${i.label_status === "fda_labeled" ? " (FDA)" : ""}</option>`).join("")}
        </select>
      </label>
      <div class="dc-row">
        <label class="dc-field"><span>Weight kg</span><input data-dc="weight" type="number" min="1" max="500" step="0.1" value="${escapeHtml(String(defaultWeight))}"></label>
        <label class="dc-field"><span>Age years</span><input data-dc="age" type="number" min="0" max="120" step="1" placeholder="opt"></label>
      </div>
      ${forms.length ? `
      <label class="dc-field">
        <span>Form</span>
        <select data-dc="form">
          <option value="">Best matching form</option>
          ${forms.map((f) => `<option value="${escapeHtml(f.dose_form || "")}">${escapeHtml(f.dose_form || "form")}${(f.strengths || []).length ? ` (${escapeHtml(f.strengths.slice(0, 3).join(", "))})` : ""}</option>`).join("")}
        </select>
      </label>` : ""}
      <div class="dc-row">
        <label class="dc-field"><span>CrCl mL/min</span><input data-dc="crcl" type="number" min="1" max="300" step="1" placeholder="renal: opt"></label>
        <label class="dc-field"><span>Child-Pugh</span>
          <select data-dc="pugh"><option value="">—</option><option value="A">A</option><option value="B">B</option><option value="C">C</option></select>
        </label>
      </div>
      <div class="dc-result" data-dc="result"><span class="dc-muted">Enter values — the dose updates automatically.</span></div>
    </section>
  `;

  const q = (key) => mount.querySelector(`[data-dc="${key}"]`);
  const resultEl = q("result");
  let timer = null;
  let requestSeq = 0;

  async function calculate() {
    const seq = ++requestSeq;
    const params = new URLSearchParams({ drug_id: String(drugId) });
    const indication = q("indication").value;
    const weight = q("weight").value;
    const age = q("age").value;
    const form = q("form") ? q("form").value : "";
    const crcl = q("crcl").value;
    const pugh = q("pugh").value;
    if (indication) params.set("indication_id", indication);
    if (weight) params.set("weight_kg", weight);
    if (age) params.set("age_years", age);
    if (form) params.set("dose_form", form);
    if (crcl) params.set("crcl", crcl);
    if (pugh) params.set("child_pugh", pugh);
    resultEl.innerHTML = `<span class="dc-muted">Calculating…</span>`;
    let data = null;
    try {
      data = await fetchJson(`${API_BASE}/drugs/dose?${params.toString()}`);
    } catch (_error) {
      if (seq === requestSeq) resultEl.innerHTML = `<span class="dc-muted">Dose lookup failed — is MedOS running?</span>`;
      return;
    }
    if (seq !== requestSeq) return;
    renderResult(data);
  }

  function renderResult(data) {
    const p = data.prescription;
    const rxText = p ? `${p.drug_display}\nSig: ${p.sig}\nDisp: ${p.dispense} · Refills: ${p.refills}` : "";
    resultEl.innerHTML = `
      <div class="dc-display">${escapeHtml(data.display || "No structured dose available")}
        <span class="dc-confidence dc-confidence-${escapeHtml(data.confidence || "low")}">${escapeHtml((data.confidence || "low").toUpperCase())}</span>
      </div>
      ${data.computed_dose != null ? `<div class="dc-computed">Computed: ${escapeHtml(String(data.computed_dose))} ${escapeHtml(data.dose_unit || "")}${data.doses_per_day ? ` · ${escapeHtml(String(data.doses_per_day))}×/day` : ""}${data.total_mg_per_day ? ` · ${escapeHtml(String(data.total_mg_per_day))} mg/day` : ""}</div>` : ""}
      ${data.indication_fallback ? `<div class="dc-note dc-tone-info">No parsed rule for “${escapeHtml(data.indication_fallback.requested_text || "selected indication")}” — using the closest rule (${escapeHtml(data.indication_fallback.used_text || "other indication")}). Verify applicability.</div>` : ""}
      ${guidanceBoxHtml("Renal adjustment", data.renal_guidance)}
      ${guidanceBoxHtml("Hepatic adjustment", data.hepatic_guidance)}
      ${(data.adjustments_applied || [])
        .filter((a) => a !== "none")
        .filter((a) => a !== (data.renal_guidance || {}).message && a !== (data.hepatic_guidance || {}).message)
        .map((a) => `<div class="dc-note">${escapeHtml(a)}</div>`).join("")}
      ${(data.assumptions || []).map((a) => `<div class="dc-note">${escapeHtml(a)}</div>`).join("")}
      ${(data.needs || []).length ? `<div class="dc-note dc-tone-warn">Needs: ${escapeHtml(data.needs.join(", "))}</div>` : ""}
      ${(data.calculation_steps || []).length ? `
        <div class="dc-steps">
          <div class="dc-steps-title">How this dose was calculated</div>
          <ol>${data.calculation_steps.map((s) => `<li class="${s.startsWith("SAFETY") ? "dc-step-safety" : ""}">${escapeHtml(s)}</li>`).join("")}</ol>
          ${data.max_mg_per_day_ceiling ? `<div class="dc-muted">Source maximum: ${escapeHtml(String(data.max_mg_per_day_ceiling))} mg/day</div>` : ""}
        </div>` : ""}
      ${(data.dose_notes || []).map((n) => `<div class="dc-note dc-tone-info">${escapeHtml(n)}</div>`).join("")}
      ${p ? `
        <div class="dc-rx">
          <div class="dc-rx-head"><strong>Prescription</strong><button type="button" class="small-button" data-dc="copy">Copy</button></div>
          <div class="dc-rx-line">${escapeHtml(p.drug_display)}</div>
          <div class="dc-rx-line">Sig: ${escapeHtml(p.sig)}</div>
          <div class="dc-rx-line">Disp: ${escapeHtml(p.dispense)} · Refills: ${escapeHtml(String(p.refills))}</div>
        </div>` : ""}
      <div class="dc-disclaimer">${escapeHtml(data.disclaimer || "Verify before clinical use.")}</div>
    `;
    const copyBtn = resultEl.querySelector('[data-dc="copy"]');
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(rxText).then(() => {
          copyBtn.textContent = "Copied";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1400);
        }).catch(() => {});
      });
    }
  }

  mount.querySelectorAll("[data-dc]").forEach((el) => {
    if (el.dataset.dc === "result") return;
    el.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(calculate, 300);
    });
    el.addEventListener("change", () => {
      clearTimeout(timer);
      timer = setTimeout(calculate, 150);
    });
  });
  calculate();
}

function qbankApiFromHref(href) {
  const url = new URL(href, API_BASE);
  if (url.pathname === "/qbank") {
    const qid = url.searchParams.get("qid");
    const db = url.searchParams.get("db") || "step2";
    if (qid) return `${API_BASE}/qbank/question/${encodeURIComponent(qid)}?db=${encodeURIComponent(db)}`;
  }
  const match = url.pathname.match(/^\/qbank\/question\/(\d+)/);
  if (match) {
    const db = url.searchParams.get("db") || "step2";
    return `${API_BASE}/qbank/question/${encodeURIComponent(match[1])}?db=${encodeURIComponent(db)}`;
  }
  return "";
}

async function renderQuestionFromHref(href) {
  const api = qbankApiFromHref(href);
  if (!api) {
    openApp(href);
    return;
  }
  const hrefUrl = new URL(href, API_BASE);
  const db = hrefUrl.searchParams.get("db") || "step2";
  const question = await fetchJson(api);
  renderQuestion(question, db);
}

function renderQuestion(question, db = "step2") {
  setHeader("QBank Question", `<button id="backToResults" class="small-button" type="button">Results</button>`);
  const choices = Array.isArray(question.choices_html) ? question.choices_html : [];
  const correct = Number(question.correct || 0);
  setContent(`
    <article class="question-view">
      <div class="preview-toolbar">
        <span class="preview-title">${escapeHtml(question.title || `Question ${question.id}`)}</span>
        <button id="openQuestionApp" class="small-button" type="button">Open App</button>
      </div>
      <section class="html-content">${rewriteApiRelativeHtml(question.stem_html || escapeHtml(question.stem || ""))}</section>
      ${choices.map((choice, index) => `
        <div class="choice" data-choice="${index + 1}">
          <span class="choice-letter">${String.fromCharCode(65 + index)}</span>
          <div class="html-content">${rewriteApiRelativeHtml(choice)}</div>
        </div>
      `).join("")}
      <div class="question-actions">
        <button id="showAnswerButton" class="small-button" type="button">Show Answer</button>
      </div>
      <section class="html-content question-explanation is-hidden">${rewriteApiRelativeHtml(question.explanation_html || escapeHtml(question.explanation || ""))}</section>
    </article>
  `);
  const reveal = (selected) => {
    contentEl.querySelectorAll(".choice").forEach((choice) => {
      const value = Number(choice.dataset.choice || 0);
      choice.classList.toggle("choice-selected", value === selected);
      choice.classList.toggle("choice-correct", value === correct);
      choice.classList.toggle("choice-wrong", selected === value && value !== correct);
    });
    contentEl.querySelector(".question-explanation")?.classList.remove("is-hidden");
  };
  contentEl.querySelectorAll(".choice").forEach((choice) => {
    choice.addEventListener("click", () => reveal(Number(choice.dataset.choice || 0)));
  });
  document.getElementById("showAnswerButton")?.addEventListener("click", () => reveal(0));
  document.getElementById("openQuestionApp")?.addEventListener("click", () => openApp(`/qbank?db=${encodeURIComponent(db)}&qid=${question.id}`));
  document.getElementById("backToResults")?.addEventListener("click", renderMode);
}

async function loadRandomQuestion() {
  setContent("Loading random question...", true);
  const question = await fetchJson(`${API_BASE}/qbank/random?db=step2&valid_only=true`);
  state.mode = "questions";
  setMode("questions");
  renderQuestion(question, "step2");
}

async function openMatch(match) {
  const href = match.href || "";
  if (!href) return;
  try {
    if (href.startsWith("/native-calc/")) {
      return renderNativeCalculator(href.replace("/native-calc/", ""));
    }
    if (href.startsWith("/calculators")) {
      const id = nativeCalcIdFromTitle(`${match.title || ""} ${match.subtitle || ""}`);
      if (id) return renderNativeCalculator(id);
      return renderCalculatorInfo(match);
    }
    if (href.startsWith("/drugs")) {
      return renderDrugProfileFromHref(href, match.title);
    }
    if (href.startsWith("/amboss?")) {
      const doc = new URL(href, API_BASE).searchParams.get("doc");
      if (doc) return renderArticleDocument(`/amboss/article/${encodeURIComponent(doc)}`, match.title, "amboss");
    }
    if (href.startsWith("/uptodate?")) {
      const topic = new URL(href, API_BASE).searchParams.get("t");
      if (topic) return renderArticleDocument(`/utd/topic/${encodeURIComponent(topic)}/html`, match.title, "utd");
    }
    if (href.startsWith("/qbank?") || href.startsWith("/qbank/question/")) {
      return renderQuestionFromHref(href);
    }
    // First Aid: search returns "#firstaid-<headingId>"; render the rendered
    // FA snippet image + text in-panel instead of jumping to the app.
    const faId = firstaidHeadingFromHref(href) || (match.source === "firstaid" ? firstaidHeadingFromHref(match.id) : "");
    if (faId) {
      return renderFirstAidSnippet(faId, match.title);
    }
    // UWorld Library article — decrypt + render its HTML in the reader frame.
    const uwDoc = uworldLibraryDocFromHref(href);
    if (uwDoc) {
      return renderArticleDocument(`/uworld-library/article/${encodeURIComponent(uwDoc)}`, match.title, "uworld");
    }
    // UMLS concept — open the in-panel concept media wall, never the whole app page.
    const cui = cuiFromHref(href);
    if (cui) {
      return renderConceptMedia(cui, match.title);
    }
    if (/^\/(?:qbank\/media|amboss\/image|cliniccons\/image|utd\/graphic)\//.test(href)) {
      return renderImage(href, match.title);
    }
    if (/^\/(?:qbank\/exhibit|cliniccons\/algorithm|cliniccons\/disease)\//.test(href)) {
      return renderHtmlFrame(href, match.title);
    }
    if (/^\/(?:calculators|books|library|amboss|uptodate|qbank|lexi|diseases|drugs)\b/.test(href)) {
      openApp(href);
      return;
    }
    return renderHtmlFrame(href, match.title);
  } catch (error) {
    setContent(`Could not open source: ${escapeHtml(String(error))}`, true);
  }
}

function applySelection(payload) {
  const term = (payload && payload.term ? payload.term : "").trim();
  if (!term) return;
  state.term = term;
  state.selectedPayload = payload;
  searchInput.value = term;
  scheduleSuggestions(0);
  if (!state.reference) {
    contextCard.className = "context-card";
    contextCard.innerHTML = `
      <h2 class="context-title">${escapeHtml(term)}</h2>
      <div class="context-meta">Selected text from current page</div>
      <p class="context-abstract">Selection ready.</p>
    `;
  }
}

async function loadStoredState() {
  const stored = await chrome.storage.session.get([LAST_REFERENCE_KEY, LAST_SELECTION_KEY]);
  const reference = stored[LAST_REFERENCE_KEY];
  if (reference && reference.term) {
    await loadTerm(reference);
    return;
  }
  const selection = stored[LAST_SELECTION_KEY];
  if (selection && selection.term) {
    applySelection(selection);
  }
}

searchButton.addEventListener("click", runSearch);
searchInput.addEventListener("input", () => scheduleSuggestions());
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    hideSuggestions();
    runSearch();
  }
  if (event.key === "Escape") hideSuggestions();
});
suggestionsEl.addEventListener("click", (event) => {
  const searchButtonEl = event.target && event.target.closest && event.target.closest("[data-search-term]");
  if (searchButtonEl) {
    searchInput.value = searchButtonEl.dataset.searchTerm || searchInput.value;
    runSearch();
    return;
  }
  const button = event.target && event.target.closest && event.target.closest("[data-suggestion-index]");
  if (!button) return;
  const index = Number(button.dataset.suggestionIndex);
  chooseSuggestion(renderedSuggestions[index]).catch((error) => {
    setContent(`Could not open suggestion: ${escapeHtml(String(error))}`, true);
  });
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (target && (suggestionsEl.contains(target) || searchInput.contains(target))) return;
  hideSuggestions();
});
openAppButton.addEventListener("click", () => openApp("/"));
modeRail.addEventListener("click", (event) => {
  const button = event.target && event.target.closest && event.target.closest("button[data-mode]");
  if (!button) return;
  setMode(button.dataset.mode || "reference");
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "MEDOS_REFERENCE_SELECTED") {
    loadTerm(message.payload || {}, { href: (message.payload || {}).href || "" });
  }
  if (message && message.type === "MEDOS_SELECTION_CHANGED") {
    applySelection(message.payload || {});
  }
});

// ── App ↔ Extension session sync ─────────────────────────────────────────
let _lastSyncedTerm = null;
let _sessionPollTimer = null;
const syncBadgeEl = document.getElementById("syncBadge");

async function pollSessionState() {
  try {
    const r = await fetch(`${API_BASE}/session/state`, { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    const term = data.current_term;
    if (term && term !== _lastSyncedTerm && term !== state.term) {
      _lastSyncedTerm = term;
      const source = data.current_source || "amboss";
      const db = data.db || "step2";
      await loadTerm({ term, source, db });
      showSyncBadge(source);
    }
  } catch { /* backend offline — no action */ }
}

function showSyncBadge(source) {
  if (!syncBadgeEl) return;
  const label = {
    amboss: "AMBOSS", utd: "UpToDate", drug: "Drug Ref", qbank: "QBank",
    firstaid: "First Aid", umls: "UMLS", uworld: "UWorld Library",
    books: "Books", diseases: "Disease",
  }[source] || "App";
  syncBadgeEl.textContent = `↑ from ${label}`;
  syncBadgeEl.hidden = false;
  syncBadgeEl.style.animation = "none";
  // force reflow so the animation restarts
  void syncBadgeEl.offsetWidth;
  syncBadgeEl.style.animation = "";
  setTimeout(() => { syncBadgeEl.hidden = true; }, 3000);
}

function startSessionPoll() {
  clearInterval(_sessionPollTimer);
  _sessionPollTimer = setInterval(pollSessionState, SESSION_POLL_MS);
}

checkBackend();
startSessionPoll();
loadStoredState();
