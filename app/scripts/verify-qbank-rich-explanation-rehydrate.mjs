import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "components", "qbank", "QuizEngine.tsx");
const source = readFileSync(sourcePath, "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  source.includes("function missingExplanationQidsForPrefetch(session: Session)"),
  "QuizEngine should prioritize the current missing explanation during completed-block rich HTML prefetch.",
);

assert(
  !source.includes("}, [active, applyActiveSession, backend, mode, persistActive]);"),
  "Foreground rich HTML rehydrate must not depend on the entire active session object.",
);

assert(
  source.includes("applyActiveSession(updatedSession);") &&
    source.includes("window.setTimeout(() => {") &&
    source.includes("persistSessionToBackend(latest);"),
  "Foreground rich HTML rehydrate should update visible UI before deferred persistence.",
);

console.log("QBank rich explanation rehydrate checks passed");
