/**
 * Offline PDF export client for MedOS.
 *
 * The backend generates real PDF bytes with the bundled PyMuPDF engine; this
 * module only captures local page content, collects a Q-Bank session from
 * browser storage, posts it to /export/pdf/* and downloads the returned blob.
 * No CDN, font, network module or new dependency is involved.
 */
import { getBackendUrl } from "./api";

export type PdfPaper = "a4" | "letter";
export type PdfExportKind = "page" | "topic" | "qbank" | "rows";

export interface PdfQuestion {
  id?: number | string;
  stem: string;
  /** Source HTML keeps tables, formatting and embedded base64 images. */
  stemHtml?: string;
  choices: string[];
  choicesHtml?: string[];
  /** 1-based, matching MedOS Q-Bank data (`question.correct`). */
  correct: number;
  explanation: string;
  explanationHtml?: string;
  /** Source refs (e.g. /qbank/media/...) or data URLs; resolved by the backend. */
  media?: string[];
  explanationMedia?: string[];
  /** Bank key so the backend can resolve relative media/exhibit refs. */
  db?: string;
  subject?: string;
  system?: string;
  tags?: string[];
  /** 0-based choice index, matching MedOS `session.answers`. */
  chosen?: number | null;
}

export interface PdfProviderPayload {
  kind: PdfExportKind;
  title: string;
  subtitle?: string;
  html?: string;
  text?: string;
  questions?: PdfQuestion[];
  columns?: string[];
  rows?: unknown[][];
  meta?: Record<string, unknown>;
  paper?: PdfPaper;
  filename?: string;
}

export interface PdfExportProvider {
  id: string;
  label: string;
  available: () => boolean | Promise<boolean>;
  collect: () =>
    | PdfProviderPayload
    | null
    | Promise<PdfProviderPayload | null>;
}

type ProviderWindow = typeof globalThis & {
  __medosPdfExportProviders?: Map<string, PdfExportProvider>;
};

function registry(): Map<string, PdfExportProvider> {
  if (typeof globalThis === "undefined") return new Map();
  const scope = globalThis as ProviderWindow;
  if (!scope.__medosPdfExportProviders) {
    scope.__medosPdfExportProviders = new Map<string, PdfExportProvider>();
  }
  return scope.__medosPdfExportProviders;
}

/** Registers an export provider. Returns a disposer for useEffect cleanup. */
export function registerPdfExportProvider(provider: PdfExportProvider): () => void {
  registry().set(provider.id, provider);
  return () => {
    const current = registry();
    if (current.get(provider.id) === provider) current.delete(provider.id);
  };
}

export function unregisterPdfExportProvider(id: string): void {
  registry().delete(id);
}

let defaultsInstalled = false;

/**
 * Installs the built-in "This page", "Article / topic" and "Q-Bank session"
 * providers. Safe to call repeatedly; the TopBar button calls it before listing.
 */
export function ensureDefaultPdfExportProviders(): void {
  if (defaultsInstalled || typeof window === "undefined") return;
  defaultsInstalled = true;

  registerPdfExportProvider({
    id: "medos.qbank.session",
    label: "Q-Bank session — questions + answers",
    available: () => findQbankSession() !== null,
    collect: () => collectQbankSession(),
  });

  registerPdfExportProvider({
    id: "medos.topic.page",
    label: "Article / topic on this page",
    available: () => isTopicRoute(window.location.pathname),
    collect: () => captureCurrentPage("topic"),
  });

  registerPdfExportProvider({
    id: "medos.this.page",
    label: "This page",
    available: () => true,
    collect: () => captureCurrentPage("page"),
  });
}

/** Lists providers in registration order, after installing the defaults. */
export function listPdfExportProviders(): PdfExportProvider[] {
  ensureDefaultPdfExportProviders();
  return Array.from(registry().values());
}

