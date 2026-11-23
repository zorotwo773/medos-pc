/**
 * NBME → USMLE 3-digit score prediction.
 *
 * How this works (and its limits): the USMLE reports a 3-digit score on a fixed,
 * equated scale. Each NBME self-assessment ("CBSSA") form has its own difficulty,
 * so the community has fit a per-form linear regression on self-reported
 * (NBME result, real USMLE score) pairs from past test-takers:
 *
 *     predicted 3-digit score = intercept − slope × (number of wrong answers)
 *
 * over ~200 questions. Different forms have different intercepts/slopes because
 * of equating. This is an ESTIMATE — good to roughly ±SCORE_SE points — not an
 * official score. Coefficients below are sourced from published community
 * calculators (nbmescore.com / nbcalc / yousmle) and reconciled across sources.
 *
 * NOTE: this table is refined by the `nbme-score-predictor-research` workflow.
 */

export type UsmleStep = "1" | "2" | "3";

export interface FormCoeff {
  intercept: number;
  slope: number;
  total: number;            // questions the regression was fit on (~200)
  confidence: "high" | "medium" | "low";
}

// Keyed by `${step}-${form}`. Values verified by the nbme-score-predictor-research
// workflow (cross-checked across nbmescore / nbmecalculator / yousmle, adversarial
// verification). Step 1 forms 21/23/24/32/33, Step 2 CK 16, and ALL Step 3 forms
// have no published per-form line → they use the per-step fallback (Step 3 gets %
// only — see summarizeExam — since no valid wrong→3-digit conversion exists).
export const FORM_COEFFS: Record<string, FormCoeff> = {
  // ── Step 1 (forms 25–31) ──
  "1-25": { intercept: 277.04, slope: 1.113, total: 200, confidence: "high" },
  "1-26": { intercept: 277.21, slope: 1.1435, total: 200, confidence: "medium" }, // wide cross-source slope spread
  "1-27": { intercept: 275.17, slope: 1.1125, total: 200, confidence: "high" },
  "1-28": { intercept: 275.67, slope: 1.048, total: 200, confidence: "high" },
  "1-29": { intercept: 272.18, slope: 1.09, total: 200, confidence: "high" },
  "1-30": { intercept: 278.60, slope: 1.15, total: 200, confidence: "low" }, // corrected by verification (was 275)
  "1-31": { intercept: 270.48, slope: 1.08, total: 200, confidence: "high" },
  // ── Step 2 CK (forms 9–15) ──
  "2-9": { intercept: 298.45, slope: 1.09, total: 200, confidence: "high" },
  "2-10": { intercept: 300.18, slope: 1.10, total: 200, confidence: "high" },
  "2-11": { intercept: 299.50, slope: 1.08, total: 200, confidence: "high" },
  "2-12": { intercept: 300.18, slope: 1.09, total: 200, confidence: "high" },
  "2-13": { intercept: 298.80, slope: 1.07, total: 200, confidence: "high" },
  "2-14": { intercept: 299.20, slope: 1.08, total: 200, confidence: "high" },
  "2-15": { intercept: 300.50, slope: 1.10, total: 200, confidence: "high" },
};

// Per-step fallback when a form has no published coefficients (average of the
// step's confirmed forms). Marked low confidence.
export const FALLBACK_COEFF: Record<UsmleStep, FormCoeff> = {
  "1": { intercept: 275.19, slope: 1.1045, total: 200, confidence: "low" },
  "2": { intercept: 299.54, slope: 1.0871, total: 200, confidence: "low" },
  // No real Step 3 wrong→3-digit conversion exists; Step 3 shows % only (gated in summarizeExam).
  "3": { intercept: 299.54, slope: 1.0871, total: 200, confidence: "low" },
};

// National 3-digit score distribution (for the bell curve). Step 1 is pass/fail
// since Jan 2022; 232/19 is the modeled 3-digit-equivalent (2019 cohort anchor).
// Step 2 CK 250/15 is the 2024-25 figure; Step 3 227/15 (2023-25).
export const SCORE_DISTRIBUTION: Record<UsmleStep, { mean: number; sd: number }> = {
  "1": { mean: 232, sd: 19 },
  "2": { mean: 250, sd: 15 },
  "3": { mean: 227, sd: 15 },
};

