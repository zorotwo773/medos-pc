/* ──────────────────────────────────────────────────────────────
   MedOS ACLS — reference panels shown under the algorithm and in
   the Causes checklist. 2025 AHA Guidelines wording.
   ────────────────────────────────────────────────────────────── */

export interface ReversibleCause {
  id: string;
  label: string;
  group: "H" | "T";
  hint: string;
  action: string;
  /** Shown only for the pediatric algorithm. */
  pediatricOnly?: boolean;
}

export const REVERSIBLE_CAUSES: ReversibleCause[] = [
  { id: "hypovolemia", label: "Hypovolemia", group: "H",
    hint: "Flat neck veins, rapid narrow-complex PEA, hemorrhage history",
    action: "Rapid crystalloid bolus; control bleeding; blood products for hemorrhage" },
  { id: "hypoxia", label: "Hypoxia", group: "H",
    hint: "Airway problem, cyanosis, bradycardic arrest",
    action: "Confirm airway, 100% O₂, effective ventilation, check ETT position" },
  { id: "hydrogen", label: "Hydrogen ion (acidosis)", group: "H",
    hint: "Prolonged downtime, DKA, renal failure, salicylates",
    action: "Effective CPR + ventilation; consider bicarbonate for severe documented acidosis" },
  { id: "hypokalemia", label: "Hypo-/Hyperkalemia", group: "H",
    hint: "Renal failure, dialysis, wide QRS/peaked T (hyper); U waves (hypo)",
    action: "HyperK: calcium chloride/gluconate + insulin/dextrose + bicarb. HypoK: K⁺ + Mg²⁺ replacement" },
  { id: "hypoglycemia", label: "Hypoglycemia", group: "H",
    hint: "Infants/children, sepsis, liver disease, toxic ingestion — check glucose early",
    action: "Dextrose IV/IO (D10 5 mL/kg in children); recheck glucose", pediatricOnly: true },
  { id: "hypothermia", label: "Hypothermia", group: "H",
    hint: "Exposure, drowning, core temp < 35 °C",
    action: "Active internal rewarming; continue resuscitation until warm (≥ 32 °C)" },
  { id: "tension", label: "Tension pneumothorax", group: "T",
    hint: "Trauma, ventilated patient, unilateral silent chest, tracheal deviation",
    action: "Immediate needle decompression (2nd ICS midclavicular or 4th/5th ICS anterior axillary) → finger/tube thoracostomy" },
  { id: "tamponade", label: "Tamponade (cardiac)", group: "T",
    hint: "Distended neck veins, narrow-complex PEA, dialysis/malignancy/trauma",
    action: "POCUS to confirm; emergency pericardiocentesis" },
  { id: "toxins", label: "Toxins", group: "T",
    hint: "Overdose history, wide QRS (TCA), bradycardia (BB/CCB), opioids",
    action: "Antidote: naloxone (opioid), bicarb (TCA), lipid emulsion (local anesthetic), glucagon/Ca²⁺ (BB/CCB)" },
  { id: "thrombosis-pulm", label: "Thrombosis — pulmonary", group: "T",
    hint: "Sudden arrest with hypoxia, immobilization, RV strain on POCUS",
    action: "Consider thrombolysis during CPR; prolonged CPR (60–90 min) after lytics" },
  { id: "thrombosis-cor", label: "Thrombosis — coronary", group: "T",
    hint: "Preceding chest pain, known CAD, VF arrest",
    action: "Post-ROSC 12-lead; emergent coronary angiography; consider ECPR" },
];

export interface RefSection {
  id: string;
  title: string;
  icon: string;
  rows: { head?: string; text: string }[];
}

