export const QBANK_LAST_SELECTION_KEY = "medos.qbank.last-selection.v1";
export const QBANK_ACTIVE_TAB_KEY = "qbank-active-block";

const BANK_CATEGORIES = new Set([
  "uworld", "amboss", "nbme", "cms", "mehlman", "boardvitals", "mksap",
]);

function cleanSelection(value) {
  if (!value || typeof value !== "object") return null;
  const db = typeof value.db === "string" ? value.db.trim() : "";
  const meta = value.meta && typeof value.meta === "object" ? value.meta : null;
  const category = typeof meta?.category === "string" ? meta.category : "";
  const label = typeof meta?.label === "string" ? meta.label.trim() : "";
  if (!db || db.length > 200 || !BANK_CATEGORIES.has(category) || !label || label.length > 200) return null;
  const step = meta.step === 1 || meta.step === 2 || meta.step === 3 ? meta.step : undefined;
  const subject = typeof meta.subject === "string" ? meta.subject : undefined;
  const form = typeof meta.form === "string" ? meta.form : undefined;
  return { db, meta: { category, ...(step ? { step } : {}), ...(subject ? { subject } : {}), ...(form ? { form } : {}), label } };
}

export function readQbankSelection(storage, fallback) {
  try {
    const saved = JSON.parse(storage?.getItem?.(QBANK_LAST_SELECTION_KEY) || "null");
    return cleanSelection(saved) || fallback;
  } catch {
    return fallback;
  }
}

export function writeQbankSelection(storage, selection) {
  const clean = cleanSelection(selection);
  if (!clean) return false;
  try {
    storage?.setItem?.(QBANK_LAST_SELECTION_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

export function buildQbankActiveTab(session, bankLabel) {
  if (!session || session.completedAt || !String(session.id || "").trim()) return null;
  const total = Array.isArray(session.questions) ? session.questions.length : 0;
  if (!total) return null;
  const current = Math.max(0, Math.min(total - 1, Number(session.current) || 0));
  const label = String(bankLabel || session.db || "Q-Bank").trim() || "Q-Bank";
  return {
    tabKey: QBANK_ACTIVE_TAB_KEY,
    href: `/qbank?resume=${encodeURIComponent(String(session.id))}`,
    title: `Q-Bank · ${label} · ${current + 1}/${total}`,
  };
}

export function upsertWorkspaceTab(tabs, incoming) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (!incoming?.tabKey) return [...list, incoming];
  const index = list.findIndex(tab => tab?.tabKey === incoming.tabKey);
  if (index < 0) return [...list, incoming];
  return list.map((tab, itemIndex) => itemIndex === index
    ? { ...tab, href: incoming.href, title: incoming.title }
    : tab);
}

export function findQbankResumeSession(sessions, resumeId) {
  const id = String(resumeId || "").trim();
  if (!id || !Array.isArray(sessions)) return null;
  return sessions.find(session => String(session?.id) === id && !session?.completedAt) || null;
}