/** Captures the main content of the current page as a sanitised HTML fragment. */
export function captureCurrentPage(kind: PdfExportKind = "page"): PdfProviderPayload {
  const root =
    (typeof document !== "undefined" &&
      (document.querySelector("main") ||
        document.querySelector("[data-medos-main]") ||
        document.body)) ||
    null;
  const clone = (root ? root.cloneNode(true) : document.createElement("div")) as HTMLElement;

  const drop = clone.querySelectorAll(
    [
      "script",
      "style",
      "noscript",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "form",
      "button",
      "input",
      "select",
      "textarea",
      "nav",
      "header",
      "footer",
      "svg",
      "canvas",
      "video",
      "audio",
      "[data-medos-print-ignore]",
      "[data-print-ignore]",
      '[aria-hidden="true"]',
      "[hidden]",
    ].join(","),
  );
  drop.forEach((element) => element.remove());

  clone.querySelectorAll("*").forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const keep =
        name === "class" ||
        name === "title" ||
        name === "colspan" ||
        name === "rowspan" ||
        name === "alt";
      if (!keep || name.startsWith("on")) element.removeAttribute(attribute.name);
    });
  });

  const title =
    (typeof document !== "undefined" && document.title
      ? document.title.replace(/\s*[|–—-]\s*MedOS.*$/i, "").trim()
      : "") || "MedOS page";
  return {
    kind,
    title,
    subtitle: `Captured from ${window.location.pathname}`,
    html: clone.outerHTML.slice(0, 12_000_000),
    meta: {
      source: "medos-pc",
      path: window.location.pathname,
      capturedAt: new Date().toISOString(),
    },
  };
}

