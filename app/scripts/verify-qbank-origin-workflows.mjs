import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const quizPath = path.join(root, "app", "components", "qbank", "QuizEngine.tsx");
const backendPath = path.join(root, "app", "backend", "qbank_reader.py");

const quiz = fs.readFileSync(quizPath, "utf8");
const backend = fs.readFileSync(backendPath, "utf8");

const checks = [
  ["source family switch", quiz.includes("qbank-source-switch") && quiz.includes("sourceFamily")],
  ["selected subject ids", quiz.includes("selectedSubjectIds") && quiz.includes("subject_ids")],
  ["AMBOSS workflow panel", quiz.includes("AMBOSS custom session") && quiz.includes("Include questions from")],
  ["UWorld workflow panel", quiz.includes("UWorld-style subjects") && quiz.includes("Subjects and foundations")],
  ["images-only frontend filter", quiz.includes("imagesOnly") && quiz.includes("images_only")],
  ["images-only backend predicate", backend.includes("images_only") && backend.includes("COALESCE(q.mediaName")],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error("Q-bank origin workflow verification failed:");
  for (const [name] of failed) console.error(`- ${name}`);
  process.exit(1);
}

console.log("Q-bank origin workflow verification passed.");
