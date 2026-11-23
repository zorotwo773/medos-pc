import fs from "node:fs";
import path from "node:path";

const quizPath = path.join(process.cwd(), "app", "components", "qbank", "QuizEngine.tsx");
const quiz = fs.readFileSync(quizPath, "utf8");

const qidEffect = quiz.match(/const qid = Number\(searchParams\.get\("qid"\)[\s\S]*?fetch\(`\$\{backend\}\/qbank\/question\/\$\{qid\}\?db=\$\{urlDb\}`\)/)?.[0] || "";
const bankEffect = quiz.match(/if \(searchParams\.get\("qid"\)\) return;[\s\S]*?setBatchSize\(urlLimit\);/)?.[0] || "";

const checks = [
  ["qid deep-link block found", qidEffect.length > 0],
  ["requested db is preserved", /const urlDb:\s*DB\s*=\s*requestedDb\s*\|\|/.test(qidEffect)],
  ["daily bank metadata is restored", /dailyBankMeta\(urlDb\)/.test(qidEffect)],
  ["bank deep-link block found", bankEffect.length > 0],
  ["plain db deep-link accepts daily banks", /isDailyQbankDb\(requestedDb \|\| ""\)/.test(bankEffect)],
  ["plain db deep-link restores bank metadata", /dailyBankMeta\(stepDb\)/.test(bankEffect)],
  ["old step2 fallback removed", !/requestedDb === "step1" \|\| requestedDb === "step3" \? requestedDb : "step2"/.test(qidEffect)],
  ["old plain db fallback removed", !/requestedDb === "step1" \|\| requestedDb === "step3" \? requestedDb : "step2"/.test(bankEffect)],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error("QBank deep-link DB verification failed:");
  for (const [name] of failed) console.error(`- ${name}`);
  process.exit(1);
}

console.log("QBank deep-link DB verification passed.");
