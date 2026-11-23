import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "components", "qbank", "qbankAnalytics.ts");
const outPath = path.join(root, ".tmp", "qbankAnalytics.verify.cjs");

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Missing analytics helper: ${sourcePath}`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const source = fs.readFileSync(sourcePath, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;
fs.writeFileSync(outPath, output);

const analytics = await import(pathToFileURL(outPath).href);

const baseSession = {
  id: "block-1",
  db: "step1",
  mode: "tutor",
  createdAt: "2026-06-17T10:00:00.000Z",
  updatedAt: "2026-06-17T10:00:00.000Z",
  current: 0,
  questions: [
    { id: 101, subject: "Cardiovascular", system: "Cardiology (Murmurs)", system_group: "Cardiology", system_detail: "Murmurs", correct: 2 },
    { id: 102, subject: "Ethics", system: "Communication", system_group: "Communication", system_detail: "", correct: 1 },
  ],
  answers: {},
  questionStartedAt: { 0: "2026-06-17T10:00:00.000Z" },
  questionTimeSec: {},
  answerMeta: {},
};

const answered = analytics.recordTimedAnswer(baseSession, {
  choiceIndex: 1,
  at: "2026-06-17T10:00:25.000Z",
  stopTimer: true,
});
assert.equal(answered.answerMeta[0].spentSec, 25);
assert.equal(answered.questionTimeSec[0], 25);
assert.equal(answered.questionStartedAt[0], undefined);
assert.equal(analytics.formatQuestionTime(71), "1 min 11 sec");

const moved = analytics.moveTimedQuestion({
  ...baseSession,
  current: 0,
  questionStartedAt: { 0: "2026-06-17T10:00:00.000Z" },
}, 1, "2026-06-17T10:00:40.000Z");
assert.equal(moved.questionTimeSec[0], 40);
assert.equal(moved.questionStartedAt[1], "2026-06-17T10:00:40.000Z");

const completedSessions = [
  {
    ...answered,
    completedAt: "2026-06-17T10:02:00.000Z",
    answers: { 0: 1, 1: 0 },
    questionTimeSec: { 0: 25, 1: 71 },
    answerMeta: {
      0: { qid: 101, questionIndex: 0, choiceIndex: 1, correctIndex: 1, answeredAt: "2026-06-17T10:00:25.000Z", elapsedSec: 25, spentSec: 25, mode: "tutor" },
      1: { qid: 102, questionIndex: 1, choiceIndex: 0, correctIndex: 0, answeredAt: "2026-06-17T10:01:36.000Z", elapsedSec: 71, spentSec: 71, mode: "tutor" },
    },
  },
  {
    id: "block-2",
    db: "amboss1",
    mode: "exam",
    createdAt: "2026-06-17T11:00:00.000Z",
    updatedAt: "2026-06-17T11:10:00.000Z",
    completedAt: "2026-06-17T11:10:00.000Z",
    current: 0,
    questions: [
      { id: 201, subject: "Ethics", system: "Professionalism", system_group: "Professionalism", system_detail: "", correct: 3 },
    ],
    answers: { 0: 1 },
    questionTimeSec: { 0: 93 },
    answerMeta: { 0: { qid: 201, questionIndex: 0, choiceIndex: 1, correctIndex: 2, answeredAt: "2026-06-17T11:01:33.000Z", elapsedSec: 93, spentSec: 93, mode: "exam" } },
  },
];

const review = analytics.buildQbankReviewStats(completedSessions, "all");
assert.equal(review.overall.total, 3);
assert.equal(review.overall.correct, 2);
assert.equal(review.overall.wrong, 1);
assert.equal(review.overall.avgSec, 63);
assert.equal(review.banks.find((bank) => bank.db === "step1").correct, 2);
assert.equal(review.banks.find((bank) => bank.db === "amboss1").wrong, 1);
assert.equal(review.subjects.find((subject) => subject.label === "Ethics").total, 2);
assert.equal(review.tests[0].label, "block-2");

console.log("QBank analytics verification passed");