/** Posts one provider payload to the local backend and downloads the PDF. */
export async function downloadPdf(payload: PdfProviderPayload): Promise<string> {
  const route =
    payload.kind === "qbank"
      ? "/export/pdf/qbank"
      : payload.kind === "topic"
        ? "/export/pdf/topic"
        : payload.kind === "rows"
          ? "/export/pdf/rows"
          : "/export/pdf/page";

  let body: Record<string, unknown>;
  if (payload.kind === "qbank") {
    // The backend Pydantic model uses snake_case and ignores unknown keys, so
    // camelCase fields must be mapped here or all rich HTML (tables/images) is
    // silently dropped and the PDF contains plain text only.
    body = {
      title: payload.title,
      questions: (payload.questions || []).map(question => ({
        id: question.id,
        stem: question.stem || "",
        stem_html: question.stemHtml || "",
        choices: question.choices || [],
        choices_html: question.choicesHtml || [],
        correct: question.correct || 1,
        explanation: question.explanation || "",
        explanation_html: question.explanationHtml || "",
        media: question.media || [],
        explanation_media: question.explanationMedia || [],
        db: question.db || "",
        subject: question.subject || "",
        system: question.system || "",
        tags: question.tags || [],
        chosen: question.chosen ?? null,
      })),
      meta: payload.meta || {},
      paper: payload.paper || "a4",
    };
  } else if (payload.kind === "rows") {
    body = {
      title: payload.title,
      columns: payload.columns || [],
      rows: payload.rows || [],
      meta: payload.meta || {},
      paper: payload.paper || "a4",
    };
  } else {
    if (!payload.html && !payload.text) {
      throw new Error("Nothing was available to export on this page.");
    }
    body = {
      title: payload.title,
      subtitle: payload.subtitle || "",
      html: payload.html || null,
      text: payload.text || null,
      meta: payload.meta || {},
      paper: payload.paper || "a4",
    };
  }

  const response = await fetch(`${getBackendUrl()}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = (await response.json()) as { detail?: unknown };
      if (parsed && parsed.detail) detail = String(parsed.detail);
    } catch {
      /* keep the HTTP status */
    }
    throw new Error(detail);
  }

  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers.get("content-disposition")) ||
    payload.filename ||
    `${safeFilename(payload.title)}.pdf`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

/** Emits a notification through MedOS's media bridge when available. */
export function notifyPdfExport(message: string, kind: "success" | "error" = "success"): void {
  const bridge = (window as unknown as {
    MedOSMedia?: { notify?: (text: string, level?: string) => void };
  }).MedOSMedia;
  if (bridge && typeof bridge.notify === "function") {
    bridge.notify(message, kind);
    return;
  }
  window.dispatchEvent(
    new CustomEvent("medos:notify", { detail: { message, kind } }),
  );
}

/* ─────────────────────────────── Q-Bank ──────────────────────────────── */

interface StoredQuestion {
  id?: number | string;
  source_id?: string;
  title?: string;
  stem?: string;
  stem_html?: string;
  choices?: string[];
  choices_html?: string[];
  correct?: number;
  explanation?: string;
  explanation_html?: string;
  media?: { url?: string; name?: string }[];
  explanation_media?: { url?: string; name?: string }[];
  subject?: string;
  system?: string;
  tags?: string[];
}

interface StoredSession {
  id?: string;
  db?: string;
  label?: string;
  blockLabel?: string;
  title?: string;
  mode?: string;
  updatedAt?: string;
  createdAt?: string;
  completedAt?: string;
  questions?: StoredQuestion[];
  answers?: Record<string, number>;
}

const QBANK_SESSION_KEY = "medos.qbank.sessions.v2";
const QBANK_EXAM_RUN_KEY = "medos.qbank.examRun.v1";

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function storedSessions(): StoredSession[] {
  const sessions = readJson<StoredSession[]>(QBANK_SESSION_KEY);
  const exam = readJson<{ blocks?: StoredSession[] } | null>(QBANK_EXAM_RUN_KEY);
  return [
    ...(Array.isArray(sessions) ? sessions : []),
    ...(exam && Array.isArray(exam.blocks) ? exam.blocks : []),
  ];
}

function sessionTimestamp(session: StoredSession): number {
  const value = session.updatedAt || session.createdAt || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findQbankSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  const sessions = storedSessions().filter(
    (session) => Array.isArray(session.questions) && session.questions.length > 0,
  );
  if (!sessions.length) return null;
  sessions.sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
  return sessions[0];
}

export function htmlToPlainText(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return "";
  if (typeof DOMParser !== "undefined") {
    try {
      const parsed = new DOMParser().parseFromString(raw, "text/html");
      return (parsed.body.textContent || "").replace(/\s+/g, " ").trim();
    } catch {
      /* fall through to the regex cleanup */
    }
  }
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_PDF_IMAGES = 8;
const MAX_PDF_IMAGE_BYTES = 3 * 1024 * 1024;

function dataUrlFromBlob(blob: Blob): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

/** Converts a local Q-Bank media URL into an embedded base64 image. */
async function imageToDataUrl(value: string): Promise<string | null> {
  const source = (value || "").trim();
  if (!source) return null;
  if (/^data:image\//i.test(source)) return source;
  try {
    const absolute = source.startsWith("/") ? `${getBackendUrl()}${source}` : source;
    const parsed = new URL(absolute, window.location.href);
    // Offline-only: never fetch an external host while building a PDF.
    if (parsed.origin !== new URL(getBackendUrl()).origin) return null;
    const response = await fetch(parsed.href, { credentials: "include" });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || blob.size > MAX_PDF_IMAGE_BYTES) return null;
    const data = await dataUrlFromBlob(blob);
    return data && data.length <= 5_000_000 ? data : null;
  } catch {
    return null;
  }
}

/**
 * Keeps source HTML intact (tables/formatting) and replaces every image with a
 * data URL so the offline renderer can draw it without any network access.
 */
export async function preparePdfHtml(
  html: string,
  extraImages: string[] = [],
): Promise<string> {
  let prepared = html || "";
  let used = 0;
  const imageTag = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const match of Array.from(prepared.matchAll(imageTag))) {
    if (used >= MAX_PDF_IMAGES) break;
    const src = match[1];
    if (/^data:image\//i.test(src)) {
      used += 1;
      continue;
    }
    const data = await imageToDataUrl(src);
    if (!data) continue;
    prepared = prepared.replace(match[0], () => match[0].replace(src, data));
    used += 1;
  }
  const appended: string[] = [];
  for (const url of extraImages) {
    if (used >= MAX_PDF_IMAGES) break;
    const data = await imageToDataUrl(url);
    if (!data) continue;
    appended.push(`<figure><img src="${data}" alt="Question media" width="480"/></figure>`);
    used += 1;
  }
  return prepared + appended.join("");
}

function mediaUrls(items: { url?: string }[] | undefined): string[] {
  const backend = getBackendUrl();
  return (items || [])
    .map(item => (item && item.url ? item.url : ""))
    .filter(Boolean)
    .map(url => (url.startsWith("/") ? `${backend}${url}` : url));
}

function toPdfQuestion(question: StoredQuestion, index: number, session: StoredSession): PdfQuestion {
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const choiceHtml = Array.isArray(question.choices_html) ? question.choices_html : [];
  const renderedChoices = choices.map((choice, choiceIndex) =>
    htmlToPlainText(choiceHtml[choiceIndex]) || htmlToPlainText(choice) || String(choice || ""),
  );
  const chosen = session.answers ? session.answers[String(index)] : undefined;
  const sourceUrls = (items: { url?: string }[] | undefined) =>
    (items || []).map(item => item && item.url).filter((url): url is string => !!url);
  // Send original HTML/refs; the backend resolves exhibits + media to embedded
  // base64 so tables and figures survive with no browser-side fetch.
  return {
    id: question.source_id || question.id || undefined,
    stem: htmlToPlainText(question.stem_html) || htmlToPlainText(question.stem),
    stemHtml: question.stem_html || "",
    choices: renderedChoices,
    choicesHtml: choiceHtml,
    correct: Number(question.correct) > 0 ? Number(question.correct) : 1,
    explanation: htmlToPlainText(question.explanation_html) || htmlToPlainText(question.explanation),
    explanationHtml: question.explanation_html || "",
    media: sourceUrls(question.media),
    explanationMedia: sourceUrls(question.explanation_media),
    db: session.db || "",
    subject: question.subject || "",
    system: question.system || "",
    tags: Array.isArray(question.tags) ? question.tags.slice(0, 50) : [],
    chosen: typeof chosen === "number" ? chosen : null,
  };
}

function collectQbankSession(): PdfProviderPayload | null {
  const session = findQbankSession();
  if (!session || !session.questions) return null;
  const questions = session.questions.map((question, index) =>
    toPdfQuestion(question, index, session),
  );
  const label =
    session.blockLabel ||
    session.label ||
    session.title ||
    (session.db ? `Q-Bank · ${session.db}` : "Q-Bank");
  return {
    kind: "qbank",
    title: `${label} · ${questions.length} questions`,
    questions,
    meta: {
      source: "medos-qbank",
      sessionId: session.id || "",
      bank: session.db || "",
      mode: session.mode || "",
      completedAt: session.completedAt || "",
      answersIncluded: true,
    },
  };
}

/* ────────────────────────────── helpers ──────────────────────────────── */

function isTopicRoute(pathname: string): boolean {
  return [
    "/uptodate",
    "/amboss",
    "/uworld",
    "/library",
    "/diseases",
    "/drugs",
    "/first-aid",
    "/sanford",
    "/lexicomp",
    "/pathways",
    "/utd-ddx",
  ].some((route) => pathname.toLowerCase().startsWith(route));
}

function safeFilename(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "medos-export"
  );
}

function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8 && utf8[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* keep looking */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain && plain[1] ? plain[1].trim() : null;
}
