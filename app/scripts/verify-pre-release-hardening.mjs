import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

function read(relPath) {
  try {
    return fs.readFileSync(path.join(root, relPath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      failures.push(`missing file: expected ${relPath} to exist`);
      return "";
    }
    throw error;
  }
}

function assertIncludes(relPath, expected, label) {
  const source = read(relPath);
  if (!source.includes(expected)) {
    failures.push(`${label}: expected ${relPath} to include ${JSON.stringify(expected)}`);
  }
}

function assertNotIncludes(relPath, unexpected, label) {
  const source = read(relPath);
  if (source.includes(unexpected)) {
    failures.push(`${label}: expected ${relPath} not to include ${JSON.stringify(unexpected)}`);
  }
}

assertIncludes(
  "components/layout/TopBar.tsx",
  'medos:open-settings',
  "topbar settings button dispatches the settings event",
);
assertNotIncludes(
  "components/layout/TopBar.tsx",
  '<a href="#" className="app-topbar-link"',
  "topbar settings is no longer a dead hash link",
);

assertIncludes("components/layout/Sidebar.tsx", 'href: "/chat"', "sidebar exposes Chat");
assertIncludes("components/layout/Sidebar.tsx", 'href: "/lexi"', "sidebar exposes Lexi");
assertIncludes("components/layout/GlobalCommandCenter.tsx", 'id: "chat"', "command center exposes Chat");
assertIncludes("components/layout/GlobalCommandCenter.tsx", 'id: "lexi"', "command center exposes Lexi");
assertIncludes("components/layout/GlobalCommandCenter.tsx", 'id: "settings"', "command center exposes Settings");
assertIncludes("components/layout/GlobalCommandCenter.tsx", 'medos:open-settings', "command center opens settings");

assertIncludes("components/qbank/QuizEngine.tsx", "Storage notice", "qbank surfaces storage failures");
assertIncludes("components/qbank/QuizEngine.tsx", "scrollTo({ top: 0", "qbank scrolls question content to top");
assertIncludes("components/qbank/QuizEngine.tsx", "saveExamTimerSnapshot(next);", "qbank snapshots exam timers on interactions");

assertIncludes("components/drugs/DrugDetailModal.tsx", "key={drug.drug_id}", "dose calculator resets on drug switch");
assertIncludes("components/drugs/DoseCalculator.tsx", 'min="1"', "dose weight/crcl minimums are bounded");
assertIncludes("components/drugs/DoseCalculator.tsx", 'max="500"', "dose weight maximum is bounded");
assertIncludes("components/drugs/DoseCalculator.tsx", 'max="120"', "dose age maximum is bounded");
assertIncludes("components/drugs/DoseCalculator.tsx", 'max="999"', "dose CrCl maximum is bounded");
assertIncludes("components/drugs/DrugSearchBar.tsx", "searchError", "drug search shows request failures");

assertIncludes("lib/zIndex.ts", "modalOverlay", "shared z-index constants exist");
assertIncludes("lib/useModalA11y.ts", "keydown", "modal accessibility hook handles keyboard");
assertIncludes("components/drugs/DrugClinicalPopup.tsx", "useModalA11y", "drug popup uses modal accessibility hook");
assertIncludes("components/anatomy/DiseaseDetailModal.tsx", "useModalA11y", "disease modal uses modal accessibility hook");

assertIncludes("app/page.tsx", "Search backend unavailable", "dashboard search reports backend outage");

assertIncludes("lib/useTouchGestures.ts", "useMultiTouchSwipe", "multi-touch swipe hook exists");
assertIncludes("lib/useTouchGestures.ts", "useTrackpadPinch", "trackpad pinch hook exists");
assertIncludes("components/qbank/QuizEngine.tsx", "useMultiTouchSwipe", "qbank wires multi-touch swipes");
assertIncludes("components/qbank/QuizEngine.tsx", "useTrackpadPinch", "qbank wires trackpad pinch");
assertIncludes("components/qbank/QuizEngine.tsx", "handleQbankShortcut", "qbank has keyboard shortcuts");
assertIncludes("components/layout/SettingsPanel.tsx", "medos.settings.v1", "settings panel persists preferences");
assertIncludes("components/layout/SettingsPanel.tsx", "medos:open-settings", "settings panel listens to open event");
assertIncludes("components/layout/SettingsPanel.tsx", "Gestures", "settings panel exposes gesture control");
assertIncludes("app/layout.tsx", "<SettingsPanel />", "settings panel is mounted globally");
assertIncludes("components/layout/TabBar.tsx", "Ctrl+PageDown", "tab bar documents ctrl page cycling");
assertIncludes("components/layout/TabBar.tsx", "cycleTab", "tab bar implements keyboard tab cycling");
assertIncludes("components/library/PdfViewer.tsx", "useTrackpadPinch", "pdf viewer supports trackpad pinch");
assertIncludes("components/amboss/AmbossReader.tsx", "useMultiTouchSwipe", "AMBOSS reader supports shell swipes");
assertIncludes("components/uptodate/ArticleViewer.tsx", "useMultiTouchSwipe", "UpToDate reader supports shell swipes");
assertIncludes("components/uworldlibrary/UWorldLibraryReader.tsx", "useMultiTouchSwipe", "UWorld reader supports shell swipes");
assertIncludes("components/lexi/LexiView.tsx", "useMultiTouchSwipe", "Lexi view supports shell swipes");
assertIncludes("components/uptodate/ArticleViewer.tsx", "Ctrl/Cmd+F", "UpToDate find is available from keyboard");

assertIncludes("app/globals.css", ":focus-visible", "global focus-visible rings exist");
assertIncludes("app/globals.css", "@media (pointer: coarse)", "coarse-pointer touch targets are handled");
assertIncludes("app/globals.css", "--text-muted:     #475569", "light muted text meets contrast better");
assertIncludes("app/globals.css", ".ao-prose table", "article table text has readability floor");
assertIncludes("components/qbank/QuizEngine.tsx", "aria-label={marked && isCorrect ? \"Correct answer\"", "qbank matrix exposes non-color answer state");
assertIncludes("components/reader/ArticleOutline.tsx", "<button", "article outline uses buttons");
assertIncludes("components/anatomy/AnatomyAtlas.tsx", "aria-label", "anatomy controls have labels");

assertIncludes("components/chat/ChatInterface.tsx", "MAX_RENDERED_MESSAGES", "chat message rendering is bounded");
assertIncludes("components/chat/ChatInterface.tsx", "requestAnimationFrame", "chat textarea autosize is rAF-debounced");
assertIncludes("backend/qbank_reader.py", "@lru_cache", "qbank decrypt HTML is cached");
assertIncludes("backend/qbank_reader.py", "MAX_DECOMPRESSED_HTML_BYTES", "qbank decrypt has gzip payload guard");
assertNotIncludes("backend/main.py", '@app.get("/library/pdf")', "duplicate legacy library PDF route removed");
assertNotIncludes("backend/main.py", '@app.get("/library/thumb")', "duplicate legacy library thumb route removed");
assertIncludes("components/library/BookLibrary.tsx", "dynamic(() => import(\"./PdfViewer\")", "PDF viewer is dynamically loaded");
assertIncludes("components/library/BookLibrary.tsx", "dynamic(() => import(\"./AddBookPanel\")", "add-book panel is dynamically loaded");
assertIncludes("components/anatomy/Viewer3D.tsx", "disposeTrackedMaterials", "anatomy disposes cloned materials");
assertIncludes("components/anatomy/Viewer3D.tsx", "clearLayerModelCache", "anatomy clears hidden GLB cache entries");
assertIncludes("app/graph/page.tsx", "dynamic(() => import(\"./GraphClient\")", "graph route is dynamically loaded");
assertIncludes("app/graph/GraphClient.tsx", "@xyflow/react", "graph client owns the React Flow dependency");
assertIncludes("next.config.ts", "@next/bundle-analyzer", "bundle analyzer is configured");
assertIncludes("package.json", "\"analyze\": \"next experimental-analyze --output\"", "bundle analyzer script exists");
assertIncludes("backend/main.py", "AI_PROVIDER_FAILURE", "AI errors use sanitized client messages");
assertNotIncludes("backend/main.py", "detail=f\"Gemini API error", "Gemini upstream text is not echoed to clients");
assertIncludes("backend/main.py", "detail=\"AI chat failed. Check backend logs for details.\"", "AI chat exceptions are sanitized");
assertNotIncludes("backend/main.py", "raise HTTPException(status_code=500, detail=str(e))", "AI chat exceptions are not echoed to clients");
assertIncludes("components/uptodate/ArticleViewer.tsx", "UTD_READER_TAB_KEY", "UpToDate persists reader tab");
assertIncludes("components/uptodate/ArticleViewer.tsx", "UTD_READER_FIND_KEY", "UpToDate persists find query");
assertIncludes("components/uptodate/ArticleViewer.tsx", "readyRef.current = true;", "UpToDate scroll restore has ready fallback");
assertIncludes("components/amboss/AmbossReader.tsx", "AMBOSS_READER_TAB_KEY", "AMBOSS persists reader tab");
assertIncludes("components/amboss/AmbossReader.tsx", "readyRef.current = true;", "AMBOSS scroll restore has ready fallback");
assertIncludes("components/uworldlibrary/UWorldLibraryReader.tsx", "UWORLD_READER_TAB_KEY", "UWorld reader persists reader tab");
assertIncludes("lib/useScrollRestore.ts", "tries < 45", "scroll restore retry budget is raised");
assertIncludes("proxy.ts", "PUBLIC_FILE_RE", "auth proxy allows public static files");
assertIncludes("proxy.ts", "mjs", "auth proxy allows PDF worker and public module scripts");

if (failures.length) {
  console.error(`Pre-release hardening checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Pre-release hardening checks passed.");