export const REFERENCE_SECTIONS: RefSection[] = [
  {
    id: "cpr-quality",
    title: "High-Quality CPR",
    icon: "compress",
    rows: [
      { text: "Push hard — at least 2 in (5 cm), no more than 2.4 in (6 cm)" },
      { text: "Push fast — 100–120/min; allow complete chest recoil" },
      { text: "Minimize interruptions — chest-compression fraction > 80%; pauses < 10 s" },
      { text: "Avoid excessive ventilation" },
      { text: "Change compressor every 2 minutes, or sooner if fatigued" },
      { text: "No advanced airway → 30:2 compression-ventilation ratio" },
      { text: "Advanced airway → 1 breath every 6 s (10/min) with continuous compressions" },
      { head: "Capnography", text: "Continuous waveform ETCO₂ — if < 10 mm Hg or falling, improve compressions; abrupt sustained rise ≥ 40 suggests ROSC" },
      { head: "Feedback", text: "Use audiovisual CPR feedback devices where available (2025: recommended to optimize quality)" },
    ],
  },
  {
    id: "shock-energy",
    title: "Shock Energy for Defibrillation",
    icon: "bolt",
    rows: [
      { head: "Biphasic", text: "Manufacturer recommendation (e.g. initial 120–200 J); if unknown, use maximum available. Second and subsequent doses equivalent or higher." },
      { head: "Monophasic", text: "360 J" },
      { head: "Refractory VF (2025)", text: "Change pad vector (anterior-posterior) or double sequential external defibrillation (DSED) may be considered where equipment and training allow" },
    ],
  },
  {
    id: "drugs",
    title: "Drug Therapy — Cardiac Arrest",
    icon: "medication",
    rows: [
      { head: "Epinephrine IV/IO", text: "1 mg every 3–5 minutes. Nonshockable rhythm: give as soon as feasible. Flush 20 mL after each peripheral dose." },
      { head: "Amiodarone IV/IO", text: "First dose 300 mg bolus · second dose 150 mg. For shock-refractory VF/pVT." },
      { head: "Lidocaine IV/IO", text: "First dose 1–1.5 mg/kg · second dose 0.5–0.75 mg/kg (max cumulative 3 mg/kg). Alternative to amiodarone." },
      { head: "Magnesium IV/IO", text: "1–2 g for torsades de pointes with long QT — not routine in arrest." },
      { head: "Not routine", text: "Calcium, sodium bicarbonate, and vasopressin are NOT recommended routinely — reserve for specific indications (hyperK, TCA overdose, etc.)" },
    ],
  },
  {
    id: "airway",
    title: "Advanced Airway",
    icon: "pulmonology",
    rows: [
      { text: "Endotracheal intubation or supraglottic airway — by experienced providers, minimizing compression pauses" },
      { text: "Waveform capnography to confirm and monitor tube placement" },
      { text: "Once placed: 1 breath every 6 seconds (10/min) with continuous chest compressions" },
      { text: "Bag-mask ventilation is an acceptable alternative during short resuscitations" },
    ],
  },
  {
    id: "rosc",
    title: "Return of Spontaneous Circulation",
    icon: "vital_signs",
    rows: [
      { text: "Pulse and blood pressure" },
      { text: "Abrupt sustained increase in ETCO₂ (typically ≥ 40 mm Hg)" },
      { text: "Spontaneous arterial pressure waves with intra-arterial monitoring" },
    ],
  },
  {
    id: "peds-cpr",
    title: "High-Quality CPR — Pediatric",
    icon: "compress",
    rows: [
      { text: "Push hard — at least ⅓ of the AP chest diameter" },
      { text: "Push fast — 100–120/min; allow complete chest recoil" },
      { text: "Minimize interruptions; change compressor every 2 min or sooner if fatigued" },
      { head: "Ratios (no advanced airway)", text: "15:2 with 2 rescuers (prepuberty) · 30:2 with 2 rescuers (postpuberty onset) · 30:2 with 1 rescuer (any age)" },
      { head: "Advanced airway", text: "Continuous compressions; give a breath every 2–3 seconds (20–30/min)" },
      { head: "Monitoring", text: "ETCO₂ and, when available, invasive diastolic blood pressure" },
    ],
  },
  {
    id: "peds-shock",
    title: "Shock Energy — Pediatric",
    icon: "bolt",
    rows: [
      { head: "First shock", text: "2 J/kg" },
      { head: "Second shock", text: "4 J/kg" },
      { head: "Subsequent", text: "≥ 4 J/kg — maximum 10 J/kg or adult dose" },
    ],
  },
  {
    id: "peds-drugs",
    title: "Drug Therapy — Pediatric Arrest",
    icon: "medication",
    rows: [
      { head: "Epinephrine IV/IO", text: "0.01 mg/kg (0.1 mg/mL concentration), max single dose 1 mg. Every 3–5 minutes." },
      { head: "Amiodarone IV/IO", text: "5 mg/kg bolus (max 300 mg). May repeat up to 3 total doses (max 150 mg subsequent)." },
      { head: "Lidocaine IV/IO", text: "1 mg/kg — alternative to amiodarone." },
    ],
  },
  {
    id: "cardioversion",
    title: "Synchronized Cardioversion — Energy",
    icon: "electric_bolt",
    rows: [
      { head: "2025 energy", text: "Use the device's recommended energy level to maximize first-shock success; if unknown, use the maximum setting." },
      { head: "Classic initial doses", text: "Narrow regular 50–100 J · narrow irregular 120–200 J biphasic (200 J monophasic) · wide regular 100 J · wide irregular — defibrillation dose (unsynchronized)" },
      { head: "Adenosine", text: "6 mg rapid IV push + NS flush → second dose 12 mg (regular rhythms only)" },
    ],
  },
];
