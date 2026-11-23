import fs from "node:fs";
import path from "node:path";

const quizPath = path.join(process.cwd(), "app", "components", "qbank", "QuizEngine.tsx");
const quiz = fs.readFileSync(quizPath, "utf8");

const checks = [
  [
    "ReferenceLayer exposes hoverEnabled gate",
    fs.readFileSync(path.join(process.cwd(), "app", "components", "common", "ReferenceLayer.tsx"), "utf8").includes("hoverEnabled?: boolean"),
  ],
  [
    "QBank pending reference class exists",
    /qbank-reference-pending/.test(quiz),
  ],
  [
    "QBankAnswerMatrix keeps scanner mounted while interactions are disabled",
    /hoverEnabled=\{referenceEnabled\}/.test(quiz) && !/if \(variant === "exam" \|\| !referenceEnabled\)/.test(quiz),
  ],
  [
    "reference gate is question-answer scoped",
    (quiz.match(/const questionReferencesEnabled = selected !== undefined;/g) || []).length >= 2,
  ],
  [
    "tutor stem uses full scanner html before answer",
    /html=\{qbankStemHtml\(tutorStemHtml, backend, active\.db, tutorStemHasMedia\)\}/.test(quiz),
  ],
  [
    "tutor stem hover opens only after answer",
    /hoverEnabled=\{questionReferencesEnabled\}/.test(quiz) && /onOpenMatch=\{questionReferencesEnabled \? openHoverMatchInPanel : undefined\}/.test(quiz),
  ],
  [
    "tutor stem scanner stays in full mode before answer",
    /modeOverride="full"/.test(quiz),
  ],
  [
    "tutor choices use full scanner html before answer",
    /html=\{qbankHtml\(choiceHtml, backend, active\.db\)\}/.test(quiz),
  ],
  [
    "tutor matrix receives reference gate",
    /referenceEnabled=\{questionReferencesEnabled\}/.test(quiz),
  ],
  [
    "exam stem uses warm scanner before answer",
    /className=\{qbankReferenceClass\("qbank-exam-html", questionReferencesEnabled\)\}/.test(quiz) &&
      /html=\{qbankHtml\(examStemHtml, backend, active\.db\)\}/.test(quiz),
  ],
  [
    "exam choices use warm scanner before answer",
    /className=\{qbankReferenceClass\("qbank-exam-choice-content", questionReferencesEnabled\)\}/.test(quiz) &&
      /html=\{qbankHtml\(choiceHtml, backend, active\.db\)\}/.test(quiz),
  ],
  [
    "exam-mode css does not suppress answered reference underlines globally",
    !/body\.qbank-exam-active \.qbank-exam-html \.medos-hover-link/.test(fs.readFileSync(path.join(process.cwd(), "app", "app", "globals.css"), "utf8")),
  ],
  [
    "pending reference css hides underlines",
    fs.readFileSync(path.join(process.cwd(), "app", "app", "globals.css"), "utf8").includes(".qbank-reference-pending"),
  ],
  [
    "tutor explanation is preloaded while thinking",
    /const shouldPreloadTutorExplanation = activeModeKey === "tutor" && !q\.explanation_html;/.test(quiz),
  ],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error("QBank reference gating verification failed:");
  for (const [name] of failed) console.error(`- ${name}`);
  process.exit(1);
}

console.log("QBank reference gating verification passed.");
