(function () {
  const runtimeVersion = "20260512-mdcalc-live-v5";
  if (window.__medosCalcRuntimeVersion === runtimeVersion) return;
  if (window.__medosCalcRuntimeAbort) {
    try { window.__medosCalcRuntimeAbort.abort(); } catch {}
  }
  window.__medosCalcRuntimeAbort = new AbortController();
  const runtimeSignal = window.__medosCalcRuntimeAbort.signal;
  window.__medosCalcRuntime = true;
  window.__medosCalcRuntimeVersion = runtimeVersion;
  const stateKey = "medos.activeCalculator.v1";
  const lexiFavoriteKey = "medos.calc.lexiFavorites";
  const shortcutKey = "medos.calc.shortcuts.v1";
  let lexiCatalog = [];
  let lexiLoaded = false;

  const defs = {
    bmi: {
      name: "BMI",
      desc: "Body Mass Index",
      fields: [
        { id: "weight", label: "Weight", unit: "kg", type: "number" },
        { id: "height", label: "Height", unit: "cm", type: "number" },
      ],
      compute: v => [round(v.weight / Math.pow(v.height / 100, 2), 1), "kg/m²"],
      bands: [[null, 18.5, "Underweight"], [18.5, 25, "Normal"], [25, 30, "Overweight"], [30, null, "Obese"]],
    },
    ibw: {
      name: "Ideal Body Weight",
      desc: "Devine formula",
      fields: [
        { id: "height", label: "Height", unit: "cm", type: "number" },
        { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
      ],
      compute: v => {
        const inches = v.height / 2.54;
        const base = v.sex === 1 ? 50 : 45.5;
        return [round(Math.max(base + 2.3 * (inches - 60), base), 1), "kg"];
      },
    },
    bsa: {
      name: "Body Surface Area",
      desc: "Mosteller formula",
      fields: [
        { id: "weight", label: "Weight", unit: "kg", type: "number" },
        { id: "height", label: "Height", unit: "cm", type: "number" },
      ],
      compute: v => [round(Math.sqrt((v.height * v.weight) / 3600), 2), "m²"],
    },
    egfr: {
      name: "eGFR (CKD-EPI)",
      desc: "CKD-EPI equations for GFR",
      fields: [
        { id: "calc", label: "Equation", type: "select", options: [["3", "2021 CKD-EPI Creatinine"], ["4", "2021 CKD-EPI Creatinine-Cystatin C"], ["0", "2009 CKD-EPI Creatinine"], ["1", "2012 CKD-EPI Cystatin C"], ["2", "2012 CKD-EPI Creatinine-Cystatin C"]] },
        { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        { id: "age", label: "Age", unit: "years", type: "number" },
        { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number", optional: true },
        { id: "cystatin", label: "Serum cystatin C", unit: "mg/L", type: "number", optional: true },
        { id: "race", label: "Race for older equations", type: "select", options: [["2", "Non-black / not used"], ["1", "Black"]] },
      ],
      compute: v => {
        const calc = v.calc;
        const cr = v.creatinine;
        const cys = v.cystatin;
        const needsCr = calc === 0 || calc === 2 || calc === 3 || calc === 4;
        const needsCys = calc === 1 || calc === 2 || calc === 4;
        if ((needsCr && !cr) || (needsCys && !cys)) return ["Enter required lab values", "", needsCr && needsCys ? "Creatinine and cystatin C required" : needsCr ? "Creatinine required" : "Cystatin C required"];
        const k = v.sex === 1 ? 0.9 : 0.7;
        const black = v.race === 1;
        let egfr = 0;
        let label = "2021 CKD-EPI Creatinine";
        if (calc === 3) {
          const a = v.sex === 1 ? -0.302 : -0.241;
          const x = cr / k;
          egfr = 142 * Math.pow(Math.min(x, 1), a) * Math.pow(Math.max(x, 1), -1.2) * Math.pow(0.9938, v.age) * (v.sex === 0 ? 1.012 : 1);
        } else if (calc === 4) {
          egfr = 135 * Math.pow(cr / k, v.sex === 1 ? (cr <= 0.9 ? -0.144 : -0.544) : (cr <= 0.7 ? -0.219 : -0.544)) * Math.pow(cys / 0.8, cys <= 0.8 ? -0.323 : -0.778) * Math.pow(0.9961, v.age) * (v.sex === 0 ? 0.963 : 1);
          label = "2021 CKD-EPI Creatinine-Cystatin C";
        } else if (calc === 0) {
          egfr = (v.sex === 1 ? 141 : 144) * Math.pow(cr / k, v.sex === 1 ? (cr <= 0.9 ? -0.411 : -1.209) : (cr <= 0.7 ? -0.329 : -1.209)) * Math.pow(0.993, v.age) * (black ? 1.159 : 1);
          label = "2009 CKD-EPI Creatinine";
        } else if (calc === 1) {
          egfr = 133 * Math.pow(cys / 0.8, cys <= 0.8 ? -0.499 : -1.328) * Math.pow(0.996, v.age) * (v.sex === 0 ? 0.932 : 1);
          label = "2012 CKD-EPI Cystatin C";
        } else {
          egfr = (v.sex === 1 ? 135 : 130) * Math.pow(cr / k, v.sex === 1 ? (cr <= 0.9 ? -0.207 : -0.601) : (cr <= 0.7 ? -0.248 : -0.601)) * Math.pow(cys / 0.8, cys <= 0.8 ? -0.375 : -0.711) * Math.pow(0.995, v.age) * (black ? 1.08 : 1);
          label = "2012 CKD-EPI Creatinine-Cystatin C";
        }
        return [Math.round(egfr), "mL/min/1.73m²", label];
      },
      bands: [[90, null, "G1 - normal kidney function"], [60, 90, "G2 - mildly decreased"], [45, 60, "G3a - mild to moderate decrease"], [30, 45, "G3b - moderate to severe decrease"], [15, 30, "G4 - severely decreased"], [null, 15, "G5 - kidney failure"]],
    },
    cockcroft: {
      name: "Creatinine Clearance",
      desc: "Cockcroft-Gault",
      fields: [
        { id: "creatinine", label: "Serum Creatinine", unit: "mg/dL", type: "number" },
        { id: "age", label: "Age", unit: "years", type: "number" },
        { id: "weight", label: "Weight", unit: "kg", type: "number" },
        { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
      ],
      compute: v => [Math.round(((140 - v.age) * v.weight / (72 * v.creatinine)) * (v.sex === 0 ? 0.85 : 1)), "mL/min"],
    },
    anion_gap: {
      name: "Anion Gap",
      desc: "Albumin-corrected anion gap",
      fields: [
        { id: "na", label: "Sodium", unit: "mEq/L", type: "number" },
        { id: "cl", label: "Chloride", unit: "mEq/L", type: "number" },
        { id: "bicarb", label: "HCO₃", unit: "mEq/L", type: "number" },
        { id: "albumin", label: "Albumin", unit: "g/dL", type: "number", value: 4 },
      ],
      compute: v => {
        const raw = v.na - (v.cl + v.bicarb);
        const corrected = raw + 2.5 * (4 - (v.albumin || 4));
        return [round(corrected, 1), "mEq/L", "Raw AG " + round(raw, 1)];
      },
      bands: [[null, 12, "Normal anion gap"], [12, null, "Elevated anion gap - consider unmeasured anions / high-gap metabolic acidosis"]],
    },
    winters: {
      name: "Winter's Formula",
      desc: "Expected pCO₂ for metabolic acidosis",
      fields: [{ id: "bicarb", label: "Serum HCO₃", unit: "mEq/L", type: "number" }],
      compute: v => [Math.round(1.5 * v.bicarb + 6) + "–" + Math.round(1.5 * v.bicarb + 10), "mmHg"],
    },
    aa_gradient: {
      name: "A-a Gradient",
      desc: "Alveolar-arterial oxygen gradient",
      fields: [
        { id: "fio2", label: "FiO₂", unit: "%", type: "number", value: 21 },
        { id: "paco2", label: "PaCO₂", unit: "mmHg", type: "number" },
        { id: "pao2", label: "PaO₂", unit: "mmHg", type: "number" },
      ],
      compute: v => [round((v.fio2 / 100) * (760 - 47) - (v.paco2 / 0.8) - v.pao2, 1), "mmHg"],
      bands: [[null, 15, "Normal on room air"], [15, null, "Elevated — suggests V/Q mismatch, diffusion impairment, or shunt"]],
    },
    qtc: {
      name: "Corrected QT (QTc)",
      desc: "QT interval corrected for heart rate",
      fields: [
        { id: "formula", label: "Formula", type: "select", options: [["0", "Bazett"], ["1", "Fridericia"], ["2", "Framingham"], ["3", "Hodges"], ["4", "Rautaharju"]] },
        { id: "heart_rate", label: "Heart rate / pulse", unit: "bpm", type: "number" },
        { id: "qt", label: "QT interval", unit: "ms", type: "number" },
      ],
      compute: v => {
        const rr = 60 / v.heart_rate;
        const results = [
          v.qt / Math.sqrt(rr),
          v.qt / Math.pow(rr, 1 / 3),
          v.qt + 154 * (1 - rr),
          v.qt + 1.75 * (v.heart_rate - 60),
          v.qt * (120 + v.heart_rate) / 180,
        ];
        const names = ["Bazett", "Fridericia", "Framingham", "Hodges", "Rautaharju"];
        return [Math.round(results[v.formula]), "ms", names[v.formula] + " formula; RR " + round(rr, 2) + " sec"];
      },
      bands: [[null, 440, "Normal range for men"], [440, 460, "Borderline prolonged"], [460, null, "Prolonged — higher torsades risk"]],
    },
    framingham: {
      name: "Framingham Risk Score",
      desc: "10-year hard coronary heart disease risk",
      fields: [
        { id: "age", label: "Age", unit: "years", type: "number" },
        { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        { id: "tc", label: "Total cholesterol", unit: "mg/dL", type: "number" },
        { id: "hdl", label: "HDL cholesterol", unit: "mg/dL", type: "number" },
        { id: "sbp", label: "Systolic BP", unit: "mmHg", type: "number" },
        { id: "smoker", label: "Current smoker", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "tx_bp", label: "On BP treatment", type: "select", options: [["0", "No"], ["1", "Yes"]] },
      ],
      compute: v => {
        if (v.age < 30 || v.age > 79) return ["N/A", "", "Framingham hard CHD equation is for ages 30-79"];
        const lnAge = Math.log(v.age), lnTc = Math.log(v.tc), lnHdl = Math.log(v.hdl), lnSbp = Math.log(v.sbp);
        const smokerAge = v.smoker ? Math.log(Math.min(v.age, v.sex === 1 ? 70 : 78)) : 0;
        const male = v.sex === 1;
        const sum = male
          ? 52.00961 * lnAge + 20.014077 * lnTc - 0.905964 * lnHdl + 1.305784 * lnSbp + 0.241549 * v.tx_bp + 12.096316 * v.smoker - 4.605038 * lnAge * lnTc - 2.84367 * smokerAge - 2.93323 * lnAge * lnAge - 172.300168
          : 31.764001 * lnAge + 22.465206 * lnTc - 1.187731 * lnHdl + 2.552905 * lnSbp + 0.420251 * v.tx_bp + 13.07543 * v.smoker - 5.060998 * lnAge * lnTc - 2.996945 * smokerAge - 146.5933061;
        const risk = (1 - Math.pow(male ? 0.9402 : 0.98767, Math.exp(sum))) * 100;
        return [round(risk, 1), "% (10-yr hard CHD risk)"];
      },
      bands: [[null, 10, "Low risk"], [10, 20, "Intermediate risk"], [20, null, "High risk"]],
    },
    glasgow_blatchford: {
      name: "Glasgow-Blatchford Score",
      desc: "Upper GI bleed risk",
      fields: [
        { id: "bun", label: "BUN", unit: "mg/dL", type: "number" },
        { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        { id: "hgb", label: "Hemoglobin", unit: "g/dL", type: "number" },
        { id: "sbp", label: "Initial systolic BP", unit: "mmHg", type: "number" },
        { id: "pulse", label: "Heart rate >=100", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "melaena", label: "Melena present", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "syncope", label: "Recent syncope", type: "select", options: [["0", "No"], ["2", "Yes"]] },
        { id: "liver", label: "Hepatic disease history", type: "select", options: [["0", "No"], ["2", "Yes"]] },
        { id: "chf", label: "Cardiac failure present", type: "select", options: [["0", "No"], ["2", "Yes"]] },
      ],
      compute: v => {
        const bun = v.bun >= 70 ? 6 : v.bun >= 28 ? 4 : v.bun >= 22.4 ? 3 : v.bun >= 18.2 ? 2 : 0;
        const hgb = v.sex === 1 ? (v.hgb < 10 ? 6 : v.hgb < 12 ? 3 : v.hgb < 13 ? 1 : 0) : (v.hgb < 10 ? 6 : v.hgb < 12 ? 1 : 0);
        const sbp = v.sbp < 90 ? 3 : v.sbp < 100 ? 2 : v.sbp < 110 ? 1 : 0;
        return [bun + hgb + sbp + v.pulse + v.melaena + v.syncope + v.liver + v.chf, "points", "Hemoglobin contributes " + hgb + " point(s)"];
      },
      bands: [[null, 2, "Score 0-1 — very low risk"], [2, 6, "2-5 — increased risk"], [6, null, "High risk — urgent endoscopy"]],
    },
    meld: {
      name: "MELD Score",
      desc: "Model for End-Stage Liver Disease",
      fields: [
        { id: "creatinine", label: "Creatinine", unit: "mg/dL", type: "number" },
        { id: "bilirubin", label: "Bilirubin", unit: "mg/dL", type: "number" },
        { id: "inr", label: "INR", type: "number" },
        { id: "dialysis", label: "On dialysis", type: "select", options: [["0", "No"], ["1", "Yes"]] },
      ],
      compute: v => {
        const cr = v.dialysis ? 4 : Math.max(1, Math.min(v.creatinine, 4));
        const bil = Math.max(1, v.bilirubin);
        return [Math.round(3.78 * Math.log(bil) + 11.2 * Math.log(v.inr) + 9.57 * Math.log(cr) + 6.43), "points"];
      },
      bands: [[null, 10, "<10 — low short-term mortality"], [10, 20, "10–19 — about 6% 90-day mortality"], [20, 30, "20–29 — about 20% 90-day mortality"], [30, null, "≥30 — high 90-day mortality risk"]],
    },
    anc: {
      name: "Absolute Neutrophil Count",
      desc: "Calculates ANC from WBC and neutrophil percentages",
      fields: [
        { id: "wbc", label: "WBC count", unit: "10^3/uL", type: "number" },
        { id: "neutrophils", label: "Segmented neutrophils", unit: "%", type: "number" },
        { id: "bands", label: "Bands", unit: "%", type: "number", value: 0, optional: true },
      ],
      compute: v => [Math.round(v.wbc * 1000 * (((v.neutrophils || 0) + (v.bands || 0)) / 100)), "cells/uL"],
      bands: [[1500, null, "Normal or not neutropenic"], [1000, 1500, "Mild neutropenia"], [500, 1000, "Moderate neutropenia"], [null, 500, "Severe neutropenia"]],
    },
    acetaminophen_toxicity: {
      name: "Acetaminophen Toxicity Assessment",
      desc: "Screens timed acetaminophen level against treatment thresholds",
      fields: [
        { id: "dose", label: "Estimated ingestion dose", unit: "mg/kg", type: "number" },
        { id: "hours", label: "Hours since ingestion", unit: "hours", type: "number" },
        { id: "level", label: "Acetaminophen concentration", unit: "mcg/mL", type: "number" },
      ],
      compute: v => {
        const threshold = v.hours >= 4 ? 150 * Math.pow(0.5, (v.hours - 4) / 4) : 150;
        const treat = (v.hours >= 4 && v.level >= threshold) || v.dose >= 150;
        return [treat ? "Treat / toxic risk" : "Below treatment line", "", "Nomogram threshold at " + v.hours + " h: " + Math.round(threshold) + " mcg/mL"];
      },
    },
    als_adult: {
      name: "Advanced Life Support: Adult",
      desc: "Adult resuscitation medication support",
      fields: [
        { id: "weight", label: "Weight", unit: "kg", type: "number" },
        { id: "scenario", label: "Scenario", type: "select", options: [["0", "Cardiac arrest"], ["1", "Bradycardia"], ["2", "Narrow-complex tachycardia"], ["3", "Anaphylaxis IM epinephrine"]] },
      ],
      compute: v => {
        const lines = [
          "Epinephrine 1 mg IV/IO every 3-5 min",
          "Atropine 1 mg IV every 3-5 min, max 3 mg; consider pacing/pressor infusion",
          "Adenosine 6 mg rapid IV, then 12 mg if needed",
          "Epinephrine IM 0.3-0.5 mg adult dose; weight entered " + v.weight + " kg",
        ];
        return [lines[v.scenario] || lines[0], "", "Verify against local ACLS protocol and patient context."];
      },
    },
    meld_na: {
      name: "MELD-Na Score",
      desc: "MELD with sodium correction",
      fields: [
        { id: "creatinine", label: "Creatinine", unit: "mg/dL", type: "number" },
        { id: "bilirubin", label: "Bilirubin", unit: "mg/dL", type: "number" },
        { id: "inr", label: "INR", type: "number" },
        { id: "sodium", label: "Sodium", unit: "mEq/L", type: "number" },
        { id: "dialysis", label: "On dialysis", type: "select", options: [["0", "No"], ["1", "Yes"]] },
      ],
      compute: v => {
        const cr = v.dialysis ? 4 : Math.max(1, Math.min(v.creatinine, 4));
        const bil = Math.max(1, v.bilirubin);
        const meld = 3.78 * Math.log(bil) + 11.2 * Math.log(Math.max(1, v.inr)) + 9.57 * Math.log(cr) + 6.43;
        const na = Math.max(125, Math.min(140, v.sodium));
        const meldNa = Math.max(6, Math.min(40, meld - na - 0.025 * meld * (140 - na) + 140));
        return [Math.round(meldNa), "points", "MELD component " + Math.round(meld) + "; sodium capped to " + na + " mEq/L"];
      },
      bands: [[null, 10, "<10 — lower short-term mortality"], [10, 20, "10-19 — moderate risk"], [20, 30, "20-29 — high risk"], [30, null, ">=30 — very high risk"]],
    },
    steroid_conversion: {
      name: "Steroid Conversion",
      desc: "Prednisone-equivalent systemic corticosteroid dose",
      fields: [
        { id: "dose", label: "Current steroid dose", unit: "mg", type: "number" },
        { id: "equivalent", label: "Steroid", type: "select", options: [["20", "Hydrocortisone"], ["25", "Cortisone"], ["5", "Prednisone / prednisolone"], ["4", "Methylprednisolone / triamcinolone"], ["0.75", "Dexamethasone"], ["0.6", "Betamethasone"]] },
      ],
      compute: v => [round(v.dose * (5 / v.equivalent), 2), "mg prednisone equivalent"],
    },
    opioid_mme: {
      name: "Morphine Milligram Equivalents",
      desc: "Total daily oral morphine equivalent dose",
      fields: [
        { id: "dailyDose", label: "Total daily dose", unit: "mg/day or mcg/hr patch", type: "number" },
        { id: "factor", label: "Opioid", type: "select", options: [["1", "Morphine PO / hydrocodone PO"], ["1.5", "Oxycodone PO"], ["4", "Hydromorphone PO"], ["3", "Oxymorphone PO"], ["0.15", "Codeine PO"], ["0.1", "Tramadol PO"], ["0.4", "Tapentadol PO"], ["2.4", "Fentanyl transdermal mcg/hr"]] },
      ],
      compute: v => [round(v.dailyDose * v.factor, 1), "MME/day", "Use as a safety screen; conversion tables vary by opioid and route."],
    },
    calvert_carboplatin: {
      name: "Carboplatin Dose (Calvert)",
      desc: "Dose from target AUC and GFR/CrCl",
      fields: [
        { id: "auc", label: "Target AUC", unit: "mg/mL/min", type: "number" },
        { id: "gfr", label: "GFR or CrCl", unit: "mL/min", type: "number" },
      ],
      compute: v => [Math.round(v.auc * (v.gfr + 25)), "mg", "Dose = target AUC x (GFR + 25)."],
    },
    maintenance_fluids: {
      name: "Maintenance Fluids",
      desc: "4-2-1 hourly maintenance fluid estimate",
      fields: [{ id: "weight", label: "Weight", unit: "kg", type: "number" }],
      compute: v => {
        const hourly = v.weight <= 10 ? 4 * v.weight : v.weight <= 20 ? 40 + 2 * (v.weight - 10) : 60 + v.weight - 20;
        return [Math.round(hourly), "mL/hr", Math.round(hourly * 24) + " mL/day by 4-2-1 rule"];
      },
    },
    corrected_calcium: {
      name: "Corrected Calcium",
      desc: "Albumin-corrected serum calcium",
      fields: [
        { id: "calcium", label: "Measured calcium", unit: "mg/dL", type: "number" },
        { id: "albumin", label: "Albumin", unit: "g/dL", type: "number" },
      ],
      compute: v => [round(v.calcium + 0.8 * (4 - v.albumin), 2), "mg/dL"],
    },
    corrected_sodium: {
      name: "Corrected Sodium",
      desc: "Sodium correction for hyperglycemia",
      fields: [
        { id: "sodium", label: "Measured sodium", unit: "mEq/L", type: "number" },
        { id: "glucose", label: "Glucose", unit: "mg/dL", type: "number" },
        { id: "factor", label: "Correction factor", type: "select", options: [["1.6", "1.6 mEq/L"], ["2.4", "2.4 mEq/L"]] },
      ],
      compute: v => [round(v.sodium + v.factor * (Math.max(0, v.glucose - 100) / 100), 1), "mEq/L"],
    },
    serum_osmolality: {
      name: "Serum Osmolality",
      desc: "Calculated osmolality with optional osmolar gap",
      fields: [
        { id: "sodium", label: "Sodium", unit: "mEq/L", type: "number" },
        { id: "glucose", label: "Glucose", unit: "mg/dL", type: "number" },
        { id: "bun", label: "BUN", unit: "mg/dL", type: "number" },
        { id: "ethanol", label: "Ethanol", unit: "mg/dL", type: "number", value: 0, optional: true },
        { id: "measured", label: "Measured osmolality", unit: "mOsm/kg", type: "number", value: 0, optional: true },
      ],
      compute: v => {
        const calculated = 2 * v.sodium + v.glucose / 18 + v.bun / 2.8 + (v.ethanol || 0) / 3.7;
        return v.measured ? [round(v.measured - calculated, 1), "mOsm/kg gap", "Calculated osmolality " + round(calculated, 1)] : [round(calculated, 1), "mOsm/kg"];
      },
    },
    fena: {
      name: "Fractional Excretion of Sodium",
      desc: "FENa from urine/plasma sodium and creatinine",
      fields: [
        { id: "una", label: "Urine sodium", unit: "mEq/L", type: "number" },
        { id: "pna", label: "Plasma sodium", unit: "mEq/L", type: "number" },
        { id: "ucr", label: "Urine creatinine", type: "number" },
        { id: "pcr", label: "Plasma creatinine", type: "number" },
      ],
      compute: v => [round(((v.una * v.pcr) / (v.pna * v.ucr)) * 100, 2), "%"],
      bands: [[null, 1, "<1% — often prerenal physiology"], [1, 2, "1-2% — indeterminate"], [2, null, ">2% — often intrinsic renal injury"]],
    },
    mdrd: {
      name: "MDRD GFR",
      desc: "IDMS-traceable MDRD estimated GFR",
      fields: [
        { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number" },
        { id: "age", label: "Age", unit: "years", type: "number" },
        { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        { id: "black", label: "Black race coefficient", type: "select", options: [["0", "No"], ["1", "Yes"]] },
      ],
      compute: v => [Math.round(175 * Math.pow(v.creatinine, -1.154) * Math.pow(v.age, -0.203) * (v.sex === 0 ? 0.742 : 1) * (v.black ? 1.212 : 1)), "mL/min/1.73m²"],
    },
    schwartz: {
      name: "Schwartz GFR",
      desc: "Pediatric bedside Schwartz estimated GFR",
      fields: [
        { id: "height", label: "Height", unit: "cm", type: "number" },
        { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number" },
        { id: "k", label: "Schwartz constant", type: "select", options: [["0.413", "0.413 bedside Schwartz"], ["0.55", "0.55 child/adolescent female"], ["0.7", "0.70 adolescent male"]] },
      ],
      compute: v => [Math.round((v.k * v.height) / v.creatinine), "mL/min/1.73m²"],
    },
    mean_arterial_pressure: {
      name: "Mean Arterial Pressure",
      desc: "MAP from systolic and diastolic blood pressure",
      fields: [
        { id: "sbp", label: "Systolic BP", unit: "mmHg", type: "number" },
        { id: "dbp", label: "Diastolic BP", unit: "mmHg", type: "number" },
      ],
      compute: v => [Math.round((v.sbp + 2 * v.dbp) / 3), "mmHg"],
      bands: [[null, 65, "<65 mmHg — low perfusion pressure"], [65, 105, "Typical target range"], [105, null, "Elevated MAP"]],
    },
    shock_index: {
      name: "Shock Index",
      desc: "Heart rate divided by systolic blood pressure",
      fields: [
        { id: "hr", label: "Heart rate", unit: "bpm", type: "number" },
        { id: "sbp", label: "Systolic BP", unit: "mmHg", type: "number" },
      ],
      compute: v => [round(v.hr / v.sbp, 2), ""],
      bands: [[null, 0.7, "Lower shock index"], [0.7, 0.9, "Borderline"], [0.9, null, "Elevated — consider shock physiology"]],
    },
    parkland: {
      name: "Parkland Formula",
      desc: "Initial burn resuscitation crystalloid estimate",
      fields: [
        { id: "weight", label: "Weight", unit: "kg", type: "number" },
        { id: "tbsa", label: "Burn size", unit: "% TBSA", type: "number" },
      ],
      compute: v => {
        const total = 4 * v.weight * v.tbsa;
        return [Math.round(total), "mL in first 24 h", Math.round(total / 2) + " mL first 8 h, " + Math.round(total / 2) + " mL next 16 h"];
      },
    },
    bicarbonate_deficit: {
      name: "Bicarbonate Deficit",
      desc: "Estimated bicarbonate replacement deficit",
      fields: [
        { id: "weight", label: "Weight", unit: "kg", type: "number" },
        { id: "current", label: "Current bicarbonate", unit: "mEq/L", type: "number" },
        { id: "target", label: "Target bicarbonate", unit: "mEq/L", type: "number", value: 24, optional: true },
        { id: "volume", label: "Distribution volume", type: "select", options: [["0.5", "0.5 x weight"], ["0.4", "0.4 x weight"], ["0.6", "0.6 x weight"]] },
      ],
      compute: v => [Math.max(0, Math.round(v.volume * v.weight * ((v.target || 24) - v.current))), "mEq", "Estimate only; reassess with serial blood gases/chemistry."],
    },
    perc: {
      name: "PERC Rule",
      desc: "Pulmonary Embolism Rule-out Criteria for very low-risk patients",
      fields: [
        { id: "age50", label: "Age >=50", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "hr100", label: "Heart rate >=100", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "spo2", label: "O2 saturation <95%", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "leg", label: "Unilateral leg swelling", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "hemoptysis", label: "Hemoptysis", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "surgery", label: "Recent surgery or trauma", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "prior", label: "Prior PE or DVT", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        { id: "hormone", label: "Hormone use", type: "select", options: [["0", "No"], ["1", "Yes"]] },
      ],
      compute: v => {
        const count = Object.keys(v).reduce((s, k) => s + Number(v[k] || 0), 0);
        return [count === 0 ? "PERC negative" : "PERC positive", "", count + " criteria present"];
      },
    },
    ldl_calculated: {
      name: "LDL Calculated",
      desc: "Friedewald estimated LDL cholesterol",
      fields: [
        { id: "tc", label: "Total cholesterol", unit: "mg/dL", type: "number" },
        { id: "hdl", label: "HDL cholesterol", unit: "mg/dL", type: "number" },
        { id: "tg", label: "Triglycerides", unit: "mg/dL", type: "number" },
      ],
      compute: v => [round(v.tc - v.hdl - v.tg / 5, 1), "mg/dL", v.tg >= 400 ? "Friedewald estimate is unreliable when triglycerides are >=400 mg/dL." : "Friedewald equation."],
    },
    free_water_deficit: {
      name: "Free Water Deficit",
      desc: "Estimated free water deficit in hypernatremia",
      fields: [
        { id: "weight", label: "Weight", unit: "kg", type: "number" },
        { id: "sodium", label: "Current sodium", unit: "mEq/L", type: "number" },
        { id: "target", label: "Target sodium", unit: "mEq/L", type: "number", value: 140, optional: true },
        { id: "tbw", label: "TBW fraction", type: "select", options: [["0.6", "0.6 adult male / child"], ["0.5", "0.5 adult female / older male"], ["0.45", "0.45 older female"]] },
      ],
      compute: v => [Math.max(0, round(v.tbw * v.weight * ((v.sodium / (v.target || 140)) - 1), 2)), "L"],
    },
    sodium_deficit: {
      name: "Sodium Deficit",
      desc: "Estimated sodium deficit in hyponatremia",
      fields: [
        { id: "weight", label: "Weight", unit: "kg", type: "number" },
        { id: "current", label: "Current sodium", unit: "mEq/L", type: "number" },
        { id: "target", label: "Target sodium", unit: "mEq/L", type: "number", value: 135, optional: true },
        { id: "tbw", label: "TBW fraction", type: "select", options: [["0.6", "0.6 adult male / child"], ["0.5", "0.5 adult female / older male"], ["0.45", "0.45 older female"]] },
      ],
      compute: v => [Math.max(0, Math.round(((v.target || 135) - v.current) * v.weight * v.tbw)), "mEq Na"],
    },
    fib4: {
      name: "FIB-4 Index",
      desc: "Noninvasive estimate of liver fibrosis using age, AST, ALT, and platelet count",
      fields: [
        { id: "age", label: "Age", unit: "years", type: "number" },
        { id: "ast", label: "AST", unit: "U/L", type: "number" },
        { id: "alt", label: "ALT", unit: "U/L", type: "number" },
        { id: "platelets", label: "Platelet count", unit: "10^3/uL", type: "number", unitOptions: [["10^3/uL", "10^3/uL", 1], ["10^9/L", "10^9/L", 1]] },
      ],
      compute: v => {
        const score = (v.age * v.ast) / (v.platelets * Math.sqrt(v.alt));
        const label = v.age <= 35
          ? "Use alternative fibrosis assessment; less reliable at age <=35"
          : v.age < 65
            ? score < 1.3 ? "Advanced fibrosis excluded" : score <= 2.67 ? "Further investigation needed" : "Advanced fibrosis likely"
            : score < 2.0 ? "Advanced fibrosis excluded" : score <= 2.67 ? "Further investigation needed" : "Advanced fibrosis likely";
        return [round(score, 2), "points", label];
      },
      bands: [[null, 1.45, "<1.45 — approximate Ishak 0-1"], [1.45, 3.25, "1.45-3.25 — indeterminate by original validation"], [3.25, null, ">3.25 — approximate Ishak 4-6"]],
    },
  };

  addScore("cha2ds2", "CHA₂DS₂-VASc", "AF stroke risk", [
    ["chf", "CHF / LV dysfunction", 1], ["htn", "Hypertension", 1], ["age75", "Age ≥ 75", 2],
    ["dm", "Diabetes mellitus", 1], ["stroke", "Prior stroke / TIA", 2], ["vasc", "Vascular disease", 1],
    ["age65", "Age 65–74", 1], ["female", "Female sex", 1],
  ], [[null, 1, "Low — anticoagulation usually not recommended"], [1, 2, "Intermediate — consider anticoagulation"], [2, null, "High — anticoagulation generally recommended"]]);
  addScore("chads2", "CHADS2 Score", "AF stroke risk", [
    ["chf", "Congestive heart failure", 1], ["htn", "Hypertension", 1], ["age", "Age >=75", 1],
    ["dm", "Diabetes mellitus", 1], ["stroke", "Prior stroke / TIA", 2],
  ], [[null, 1, "0 — low annual stroke risk"], [1, 2, "1 — intermediate risk"], [2, null, ">=2 — higher risk"]]);
  addScore("has_bled", "HAS-BLED", "Major bleeding risk", [
    ["htn", "Uncontrolled hypertension", 1], ["renal", "Abnormal renal function", 1], ["liver", "Abnormal liver function", 1],
    ["stroke", "Prior stroke", 1], ["bleeding", "Bleeding history or predisposition", 1], ["inr", "Labile INR", 1],
    ["elderly", "Age >65", 1], ["drugs", "Drugs predisposing to bleeding", 1], ["alcohol", "Alcohol use", 1],
  ], [[null, 3, "0-2 — lower bleeding risk"], [3, null, ">=3 — high bleeding risk; review modifiable factors"]]);
  addScore("heart_score", "HEART Score", "Major adverse cardiac event risk", [
    ["history", "History", [[0, "Slightly suspicious"], [1, "Moderately suspicious"], [2, "Highly suspicious"]]],
    ["ecg", "ECG", [[0, "Normal"], [1, "Nonspecific repolarization disturbance"], [2, "Significant ST depression"]]],
    ["age", "Age", [[0, "<45"], [1, "45-64"], [2, ">=65"]]],
    ["risk", "Risk factors", [[0, "None"], [1, "1-2 risk factors"], [2, ">=3 risk factors or atherosclerotic disease"]]],
    ["troponin", "Troponin", [[0, "Normal"], [1, "1-3x normal limit"], [2, ">3x normal limit"]]],
  ], [[null, 4, "0-3 — low risk"], [4, 7, "4-6 — moderate risk"], [7, null, "7-10 — high risk"]]);
  addScore("geneva_pe", "Revised Geneva Score", "Objective PE pretest probability", [
    ["age65", "Age >65", 1], ["prior", "Previous DVT or PE", 3], ["surgery", "Surgery/fracture within 1 month", 2],
    ["cancer", "Active malignancy", 2], ["leg_pain", "Unilateral lower limb pain", 3], ["hemoptysis", "Hemoptysis", 2],
    ["heart_rate", "Heart rate", [[0, "<75"], [3, "75-94"], [5, ">=95"]]], ["edema", "Pain on palpation and unilateral edema", 4],
  ], [[null, 4, "Low PE probability"], [4, 11, "Intermediate PE probability"], [11, null, "High PE probability"]]);
  addScore("qsofa", "qSOFA", "Quick sepsis-associated organ dysfunction screen", [
    ["rr", "Respiratory rate >=22/min", 1], ["mental", "Altered mentation", 1], ["sbp", "Systolic BP <=100 mmHg", 1],
  ], [[null, 2, "0-1 — lower qSOFA risk"], [2, null, ">=2 — higher risk; evaluate for sepsis/organ dysfunction"]]);
  addScore("sirs", "SIRS Criteria", "Systemic inflammatory response screen", [
    ["temp", "Temp >38 C or <36 C", 1], ["hr", "Heart rate >90/min", 1], ["resp", "RR >20/min or PaCO2 <32", 1], ["wbc", "WBC >12k, <4k, or bands >10%", 1],
  ], [[null, 2, "0-1 — SIRS not met"], [2, null, ">=2 — SIRS met"]]);
  addScore("centor_mcisaac", "Centor / McIsaac Score", "Strep pharyngitis prediction score", [
    ["fever", "Fever history or temp >38 C", 1], ["cough", "Absence of cough", 1], ["nodes", "Tender anterior cervical adenopathy", 1],
    ["exudate", "Tonsillar swelling or exudate", 1], ["age", "Age adjustment", [[1, "3-14 years"], [0, "15-44 years"], [-1, ">=45 years"]]],
  ], [[null, 2, "Low probability"], [2, 4, "Intermediate probability"], [4, null, "Higher probability"]]);
  addScore("stop_bang", "STOP-BANG", "Obstructive sleep apnea screening score", [
    ["snore", "Snoring", 1], ["tired", "Tired/daytime sleepiness", 1], ["observed", "Observed apnea", 1], ["pressure", "Hypertension", 1],
    ["bmi", "BMI >35", 1], ["age", "Age >50", 1], ["neck", "Neck circumference >40 cm", 1], ["sex", "Male sex", 1],
  ], [[null, 3, "0-2 — low OSA risk"], [3, 5, "3-4 — intermediate OSA risk"], [5, null, "5-8 — high OSA risk"]]);
  addScore("rcri", "Revised Cardiac Risk Index", "Preoperative cardiac risk estimate", [
    ["surgery", "High-risk surgery", 1], ["ihd", "Ischemic heart disease", 1], ["chf", "Congestive heart failure", 1],
    ["stroke", "Cerebrovascular disease", 1], ["insulin", "Diabetes on insulin", 1], ["creatinine", "Creatinine >2 mg/dL", 1],
  ], [[null, 1, "0 — lowest RCRI class"], [1, 2, "1 — elevated risk"], [2, null, ">=2 — higher perioperative cardiac risk"]]);
  addScore("bisap", "BISAP Score", "Early pancreatitis mortality risk score", [
    ["bun", "BUN >25 mg/dL", 1], ["mental", "Impaired mental status", 1], ["sirs", "SIRS present", 1], ["age", "Age >60", 1], ["effusion", "Pleural effusion", 1],
  ], [[null, 3, "0-2 — lower mortality risk"], [3, null, ">=3 — higher mortality risk"]]);
  addScore("cage", "CAGE Questions", "Alcohol use disorder screening questions", [
    ["cut", "Need to Cut down", 1], ["annoyed", "Annoyed by criticism", 1], ["guilty", "Guilty about drinking", 1], ["eye", "Eye-opener drink", 1],
  ], [[null, 2, "0-1 — screen negative"], [2, null, ">=2 — screen positive"]]);
  addScore("audit_c", "AUDIT-C", "Brief alcohol use screen", [
    ["frequency", "How often drink alcohol", [[0, "Never"], [1, "Monthly or less"], [2, "2-4 times/month"], [3, "2-3 times/week"], [4, ">=4 times/week"]]],
    ["quantity", "Typical drinks per drinking day", [[0, "1-2"], [1, "3-4"], [2, "5-6"], [3, "7-9"], [4, ">=10"]]],
    ["binge", "Six or more drinks on one occasion", [[0, "Never"], [1, "Less than monthly"], [2, "Monthly"], [3, "Weekly"], [4, "Daily or almost daily"]]],
  ], [[null, 3, "0-2 — normal alcohol consumption"], [3, 4, "3 — alcohol misuse for females only"], [4, 5, "4 — alcohol misuse"], [5, null, ">=5 — alcohol misuse and possible liver damage"]]);
  defs.audit_c.compute = v => {
    const score = v.frequency + v.quantity + v.binge;
    const msg = score < 3 ? "Normal alcohol consumption" : score === 3 ? "Alcohol misuse for females only" : score === 4 ? "Alcohol misuse" : "Alcohol misuse and possible liver damage";
    return [score, "points", msg + (v.quantity + v.binge === 0 && v.frequency > 0 ? "; review intake if points only come from question 1" : "")];
  };
  addScore("gcs", "Glasgow Coma Scale", "Eye + Verbal + Motor", [
    ["eye", "Eye opening", [[4, "Spontaneous"], [3, "To voice"], [2, "To pain"], [1, "None"]]],
    ["verbal", "Verbal response", [[5, "Oriented"], [4, "Confused"], [3, "Words"], [2, "Sounds"], [1, "None"]]],
    ["motor", "Motor response", [[6, "Obeys"], [5, "Localizes"], [4, "Withdraws"], [3, "Flexion"], [2, "Extension"], [1, "None"]]],
  ], [[13, null, "Mild impairment"], [9, 13, "Moderate impairment"], [null, 9, "Severe impairment — consider airway protection if ≤8"]]);
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
  ], [[null, 1, "0 — no stroke symptoms"], [1, 5, "1-4 — minor stroke"], [5, 16, "5-15 — moderate stroke"], [16, 21, "16-20 — moderate to severe stroke"], [21, null, "21-42 — severe stroke"]]);
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
    ["confusion", "Confusion", 1], ["bun", "BUN > 19", 1], ["rr", "RR ≥ 30", 1], ["bp", "Low BP", 1], ["age65", "Age ≥ 65", 1],
  ], [[null, 1, "Low severity — outpatient treatment often appropriate"], [1, 3, "Moderate severity — consider hospital assessment"], [3, null, "Severe pneumonia — consider ICU / urgent care"]]);
  addScore("child_pugh", "Child-Pugh Score", "Liver disease severity", [
    ["bilirubin", "Bilirubin", [[1, "<2"], [2, "2–3"], [3, ">3"]]],
    ["albumin", "Albumin", [[1, ">3.5"], [2, "2.8–3.5"], [3, "<2.8"]]],
    ["pt_inr", "INR", [[1, "<1.7"], [2, "1.7–2.3"], [3, ">2.3"]]],
    ["ascites", "Ascites", [[1, "None"], [2, "Mild"], [3, "Severe"]]],
    ["encephalopathy", "Encephalopathy", [[1, "None"], [2, "Grade I–II"], [3, "Grade III–IV"]]],
  ], [[null, 7, "Class A — well compensated"], [7, 10, "Class B — significant dysfunction"], [10, null, "Class C — decompensated disease"]]);
  addScore("sofa", "SOFA Score", "Sequential organ failure", [
    ["pf", "PaO₂/FiO₂", [[0, "≥400"], [1, "300–399"], [2, "200–299"], [3, "100–199"], [4, "<100"]]],
    ["plt", "Platelets", [[0, "≥150"], [1, "100–149"], [2, "50–99"], [3, "20–49"], [4, "<20"]]],
    ["bil", "Bilirubin", [[0, "<1.2"], [1, "1.2–1.9"], [2, "2–5.9"], [3, "6–11.9"], [4, "≥12"]]],
    ["cv", "Cardiovascular", [[0, "MAP ≥70"], [1, "MAP <70"], [2, "Low pressor"], [3, "Moderate pressor"], [4, "High pressor"]]],
    ["gcs", "GCS", [[0, "15"], [1, "13–14"], [2, "10–12"], [3, "6–9"], [4, "<6"]]],
    ["cr", "Creatinine", [[0, "<1.2"], [1, "1.2–1.9"], [2, "2–3.4"], [3, "3.5–4.9"], [4, ">5"]]],
  ], [[null, 7, "Lower organ failure burden"], [7, 11, "Moderate organ failure burden"], [11, null, "High organ failure burden / mortality risk"]]);
  addScore("apgar", "APGAR Score", "Neonatal wellbeing", [
    ["activity", "Activity", [[0, "Absent"], [1, "Some flexion"], [2, "Active"]]],
    ["pulse", "Pulse", [[0, "Absent"], [1, "<100"], [2, "≥100"]]],
    ["grimace", "Grimace", [[0, "None"], [1, "Grimace"], [2, "Cry"]]],
    ["appearance", "Color", [[0, "Blue/pale"], [1, "Blue extremities"], [2, "Pink"]]],
    ["respiration", "Respiration", [[0, "Absent"], [1, "Weak"], [2, "Strong cry"]]],
  ], [[7, null, "Normal transition"], [4, 7, "Moderate concern — stimulate/support"], [null, 4, "Severely depressed — resuscitation likely needed"]]);
  addScore("news2", "NEWS2 Score", "Clinical deterioration", [
    ["rr", "Resp rate", [[3, "≤8"], [1, "9–11"], [0, "12–20"], [2, "21–24"], [3, "≥25"]]],
    ["failure", "Hypercapnic respiratory failure", [[0, "No"], [1, "Yes"]]],
    ["spo2", "SpO2 scale 1", [[3, "≤91"], [2, "92–93"], [1, "94–95"], [0, "≥96"]]],
    ["spo2_scale2", "SpO2 scale 2", [[3, "≤83"], [2, "84-85"], [1, "86-87"], [0, "88-92 or ≥93 on room air"], [1, "93-94 on O2"], [2, "95-96 on O2"], [3, "≥97 on O2"]]],
    ["oxygen", "Room air or supplemental O2", [[0, "Room air"], [2, "Supplemental O2"]]],
    ["sbp", "SBP", [[3, "≤90"], [2, "91–100"], [1, "101–110"], [0, "111–219"], [3, "≥220"]]],
    ["pulse", "Pulse", [[3, "≤40"], [1, "41–50"], [0, "51–90"], [1, "91–110"], [2, "111–130"], [3, "≥131"]]],
    ["temp", "Temp", [[3, "≤35"], [1, "35.1–36"], [0, "36.1–38"], [1, "38.1–39"], [2, "≥39.1"]]],
    ["acvpu", "ACVPU", [[0, "Alert"], [3, "Confusion / V / P / U"]]],
  ], [[null, 1, "Low risk — routine observations"], [1, 5, "Low-medium risk — increase observation frequency"], [5, 7, "Medium risk — urgent clinical review"], [7, null, "High risk — emergency response"]]);
  defs.news2.compute = v => [
    v.rr + (v.failure ? v.spo2_scale2 : v.spo2) + v.oxygen + v.sbp + v.pulse + v.temp + v.acvpu,
    "points",
    v.failure ? "Using NEWS2 SpO2 scale 2" : "Using NEWS2 SpO2 scale 1",
  ];
  addScore("four_t", "4T Score", "Pretest probability of heparin-induced thrombocytopenia", [
    ["thrombocytopenia", "Thrombocytopenia", [[0, "Platelet fall <30% or nadir <10"], [1, "Fall 30-50% or nadir 10-19"], [2, "Fall >50% and nadir >=20"]]],
    ["timing", "Timing of platelet fall", [[0, "<4 days without recent heparin"], [1, "Unclear or >10 days"], [2, "Days 5-10 or <=1 day with recent exposure"]]],
    ["thrombosis", "Thrombosis or sequelae", [[0, "None"], [1, "Progressive/recurrent thrombosis or skin lesions"], [2, "New thrombosis, skin necrosis, or acute systemic reaction"]]],
    ["other", "Other causes of thrombocytopenia", [[0, "Definite other cause"], [1, "Possible other cause"], [2, "No apparent other cause"]]],
  ], [[null, 4, "Low probability of HIT"], [4, 6, "Intermediate probability of HIT"], [6, null, "High probability of HIT"]]);
  defs.apache2 = {
    name: "APACHE II Score",
    desc: "Critical illness severity score",
    fields: [
      { id: "organ_insufficiency", label: "Severe organ failure or immunocompromise", type: "select", options: [["0", "No"], ["1", "Yes"]] },
      { id: "surgery", label: "Type of surgery", type: "select", options: [["0", "Emergency"], ["1", "Elective"], ["2", "Nonoperative"]] },
      { id: "age", label: "Age", unit: "years", type: "number" },
      { id: "temperature", label: "Temperature", unit: "C", type: "number" },
      { id: "map", label: "Mean arterial pressure", unit: "mmHg", type: "number" },
      { id: "ph", label: "Arterial pH", type: "number" },
      { id: "heart_rate", label: "Heart rate", unit: "bpm", type: "number" },
      { id: "respiratory_rate", label: "Respiratory rate", unit: "/min", type: "number" },
      { id: "sodium", label: "Sodium", unit: "mEq/L", type: "number" },
      { id: "potassium", label: "Potassium", unit: "mEq/L", type: "number" },
      { id: "creatinine", label: "Creatinine", unit: "mg/dL", type: "number" },
      { id: "acute_renal_failure", label: "Acute renal failure", type: "select", options: [["0", "No"], ["1", "Yes"]] },
      { id: "hematocrit", label: "Hematocrit", unit: "%", type: "number" },
      { id: "wbc", label: "White blood cell count", unit: "10^3/uL", type: "number" },
      { id: "gcs", label: "Glasgow Coma Scale", type: "number" },
      { id: "fio2", label: "FiO2", type: "select", options: [["0", "<50% or non-intubated"], ["1", ">=50%"]] },
      { id: "pao2", label: "PaO2 if FiO2 <50%", type: "select", options: [["0", ">70"], ["1", "61-70"], ["3", "55-60"], ["4", "<55"]] },
      { id: "aa_grad", label: "A-a gradient if FiO2 >=50%", type: "select", options: [["0", "<200"], ["2", "200-349"], ["3", "350-499"], ["4", ">499"]] },
    ],
    compute: v => {
      const tempPts = v.temperature >= 41 ? 4 : v.temperature >= 39 ? 3 : v.temperature >= 38.5 ? 1 : v.temperature >= 36 ? 0 : v.temperature >= 34 ? 1 : v.temperature >= 32 ? 2 : v.temperature >= 30 ? 3 : 4;
      const mapPts = v.map >= 160 ? 4 : v.map >= 130 ? 3 : v.map >= 110 ? 2 : v.map >= 70 ? 0 : v.map >= 50 ? 2 : 4;
      const phPts = v.ph >= 7.7 ? 4 : v.ph >= 7.6 ? 3 : v.ph >= 7.5 ? 1 : v.ph >= 7.33 ? 0 : v.ph >= 7.25 ? 2 : v.ph >= 7.15 ? 3 : 4;
      const hrPts = v.heart_rate >= 180 ? 4 : v.heart_rate >= 140 ? 3 : v.heart_rate >= 110 ? 2 : v.heart_rate >= 70 ? 0 : v.heart_rate >= 55 ? 2 : v.heart_rate >= 40 ? 3 : 4;
      const rrPts = v.respiratory_rate >= 50 ? 4 : v.respiratory_rate >= 35 ? 3 : v.respiratory_rate >= 25 ? 1 : v.respiratory_rate >= 12 ? 0 : v.respiratory_rate >= 10 ? 1 : v.respiratory_rate >= 6 ? 2 : 4;
      const naPts = v.sodium >= 180 ? 4 : v.sodium >= 160 ? 3 : v.sodium >= 155 ? 2 : v.sodium >= 150 ? 1 : v.sodium >= 130 ? 0 : v.sodium >= 120 ? 2 : v.sodium >= 111 ? 3 : 4;
      const kPts = v.potassium >= 7 ? 4 : v.potassium >= 6 ? 3 : v.potassium >= 5.5 ? 1 : v.potassium >= 3.5 ? 0 : v.potassium >= 3 ? 1 : v.potassium >= 2.5 ? 2 : 4;
      let crPts = v.creatinine >= 3.5 ? 4 : v.creatinine >= 2 ? 3 : v.creatinine >= 1.5 ? 2 : v.creatinine >= 0.6 ? 0 : 2;
      if (v.acute_renal_failure && v.creatinine >= 1.5) crPts *= 2;
      const hctPts = v.hematocrit >= 60 ? 4 : v.hematocrit >= 50 ? 2 : v.hematocrit >= 46 ? 1 : v.hematocrit >= 30 ? 0 : v.hematocrit >= 20 ? 2 : 4;
      const wbcPts = v.wbc >= 40 ? 4 : v.wbc >= 20 ? 2 : v.wbc >= 15 ? 1 : v.wbc >= 3 ? 0 : v.wbc >= 1 ? 2 : 4;
      const agePts = v.age >= 75 ? 6 : v.age >= 65 ? 5 : v.age >= 55 ? 3 : v.age >= 45 ? 2 : 0;
      const chronicPts = v.organ_insufficiency ? (v.surgery === 1 ? 2 : 5) : 0;
      const oxygenPts = v.fio2 === 0 ? v.pao2 : v.aa_grad;
      const value = tempPts + mapPts + phPts + hrPts + rrPts + naPts + kPts + crPts + hctPts + wbcPts + Math.max(0, 15 - v.gcs) + agePts + chronicPts + oxygenPts;
      return [value, "points", "Physiology " + (value - agePts - chronicPts) + "; age " + agePts + "; chronic health " + chronicPts];
    },
    bands: [[null, 10, "Lower APACHE II severity"], [10, 20, "Moderate APACHE II severity"], [20, 30, "High APACHE II severity"], [30, null, "Very high APACHE II severity"]],
  };
  addScore("fracture_index_no_bmd", "Fracture Index without known BMD", "Estimates fracture risk when BMD is unavailable", [
    ["age", "Age", [[0, "<65"], [1, "65-69"], [2, "70-74"], [3, "75-79"], [4, ">=80"]]],
    ["prior", "Prior fracture after age 50", 1],
    ["mother", "Maternal hip fracture", 1],
    ["weight", "Weight <57 kg", 1],
    ["smoker", "Current smoker", 1],
    ["arms", "Needs arms to rise from chair", 1],
  ], [[null, 2, "Lower fracture risk"], [2, 4, "Intermediate fracture risk"], [4, null, "Higher fracture risk"]]);

  const shortcuts = [
    ["1", "egfr", "eGFR"], ["2", "cockcroft", "CrCl"], ["3", "anion_gap", "Anion gap"],
    ["4", "aa_gradient", "A-a"], ["5", "cha2ds2", "CHA2DS2"], ["6", "wells_pe", "Wells PE"],
    ["7", "curb65", "CURB-65"], ["8", "meld", "MELD"], ["9", "gcs", "GCS"], ["0", "bmi", "BMI"],
  ];
  const defaultShortcutTargets = shortcuts.map(([, id]) => "native:" + id);
  const appCommands = [
    { key: "F", sequence: "S", label: "Global search selected text", combo: "Ctrl+Alt+F or /", action: () => openGlobalSearch(selectedText()) },
    { key: "K", sequence: "K", label: "Command center", combo: "Ctrl+Alt+K or g k", action: () => openCommandCenter() },
    { key: "L", sequence: "L", label: "Labs reference", combo: "Ctrl+Alt+L or g l", action: () => openLabsWindow() },
    { key: "U", sequence: "U", label: "Open UpToDate", combo: "Ctrl+Alt+U or g u", action: () => navigateTo("/uptodate", "UpToDate") },
    { key: "A", sequence: "A", label: "Open AMBOSS", combo: "Ctrl+Alt+A or g a", action: () => navigateTo("/amboss", "AMBOSS") },
    { key: "Q", sequence: "Q", label: "Open Q-Bank", combo: "Ctrl+Alt+Q or g q", action: () => navigateTo("/qbank", "Q-Bank") },
    { key: "M", sequence: "C", label: "Medical calculators", combo: "Ctrl+Alt+M or g c", action: () => toggleCalcLauncher() },
    { key: "?", sequence: "?", label: "Shortcut help", combo: "Ctrl+Alt+/ or ?", action: () => openShortcutHelp() },
  ];
  const labGroups = [
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
  const shiftedDigitKeys = {
    ")": "0",
    "!": "1",
    "@": "2",
    "#": "3",
    "$": "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
  };

  const nativeAliases = [
    ["bmi", ["body mass index", "bmi"]],
    ["ibw", ["ideal body weight adult", "ideal body weight"]],
    ["bsa", ["body surface area", "bsa"]],
    ["anc", ["absolute neutrophil", "anc"]],
    ["four_t", ["4t score", "4t"]],
    ["acetaminophen_toxicity", ["acetaminophen toxicity", "acetaminophen toxicity assessment"]],
    ["als_adult", ["advanced life support adult", "advanced life support"]],
    ["apache2", ["apache ii", "apache 2"]],
    ["fracture_index_no_bmd", ["fracture index without known bone mineral density"]],
    ["calvert_carboplatin", ["calvert", "carboplatin"]],
    ["steroid_conversion", ["steroid conversion", "corticosteroid conversion"]],
    ["opioid_mme", ["morphine milligram", "mme calculator"]],
    ["maintenance_fluids", ["maintenance fluids", "maintenance fluid"]],
    ["corrected_calcium", ["calcium correction", "corrected calcium"]],
    ["corrected_sodium", ["sodium correction hyperglycemia", "corrected sodium hyperglycemia"]],
    ["serum_osmolality", ["serum osmolality", "serum osmolarity"]],
    ["fena", ["fractional excretion of sodium", "fena"]],
    ["mdrd", ["mdrd"]],
    ["schwartz", ["schwartz gfr", "revised schwartz"]],
    ["mean_arterial_pressure", ["mean arterial pressure", "map"]],
    ["shock_index", ["shock index"]],
    ["parkland", ["parkland"]],
    ["bicarbonate_deficit", ["bicarbonate deficit"]],
    ["heart_score", ["heart score", "heart pathway"]],
    ["perc", ["perc rule"]],
    ["geneva_pe", ["geneva pulmonary embolism", "revised geneva"]],
    ["qsofa", ["qsofa", "quick sofa"]],
    ["sirs", ["sirs sepsis", "sirs criteria"]],
    ["centor_mcisaac", ["centor", "mcisaac"]],
    ["stop_bang", ["stop bang", "stop-bang"]],
    ["rcri", ["revised cardiac risk", "rcri"]],
    ["bisap", ["bisap"]],
    ["cage", ["cage questions"]],
    ["audit_c", ["audit c", "audit-c"]],
    ["ldl_calculated", ["ldl calculated"]],
    ["free_water_deficit", ["free water deficit", "water deficit"]],
    ["sodium_deficit", ["sodium deficit"]],
    ["fib4", ["fib 4", "fibrosis 4", "fib-4"]],
    ["egfr", ["egfr", "glomerular filtration", "ckd epi"]],
    ["framingham", ["framingham risk", "hard coronary heart disease"]],
    ["glasgow_blatchford", ["glasgow blatchford", "blatchford bleeding", "gbs score"]],
    ["cockcroft", ["cockcroft", "creatinine clearance"]],
    ["anion_gap", ["anion gap", "anion gap in hypoalbumin"]],
    ["winters", ["winter", "expected pco2"]],
    ["aa_gradient", ["a a gradient", "alveolar arterial"]],
    ["qtc", ["corrected qt", "qtc", "qt interval"]],
    ["meld_na", ["meldna", "meld na", "combined meld"]],
    ["meld", ["meld score original", "meld score"]],
    ["has_bled", ["has bled"]],
    ["chads2", ["chads2", "chads 2"]],
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

  function addScore(id, name, desc, rows, bands) {
    defs[id] = {
      name, desc,
      fields: rows.map(([fid, label, points]) => ({
        id: fid,
        label,
        type: "select",
        options: Array.isArray(points)
          ? points.map(([v, l]) => [String(v), String(v) + " — " + l])
          : [["0", "No"], [String(points), "Yes"]],
      })),
      compute: v => [round(Object.keys(v).reduce((s, k) => s + Number(v[k] || 0), 0), 1), "points"],
      bands,
    };
  }

  function round(n, places) {
    const p = Math.pow(10, places || 0);
    return Math.round(n * p) / p;
  }

  function values(panel) {
    const out = rawValues(panel);
    panel.querySelectorAll("[data-calc-field]").forEach(el => {
      const id = el.dataset.calcField;
      const unitSelect = panel.querySelector(`[data-calc-unit="${id}"]`);
      const selected = unitSelect ? unitSelect.options[unitSelect.selectedIndex] : null;
      const factor = selected ? Number(selected.getAttribute("data-factor") || 1) : 1;
      if (out[id] != null && Number.isFinite(Number(out[id]))) out[id] = Number(out[id]) * factor;
    });
    return out;
  }

  function readState() {
    try {
      return JSON.parse(sessionStorage.getItem(stateKey) || "null");
    } catch {
      return null;
    }
  }

  function writeState(id, panel) {
    try {
      sessionStorage.setItem(stateKey, JSON.stringify({
        kind: "native",
        id,
        values: rawValues(panel),
        units: selectedUnits(panel),
        min: panel.classList.contains("is-min"),
        max: panel.classList.contains("is-max"),
      }));
    } catch {}
  }

  function clearState() {
    try {
      sessionStorage.removeItem(stateKey);
    } catch {}
  }

  function backendUrl() {
    const host = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
    return "http://" + host + ":8002";
  }

  function norm(s) {
    return String(s || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function cleanText(s) {
    return String(s || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
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
      .replace(/&ldquo;|&rdquo;/gi, '"')
      .replace(/<calculator\b[^>]*>(.*?)<\/calculator>/gi, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeUnitText(s) {
    return cleanText(s).toLowerCase().replace(/[µμ]/g, "u").replace(/[×x]/g, "x").replace(/\s+/g, "");
  }

  function liveUnitFactor(input, label, fromUnit, toUnit) {
    const from = normalizeUnitText(fromUnit);
    const to = normalizeUnitText(toUnit);
    if (!from || !to || from === to) return 1;
    const text = norm([input.name, label, fromUnit, toUnit].join(" "));
    if (from.includes("umol/l") && to.includes("mg/dl") && text.includes("creatinine")) return 1 / 88.4;
    if (from.includes("umol/l") && to.includes("mg/dl") && text.includes("bilirubin")) return 1 / 17.104;
    if (from.includes("mmol/l") && to.includes("mg/dl") && text.includes("glucose")) return 18.0182;
    if (from.includes("mmol/l") && to.includes("mg/dl") && text.includes("bun")) return 2.8;
    if (from.includes("g/l") && to.includes("g/dl")) return 0.1;
    if (from.includes("mmol/l") && to.includes("mg/dl") && text.includes("cholesterol")) return 38.67;
    if (from.includes("mmol/l") && to.includes("mg/dl") && text.includes("triglyceride")) return 88.57;
    if ((from.includes("10^9/l") || from.includes("10⁹/l")) && (to.includes("10^3/ul") || to.includes("10³/ul"))) return 1;
    return 1;
  }

  function liveUnitOptions(input, label) {
    const us = cleanText(input.unitUs || input.unit);
    const si = cleanText(input.unitSi);
    const base = us || cleanText(input.unit) || si;
    if (!base || !si || normalizeUnitText(base) === normalizeUnitText(si)) return null;
    return [[base, base, 1], [si, si, liveUnitFactor(input, label, si, base)]];
  }

  function liveFieldsFromInputs(inputs, title) {
    let section = "";
    let sectionIndex = -1;
    const titleNorm = norm(title);
    const sectionName = index => {
      if (titleNorm.includes("framingham heart failure")) return index === 0 ? "Major Criteria" : "Minor Criteria";
      if (titleNorm.includes("jones criteria")) return ["Evidence of Preceding GAS Infection", "Major Criteria", "Minor Criteria"][index] || "Criteria";
      if (titleNorm.includes("duke") && titleNorm.includes("criteria")) return ["Pathologic Criteria", "Major Criteria", "Minor Criteria"][index] || "Criteria";
      return "Criteria";
    };
    const out = [];
    (Array.isArray(inputs) ? inputs : []).slice(0, 40).forEach(input => {
      if (!input) return;
      if (input.type === "subheading") {
        sectionIndex += 1;
        section = cleanText(input.label) || sectionName(sectionIndex);
        return;
      }
      if (!input.name || !input.label) return;
      const id = String(input.name || input.label || "field").replace(/[^a-z0-9_]/gi, "_");
      const label = cleanText(input.label) || String(input.name || id);
      if (Array.isArray(input.options) && input.options.length) {
        out.push({
          id,
          label,
          type: "select",
          options: input.options.map(option => [String(option.value || 0), String(option.value || 0) + " - " + (cleanText(option.label) || String(option.value || ""))]),
          optional: !!input.optional,
          hint: cleanText(input.hint) || "",
          conditionality: input.conditionality || "",
          section: section || (titleNorm.includes("criteria") ? "Criteria" : ""),
        });
        return;
      }
      const normalRange = input.normalMin != null && input.normalMax != null && (Number(input.normalMin) > 0 || Number(input.normalMax) > 0)
        ? Number(input.normalMin).toFixed(1) + " - " + Number(input.normalMax).toFixed(1)
        : "";
      const unitOptions = liveUnitOptions(input, label);
      out.push({
        id,
        label,
        unit: cleanText(input.unitUs || input.unit) || "",
        type: "number",
        optional: !!input.optional,
        hint: cleanText(input.hint) || "",
        placeholder: normalRange,
        conditionality: input.conditionality || "",
        section: section || (titleNorm.includes("criteria") ? "Criteria" : ""),
        unitOptions: unitOptions || undefined,
      });
    });
    return out;
  }

  function fieldVisibleRuntime(field, def, v) {
    const expr = String(field.conditionality || "").trim();
    if (!expr) return true;
    if (!/^[\w\s.$=!<>&|()+\-*/%?:'"]+$/.test(expr)) return true;
    const names = def.fields.map(f => f.id).filter(id => /^[A-Za-z_$][\w$]*$/.test(id));
    try {
      const fn = new Function(...names, "return Boolean(" + expr + ");");
      return !!fn(...names.map(name => v[name] ?? 0));
    } catch {
      return true;
    }
  }

  function splitMdCalcText(value) {
    const cleaned = cleanText(value);
    if (!cleaned) return [];
    return cleaned.split(/(?:\n|•|;\s+(?=[A-Z]))/).map(item => item.trim()).filter(Boolean).slice(0, 6);
  }

  function mdcalcDetails(item, description) {
    const details = item && item.details ? item.details : {};
    const when = cleanText(details.whenToUse || details.beforeUse || details.instructions || description);
    const pitfalls = splitMdCalcText(details.pearlsPitfalls);
    const why = cleanText(details.management || details.advice || details.criticalActions || details.moreInfo || item.formula);
    return { when, pitfalls, why };
  }

  function executeMdCalcLogic(item, fields, v) {
    const logic = item && item.equationLogicText;
    if (!logic) return null;
    const params = [];
    const args = [];
    (Array.isArray(item.inputs) ? item.inputs : []).forEach(input => {
      const name = String(input.name || "");
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || params.includes(name)) return;
      const id = name.replace(/[^a-z0-9_]/gi, "_");
      params.push(name);
      args.push(v[id] ?? input.default ?? 0);
    });
    try {
      const fn = new Function(...params, "UOMSYSTEM", logic + "\nreturn typeof calc_output !== \"undefined\" ? calc_output : [];");
      const output = fn(...args, true);
      if (!Array.isArray(output) || !output.length) return null;
      const mini = output.find(row => String(row && row.name || "").toLowerCase() === "mini") || output[0];
      const valueRaw = mini && mini.value != null ? mini.value : "";
      const numeric = typeof valueRaw === "number" ? valueRaw : Number(String(valueRaw).replace(/,/g, ""));
      const value = Number.isFinite(numeric) && String(valueRaw).trim() !== "" ? round(numeric, Number.isInteger(numeric) ? 0 : 2) : String(valueRaw || "Calculated");
      const notes = output.map(row => cleanText([row && row.message, row && row !== mini ? row.value : ""].filter(Boolean).join(" "))).filter(Boolean);
      return [value, cleanText(mini && mini.value_text) || "", notes.slice(0, 3).join(" ")];
    } catch {
      const entered = fields.filter(field => v[field.id] != null).map(field => field.label + ": " + v[field.id]).join("; ");
      return [fields.length, "inputs captured", entered || "MDCalc equation logic is present but could not be evaluated for this input combination."];
    }
  }

  const unitSets = {
    weightKg: [["kg", "kg", 1], ["lb", "lb", 0.45359237]],
    heightCm: [["cm", "cm", 1], ["in", "in", 2.54]],
    creatinine: [["mg/dL", "mg/dL", 1], ["umol/L", "umol/L", 1 / 88.4]],
    bilirubin: [["mg/dL", "mg/dL", 1], ["umol/L", "umol/L", 1 / 17.1]],
    glucose: [["mg/dL", "mg/dL", 1], ["mmol/L", "mmol/L", 18.0182]],
    bun: [["mg/dL", "mg/dL", 1], ["mmol/L urea", "mmol/L", 2.8]],
    calcium: [["mg/dL", "mg/dL", 1], ["mmol/L", "mmol/L", 4.008]],
    albumin: [["g/dL", "g/dL", 1], ["g/L", "g/L", 0.1]],
    cholesterol: [["mg/dL", "mg/dL", 1], ["mmol/L", "mmol/L", 38.67]],
    triglycerides: [["mg/dL", "mg/dL", 1], ["mmol/L", "mmol/L", 88.57]],
    electrolytes: [["mEq/L", "mEq/L", 1], ["mmol/L", "mmol/L", 1]],
  };

  function fieldText(f) {
    return norm([f.id, f.label, f.unit].join(" "));
  }

  function unitOptionsForField(f) {
    if (!f || f.type !== "number") return [];
    if (Array.isArray(f.unitOptions)) return f.unitOptions;
    const text = fieldText(f);
    if (f.unit === "kg" || text.includes("weight")) return unitSets.weightKg;
    if (f.unit === "cm" || text.includes("height") || text.includes("neck")) return unitSets.heightCm;
    if (text.includes("creatinine")) return unitSets.creatinine;
    if (text.includes("bilirubin")) return unitSets.bilirubin;
    if (text.includes("glucose")) return unitSets.glucose;
    if (text.includes("bun")) return unitSets.bun;
    if (text.includes("calcium")) return unitSets.calcium;
    if (text.includes("albumin")) return unitSets.albumin;
    if (text.includes("triglyceride")) return unitSets.triglycerides;
    if (text.includes("cholesterol") || f.id === "tc" || f.id === "hdl") return unitSets.cholesterol;
    if (f.unit === "mEq/L" && /(sodium|chloride|hco|bicarbonate|potassium|infusate)/.test(text)) return unitSets.electrolytes;
    return [];
  }

  function normalGuideForField(f) {
    if (!f || f.type !== "number") return "";
    const text = fieldText(f);
    if (text.includes("bun")) return "8.0 - 20.0";
    if (text.includes("hemoglobin") || text.includes("hgb")) return "12.0 - 17.0";
    if (text.includes("systolic") || text.includes("sbp")) return "100.0 - 120.0";
    if (text.includes("creatinine")) return "0.7 - 1.3";
    if (text.includes("cystatin")) return "0.51 - 0.98";
    if (text.includes("ast")) return "15.0 - 41.0";
    if (text.includes("alt")) return "1.0 - 35.0";
    if (text.includes("platelet")) return "150.0 - 350.0";
    if (text.includes("glucose")) return "70.0 - 100.0";
    if (text.includes("albumin")) return "3.5 - 5.0";
    if (text.includes("sodium")) return "135.0 - 145.0";
    if (text.includes("potassium")) return "3.5 - 5.0";
    if (text.includes("calcium")) return "8.5 - 10.5";
    if (text.includes("heart rate") || text.includes("pulse")) return "60.0 - 100.0";
    if (text.includes("respiratory rate") || text.includes("resp rate")) return "12.0 - 20.0";
    if (text.includes("temperature")) return "36.1 - 38.0";
    return "";
  }

  function fieldPlaceholder(f) {
    return f.placeholder || normalGuideForField(f) || (f.value != null ? String(f.value) : "Enter value");
  }

  function compactNumber(n) {
    const value = Number(n);
    if (!Number.isFinite(value)) return "";
    if (Math.abs(value) >= 100) return String(Math.round(value));
    if (Math.abs(value) >= 10) return String(Math.round(value * 10) / 10);
    return String(Math.round(value * 100) / 100);
  }

  function nativeForLexi(item) {
    const title = norm(item.title);
    if (title.includes("for age")) return "";
    if (title.includes("gehan") || title.includes("du bois")) return "";
    if (title.includes("delta")) return "";
    if (title.includes("fracture index") && !title.includes("without")) return "";
    if (title.includes("framingham") && title.includes("stroke")) return "";
    if (title.includes("cockcroft") && title.includes("with ibw")) return "";
    if (title.includes("apache ii") && title.includes("by diagnosis")) return "";
    if (title.includes("acc aha")) return "";
    const haystack = norm([item.title, item.subtitle, ...(item.categories || [])].join(" "));
    const hit = nativeAliases.find(([, aliases]) => aliases.some(alias => haystack.includes(norm(alias))));
    return hit ? hit[0] : "";
  }

  function lexiTemplateFor(item) {
    const title = item.title || "Lexi calculator";
    const key = "lexi_" + String(item.id || norm(title)).replace(/[^a-z0-9_]/gi, "_");
    const category = item.category || "Lexi calculator";
    const description = cleanText(item.description) || "Executable Lexi worksheet";
    const titleNorm = norm(title);
    const liveFields = liveFieldsFromInputs(item.inputs, title);
    if (item.equationLogicText && liveFields.length) {
      const def = {
        id: key,
        name: title,
        desc: description,
        details: mdcalcDetails(item, description),
        fields: liveFields,
        compute: v => executeMdCalcLogic(item, liveFields, v) || [liveFields.length, "inputs captured", "MDCalc equation logic is present but did not return a display result."],
      };
      return [key, def];
    }
    const bySum = (name, fields, note) => ({
      name, desc: description,
      fields: fields.map((label, index) => ({ id: "f" + index, label, type: "select", options: [["0", "No"], ["1", "Yes"]] })),
      compute: v => [Object.keys(v).reduce((s, k) => s + Number(v[k] || 0), 0), "points", note || ""],
    });
    let def;
    if (titleNorm.includes("calcium correction")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "calcium", label: "Measured calcium", unit: titleNorm.includes("si units") ? "mmol/L" : "mg/dL", type: "number" },
          { id: "albumin", label: "Albumin", unit: titleNorm.includes("si units") ? "g/L" : "g/dL", type: "number" },
        ],
        compute: v => titleNorm.includes("si units")
          ? [round(v.calcium + 0.02 * (40 - v.albumin), 2), "mmol/L", "Corrected Ca = Ca + 0.02 x (40 - albumin g/L)"]
          : [round(v.calcium + 0.8 * (4 - v.albumin), 2), "mg/dL", "Corrected Ca = Ca + 0.8 x (4 - albumin g/dL)"],
      };
    } else if (titleNorm.includes("anion gap") && (titleNorm.includes("delta delta") || titleNorm.includes("delta ratio") || titleNorm.includes("delta gradient"))) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "na", label: "Sodium", unit: "mEq/L", type: "number" },
          { id: "cl", label: "Chloride", unit: "mEq/L", type: "number" },
          { id: "bicarb", label: "HCO3", unit: "mEq/L", type: "number" },
        ],
        compute: v => {
          const ag = v.na - v.cl - v.bicarb;
          const deltaAg = ag - 12;
          const deltaBicarb = 24 - v.bicarb;
          return titleNorm.includes("ratio")
            ? [round(deltaAg / deltaBicarb, 2), "ratio", "AG " + round(ag, 1) + "; delta AG " + round(deltaAg, 1)]
            : [round(deltaAg - deltaBicarb, 1), "mEq/L", "AG " + round(ag, 1) + "; delta-delta gradient"];
        },
      };
    } else if (titleNorm.includes("fractional excretion of sodium")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "una", label: "Urine sodium", type: "number" }, { id: "pna", label: "Plasma sodium", type: "number" },
          { id: "ucr", label: "Urine creatinine", type: "number" }, { id: "pcr", label: "Plasma creatinine", type: "number" },
        ],
        compute: v => [round(((v.una * v.pcr) / (v.pna * v.ucr)) * 100, 2), "%", "FENa = (UNa x PCr)/(PNa x UCr) x 100"],
      };
    } else if (titleNorm.includes("osmolal") || titleNorm.includes("osmolality")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "sodium", label: "Sodium", unit: "mEq/L", type: "number" }, { id: "glucose", label: "Glucose", unit: "mg/dL", type: "number" },
          { id: "bun", label: "BUN", unit: "mg/dL", type: "number" }, { id: "ethanol", label: "Ethanol", unit: "mg/dL", type: "number", value: 0, optional: true },
          { id: "measured", label: "Measured osmolality", unit: "mOsm/kg", type: "number", value: 0, optional: true },
        ],
        compute: v => {
          const calc = 2 * v.sodium + v.glucose / 18 + v.bun / 2.8 + (v.ethanol || 0) / 3.7;
          return v.measured ? [round(v.measured - calc, 1), "mOsm/kg gap", "Calculated osmolality " + round(calc, 1)] : [round(calc, 1), "mOsm/kg", "Calculated serum osmolality"];
        },
      };
    } else if (titleNorm.includes("sodium correction")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "sodium", label: "Measured sodium", unit: "mEq/L", type: "number" },
          { id: "glucose", label: "Glucose", unit: "mg/dL", type: "number" },
          { id: "factor", label: "Correction factor", type: "select", options: [["1.6", "1.6 mEq/L"], ["2.4", "2.4 mEq/L"]] },
        ],
        compute: v => [round(v.sodium + v.factor * (Math.max(0, v.glucose - 100) / 100), 1), "mEq/L", "Corrected sodium in hyperglycemia"],
      };
    } else if (titleNorm.includes("sodium deficit")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "weight", label: "Weight", unit: "kg", type: "number" },
          { id: "current", label: "Current sodium", unit: "mEq/L", type: "number" },
          { id: "target", label: "Target sodium", unit: "mEq/L", type: "number", value: 135 },
          { id: "tbw", label: "TBW fraction", type: "select", options: [["0.6", "0.6 adult male / child"], ["0.5", "0.5 adult female / older male"], ["0.45", "0.45 older female"]] },
        ],
        compute: v => [round((v.target - v.current) * v.weight * v.tbw, 0), "mEq Na", "Na deficit = TBW x (target Na - current Na)"],
      };
    } else if (titleNorm.includes("water deficit") || titleNorm.includes("hypernatremia")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "weight", label: "Weight", unit: "kg", type: "number" },
          { id: "sodium", label: "Current sodium", unit: "mEq/L", type: "number" },
          { id: "target", label: "Target sodium", unit: "mEq/L", type: "number", value: 140 },
          { id: "tbw", label: "TBW fraction", type: "select", options: [["0.6", "0.6 adult male / child"], ["0.5", "0.5 adult female / older male"], ["0.45", "0.45 older female"]] },
        ],
        compute: v => [round(v.tbw * v.weight * ((v.sodium / v.target) - 1), 2), "L free water", "Water deficit = TBW x weight x ((Na/target Na)-1)"],
      };
    } else if (titleNorm.includes("hyponatremia correction infusate rate")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "weight", label: "Weight", unit: "kg", type: "number" },
          { id: "current", label: "Current sodium", unit: "mEq/L", type: "number" },
          { id: "infusate", label: "Infusate sodium", unit: "mEq/L", type: "number", value: 513 },
          { id: "rate", label: "Infusion rate", unit: "mL/hr", type: "number" },
          { id: "tbw", label: "TBW fraction", type: "select", options: [["0.6", "0.6"], ["0.5", "0.5"], ["0.45", "0.45"]] },
        ],
        compute: v => [round(((v.infusate - v.current) / (v.tbw * v.weight + 1)) * (v.rate / 1000), 2), "mEq/L/hr", "Adrogue-Madias estimate"],
      };
    } else if (titleNorm.includes("du bois")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "height", label: "Height", unit: "cm", type: "number" },
          { id: "weight", label: "Weight", unit: "kg", type: "number" },
        ],
        compute: v => [round(0.007184 * Math.pow(v.height, 0.725) * Math.pow(v.weight, 0.425), 2), "m²", "BSA = 0.007184 x height^0.725 x weight^0.425"],
      };
    } else if (titleNorm.includes("gehan")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "height", label: "Height", unit: "cm", type: "number" },
          { id: "weight", label: "Weight", unit: "kg", type: "number" },
        ],
        compute: v => [round(0.0235 * Math.pow(v.height, 0.42246) * Math.pow(v.weight, 0.51456), 2), "m²", "Gehan and George BSA formula"],
      };
    } else if (titleNorm.includes("adjusted body weight")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "actual", label: "Actual body weight", unit: "kg", type: "number" },
          { id: "ideal", label: "Ideal body weight", unit: "kg", type: "number" },
          { id: "factor", label: "Correction factor", type: "select", options: [["0.4", "0.4 common dosing factor"], ["0.3", "0.3"], ["0.5", "0.5"]] },
        ],
        compute: v => [round(v.ideal + v.factor * (v.actual - v.ideal), 1), "kg", "AdjBW = IBW + factor x (actual - IBW)"],
      };
    } else if ((titleNorm.includes("ideal body weight") || titleNorm.includes("dosing weight")) && !titleNorm.includes("pediatric")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "height", label: "Height", unit: "cm", type: "number" },
          { id: "actual", label: "Actual body weight", unit: "kg", type: "number", value: 0, optional: true },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        ],
        compute: v => {
          const inches = v.height / 2.54;
          const ibw = (v.sex === 1 ? 50 : 45.5) + 2.3 * Math.max(0, inches - 60);
          return [round(ibw, 1), "kg IBW", v.actual ? "Actual body weight is " + round((v.actual / ibw) * 100, 0) + "% of IBW" : "Devine adult IBW"];
        },
      };
    } else if (titleNorm.includes("basal energy")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "weight", label: "Weight", unit: "kg", type: "number" },
          { id: "height", label: "Height", unit: "cm", type: "number" },
          { id: "age", label: "Age", unit: "years", type: "number" },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        ],
        compute: v => [round(v.sex === 1 ? 88.362 + 13.397 * v.weight + 4.799 * v.height - 5.677 * v.age : 447.593 + 9.247 * v.weight + 3.098 * v.height - 4.33 * v.age, 0), "kcal/day", "Harris-Benedict basal energy estimate"],
      };
    } else if (titleNorm.includes("lean body weight")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "weight", label: "Weight", unit: "kg", type: "number" },
          { id: "height", label: "Height", unit: "cm", type: "number" },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        ],
        compute: v => {
          const bmi = v.weight / Math.pow(v.height / 100, 2);
          const lbw = v.sex === 1 ? (9270 * v.weight) / (6680 + 216 * bmi) : (9270 * v.weight) / (8780 + 244 * bmi);
          return [round(lbw, 1), "kg", "Janmahasatian lean body weight estimate"];
        },
      };
    } else if (titleNorm.includes("maintenance fluid")) {
      def = {
        name: title, desc: description,
        fields: [{ id: "weight", label: "Weight", unit: "kg", type: "number" }],
        compute: v => {
          const hourly = v.weight <= 10 ? 4 * v.weight : v.weight <= 20 ? 40 + 2 * (v.weight - 10) : 60 + v.weight - 20;
          return [round(hourly, 0), "mL/hr", round(hourly * 24, 0) + " mL/day by 4-2-1 rule"];
        },
      };
    } else if (titleNorm.includes("cockcroft") && titleNorm.includes("with ibw")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "creatinine", label: "Serum creatinine", unit: titleNorm.includes("si units") ? "umol/L" : "mg/dL", type: "number" },
          { id: "age", label: "Age", unit: "years", type: "number" },
          { id: "height", label: "Height", unit: "cm", type: "number" },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        ],
        compute: v => {
          const cr = titleNorm.includes("si units") ? v.creatinine / 88.4 : v.creatinine;
          const ibw = (v.sex === 1 ? 50 : 45.5) + 2.3 * Math.max(0, v.height / 2.54 - 60);
          return [round(((140 - v.age) * ibw * (v.sex === 0 ? 0.85 : 1)) / (72 * cr), 0), "mL/min", "IBW " + round(ibw, 1) + " kg used"];
        },
      };
    } else if (titleNorm.includes("cystatin c") && !titleNorm.includes("w cystatin")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "cystatin", label: "Cystatin C", unit: "mg/L", type: "number" },
          { id: "age", label: "Age", unit: "years", type: "number" },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        ],
        compute: v => {
          const x = v.cystatin / 0.8;
          return [round(133 * Math.pow(Math.min(x, 1), -0.499) * Math.pow(Math.max(x, 1), -1.328) * Math.pow(0.996, v.age) * (v.sex === 0 ? 0.932 : 1), 0), "mL/min/1.73m²", "CKD-EPI 2012 cystatin C equation"];
        },
      };
    } else if (titleNorm.includes("w cystatin")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number" },
          { id: "cystatin", label: "Cystatin C", unit: "mg/L", type: "number" },
          { id: "age", label: "Age", unit: "years", type: "number" },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        ],
        compute: v => {
          const k = v.sex === 1 ? 0.9 : 0.7;
          const a = v.sex === 1 ? -0.219 : -0.248;
          const scr = v.creatinine / k;
          const scys = v.cystatin / 0.8;
          return [round(135 * Math.pow(Math.min(scr, 1), a) * Math.pow(Math.max(scr, 1), -0.544) * Math.pow(Math.min(scys, 1), -0.323) * Math.pow(Math.max(scys, 1), -0.778) * Math.pow(0.9961, v.age) * (v.sex === 0 ? 0.963 : 1), 0), "mL/min/1.73m²", "CKD-EPI 2021 creatinine-cystatin C equation"];
        },
      };
    } else if ((titleNorm.includes("ckd epi") || titleNorm.includes("glomerular filtration rate by ckd")) && !titleNorm.includes("cystatin")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number" },
          { id: "age", label: "Age", unit: "years", type: "number" },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        ],
        compute: v => {
          const k = v.sex === 1 ? 0.9 : 0.7;
          const a = v.sex === 1 ? -0.302 : -0.241;
          const x = v.creatinine / k;
          return [round(142 * Math.pow(Math.min(x, 1), a) * Math.pow(Math.max(x, 1), -1.2) * Math.pow(0.9938, v.age) * (v.sex === 0 ? 1.012 : 1), 0), "mL/min/1.73m²", "2021 CKD-EPI creatinine equation"];
        },
      };
    } else if (titleNorm.includes("mdrd")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number" },
          { id: "age", label: "Age", unit: "years", type: "number" },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
          { id: "black", label: "Black race coefficient", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        ],
        compute: v => [round(175 * Math.pow(v.creatinine, -1.154) * Math.pow(v.age, -0.203) * (v.sex === 0 ? 0.742 : 1) * (v.black ? 1.212 : 1), 0), "mL/min/1.73m²", "MDRD IDMS-traceable equation"],
      };
    } else if (titleNorm.includes("schwartz")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "height", label: "Height", unit: "cm", type: "number" },
          { id: "creatinine", label: "Serum creatinine", unit: "mg/dL", type: "number" },
          { id: "k", label: "Schwartz constant", type: "select", options: [["0.413", "0.413 bedside Schwartz"], ["0.55", "0.55"], ["0.7", "0.70"]] },
        ],
        compute: v => [round((v.k * v.height) / v.creatinine, 0), "mL/min/1.73m²", "Schwartz eGFR = k x height / SCr"],
      };
    } else if (titleNorm.includes("fractional excretion of urate")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "uurate", label: "Urine urate", type: "number" }, { id: "purate", label: "Plasma urate", type: "number" },
          { id: "ucr", label: "Urine creatinine", type: "number" }, { id: "pcr", label: "Plasma creatinine", type: "number" },
        ],
        compute: v => [round(((v.uurate * v.pcr) / (v.purate * v.ucr)) * 100, 2), "%", "FE urate"],
      };
    } else if (titleNorm.includes("transtubular potassium gradient")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "urineK", label: "Urine potassium", type: "number" }, { id: "serumK", label: "Serum potassium", type: "number" },
          { id: "urineOsm", label: "Urine osmolality", type: "number" }, { id: "serumOsm", label: "Serum osmolality", type: "number" },
        ],
        compute: v => [round((v.urineK / v.serumK) / (v.urineOsm / v.serumOsm), 1), "", "TTKG"],
      };
    } else if (titleNorm.includes("henderson")) {
      def = {
        name: title, desc: description,
        fields: [{ id: "bicarb", label: "Bicarbonate", unit: "mEq/L", type: "number" }, { id: "pco2", label: "pCO2", unit: "mmHg", type: "number" }],
        compute: v => [round(6.1 + Math.log10(v.bicarb / (0.03 * v.pco2)), 2), "pH", "Henderson-Hasselbalch"],
      };
    } else if (titleNorm.includes("phenytoin") && titleNorm.includes("free")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "total", label: "Total phenytoin", unit: "mcg/mL", type: "number" },
          { id: "albumin", label: "Albumin", unit: "g/dL", type: "number" },
          { id: "renal", label: "Renal failure/uremia", type: "select", options: [["0", "No"], ["1", "Yes"]] },
        ],
        compute: v => [round(v.total / ((v.renal ? 0.1 : 0.2) * v.albumin + 0.1), 1), "mcg/mL corrected total", "Sheiner-Tozer correction"],
      };
    } else if (titleNorm.includes("protein excretion")) {
      def = {
        name: title, desc: description,
        fields: [{ id: "protein", label: "Urine protein", unit: "mg/dL", type: "number" }, { id: "creatinine", label: "Urine creatinine", unit: "mg/dL", type: "number" }],
        compute: v => [round((v.protein / v.creatinine) * 1000, 0), "mg/g creatinine", "Spot urine protein/creatinine estimate"],
      };
    } else if (titleNorm.includes("temperature")) {
      def = {
        name: title, desc: description,
        fields: [{ id: "value", label: "Temperature", type: "number" }, { id: "direction", label: "Convert", type: "select", options: [["0", "C to F"], ["1", "F to C"]] }],
        compute: v => v.direction === 0 ? [round((v.value * 9) / 5 + 32, 1), "°F"] : [round(((v.value - 32) * 5) / 9, 1), "°C"],
      };
    } else if (titleNorm === "unit conversions length") {
      def = { name: title, desc: description, fields: [{ id: "cm", label: "Centimeters", unit: "cm", type: "number" }], compute: v => [round(v.cm / 2.54, 2), "inches"] };
    } else if (titleNorm === "unit conversions weight") {
      def = { name: title, desc: description, fields: [{ id: "kg", label: "Kilograms", unit: "kg", type: "number" }], compute: v => [round(v.kg * 2.20462, 2), "lb"] };
    } else if (titleNorm.includes("dose") || titleNorm.includes("infusion") || titleNorm.includes("drip") || titleNorm.includes("dosing") || category.includes("Dosing")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "weight", label: "Weight", unit: "kg", type: "number" },
          { id: "dose", label: "Ordered dose", unit: "mcg/kg/min", type: "number" },
          { id: "concentration", label: "Concentration", unit: "mg/mL", type: "number" },
        ],
        compute: v => [round((v.dose * v.weight * 60) / (v.concentration * 1000), 2), "mL/hr", "Rate for mcg/kg/min order with mg/mL concentration. Adjust units before use."],
      };
    } else if (titleNorm.includes("growth") || titleNorm.includes("percentile") || titleNorm.includes("cdc") || titleNorm.includes("who")) {
      def = {
        name: title, desc: description,
        fields: [
          { id: "age", label: "Age", unit: "months", type: "number" },
          { id: "measurement", label: "Measurement", type: "number" },
          { id: "sex", label: "Sex", type: "select", options: [["0", "Female"], ["1", "Male"]] },
        ],
        compute: v => [String(v.measurement) + " at " + String(v.age) + " months", "", "Growth percentile lookup tables are not embedded; value is captured for note export."],
      };
    } else if (titleNorm.includes("chads2")) {
      def = bySum(title, ["CHF", "Hypertension", "Age >=75", "Diabetes", "Prior stroke/TIA"], "CHADS2 stroke risk score; prior stroke/TIA counts as 2 in the full score.");
    } else if (titleNorm.includes("has bled")) {
      def = bySum(title, ["Hypertension", "Abnormal renal/liver function", "Stroke", "Bleeding", "Labile INR", "Elderly", "Drugs/alcohol"], "Higher scores indicate higher bleeding risk.");
    } else if (liveFields.length) {
      def = {
        name: title, desc: description,
        details: mdcalcDetails(item, description),
        fields: liveFields,
        compute: v => [Object.keys(v).filter(k => v[k] != null).length, "inputs captured", "Live catalog input fields are available; native equation is not implemented yet."],
      };
    } else {
      def = {
        name: title, desc: description,
        fields: [
          { id: "primary", label: "Primary value", type: "number" },
          { id: "secondary", label: "Secondary value", type: "number", value: 0, optional: true },
        ],
        compute: v => [round((v.primary || 0) + (v.secondary || 0), 2), "recorded value", "Lexi payload formula is not decoded; this worksheet captures values and exports a note."],
      };
    }
    def.id = key;
    return [key, def];
  }

  function readLexiFavorites() {
    try {
      return new Set(JSON.parse(localStorage.getItem(lexiFavoriteKey) || "[]"));
    } catch {
      return new Set();
    }
  }

  function writeLexiFavorites(favorites) {
    try {
      localStorage.setItem(lexiFavoriteKey, JSON.stringify([...favorites]));
    } catch {}
  }

  function readShortcutTargets() {
    try {
      const parsed = JSON.parse(localStorage.getItem(shortcutKey) || "null");
      if (Array.isArray(parsed)) {
        return defaultShortcutTargets.map((fallback, i) => {
          const value = parsed[i];
          if (typeof value !== "string" || !value) return fallback;
          return value.includes(":") ? value : "native:" + value;
        });
      }
    } catch {}
    return [...defaultShortcutTargets];
  }

  function writeShortcutTargets(targets) {
    try {
      localStorage.setItem(shortcutKey, JSON.stringify(targets.slice(0, 10)));
    } catch {}
  }

  function targetLabel(target) {
    const [kind, id] = String(target || "").split(":");
    if (kind === "native" && defs[id]) return defs[id].name;
    if (kind === "lexi") {
      const item = lexiCatalog.find(calc => String(calc.id) === String(id));
      return item ? item.title : "Lexi calculator";
    }
    return "Calculator";
  }

  function openTarget(target) {
    const [kind, id] = String(target || "").split(":");
    if (kind === "native" && defs[id]) {
      open(id);
      return;
    }
    if (kind === "lexi") {
      const item = lexiCatalog.find(calc => String(calc.id) === String(id));
      if (item) {
        openLexi(item);
        return;
      }
      if (!lexiLoaded) {
        loadLexiCatalog().then(list => {
          const loadedItem = list.find(calc => String(calc.id) === String(id));
          if (loadedItem) openLexi(loadedItem);
        });
      }
    }
  }

  function calculatorQueryFromHref(href) {
    try {
      const url = new URL(String(href || ""), window.location.origin);
      if (!url.pathname.startsWith("/calculators")) return "";
      return url.searchParams.get("q") || url.searchParams.get("calc") || "";
    } catch {
      return "";
    }
  }

  function catalogIdFromSearchResult(item) {
    const raw = String(item?.id || "");
    if (!raw) return "";
    if (raw.startsWith("lexi-calc:")) return raw.slice("lexi-calc:".length);
    if (/^(mdcalc_|lexi_)/i.test(raw)) return raw;
    return "";
  }

  function nativeIdFromSearchResult(item) {
    const raw = String(item?.id || "");
    const compact = raw.replace(/^native:/, "").replace(/^calculator:/, "").replace(/-/g, "_");
    if (defs[compact]) return compact;
    const fromHref = calculatorQueryFromHref(item?.href || "");
    if (fromHref && defs[fromHref]) return fromHref;
    if (fromHref && defs[fromHref.replace(/-/g, "_")]) return fromHref.replace(/-/g, "_");
    return "";
  }

  function rememberCatalogItem(item) {
    if (!item || item.id == null) return;
    const index = lexiCatalog.findIndex(calc => String(calc.id) === String(item.id));
    if (index >= 0) lexiCatalog[index] = item;
    else lexiCatalog.push(item);
    renderShortcutGrid();
    renderShortcutEditor();
    renderLexiCatalog();
  }

  async function fetchCatalogSearch(query) {
    const q = String(query || "").trim();
    if (!q) return [];
    const urls = [
      "/api/lexi-calc/list?limit=30&q=" + encodeURIComponent(q),
      backendUrl() + "/lexi/calc/list?limit=30&q=" + encodeURIComponent(q),
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        const list = Array.isArray(data.results) ? data.results : [];
        if (list.length) return list;
      } catch {}
    }
    return [];
  }

  async function catalogItemFromSearchResult(item) {
    if (item && (Array.isArray(item.inputs) || item.equationLogicText || item.source === "mdcalc-live")) {
      rememberCatalogItem(item);
      return item;
    }
    const wantedId = catalogIdFromSearchResult(item);
    const title = String(item?.title || calculatorQueryFromHref(item?.href || "") || "").trim();
    const titleNorm = norm(title);
    if (wantedId) {
      const cached = lexiCatalog.find(calc => String(calc.id) === wantedId);
      if (cached) return cached;
    }
    if (titleNorm) {
      const cached = lexiCatalog.find(calc => norm(calc.title) === titleNorm);
      if (cached) return cached;
    }
    const fetched = await fetchCatalogSearch(title || wantedId);
    const found = fetched.find(calc => wantedId && String(calc.id) === wantedId)
      || fetched.find(calc => titleNorm && norm(calc.title) === titleNorm)
      || fetched[0];
    if (found) {
      rememberCatalogItem(found);
      return found;
    }
    if (!lexiLoaded && (wantedId || titleNorm)) {
      const list = await loadLexiCatalog();
      return list.find(calc => wantedId && String(calc.id) === wantedId)
        || list.find(calc => titleNorm && norm(calc.title) === titleNorm)
        || null;
    }
    return null;
  }

  async function openSearchResult(item) {
    const nativeId = nativeIdFromSearchResult(item);
    if (nativeId) {
      open(nativeId);
      return true;
    }
    const catalogItem = await catalogItemFromSearchResult(item);
    if (catalogItem) {
      openLexi(catalogItem);
      return true;
    }
    const queryTitle = String(item?.title || calculatorQueryFromHref(item?.href || "") || "").trim();
    const aliasNative = queryTitle ? nativeForLexi({ title: queryTitle, subtitle: item?.subtitle || "", categories: [] }) : "";
    if (aliasNative && defs[aliasNative]) {
      open(aliasNative);
      return true;
    }
    return false;
  }

  function publishCalcApi() {
    window.medosCalc = {
      openTarget,
      openSearchResult,
      readShortcutTargets,
      targetLabel,
      refreshShortcuts: () => {
        renderShortcutGrid();
        renderShortcutEditor();
      },
    };
    window.dispatchEvent(new CustomEvent("medos:calc-runtime-ready"));
  }

  function selectedText() {
    const selection = window.getSelection ? String(window.getSelection()) : "";
    return selection.replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function navigateTo(href, title) {
    window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href, title } }));
  }

  function toggleCalcLauncher() {
    document.getElementById("medos-calc-launcher")?.remove();
  }

  function closeUtilityWindow(id) {
    const panel = document.getElementById(id);
    if (panel) panel.remove();
  }

  function makeUtilityWindow(id, title, bodyHtml, wide) {
    closeUtilityWindow(id);
    const panel = document.createElement("section");
    panel.id = id;
    panel.className = "mcalc-utility-window" + (wide ? " is-wide" : "");
    panel.innerHTML = `
      <div class="mcalc-titlebar">
        <strong>${escapeHtml(title)}</strong>
        <button type="button" data-mcalc-util-min title="Minimize">_</button>
        <button type="button" data-mcalc-util-close title="Close">×</button>
      </div>
      <div class="mcalc-utility-body">${bodyHtml}</div>`;
    document.body.appendChild(panel);
    panel.querySelector("[data-mcalc-util-close]").onclick = () => panel.remove();
    panel.querySelector("[data-mcalc-util-min]").onclick = () => panel.classList.toggle("is-min");
    return panel;
  }

  function commandButton(label, combo, action) {
    return `<button type="button" data-mcalc-command="${escapeHtml(label)}"><span>${escapeHtml(label)}</span><kbd>${escapeHtml(combo)}</kbd></button>`;
  }

  function openCommandCenter() {
    const panel = makeUtilityWindow("medos-command-center", "Command center", `
      <div class="mcalc-command-search">
        <input data-mcalc-command-query type="search" placeholder="Search MedOS, or type a topic">
        <button type="button" data-mcalc-command-search>Search</button>
      </div>
      <div class="mcalc-command-grid">
        ${appCommands.map(c => commandButton(c.label, c.combo, c.key)).join("")}
      </div>`, true);
    const input = panel.querySelector("[data-mcalc-command-query]");
    const runSearch = () => openGlobalSearch(input.value.trim() || selectedText());
    input.focus();
    panel.querySelector("[data-mcalc-command-search]").onclick = runSearch;
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") runSearch();
      if (event.key === "Escape") panel.remove();
    });
    panel.querySelectorAll("[data-mcalc-command]").forEach((button, index) => {
      button.addEventListener("click", () => appCommands[index]?.action());
    });
  }

  function openShortcutHelp() {
    makeUtilityWindow("medos-shortcut-help", "MedOS shortcuts", `
      <div class="mcalc-help-grid">
        ${appCommands.map(c => `<div><kbd>${escapeHtml(c.combo)}</kbd><span>${escapeHtml(c.label)}</span></div>`).join("")}
        <div><kbd>Ctrl+Alt+1..0</kbd><span>Open one of the 10 calculator shortcut slots</span></div>
        <div><kbd>Alt+Shift+1..0</kbd><span>Alternate calculator shortcut combo</span></div>
      </div>`, false);
  }

  async function fetchGlobalSearch(q) {
    const params = new URLSearchParams({ q, scopes: "all", grouped: "false", limit: "18" });
    let res = await fetch(backendUrl() + "/search?" + params.toString(), { cache: "no-store" });
    if (!res.ok && window.location.hostname !== "127.0.0.1") {
      res = await fetch("http://127.0.0.1:8002/search?" + params.toString(), { cache: "no-store" });
    }
    if (!res.ok) throw new Error("search failed");
    return res.json();
  }

  function resultHref(item) {
    return item && item.href ? String(item.href) : "";
  }

  function renderSearchResults(panel, data) {
    const list = panel.querySelector("[data-mcalc-global-results]");
    const status = panel.querySelector("[data-mcalc-global-status]");
    const results = Array.isArray(data?.results) ? data.results : [];
    status.textContent = results.length ? `${results.length} results` : "No results";
    list.innerHTML = results.map((item, index) => `
      <button type="button" data-mcalc-global-result="${index}">
        <strong>${escapeHtml(item.title || "Untitled")}</strong>
        <small>${escapeHtml(item.subtitle || item.scope || item.kind || "")}</small>
      </button>`).join("");
    list.querySelectorAll("[data-mcalc-global-result]").forEach((button, index) => {
      button.addEventListener("click", () => {
        const href = resultHref(results[index]);
        if (href) navigateTo(href, results[index].title);
        panel.remove();
      });
    });
  }

  function openGlobalSearch(initial) {
    const panel = makeUtilityWindow("medos-global-search", "Global search", `
      <div class="mcalc-command-search">
        <input data-mcalc-global-query type="search" placeholder="Search UpToDate, AMBOSS, books, Q-Bank, calculators">
        <button type="button" data-mcalc-global-run>Search</button>
      </div>
      <div data-mcalc-global-status class="mcalc-global-status">Type a term and press Enter</div>
      <div data-mcalc-global-results class="mcalc-global-results"></div>`, true);
    const input = panel.querySelector("[data-mcalc-global-query]");
    const run = async () => {
      const q = input.value.trim();
      if (!q) return;
      panel.querySelector("[data-mcalc-global-status]").textContent = "Searching...";
      try {
        renderSearchResults(panel, await fetchGlobalSearch(q));
      } catch {
        panel.querySelector("[data-mcalc-global-status]").textContent = "Search backend unavailable";
      }
    };
    input.value = initial || "";
    panel.querySelector("[data-mcalc-global-run]").onclick = run;
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") run();
      if (event.key === "Escape") panel.remove();
    });
    input.focus();
    input.select();
    if (input.value.trim()) run();
  }

  function openLabsWindow() {
    const panel = makeUtilityWindow("medos-labs-window", "Labs reference", `
      <div class="mcalc-labs-toolbar">
        <input data-mcalc-labs-search type="search" placeholder="Filter labs">
        <button type="button" data-mcalc-labs-copy>Copy visible</button>
      </div>
      <div class="mcalc-lab-groups">
        ${labGroups.map((group, groupIndex) => `
          <details class="mcalc-lab-group" open>
            <summary><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.subtitle)}</small></summary>
            <div>
              ${group.items.map(([name, range], itemIndex) => `
                <button type="button" data-lab-row="${groupIndex}:${itemIndex}" data-lab-text="${escapeHtml((name + " " + range).toLowerCase())}">
                  <span>${escapeHtml(name)}</span><b>${escapeHtml(range)}</b>
                </button>`).join("")}
            </div>
          </details>`).join("")}
      </div>`, true);
    const input = panel.querySelector("[data-mcalc-labs-search]");
    const filter = () => {
      const q = norm(input.value);
      panel.querySelectorAll("[data-lab-row]").forEach(row => {
        const text = norm(row.getAttribute("data-lab-text") || "");
        row.style.display = !q || q.split(" ").every(token => text.includes(token)) ? "" : "none";
      });
    };
    input.addEventListener("input", filter);
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") panel.remove();
    });
    panel.querySelector("[data-mcalc-labs-copy]").onclick = () => {
      const visible = [...panel.querySelectorAll("[data-lab-row]")]
        .filter(row => row.style.display !== "none")
        .map(row => `${row.querySelector("span")?.textContent}: ${row.querySelector("b")?.textContent}`)
        .join("\n");
      navigator.clipboard?.writeText(visible);
    };
    input.focus();
  }

  function appCommandFromEvent(event) {
    return null;
  }

  function isEditableTarget(target) {
    const el = target && target.nodeType === 1 ? target : null;
    if (!el) return false;
    const tag = String(el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable || !!el.closest("[contenteditable='true']");
  }

  let pendingSequence = "";
  let pendingSequenceTimer = 0;

  function clearPendingSequence() {
    pendingSequence = "";
    if (pendingSequenceTimer) window.clearTimeout(pendingSequenceTimer);
    pendingSequenceTimer = 0;
  }

  function runShortcutAction(event, action) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    action();
  }

  function handleSequenceShortcut(event) {
    return false;
  }

  function shortcutIndexFromEvent(event) {
    const hasShortcutModifier = event.altKey && (event.ctrlKey || event.shiftKey || event.metaKey);
    if (!hasShortcutModifier) return -1;

    let digit = "";
    if (/^Digit[0-9]$/.test(event.code || "")) digit = event.code.slice(5);
    else if (/^Numpad[0-9]$/.test(event.code || "")) digit = event.code.slice(6);
    else if (/^[0-9]$/.test(event.key || "")) digit = event.key;
    else digit = shiftedDigitKeys[event.key] || "";

    if (!digit) return -1;
    const index = digit === "0" ? 9 : Number(digit) - 1;
    return index >= 0 && index < 10 ? index : -1;
  }

  function handleGlobalShortcut(event) {
    if (event.repeat) return;
    if (handleSequenceShortcut(event)) return;
    const command = appCommandFromEvent(event);
    if (command) {
      runShortcutAction(event, command.action);
      return;
    }
    const index = shortcutIndexFromEvent(event);
    if (index < 0) return;
    runShortcutAction(event, () => openTarget(readShortcutTargets()[index] || defaultShortcutTargets[index]));
  }

  async function loadLexiCatalog() {
    if (lexiLoaded) return lexiCatalog;
    const status = document.querySelector("[data-mcalc-lexi-status]");
    if (status) status.textContent = "Loading Lexi calculators...";
    try {
      let res = await fetch("/api/lexi-calc/list?limit=1500", { cache: "no-store" });
      if (!res.ok) res = await fetch(backendUrl() + "/lexi/calc/list?limit=1000", { cache: "no-store" });
      const data = await res.json();
      lexiCatalog = Array.isArray(data.results) ? data.results : [];
    } catch {
      lexiCatalog = [];
    }
    lexiLoaded = true;
    renderShortcutGrid();
    renderShortcutEditor();
    renderLexiCatalog();
    const active = readState();
    if (active && active.kind === "lexi") restoreLexi(active);
    return lexiCatalog;
  }

  function renderFields(def, initialValues, initialUnits) {
    return def.fields.map(f => {
      const unitOptions = unitOptionsForField(f);
      const label = escapeHtml(f.label + (!unitOptions.length && f.unit ? " (" + f.unit + ")" : ""));
      const hint = f.hint ? `<small>${escapeHtml(f.hint)}</small>` : "";
      const current = initialValues && initialValues[f.id] != null ? initialValues[f.id] : (f.value || "");
      if (f.type === "select") {
        return `<label class="mcalc-field" data-calc-wrap="${f.id}"><span>${label}</span>${hint}<select data-calc-field="${f.id}">${f.options.map(o => `<option value="${o[0]}"${String(current) === String(o[0]) ? " selected" : ""}>${escapeHtml(o[1])}</option>`).join("")}</select></label>`;
      }
      const unitValue = initialUnits && initialUnits[f.id] ? initialUnits[f.id] : unitOptions[0]?.[0];
      const unitSelect = unitOptions.length
        ? `<select data-calc-unit="${f.id}">${unitOptions.map(o => `<option value="${escapeHtml(o[0])}" data-factor="${o[2]}"${String(unitValue) === String(o[0]) ? " selected" : ""}>${escapeHtml(o[1])}</option>`).join("")}</select>`
        : "";
      return `<label class="mcalc-field" data-calc-wrap="${f.id}"><span>${label}</span>${hint}<div class="${unitOptions.length ? "mcalc-unit-row" : ""}"><input data-calc-field="${f.id}" type="number" step="any" value="${escapeHtml(current)}" placeholder="${escapeHtml(fieldPlaceholder(f))}">${unitSelect}</div></label>`;
    }).join("");
  }

  function renderCalcDetails(def) {
    const details = def.details || {};
    const when = cleanText(details.when || def.desc || def.name || "Clinical decision support calculator.");
    const pitfalls = Array.isArray(details.pitfalls) && details.pitfalls.length
      ? details.pitfalls
      : ["Confirm units, timing, and patient population before acting.", "Decision support only; use local clinical protocol."];
    const why = cleanText(details.why);
    const bands = Array.isArray(def.bands) && def.bands.length
      ? def.bands.map(([min, max, label]) => `${min == null ? "<" : min}${max == null ? "+" : "-" + max}: ${label}`).join("; ")
      : "Interpret with the clinical context, trend, and local protocol.";
    return `<div class="mcalc-details" data-mcalc-details>
      <div class="mcalc-detail-tabs">
        <button type="button" class="is-active" data-mcalc-detail-tab="when">When</button>
        <button type="button" data-mcalc-detail-tab="pitfalls">Pitfalls</button>
        <button type="button" data-mcalc-detail-tab="why">Why</button>
      </div>
      <div class="mcalc-detail-panel is-active" data-mcalc-detail-panel="when">${escapeHtml(when)}</div>
      <div class="mcalc-detail-panel" data-mcalc-detail-panel="pitfalls"><ul>${pitfalls.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
      <div class="mcalc-detail-panel" data-mcalc-detail-panel="why">${escapeHtml(why || bands)}</div>
    </div>`;
  }

  function open(id, options) {
    const def = defs[id];
    if (!def) return;
    const restored = options && options.state ? options.state : {};
    let panel = document.getElementById("medos-calc-compose");
    if (panel) panel.remove();
    panel = document.createElement("section");
    panel.id = "medos-calc-compose";
    panel.className = "mcalc-window";
    panel.innerHTML = `
      <div class="mcalc-titlebar">
        <strong>${escapeHtml(def.name)}</strong>
        <button type="button" data-mcalc-min title="Minimize">_</button>
        <button type="button" data-mcalc-max title="Expand">□</button>
        <button type="button" data-mcalc-close title="Close">×</button>
      </div>
      <div class="mcalc-body">
        <p>${escapeHtml(def.desc || "")}</p>
        ${renderCalcDetails(def)}
        ${renderFields(def, restored.values || {}, restored.units || {})}
        <div class="mcalc-result"><span data-mcalc-value>Enter values</span><small data-mcalc-unit></small><em data-mcalc-note></em><button type="button" data-mcalc-copy>Copy note</button></div>
      </div>`;
    document.body.appendChild(panel);
    if (restored.min) panel.classList.add("is-min");
    if (restored.max) panel.classList.add("is-max");
    update(panel, def);
    writeState(id, panel);
    panel.querySelectorAll("[data-calc-field],[data-calc-unit]").forEach(el => {
      const handle = () => {
        update(panel, def);
        writeState(id, panel);
      };
      el.addEventListener("input", handle);
      el.addEventListener("change", handle);
    });
    panel.querySelectorAll("[data-mcalc-detail-tab]").forEach(tab => {
      tab.addEventListener("click", () => {
        const target = tab.getAttribute("data-mcalc-detail-tab");
        panel.querySelectorAll("[data-mcalc-detail-tab]").forEach(item => item.classList.toggle("is-active", item === tab));
        panel.querySelectorAll("[data-mcalc-detail-panel]").forEach(item => item.classList.toggle("is-active", item.getAttribute("data-mcalc-detail-panel") === target));
      });
    });
    panel.querySelector("[data-mcalc-close]").onclick = () => {
      panel.remove();
      clearState();
    };
    panel.querySelector("[data-mcalc-min]").onclick = () => {
      panel.classList.toggle("is-min");
      writeState(id, panel);
    };
    panel.querySelector("[data-mcalc-max]").onclick = () => {
      panel.classList.toggle("is-max");
      writeState(id, panel);
    };
    panel.querySelector("[data-mcalc-copy]").onclick = () => copyNativeNote(panel, def);
  }

  function openLexi(item, options) {
    const preferLiveMdCalc = item.source === "mdcalc-live" && item.equationLogicText;
    const nativeId = preferLiveMdCalc ? "" : nativeForLexi(item);
    if (nativeId && defs[nativeId]) {
      open(nativeId, options);
      return;
    }
    const [id, def] = lexiTemplateFor(item);
    defs[id] = def;
    open(id, options);
  }

  function writeLexiState(item, panel) {
    try {
      sessionStorage.setItem(stateKey, JSON.stringify({
        kind: "lexi",
        id: item.id,
        title: item.title,
        category: item.category,
        categories: item.categories || [],
        subtitle: item.subtitle || "",
        min: panel.classList.contains("is-min"),
        max: panel.classList.contains("is-max"),
      }));
    } catch {}
  }

  function restoreLexi(active) {
    const item = lexiCatalog.find(calc => String(calc.id) === String(active.id)) || active;
    openLexi(item, { state: active });
  }

  function rawValues(panel) {
    const out = {};
    panel.querySelectorAll("[data-calc-field]").forEach(el => {
      out[el.dataset.calcField] = el.value === "" ? null : Number(el.value);
    });
    return out;
  }

  function selectedUnits(panel) {
    const out = {};
    panel.querySelectorAll("[data-calc-unit]").forEach(el => {
      out[el.dataset.calcUnit] = el.value;
    });
    return out;
  }

  function update(panel, def) {
    const v = values(panel);
    def.fields.forEach(field => {
      const visible = fieldVisibleRuntime(field, def, v);
      const wrap = panel.querySelector(`[data-calc-wrap="${field.id}"]`);
      if (wrap) wrap.style.display = visible ? "" : "none";
      if (!visible) v[field.id] = 0;
    });
    const needed = def.fields.filter(f => fieldVisibleRuntime(f, def, v) && f.type !== "select" && !f.optional).every(f => Number.isFinite(v[f.id]) && v[f.id] > 0);
    if (!needed) return;
    try {
      const [value, unit, note] = def.compute(v);
      panel.querySelector("[data-mcalc-value]").textContent = value;
      panel.querySelector("[data-mcalc-unit]").textContent = unit || "";
      const interpretation = interpretationFor(def, value);
      panel.querySelector("[data-mcalc-note]").textContent = [note, interpretation].filter(Boolean).join(" · ");
    } catch {}
  }

  function fieldNoteValue(def, field, value) {
    if (value == null || value === "" || !Number.isFinite(Number(value))) return "not entered";
    if (field.type === "select") {
      const option = (field.options || []).find(o => Number(o[0]) === Number(value));
      return option ? option[1] : String(value);
    }
    return String(value) + (field.unit ? " " + field.unit : "");
  }

  function nativeNoteText(panel, def) {
    const v = rawValues(panel);
    const converted = values(panel);
    const units = selectedUnits(panel);
    const value = panel.querySelector("[data-mcalc-value]").textContent.trim();
    const unit = panel.querySelector("[data-mcalc-unit]").textContent.trim();
    const note = panel.querySelector("[data-mcalc-note]").textContent.trim();
    const lines = [
      def.name,
      "Used for: " + (def.desc || def.name),
      ...def.fields.map(field => {
        const unitOptions = unitOptionsForField(field);
        if (field.type === "number" && unitOptions.length && v[field.id] != null) {
          const selected = unitOptions.find(o => o[0] === units[field.id]) || unitOptions[0];
          const base = field.unit && selected[0] !== field.unit ? " (" + compactNumber(converted[field.id]) + " " + field.unit + ")" : "";
          return field.label + ": " + v[field.id] + " " + selected[1] + base;
        }
        return field.label + ": " + fieldNoteValue(def, field, v[field.id]);
      }),
      "Result: " + [value, unit].filter(Boolean).join(" "),
    ];
    if (note) lines.push("Interpretation: " + note);
    return lines.join("\n");
  }

  async function copyNativeNote(panel, def) {
    const needed = def.fields.filter(f => f.type !== "select" && !f.optional).every(f => {
      const el = panel.querySelector(`[data-calc-field="${f.id}"]`);
      return el && el.value !== "";
    });
    if (!needed) return;
    await copyText(nativeNoteText(panel, def));
    const button = panel.querySelector("[data-mcalc-copy]");
    if (!button) return;
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = "Copy note"; }, 1200);
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
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

  function interpretationFor(def, value) {
    const numeric = Number(value);
    if (!def.bands || !Number.isFinite(numeric)) return "";
    const band = def.bands.find(([min, max]) => (min == null || numeric >= min) && (max == null || numeric < max));
    return band ? band[2] : "";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function createLauncher() {
    if (document.getElementById("medos-calc-launcher")) return;
    const launcher = document.createElement("aside");
    launcher.id = "medos-calc-launcher";
    launcher.className = "mcalc-launcher";
    launcher.innerHTML = `
      <button type="button" class="mcalc-launcher-main" title="Clinical calculators">Calc</button>
      <div class="mcalc-launcher-menu" aria-label="Calculator shortcuts">
        <div class="mcalc-shortcut-grid" data-mcalc-shortcuts></div>
        <details class="mcalc-shortcut-editor">
          <summary>Customize shortcuts</summary>
          <div data-mcalc-shortcut-editor></div>
        </details>
        <div class="mcalc-lexi-browser">
          <input data-mcalc-lexi-search type="search" placeholder="Search all Lexi calculators">
          <div data-mcalc-lexi-status>Loading Lexi calculators...</div>
          <div data-mcalc-lexi-list></div>
        </div>
      </div>`;
    document.body.appendChild(launcher);
    launcher.querySelector(".mcalc-launcher-main").addEventListener("click", () => launcher.classList.toggle("is-open"));
    launcher.querySelector("[data-mcalc-lexi-search]").addEventListener("input", renderLexiCatalog);
    launcher.querySelector("[data-mcalc-shortcut-editor]").addEventListener("change", event => {
      const select = event.target.closest("[data-mcalc-shortcut-select]");
      if (!select) return;
      const index = Number(select.getAttribute("data-mcalc-shortcut-select"));
      const targets = readShortcutTargets();
      targets[index] = select.value;
      writeShortcutTargets(targets);
      renderShortcutGrid();
      window.dispatchEvent(new CustomEvent("medos:calc-shortcuts-changed"));
    });
    renderShortcutGrid();
    renderShortcutEditor();
    loadLexiCatalog();
  }

  function renderShortcutGrid() {
    const grid = document.querySelector("[data-mcalc-shortcuts]");
    if (!grid) return;
    const targets = readShortcutTargets();
    grid.innerHTML = shortcuts.map(([key], i) => {
      const target = targets[i] || defaultShortcutTargets[i];
      return `<button type="button" data-mcalc-shortcut="${i}" title="Ctrl+Alt+${key} or Alt+Shift+${key}">${key}<span>${escapeHtml(targetLabel(target))}</span></button>`;
    }).join("");
  }

  function renderShortcutEditor() {
    const editor = document.querySelector("[data-mcalc-shortcut-editor]");
    if (!editor) return;
    const targets = readShortcutTargets();
    const favorites = readLexiFavorites();
    const nativeOptions = Object.keys(defs)
      .sort((a, b) => defs[a].name.localeCompare(defs[b].name))
      .map(id => `<option value="native:${escapeHtml(id)}">${escapeHtml(defs[id].name)}</option>`)
      .join("");
    const lexiOptions = lexiCatalog
      .slice()
      .sort((a, b) => {
        const af = favorites.has(String(a.id)) ? 0 : 1;
        const bf = favorites.has(String(b.id)) ? 0 : 1;
        return af - bf || String(a.title).localeCompare(String(b.title));
      })
      .map(item => `<option value="lexi:${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`)
      .join("");

    editor.innerHTML = shortcuts.map(([key], i) => {
      const target = targets[i] || defaultShortcutTargets[i];
      return `<label><span>${key}</span><select data-mcalc-shortcut-select="${i}">
        <optgroup label="Native calculators">${nativeOptions}</optgroup>
        <optgroup label="Lexi database">${lexiOptions}</optgroup>
      </select></label>`;
    }).join("");
    editor.querySelectorAll("[data-mcalc-shortcut-select]").forEach((select, i) => {
      select.value = targets[i] || defaultShortcutTargets[i];
    });
  }

  function renderLexiCatalog() {
    const list = document.querySelector("[data-mcalc-lexi-list]");
    const status = document.querySelector("[data-mcalc-lexi-status]");
    const input = document.querySelector("[data-mcalc-lexi-search]");
    if (!list || !status) return;

    const q = norm(input ? input.value : "");
    const favorites = readLexiFavorites();
    const filtered = lexiCatalog
      .filter(item => {
        if (!q) return true;
        const text = norm([item.title, item.subtitle, ...(item.categories || [])].join(" "));
        return q.split(" ").every(token => text.includes(token));
      })
      .sort((a, b) => {
        const af = favorites.has(String(a.id)) ? 0 : 1;
        const bf = favorites.has(String(b.id)) ? 0 : 1;
        return af - bf || String(a.title).localeCompare(String(b.title));
      });

    status.textContent = lexiLoaded
      ? filtered.length + " of " + lexiCatalog.length + " Lexi calculators"
      : "Loading Lexi calculators...";
    list.innerHTML = filtered.map(item => {
      const nativeId = nativeForLexi(item);
      const fav = favorites.has(String(item.id));
      return `<div class="mcalc-lexi-row">
        <button type="button" data-medos-lexi-calc="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(nativeId ? "Native calculator available" : (item.subtitle || item.category || "Lexi calculator"))}</small>
        </button>
        <button type="button" class="mcalc-lexi-star${fav ? " is-fav" : ""}" data-mcalc-lexi-fav="${escapeHtml(item.id)}" title="${fav ? "Remove favorite" : "Add favorite"}">★</button>
      </div>`;
    }).join("");
  }

  function applyPageFilters() {
    const category = document.querySelector("[data-mcalc-page-category]");
    const search = document.querySelector("[data-mcalc-page-search]");
    const cards = document.querySelectorAll("[data-mcalc-page-card]");
    if (!category || !cards.length) return;

    const selected = category.value || "All";
    const q = norm(search ? search.value : "");
    cards.forEach(card => {
      const cardCategory = card.getAttribute("data-mcalc-page-category-value") || "";
      const text = norm(card.getAttribute("data-mcalc-page-search-text") || card.textContent || "");
      const categoryMatch = selected === "All" || cardCategory.split("|||").includes(selected);
      const searchMatch = !q || q.split(" ").every(token => text.includes(token));
      card.style.display = categoryMatch && searchMatch ? "" : "none";
    });
  }

  document.addEventListener("click", event => {
    if (event.target.closest("[data-medos-favorite-button]")) return;

    const shortcutTarget = event.target.closest("[data-mcalc-shortcut]");
    if (shortcutTarget) {
      const index = Number(shortcutTarget.getAttribute("data-mcalc-shortcut"));
      const target = readShortcutTargets()[index] || defaultShortcutTargets[index];
      openTarget(target);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const lexiFav = event.target.closest("[data-mcalc-lexi-fav]");
    if (lexiFav) {
      const id = String(lexiFav.getAttribute("data-mcalc-lexi-fav"));
      const favorites = readLexiFavorites();
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      writeLexiFavorites(favorites);
      renderLexiCatalog();
      renderShortcutEditor();
      window.dispatchEvent(new CustomEvent("medos:calc-favorites-changed"));
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const lexiTarget = event.target.closest("[data-medos-lexi-calc]");
    if (lexiTarget) {
      const id = String(lexiTarget.getAttribute("data-medos-lexi-calc"));
      const item = lexiCatalog.find(calc => String(calc.id) === id) || {
        id,
        title: lexiTarget.getAttribute("data-medos-lexi-title") || "Lexi calculator",
        subtitle: lexiTarget.getAttribute("data-medos-lexi-subtitle") || "Lexi calculator",
        category: lexiTarget.getAttribute("data-medos-lexi-category") || "Lexi calculator",
        description: lexiTarget.getAttribute("data-medos-lexi-description") || "",
        categories: [],
      };
      openLexi(item);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const target = event.target.closest("[data-medos-calc]");
    if (!target) return;
    const id = target.getAttribute("data-medos-calc");
    if (!defs[id]) return;
    event.preventDefault();
    event.stopPropagation();
    open(id);
  }, { capture: true, signal: runtimeSignal });

  document.addEventListener("input", event => {
    if (event.target.closest("[data-mcalc-page-search]")) applyPageFilters();
  }, { capture: true, signal: runtimeSignal });

  document.addEventListener("change", event => {
    if (event.target.closest("[data-mcalc-page-category]")) applyPageFilters();
  }, { capture: true, signal: runtimeSignal });

  window.addEventListener("keydown", handleGlobalShortcut, { capture: true, signal: runtimeSignal });

  window.addEventListener("medos:calc-shortcuts-changed", () => {
    renderShortcutGrid();
    renderShortcutEditor();
  }, { signal: runtimeSignal });

  window.addEventListener("medos:calc-favorites-changed", () => {
    renderLexiCatalog();
    renderShortcutEditor();
  }, { signal: runtimeSignal });

  window.addEventListener("medos:open-calculator-result", event => {
    openSearchResult(event.detail || {});
  }, { signal: runtimeSignal });

  function boot() {
    document.getElementById("medos-calc-launcher")?.remove();
    publishCalcApi();
    applyPageFilters();
    const active = readState();
    if (active && active.kind === "lexi") loadLexiCatalog();
    else if (active && defs[active.id]) open(active.id, { state: active });
  }

  const style = document.createElement("style");
  style.textContent = `
    .mcalc-window{position:fixed;right:84px;bottom:18px;z-index:9999;width:min(460px,calc(100vw - 120px));max-height:calc(100vh - 64px);background:var(--bg-base,#f8fafc);border:1px solid var(--border,#d8dee8);border-radius:10px;box-shadow:0 24px 70px rgba(15,23,42,.28);overflow:hidden;font-family:inherit}
    .mcalc-window.is-max{right:84px;bottom:18px;width:min(920px,calc(100vw - 120px));height:min(760px,calc(100vh - 58px));border-radius:10px}
    .mcalc-titlebar{height:44px;background:var(--text-primary,#172033);color:var(--bg-base,#fff);display:flex;align-items:center;gap:8px;padding:0 12px}
    .mcalc-titlebar strong{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
    .mcalc-titlebar button{width:28px;height:28px;border:0;background:transparent;color:inherit;border-radius:6px;cursor:pointer;font-size:16px}
    .mcalc-titlebar button:hover{background:rgba(255,255,255,.12)}
    .mcalc-body{padding:12px 14px;overflow:auto;max-height:calc(100vh - 112px)}
    .mcalc-window.is-min{width:min(360px,calc(100vw - 92px));height:42px}
    .mcalc-window.is-min .mcalc-body{display:none}
    .mcalc-field{display:block;margin:0 0 12px}
    .mcalc-field span{display:block;font-size:13px;color:var(--text-primary,#172033);font-weight:800;line-height:1.35;margin-bottom:4px}
    .mcalc-field small{display:block;font-size:12px;color:var(--text-muted,#667085);font-style:italic;line-height:1.4;margin:0 0 6px}
    .mcalc-field input,.mcalc-field select{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--bg-card,#fff);font-size:13px}
    .mcalc-unit-row{display:grid;grid-template-columns:minmax(0,1fr) 104px;gap:8px}
    .mcalc-field input::placeholder{color:rgba(100,116,139,.42)}
    .mcalc-details{margin:0 0 12px;border:1px solid var(--border,#d8dee8);border-radius:8px;background:var(--bg-card,#fff);font-size:12px;color:var(--text-muted,#667085);overflow:hidden}
    .mcalc-detail-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--border,#d8dee8)}
    .mcalc-detail-tabs button{height:34px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--text-muted,#667085);font-size:11px;font-weight:800;cursor:pointer}
    .mcalc-detail-tabs button.is-active{border-bottom-color:var(--accent,#3282e3);background:rgba(59,130,246,.06);color:var(--text-primary,#172033)}
    .mcalc-detail-panel{display:none;padding:10px 12px;line-height:1.45}
    .mcalc-detail-panel.is-active{display:block}
    .mcalc-detail-panel ul{margin:0;padding-left:17px}
    .mcalc-result{margin-top:14px;padding:14px 16px;border:1px solid var(--border,#d8dee8);border-radius:8px;background:var(--bg-card,#fff)}
    .mcalc-result span{font-size:28px;font-weight:800;color:var(--text-primary,#172033)}
    .mcalc-result small{margin-left:8px;color:var(--text-secondary,#48566a)}
    .mcalc-result em{display:block;margin-top:6px;font-size:12px;color:var(--text-muted,#667085);font-style:normal}
    .mcalc-result button{margin-top:12px;padding:7px 10px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--bg-card,#fff);color:var(--text-secondary,#48566a);font-size:12px;font-weight:700;cursor:pointer}
    .mcalc-result button:hover{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.35)}
    .mcalc-launcher{display:none;position:fixed;left:18px;bottom:18px;z-index:9998;font-family:inherit}
    .mcalc-launcher-main{width:42px;height:42px;padding:0;border:1px solid rgba(148,163,184,.55);border-radius:999px;background:rgba(15,23,42,.66);color:var(--bg-base,#fff);font-size:0;font-weight:800;box-shadow:0 14px 34px rgba(15,23,42,.18);cursor:pointer;opacity:.62;backdrop-filter:blur(8px)}
    .mcalc-launcher-main::before{content:'⌘';font-size:18px}
    .mcalc-launcher-menu{position:absolute;left:0;bottom:48px;width:min(520px,calc(100vw - 36px));display:none;gap:8px;padding:8px;border:1px solid var(--border,#d8dee8);border-radius:8px;background:var(--bg-base,#f8fafc);box-shadow:0 18px 46px rgba(15,23,42,.22)}
    .mcalc-launcher:hover .mcalc-launcher-menu,.mcalc-launcher:focus-within .mcalc-launcher-menu,.mcalc-launcher.is-open .mcalc-launcher-menu{display:block}
    .mcalc-shortcut-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-bottom:8px}
    .mcalc-shortcut-grid button{display:flex;align-items:center;gap:7px;min-width:0;padding:7px 8px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--bg-card,#fff);color:var(--text-primary,#172033);font-size:12px;cursor:pointer;text-align:left}
    .mcalc-shortcut-grid button:hover,.mcalc-lexi-row button:hover{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.35)}
    .mcalc-shortcut-grid button::first-letter{font-weight:800}
    .mcalc-shortcut-grid span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mcalc-shortcut-editor{border-top:1px solid var(--border,#d8dee8);padding:7px 0;margin-top:2px}
    .mcalc-shortcut-editor summary{cursor:pointer;font-size:11px;font-weight:800;color:var(--text-secondary,#48566a);list-style:none}
    .mcalc-shortcut-editor summary::-webkit-details-marker{display:none}
    .mcalc-shortcut-editor [data-mcalc-shortcut-editor]{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
    .mcalc-shortcut-editor label{display:grid;grid-template-columns:24px minmax(0,1fr);align-items:center;gap:5px}
    .mcalc-shortcut-editor label span{font-size:11px;font-weight:800;color:var(--text-muted,#667085)}
    .mcalc-shortcut-editor select{min-width:0;width:100%;box-sizing:border-box;padding:6px 7px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--bg-card,#fff);font-size:11px}
    .mcalc-lexi-browser{border-top:1px solid var(--border,#d8dee8);padding-top:8px}
    .mcalc-lexi-browser input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--bg-card,#fff);font-size:12px;margin-bottom:6px}
    .mcalc-lexi-browser [data-mcalc-lexi-status]{font-size:11px;color:var(--text-muted,#667085);margin:0 0 6px}
    .mcalc-lexi-browser [data-mcalc-lexi-list]{max-height:min(360px,calc(100vh - 260px));overflow:auto;display:grid;gap:5px}
    .mcalc-lexi-row{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:5px}
    .mcalc-lexi-row button{min-width:0;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--bg-card,#fff);color:var(--text-primary,#172033);cursor:pointer}
    .mcalc-lexi-row button:first-child{padding:7px 8px;text-align:left}
    .mcalc-lexi-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
    .mcalc-lexi-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--text-muted,#667085);margin-top:2px}
    .mcalc-lexi-star{display:grid;place-items:center;color:var(--text-muted,#667085);font-size:13px}
    .mcalc-lexi-star.is-fav{color:var(--amber,#d97706)}
    .mcalc-lexi-detail h3{font-size:18px;margin:6px 0;color:var(--text-primary,#172033)}
    .mcalc-lexi-detail p{font-size:13px;color:var(--text-secondary,#48566a);line-height:1.45}
    .mcalc-lexi-detail div:not(.mcalc-lexi-kicker){display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
    .mcalc-lexi-detail span{font-size:11px;padding:4px 7px;border:1px solid var(--border,#d8dee8);border-radius:999px;background:var(--bg-card,#fff);color:var(--text-secondary,#48566a)}
    .mcalc-lexi-detail section{margin-top:12px;padding:12px;border:1px solid var(--border,#d8dee8);border-radius:8px;background:var(--bg-card,#fff);font-size:12px;line-height:1.5;color:var(--text-muted,#667085)}
    .mcalc-lexi-kicker{text-transform:uppercase;letter-spacing:.06em;font-size:10px;font-weight:800;color:var(--accent,#2563eb)}
    .mcalc-utility-window{position:fixed;right:24px;bottom:18px;z-index:10000;width:min(560px,calc(100vw - 70px));max-height:calc(100vh - 70px);background:var(--bg-base,#f8fafc);border:1px solid var(--border,#d8dee8);border-radius:10px;box-shadow:0 24px 70px rgba(15,23,42,.28);overflow:hidden;font-family:inherit}
    .mcalc-utility-window.is-wide{width:min(760px,calc(100vw - 70px))}
    .mcalc-utility-window.is-min{height:44px}
    .mcalc-utility-window.is-min .mcalc-utility-body{display:none}
    .mcalc-utility-body{padding:16px 18px;overflow:auto;max-height:calc(100vh - 124px)}
    .mcalc-command-search{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-bottom:12px}
    .mcalc-command-search input,.mcalc-labs-toolbar input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--bg-card,#fff);font-size:13px;color:var(--text-primary,#172033)}
    .mcalc-command-search button,.mcalc-labs-toolbar button{padding:9px 12px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--text-primary,#172033);color:var(--bg-base,#fff);font-size:12px;font-weight:800;cursor:pointer}
    .mcalc-command-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .mcalc-command-grid button,.mcalc-global-results button{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;padding:10px 12px;border:1px solid var(--border,#d8dee8);border-radius:7px;background:var(--bg-card,#fff);color:var(--text-primary,#172033);cursor:pointer;text-align:left}
    .mcalc-command-grid button:hover,.mcalc-global-results button:hover,.mcalc-lab-group button:hover{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.35)}
    .mcalc-command-grid span{font-size:12px;font-weight:700}
    .mcalc-command-grid kbd,.mcalc-help-grid kbd{font-size:10px;color:var(--text-muted,#667085);border:1px solid var(--border,#d8dee8);border-radius:4px;padding:2px 5px;background:var(--bg-base,#f8fafc);white-space:nowrap}
    .mcalc-help-grid{display:grid;gap:8px}
    .mcalc-help-grid div{display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#d8dee8);font-size:12px;color:var(--text-secondary,#48566a)}
    .mcalc-global-status{font-size:11px;color:var(--text-muted,#667085);margin-bottom:8px}
    .mcalc-global-results{display:grid;gap:6px}
    .mcalc-global-results button{display:block}
    .mcalc-global-results strong{display:block;font-size:13px;color:var(--text-primary,#172033);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mcalc-global-results small{display:block;font-size:11px;color:var(--text-muted,#667085);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mcalc-labs-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-bottom:12px}
    .mcalc-lab-groups{display:grid;gap:10px}
    .mcalc-lab-group{border:1px solid var(--border,#d8dee8);border-radius:8px;background:var(--bg-card,#fff);overflow:hidden}
    .mcalc-lab-group summary{cursor:pointer;list-style:none;padding:13px 14px;display:grid;grid-template-columns:minmax(0,1fr) 18px;gap:8px;align-items:center}
    .mcalc-lab-group summary::-webkit-details-marker{display:none}
    .mcalc-lab-group summary::after{content:'›';font-size:24px;line-height:1;color:var(--text-primary,#172033);transform:rotate(90deg)}
    .mcalc-lab-group:not([open]) summary::after{transform:none}
    .mcalc-lab-group summary strong{font-size:15px;color:var(--text-primary,#172033)}
    .mcalc-lab-group summary small{display:block;font-size:12px;color:var(--text-muted,#667085);font-weight:400;margin-top:3px}
    .mcalc-lab-group div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:0 12px 12px}
    .mcalc-lab-group button{display:flex;justify-content:space-between;gap:10px;padding:8px 9px;border:1px solid var(--border,#d8dee8);border-radius:6px;background:var(--bg-base,#f8fafc);cursor:pointer;text-align:left}
    .mcalc-lab-group span{font-size:12px;color:var(--text-primary,#172033);font-weight:700}
    .mcalc-lab-group b{font-size:11px;color:var(--text-secondary,#48566a);font-weight:600;text-align:right}
    @media (max-width:720px){.mcalc-command-grid,.mcalc-lab-group div{grid-template-columns:1fr}.mcalc-utility-window,.mcalc-utility-window.is-wide{right:12px;left:12px;width:auto}.mcalc-help-grid div{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true, signal: runtimeSignal });
  else boot();
})();