// ± points the prediction is good to (NBME SEM ≈ 8 points).
export const SCORE_SE = 8;

// Passing 3-digit thresholds (Step 2 CK rose 214→218 on 2025-07-01; Step 3 198→200 on 2024-01-01).
export const PASS_THRESHOLD: Record<UsmleStep, number> = { "1": 196, "2": 218, "3": 200 };

// x-axis buckets for the score-distribution chart.
export const SCORE_BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "≤155", lo: 0, hi: 155 },
  { label: "156–170", lo: 156, hi: 170 },
  { label: "171–185", lo: 171, hi: 185 },
  { label: "186–200", lo: 186, hi: 200 },
  { label: "201–215", lo: 201, hi: 215 },
  { label: "216–230", lo: 216, hi: 230 },
  { label: "231–245", lo: 231, hi: 245 },
  { label: "246–260", lo: 246, hi: 260 },
  { label: "261–275", lo: 261, hi: 275 },
  { label: "≥276", lo: 276, hi: 400 },
];

export interface ScorePrediction {
  score: number;
  low: number;
  high: number;
  confidence: "high" | "medium" | "low";
  hasFormData: boolean;
  step: UsmleStep;
  form: string;
}

function clampScore(n: number) {
  return Math.max(1, Math.min(300, Math.round(n)));
}

/** Parse a bank key like "nbme-1-27" → { step:"1", form:"27" }; null for non-NBME. */
export function parseNbmeKey(db: string): { step: UsmleStep; form: string } | null {
  const m = /^nbme-([123])-(.+)$/.exec(db || "");
  if (!m) return null;
  return { step: m[1] as UsmleStep, form: m[2] };
}

/**
 * Predict the 3-digit score from the number wrong. `total` is the number of
 * questions actually taken; if it differs from the model's total the wrong count
 * is scaled proportionally so partial/!200-question forms still map sensibly.
 */
export function predictNbmeScore(step: UsmleStep, form: string, wrong: number, total: number): ScorePrediction {
  const key = `${step}-${form}`;
  const coeff = FORM_COEFFS[key];
  const c = coeff || FALLBACK_COEFF[step];
  const scaledWrong = c.total && total && total !== c.total ? wrong * (c.total / total) : wrong;
  const score = clampScore(c.intercept - c.slope * scaledWrong);
  return {
    score,
    low: clampScore(score - SCORE_SE),
    high: clampScore(score + SCORE_SE),
    confidence: c.confidence,
    hasFormData: Boolean(coeff),
    step,
    form,
  };
}

/** Normal PDF (unnormalized height is fine for relative bar heights). */
export function normalPdf(x: number, mean: number, sd: number): number {
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}

/** Approx normal CDF (Abramowitz-Stegun) → percentile of a score. */
export function normalCdf(x: number, mean: number, sd: number): number {
  const z = (x - mean) / (sd * Math.SQRT2);
  // erf approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

/** Percentile (0-100) of `score` within the step's national distribution. */
export function scorePercentile(step: UsmleStep, score: number): number {
  const { mean, sd } = SCORE_DISTRIBUTION[step];
  return Math.max(1, Math.min(99, Math.round(normalCdf(score, mean, sd) * 100)));
}

/** Relative bar heights (0-1) per bucket from the step's normal distribution. */
export function distributionBars(step: UsmleStep): number[] {
  const { mean, sd } = SCORE_DISTRIBUTION[step];
  const raw = SCORE_BUCKETS.map(b => {
    const mid = b.lo === 0 ? 150 : b.hi >= 400 ? 281 : (b.lo + b.hi) / 2;
    return normalPdf(mid, mean, sd);
  });
  const max = Math.max(...raw, 1e-9);
  return raw.map(v => v / max);
}
