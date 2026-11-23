import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (...parts) => readFileSync(resolve(root, ...parts), "utf8");
const source = read("components", "qbank", "QuizEngine.tsx");
const ambossHtml = read("components", "amboss", "AmbossHtml.tsx");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// ── No floating/sticky image hover previews — media opens via the click viewer ──
assert(
  !source.includes("showMediaPreview"),
  "QBank should not create image hover previews; images should open through the fullscreen click viewer.",
);

assert(
  !source.includes("mediaPreview"),
  "QBank should not keep floating image preview state or render sticky preview popouts.",
);

// ── Inline media/exhibit opens in the in-app MediaViewer (never a page nav) ──
assert(
  source.includes("const [mediaViewer, setMediaViewer]") &&
    source.includes("setMediaViewer(withExhibitSrcQid(src))") &&
    source.includes("onClick={openInlineMedia}"),
  "QBank inline media should open in the fullscreen click viewer via openInlineMedia + withExhibitSrcQid.",
);

// ── Both tutor AND exam stems must wire the shared media handler ──
// The MISSING tutor-stem handler is the exact regression that made the "exhibit"
// link navigate the page (tearing down the exam). Tutor stem (1) + exam stem (2).
assert(
  (source.match(/onClick=\{openStemMedia\}/g) || []).length >= 3,
  "Both tutor and exam stems must wire onClick={openStemMedia} so exhibit clicks open in-app, not navigate.",
);

// ── Exhibit links must carry the source qid for the O(1) backend fast path ──
// (otherwise /qbank/exhibit falls back to a full-bank decrypt scan = the multi-
// minute "exhibit won't open" hang).
assert(
  source.includes("withExhibitSrcQid") && source.includes("srcqid="),
  "Exhibit URLs must carry srcqid so the backend uses the single-row fast path, not a full-bank scan.",
);

// ── AmbossHtml is the universal chokepoint ──
// ANY /qbank/exhibit or /qbank/media anchor is intercepted and opened in a viewer
// (host MediaViewer first, built-in overlay fallback) and NEVER navigates, in any
// mode. This is what keeps the bug from resurfacing on un-handled surfaces.
assert(
  ambossHtml.includes("a[href*='/qbank/exhibit/'], a[href*='/qbank/media/']") &&
    ambossHtml.includes("setFrameOverlay") &&
    ambossHtml.includes("setImageOverlay"),
  "AmbossHtml must intercept /qbank/exhibit and /qbank/media anchors so they open in a viewer, never navigate.",
);

// ── The "Loading formatted references…" spinner can never get stuck ──
// It is gated on per-question fetch resolution (explanationResolved) which is set
// when the backend answers AND by a hard safety-net timeout, so it cannot outlive
// the fetch even when the backend is cold/slow/empty.
assert(
  source.includes("explanationResolved") &&
    source.includes("markExplanationResolved") &&
    source.includes("!explanationResolved["),
  "The formatted-references spinner must be gated on explanationResolved so it can never get stuck.",
);

console.log("QBank media/exhibit + explanation-spinner regression checks passed");
