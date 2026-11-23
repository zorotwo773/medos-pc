import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(root, "app", "globals.css"), "utf8");
const quizEngine = readFileSync(resolve(root, "components", "qbank", "QuizEngine.tsx"), "utf8");
const readingChrome = readFileSync(resolve(root, "components", "layout", "ReadingChromeController.tsx"), "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const richTableRule = css.match(/\.qbank-rich-html table\s*\{(?<body>[\s\S]*?)\}/);
assert(richTableRule, "Missing .qbank-rich-html table rule");
assert(
  !/width\s*:\s*100%\s*!important/i.test(richTableRule.groups.body),
  "QBank rich tables must not force width: 100% !important because source-sized option headers need to align with answer-choice tables",
);
assert(
  /\.qbank-rich-html table:not\(\[style\*=["']width["']\]\)\s*\{[\s\S]*?width\s*:\s*100%/i.test(css),
  "QBank rich tables without an inline source width should still expand to the reading column",
);
assert(
  /\.qbank-choice-html table[\s\S]*?\.qbank-exam-choice-content table[\s\S]*?max-width\s*:\s*100%/i.test(css),
  "QBank answer-choice tables need scoped rules that preserve compact source geometry within the choice column",
);
assert(
  !/<span\s+className="qbank-exam-choice-content"\s+dangerouslySetInnerHTML/.test(quizEngine),
  "Exam answer choices with rich HTML should not inject tables into inline span wrappers",
);
assert(
  !/as="span"\s+className="qbank-rich-html qbank-choice-html"/.test(quizEngine),
  "Tutor answer choices with rich HTML should not render table content through inline ReferenceLayer spans",
);
assert(
  /function buildQbankChoiceMatrix\b/.test(quizEngine),
  "Table-style answer choices should be detected and normalized into a shared choice matrix",
);
assert(
  /\.qbank-answer-matrix\b/.test(css) && /qbank-answer-matrix/.test(quizEngine),
  "Table-style answer choices need a shared matrix renderer so stem headings and choices use the same columns",
);
assert(
  /choiceMatrix\s*\?\s*\(/.test(quizEngine),
  "Tutor and exam modes should branch to the shared choice-matrix renderer when table choices are detected",
);
assert(
  /const\s+isAmbossBank\s*=\s*active\.db\.startsWith\(["']amboss["']\)/.test(quizEngine),
  "AMBOSS QBank needs a source-specific branch for stem-bound question figures",
);
assert(
  /isAmbossBank\s*\?\s*mediaLinksFromHtml\(q\.stem_html,\s*backend,\s*active\.db\)/.test(quizEngine),
  "AMBOSS stem-embedded figures should be included in the image tray before answering",
);
assert(
  /qbankStemHtml\(tutorStemHtml,\s*backend,\s*active\.db,\s*tutorStemHasMedia\)/.test(quizEngine),
  "Question-stem figure cues should account for AMBOSS stem-embedded media, not only q.media",
);
assert(
  /function mediaDisplayCaption\b/.test(quizEngine) && /function isMeaningfulMediaCaption\b/.test(quizEngine),
  "QBank media captions should be filtered so raw file names are not rendered under images",
);
assert(
  !/<figcaption[^>]*>\s*(?:<ImageIcon[^>]*>\s*)?\{m\.name\}\s*<\/figcaption>/s.test(quizEngine),
  "QBank media figures should not render the raw media file name as a visible caption",
);
assert(
  /item\.caption\s*&&\s*<span>\{item\.caption\}<\/span>/.test(quizEngine),
  "QBank image tray should only show a visible label when the media has a meaningful caption",
);
assert(
  /type ReaderScrollSource\s*=/.test(readingChrome) && /function scrollTuningFor\b/.test(readingChrome),
  "Reader chrome scroll hiding should use source-specific tuning for QBank",
);
assert(
  /source\s*!==\s*["']qbank["'][\s\S]*?setHidden\(true\)/.test(readingChrome),
  "QBank wheel events should not hide the app chrome immediately on every small downward scroll",
);
assert(
  /body\.qbank-tutor-active\.medos-reading-chrome-hidden\s+\.shell-frame/.test(css),
  "QBank should keep the shell grid stable while reader chrome is visually hidden",
);

console.log("QBank choice table rendering checks passed");
