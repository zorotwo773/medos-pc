import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(root, "app", "globals.css"), "utf8");
const quizEngine = readFileSync(resolve(root, "components", "qbank", "QuizEngine.tsx"), "utf8");
const studyTimer = readFileSync(resolve(root, "components", "layout", "StudyTimerDock.tsx"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  /document\.body\.classList\.toggle\(["']qbank-tutor-active["'],\s*readingActive\)/.test(quizEngine),
  "QBank tutor mode must expose the qbank-tutor-active body class for global chrome guards",
);
assert(
  /classList\.contains\(["']qbank-tutor-active["']\)/.test(studyTimer),
  "StudyTimerDock must observe qbank-tutor-active, not only qbank-exam-active",
);
assert(
  /if\s*\(\s*qbankActive\s*\|\|\s*phoneHidden\s*\)\s*return\s+null/.test(studyTimer),
  "StudyTimerDock must not render while any QBank quiz surface is active",
);

const qbankTimerRule = css.match(/body\.qbank-tutor-active\s+\.study-timer-dock\s*\{(?<body>[\s\S]*?)\}/);
assert(qbankTimerRule, "Missing CSS fallback that hides the global study timer in QBank tutor mode");
assert(/display\s*:\s*none\s*!important/i.test(qbankTimerRule.groups.body), "QBank tutor timer fallback must force display: none");
assert(/pointer-events\s*:\s*none\s*!important/i.test(qbankTimerRule.groups.body), "QBank tutor timer fallback must disable pointer events");

console.log("QBank study timer suppression checks passed");
