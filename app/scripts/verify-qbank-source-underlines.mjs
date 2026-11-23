import fs from "node:fs";
import path from "node:path";

const cssPath = path.join(process.cwd(), "app", "app", "globals.css");
const css = fs.readFileSync(cssPath, "utf8");

const required = [
  [".qbank-rich-html .selected", /(?:\.qbank-rich-html\s+\.selected|\.qbank-source-underline)/],
  [".qbank-exam-html .selected", /(?:\.qbank-exam-html\s+\.selected|\.qbank-source-underline)/],
  [".qbank-exam-choice-content .selected", /(?:\.qbank-exam-choice-content\s+\.selected|\.qbank-source-underline)/],
  ["visible underline decoration", /text-decoration(?:-line)?\s*:\s*underline/],
  ["underline offset", /text-underline-offset\s*:/],
];

const missing = required.filter(([, pattern]) => !pattern.test(css));
if (missing.length) {
  console.error("QBank source underline verification failed:");
  for (const [name] of missing) console.error(`- missing ${name}`);
  process.exit(1);
}

console.log("QBank source underline verification passed.");
