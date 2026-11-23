"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Search, ArrowLeft, Plus, Trash2, Maximize2, Minimize2, Star } from "lucide-react";
import dynamic from "next/dynamic";
import { getBackendUrl } from "@/lib/api";
import { useRouter, useSearchParams } from "next/navigation";
import { recordRecent } from "@/lib/useRecent";
import { saveScroll, loadScroll } from "@/lib/activity";
import { useDarkMode } from "@/components/common/useDarkMode";
import { buildPreviewSearchParams } from "@/lib/searchInteraction.mjs";
import { rankBookMatches } from "@/lib/bookArchiveSearch.mjs";
import {
  PDF_NAVIGATION_ACTIVATION_EVENT,
  createPdfNavigationRequest,
  parsePdfPage,
  requestFromLibraryPdfActivation,
  type PdfNavigationRequest,
  type PdfNavigationSource,
} from "@/lib/pdfNavigation";

const SHELF_CACHE_KEY = "medos:library:shelf_v5";
const PdfViewer = dynamic(() => import("./PdfViewer"), {
  ssr: false,
  loading: () => (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#2d2d2d", color: "#9ca3af", fontSize: 13 }}>
      <div className="loader" style={{ marginRight: 10 }} /> Loading viewer...
    </div>
  ),
});
const AddBookPanel = dynamic(() => import("./AddBookPanel"), { ssr: false });

/** Resume key for a book — matches the recents href so saveScroll also keeps
 *  the resume pointer's page fresh. */
function bookScrollHref(bookId: string) {
  return `/library?path=${encodeURIComponent(bookId.replaceAll("\\", "/"))}`;
}

export function pdfViewerKeyForBook(bookId: string) {
  return bookId.replaceAll("\\", "/");
}

export function resolvePdfStartPage(urlPage: string | null, savedPage: number | null | undefined): {
  page: number;
  source: Extract<PdfNavigationSource, "route" | "recent">;
} {
  const explicitPage = parsePdfPage(urlPage);
  if (explicitPage !== null) return { page: explicitPage, source: "route" };
  const resumePage = typeof savedPage === "number" && Number.isFinite(savedPage) && savedPage >= 1
    ? Math.round(savedPage)
    : 1;
  return { page: resumePage, source: "recent" };
}

export function createPdfPageReportHandler(
  bookId: string,
  persist: (href: string, page: number) => void = saveScroll,
) {
  const href = bookScrollHref(bookId);
  return (event: { data?: unknown }) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    const report = data as { type?: unknown; page?: unknown };
    if (report.type !== "medos-pdf-page" || !Number.isSafeInteger(report.page) || Number(report.page) < 1) return;
    persist(href, Number(report.page));
  };
}

interface RemoteBook {
  id: string; // file path relative to LIBRARY_PATH
  title: string;
  filename: string;
  folder: string;
}

interface LibrarySearchHit {
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  scope: string;
  kind: string;
}

interface Shelf {
  id: string;
  label: string;
  size: "large" | "small";
  color: string;
}

interface LibraryState {
  shelves: Shelf[];
  books: Record<string, string>; // book.id -> shelf.id
  priority_books?: Record<string, string | boolean>; // book.id -> tier | true (★ override)
}

type FolderImportMode = "copy" | "move";

interface FolderImportJob {
  status?: string;
  source_path?: string;
  library_path?: string;
  scanned?: number;
  processed?: number;
  copied?: number;
  moved?: number;
  skipped?: number;
  failed?: number;
  books?: number;
  error?: string;
}

const DEFAULT_SHELVES: Shelf[] = [
  { id: "harrison", label: "Harrison's Internal Medicine", size: "large", color: "#00658e" },
  { id: "general", label: "General Collection", size: "large", color: "#4338ca" },
];

function Book3D({ book, index, totalBooks, shelfHovered, size, onClick, onDragStart, coarsePointer = false }: {
  book: RemoteBook; index: number; totalBooks: number;
  shelfHovered: boolean; size: "large" | "small";
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  coarsePointer?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const w = coarsePointer ? (size === "large" ? 132 : 108) : (size === "large" ? 140 : 100);
  const h = coarsePointer ? (size === "large" ? 184 : 150) : (size === "large" ? 190 : 135);
  const spineW = size === "large" ? 12 : 8;
  const activeHover = !coarsePointer && hovered;
  const activeShelfHover = !coarsePointer && shelfHovered;

  let transform = coarsePointer ? "translateZ(0)" : `rotateY(-50deg) rotateZ(-2deg)`;
  if (activeHover) {
    transform = `rotateY(0deg) translateZ(40px) translateY(-10px)`;
  } else if (activeShelfHover) {
    const spread = (index / Math.max(totalBooks - 1, 1)) * 28;
    transform = `rotateY(-20deg) rotateZ(0deg) translateX(${spread}px)`;
  }

  const thumbUrl = `${getBackendUrl()}/library/thumb?path=${encodeURIComponent(book.id)}`;
  const [thumbReady, setThumbReady] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    setThumbReady(false);
    setThumbFailed(false);
  }, [thumbUrl]);

  return (
    <div
      draggable={!coarsePointer}
      onDragStart={event => {
        if (coarsePointer) {
          event.preventDefault();
          return;
        }
        onDragStart(event);
      }}
      onClick={onClick}
      style={{ flexShrink: 0, width: w, cursor: coarsePointer ? "pointer" : "grab", zIndex: activeHover ? 30 : 10, scrollSnapAlign: "start" }}
      onMouseEnter={() => { if (!coarsePointer) setHovered(true); }}
      onMouseLeave={() => { if (!coarsePointer) setHovered(false); }}
    >
      <div style={{
        position: "relative", width: w, height: h, background: "#fff",
        borderRadius: "0 4px 4px 0", borderLeft: `${spineW}px solid #333`,
        boxShadow: activeHover ? `-16px 20px 36px rgba(0,0,0,0.18)` : `-${spineW}px ${spineW}px ${spineW * 2}px rgba(0,0,0,0.08)`,
        transform, transformOrigin: "left center", transition: "400ms cubic-bezier(0.175, 0.885, 0.32, 1.1)", overflow: "hidden",
      }}>
        {/* Cover — placeholder gradient shown until thumbnail loads */}
        {!thumbReady && (
          <div style={{
            position: "absolute", inset: 0,
            background: `linear-gradient(135deg, hsl(${(book.title.charCodeAt(0) * 7) % 360},55%,35%), hsl(${(book.title.charCodeAt(0) * 13) % 360},45%,20%))`,
            display: "flex", alignItems: "flex-end", padding: 4,
          }}>
            <span style={{ fontSize: 7, color: "rgba(255,255,255,0.7)", lineHeight: 1.2, wordBreak: "break-word" }}>{book.title}</span>
          </div>
        )}
        {!thumbFailed && (
          <img
            src={thumbUrl}
            alt={book.title}
            loading="lazy"
            decoding="async"
            onLoad={() => setThumbReady(true)}
            onError={() => setThumbFailed(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover", opacity: thumbReady ? 1 : 0, transition: "opacity 300ms" }}
          />
        )}
        {/* Shine */}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "15%", background: "linear-gradient(to right, rgba(255,255,255,0.4), transparent)" }} />
      </div>
      {/* Tooltip equivalent title */}
      <div style={{ opacity: coarsePointer || activeHover ? 1 : 0, transition: "opacity 200ms", marginTop: 8, paddingLeft: 4 }}>
        <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {book.title}
        </p>
      </div>
    </div>
  );
}

function ShelfSection({ shelf, booksOnShelf, onSelectBook, onDrop, onDragOver, coarsePointer = false, darkModeOn = false }: {
  shelf: Shelf; booksOnShelf: RemoteBook[]; onSelectBook: (b: RemoteBook) => void;
  onDrop: (e: React.DragEvent) => void; onDragOver: (e: React.DragEvent) => void;
  coarsePointer?: boolean;
  darkModeOn?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const isLarge = shelf.size === "large";
  const activeHover = !coarsePointer && hovered;
  const shelfHeadingColor = darkModeOn ? "var(--text-primary)" : shelf.color;

  return (
    <section 
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ marginBottom: isLarge ? 40 : 0 }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
        <h2 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: isLarge ? 28 : 18, fontWeight: isLarge ? 600 : 400, color: shelfHeadingColor, letterSpacing: isLarge ? "-0.02em" : 0, lineHeight: 1 }}>
          {shelf.label}
        </h2>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.18em" }}>{booksOnShelf.length} VOLUMES</span>
      </div>

      {/* Surface */}
      <div
        onMouseEnter={() => { if (!coarsePointer) setHovered(true); }}
        onMouseLeave={() => { if (!coarsePointer) setHovered(false); }}
        style={{
          position: "relative", background: activeHover ? "var(--bg-card-hover)" : "var(--bg-card)",
          borderRadius: 12, padding: isLarge ? "40px 28px 20px" : "24px 20px 16px",
          paddingTop: activeHover ? (isLarge ? 52 : 32) : (isLarge ? 40 : 24),
          paddingBottom: activeHover ? (isLarge ? 28 : 20) : (isLarge ? 20 : 16),
          borderBottom: `${isLarge ? 8 : 6}px solid var(--border)`,
          perspective: isLarge ? "2000px" : "1500px",
          transition: `all 700ms cubic-bezier(0.175, 0.885, 0.32, 1.05)`,
          minHeight: isLarge ? 280 : 200,
        }}
      >
        <div style={{
          display: "flex",
          gap: coarsePointer ? 18 : (isLarge ? 16 : 8),
          overflowX: "auto",
          alignItems: "flex-end",
          transformStyle: coarsePointer ? "flat" : "preserve-3d",
          paddingBottom: 8,
          paddingLeft: 4,
          scrollbarWidth: "thin",
          WebkitOverflowScrolling: "touch",
          overscrollBehaviorX: "contain",
          scrollSnapType: coarsePointer ? "x proximity" : undefined,
          touchAction: "pan-x pan-y",
        }}>
          {booksOnShelf.map((book, i) => (
            <Book3D key={book.id} book={book} index={i} totalBooks={booksOnShelf.length} shelfHovered={activeHover} size={shelf.size} coarsePointer={coarsePointer} onClick={() => onSelectBook(book)} onDragStart={(e) => e.dataTransfer.setData("book_id", book.id)} />
          ))}
          {booksOnShelf.length === 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, minHeight: isLarge ? 200 : 140 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "rgba(159,168,177,0.6)", letterSpacing: "0.14em", textTransform: "uppercase" }}>{coarsePointer ? "Add books to this shelf" : "Drag books here"}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface ShelfCache {
  books: RemoteBook[];
  shelves: Shelf[];
}

function readShelfCache(): ShelfCache | null {
  try {
    const raw = localStorage.getItem(SHELF_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ShelfCache;
  } catch { return null; }
}

function writeShelfCache(books: RemoteBook[], shelves: Shelf[]) {
  try {
    localStorage.setItem(SHELF_CACHE_KEY, JSON.stringify({ books, shelves }));
  } catch { /* storage full — not critical */ }
}

const BOOK_ALIAS_TERMS: Record<string, string[]> = {
  harrison: ["harrisons", "harrison", "principles internal medicine"],
  harrisons: ["harrisons", "harrison", "principles internal medicine"],
  hpm: ["harrisons", "harrison", "principles internal medicine"],
  firstaid: ["first aid", "firstaid", "first aid usmle", "usmle step"],
  fa: ["first aid", "firstaid", "first aid usmle", "usmle step"],
};

function normalizeBookLookup(value: string) {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bookLookupText(book: RemoteBook) {
  return normalizeBookLookup(`${book.title} ${book.filename} ${book.folder} ${book.id}`);
}

function findBookFromAlias(books: RemoteBook[], value: string | null) {
  if (!value) return null;
  const normalized = normalizeBookLookup(value);
  if (!normalized) return null;
  const compact = normalized.replace(/\s+/g, "");
  const terms = (BOOK_ALIAS_TERMS[compact] ?? [normalized])
    .map(normalizeBookLookup)
    .filter(Boolean);

  let bestBook: RemoteBook | null = null;
  let bestScore = 0;
  for (const book of books) {
    const haystack = bookLookupText(book);
    let score = 0;
    for (const term of terms) {
      if (haystack === term) score += 120;
      else if (haystack.startsWith(term)) score += 70;
      else if (haystack.includes(term)) score += 30 + term.length;
    }
    if ((compact === "harrison" || compact === "harrisons" || compact === "hpm") && haystack.includes("internal medicine")) {
      score += 8;
    }
    if ((compact === "firstaid" || compact === "fa") && haystack.includes("step 1")) {
      score += 8;
    }
    if (score > bestScore) {
      bestBook = book;
      bestScore = score;
    }
  }

  return bestBook;
}

function isTypingShortcutTarget(target: EventTarget | null) {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable || Boolean(target.closest("[contenteditable='true']"));
}

export default function BookLibrary() {
  const [darkModeOn] = useDarkMode();
  const router = useRouter();
  const searchParams = useSearchParams();
  const cached = typeof window !== "undefined" ? readShelfCache() : null;
  const [books, setBooks] = useState<RemoteBook[]>(cached?.books ?? []);
  const [state, setState] = useState<LibraryState>({
    shelves: cached?.shelves ?? DEFAULT_SHELVES,
    books: {},
  });
  const [selectedBook, setSelectedBook] = useState<RemoteBook | null>(null);
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [chapterMatches, setChapterMatches] = useState<LibrarySearchHit[]>([]);
  const [archiveSearchStatus, setArchiveSearchStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [priorityBooks, setPriorityBooks] = useState<Record<string, string | boolean>>({});
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [searchIndexing, setSearchIndexing] = useState<{ status?: string; processed?: number; total?: number } | null>(null);
  const searchIndexPollRef = useRef<number | null>(null);
  const [libraryPath, setLibraryPath] = useState("");
  const [folderImportJob, setFolderImportJob] = useState<FolderImportJob | null>(null);
  const [folderImporting, setFolderImporting] = useState(false);
  const [folderImportError, setFolderImportError] = useState("");
  const [coarsePointer, setCoarsePointer] = useState(false);
  const libraryAccent = darkModeOn ? "var(--accent)" : "#00658e";
  const libraryAccentInk = darkModeOn ? "#000" : "white";
  const [readerFullscreen, setReaderFullscreen] = useState(false);
  // Resolved page the viewer should open at (null = still resolving → gate the
  // iframe so it opens directly at the resume page rather than page 1).
  const [pdfStartPage, setPdfStartPage] = useState<number | null>(null);
  const [pdfNavigationRequest, setPdfNavigationRequest] = useState<PdfNavigationRequest | null>(null);
  const folderPollRef = useRef<number | null>(null);
  const readerShellRef = useRef<HTMLDivElement | null>(null);

  const openBook = useCallback((book: RemoteBook) => {
    const normalizedPath = book.id.replaceAll("\\", "/");
    setSelectedBook(book);
    router.replace(`/library?path=${encodeURIComponent(normalizedPath)}`, { scroll: false });
  }, [router]);

  const exitReaderFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    }
  }, []);

  const toggleReaderFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    const target = readerShellRef.current;
    if (!target) return;
    if (document.fullscreenElement === target) {
      exitReaderFullscreen();
      return;
    }
    void target.requestFullscreen?.();
  }, [exitReaderFullscreen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarsePointer(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setReaderFullscreen(document.fullscreenElement === readerShellRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  useEffect(() => {
    if (!selectedBook || typeof window === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f" ||
        isTypingShortcutTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      toggleReaderFullscreen();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedBook, toggleReaderFullscreen]);

  const processFile = async (file: File) => {
    setProcessing(true);
    try {
      const pdfjsLib = await import("pdfjs-dist");
      // Use the locally-bundled worker (app/public/pdf.worker.min.mjs, version-matched
      // to pdfjs-dist), NOT the cdnjs CDN — a CDN worker fails on an offline / locked-
      // down network, so getDocument() rejects and Add-Book silently can't import PDFs.
      // Mirrors PdfViewer.tsx, which already points at the local worker.
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      
      let extractedText = "";
      const numPages = Math.min(20, pdf.numPages);
      for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        extractedText += textContent.items
          .map(item => ("str" in item ? String(item.str ?? "") : ""))
          .join(" ") + " ";
      }
      
      const analyzeRes = await fetch(`${getBackendUrl()}/ai/analyze-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: extractedText.slice(0, 8000),
          filename: file.name
        })
      });
      const analysis = await analyzeRes.json();
      const folderName = analysis.systems?.[0]?.name || "General";
      
      const formData = new FormData();
      formData.append("file", file);
      formData.append("folder", folderName);
      
      const uploadRes = await fetch(`${getBackendUrl()}/library/upload`, {
        method: "POST",
        body: formData
      });
      
      if (!uploadRes.ok) throw new Error("Upload failed");
      
      await fetchData();
      setAddPanelOpen(false);
      pollSearchIndex();

    } catch (e) {
      console.error("Error processing file", e);
      alert("Failed to process the PDF.");
    } finally {
      setProcessing(false);
    }
  };

  const toBooksMap = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, string>;
  };

  const normalizeBook = (raw: unknown): RemoteBook | null => {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const id =
      (typeof r.id === "string" && r.id) ||
      (typeof r.path === "string" && r.path) ||
      (typeof r.filepath === "string" && r.filepath) ||
      "";
    if (!id) return null;
    const cleanId = id.replaceAll("\\", "/");
    const filename =
      (typeof r.filename === "string" && r.filename) ||
      cleanId.split("/").pop() ||
      cleanId;
    const fallbackFolder = cleanId.includes("/")
      ? cleanId.split("/")[0]
      : "General";
    const folder =
      (typeof r.folder === "string" && r.folder) ||
      (typeof r.category === "string" && r.category) ||
      fallbackFolder;
    const title =
      (typeof r.title === "string" && r.title) ||
      filename.replace(/\.pdf$/i, "");
    return { id: cleanId, title, filename, folder };
  };

  const applyBooks = useCallback((loadedBooks: RemoteBook[], dataState: unknown) => {
    setBooks(loadedBooks);
    const uniqueFolders = Array.from(new Set(loadedBooks.map((b: RemoteBook) => b.folder))).filter(Boolean) as string[];
    uniqueFolders.sort((a, b) => {
      if (a === "Miscellaneous" || a === "General") return 1;
      if (b === "Miscellaneous" || b === "General") return -1;
      return a.localeCompare(b);
    });
    const dynamicShelves = uniqueFolders.length > 0
      ? uniqueFolders.map((folder, i) => ({
          id: folder.toLowerCase().replace(/[^a-z0-9]/g, "-"),
          label: folder,
          size: "large" as const,
          color: `hsl(${(i * 45) % 360}, 75%, 35%)`,
        }))
      : DEFAULT_SHELVES;
    setState({
      shelves: dynamicShelves,
      books: toBooksMap((dataState as { books?: unknown })?.books),
    });
    const rawPriority = (dataState as { priority_books?: unknown })?.priority_books;
    if (rawPriority && typeof rawPriority === "object" && !Array.isArray(rawPriority)) {
      setPriorityBooks(rawPriority as Record<string, string | boolean>);
    }
    // Persist so next page load is instant (no API wait)
    writeShelfCache(loadedBooks, dynamicShelves);
  }, []);

  // Ref kept in sync so setTimeout closures always reach the latest fetchData
  const fetchDataRef = useRef<(retry: number) => Promise<void>>(async () => {});

  const fetchData = useCallback(async (retryCount = 0) => {
    try {
      const [resBooks, resState] = await Promise.all([
        fetch(`${getBackendUrl()}/library/books`),
        fetch(`${getBackendUrl()}/library/state`)
      ]);
      if (!resBooks.ok) throw new Error(`books endpoint failed: ${resBooks.status}`);
      const dataBooks = await resBooks.json();
      const dataState = resState.ok ? await resState.json() : {};
      const rawBooks = Array.isArray(dataBooks) ? dataBooks : (dataBooks?.books || []);
      const loadedBooks = rawBooks.map(normalizeBook).filter((b: RemoteBook | null): b is RemoteBook => Boolean(b));

      if (loadedBooks.length === 0 && retryCount < 12) {
        setIndexing(true);
        setTimeout(() => fetchDataRef.current?.(retryCount + 1), 2000 * Math.min(retryCount + 1, 4));
        return;
      }

      setIndexing(false);
      applyBooks(loadedBooks, dataState);
    } catch (err) {
      console.error("Failed to load library", err);
      if (retryCount < 3) {
        setTimeout(() => fetchDataRef.current?.(retryCount + 1), 2000);
        return;
      }
      setIndexing(false);
    }
  }, [applyBooks]);

  const fetchLibraryStatus = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/library/index-status`);
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.library_path === "string") setLibraryPath(data.library_path);
    } catch (err) {
      console.error("Failed to load library status", err);
    }
  }, []);

  const pollSearchIndex = useCallback(() => {
    const tick = async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/library/index-status`);
        if (!res.ok) { setSearchIndexing(null); return; }
        const data = await res.json();
        const si = data?.search_index ?? {};
        const status = si.status as string | undefined;
        if (status === "indexing_chapters" || status === "indexing_search") {
          setSearchIndexing({ status, processed: si.processed, total: si.total });
          searchIndexPollRef.current = window.setTimeout(tick, 1500);
        } else {
          setSearchIndexing(null);
        }
      } catch { setSearchIndexing(null); }
    };
    if (searchIndexPollRef.current) window.clearTimeout(searchIndexPollRef.current);
    setSearchIndexing({ status: "indexing_chapters" });
    searchIndexPollRef.current = window.setTimeout(tick, 800);
  }, []);

  const togglePriority = useCallback(async (book: RemoteBook) => {
    const id = book.id.replaceAll("\\", "/");
    const isOn = Boolean(priorityBooks[id]);
    setPriorityBusy(true);
    setPriorityBooks(prev => {
      const next = { ...prev };
      if (isOn) delete next[id]; else next[id] = "gold";
      return next;
    });
    try {
      const res = await fetch(`${getBackendUrl()}/library/priority`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book_id: id, priority: !isOn, tier: "gold" }),
      });
      if (!res.ok) throw new Error("priority update failed");
      const data = await res.json();
      if (data?.priority_books && typeof data.priority_books === "object") {
        setPriorityBooks(data.priority_books as Record<string, string | boolean>);
      }
    } catch {
      setPriorityBooks(prev => {
        const next = { ...prev };
        if (isOn) next[id] = "gold"; else delete next[id];
        return next;
      });
    } finally {
      setPriorityBusy(false);
    }
  }, [priorityBooks]);

  const pollFolderImport = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/library/import-folder/status`);
      if (!res.ok) throw new Error(`status failed: ${res.status}`);
      const job = await res.json();
      setFolderImportJob(job);

      if (job.status === "completed") {
        setFolderImporting(false);
        await fetchData();
        await fetchLibraryStatus();
        pollSearchIndex();
        return;
      }
      if (job.status === "failed") {
        setFolderImporting(false);
        setFolderImportError(job.error || "Folder import failed");
        return;
      }
      folderPollRef.current = window.setTimeout(() => pollFolderImport(), 1200);
    } catch (err) {
      setFolderImporting(false);
      setFolderImportError(err instanceof Error ? err.message : "Folder import status failed");
    }
  }, [fetchData, fetchLibraryStatus, pollSearchIndex]);

  const handleFolderImport = useCallback(async (
    sourcePath: string,
    options: { mode: FolderImportMode; recursive: boolean; overwrite: boolean },
  ) => {
    const cleaned = sourcePath.trim();
    if (!cleaned) return;
    if (folderPollRef.current) window.clearTimeout(folderPollRef.current);
    setFolderImportError("");
    setFolderImporting(true);
    setFolderImportJob({ status: "queued", source_path: cleaned });

    try {
      const res = await fetch(`${getBackendUrl()}/library/import-folder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_path: cleaned,
          mode: options.mode,
          recursive: options.recursive,
          overwrite: options.overwrite,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.detail === "string" ? data.detail : `Import failed: ${res.status}`);
      }
      setFolderImportJob(data);
      folderPollRef.current = window.setTimeout(() => pollFolderImport(), 500);
    } catch (err) {
      setFolderImporting(false);
      setFolderImportError(err instanceof Error ? err.message : "Folder import failed");
    }
  }, [pollFolderImport]);

  // Keep ref current so retries never call a stale closure
  useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { fetchLibraryStatus(); }, [fetchLibraryStatus]);
  useEffect(() => () => {
    if (folderPollRef.current) window.clearTimeout(folderPollRef.current);
    if (searchIndexPollRef.current) window.clearTimeout(searchIndexPollRef.current);
  }, []);

  useEffect(() => {
    const path = searchParams.get("path");
    const bookAlias = searchParams.get("book");
    if (!path && !bookAlias) {
      setSelectedBook(current => current ? null : current);
      return;
    }
    if (books.length === 0) return;
    const normalizedPath = path?.replaceAll("\\", "/");
    const match = normalizedPath
      ? books.find(b => b.id === normalizedPath)
      : findBookFromAlias(books, bookAlias);
    if (match) {
      setSelectedBook(current => current?.id === match.id ? current : match);
    } else if (!match && bookAlias && !searchQuery.trim()) {
      setSearchQuery(bookAlias.replace(/[-_]+/g, " "));
    }
  }, [searchParams, books, searchQuery]);

  useEffect(() => {
    if (!selectedBook) return;
    const normalizedPath = selectedBook.id.replaceAll("\\", "/");
    recordRecent({
      tag: "BOOK",
      label: selectedBook.title,
      href: `/library?path=${encodeURIComponent(normalizedPath)}`,
      source: "library",
      kind: "book",
      detail: selectedBook.folder,
    });
  }, [selectedBook]);

  // Resolve which page to open at: an explicit ?page= deep-link wins, otherwise
  // the last page the user read (persisted via the viewer's page reports).
  useEffect(() => {
    if (!selectedBook) {
      setPdfStartPage(null);
      setPdfNavigationRequest(null);
      return;
    }
    const urlPage = searchParams.get("page");
    const explicitPage = parsePdfPage(urlPage);
    if (explicitPage !== null) {
      setPdfStartPage(explicitPage);
      setPdfNavigationRequest(createPdfNavigationRequest(explicitPage, "route"));
      return;
    }
    let alive = true;
    setPdfStartPage(null);
    loadScroll(bookScrollHref(selectedBook.id)).then(saved => {
      if (!alive) return;
      const resolved = resolvePdfStartPage(null, saved?.y);
      setPdfStartPage(resolved.page);
      setPdfNavigationRequest(createPdfNavigationRequest(resolved.page, resolved.source));
    });
    return () => { alive = false; };
  }, [selectedBook, searchParams]);

  // Next.js does not rerender an identical URL. A narrow activation event lets
  // search/index/recents reissue the same book+page request without polluting
  // permanent history with a synthetic token.
  useEffect(() => {
    if (!selectedBook) return;
    const onActivation = (event: Event) => {
      const request = requestFromLibraryPdfActivation(
        (event as CustomEvent).detail,
        selectedBook.id,
      );
      if (!request) return;
      setPdfStartPage(request.page);
      setPdfNavigationRequest(request);
    };
    window.addEventListener(PDF_NAVIGATION_ACTIVATION_EVENT, onActivation);
    return () => window.removeEventListener(PDF_NAVIGATION_ACTIVATION_EVENT, onActivation);
  }, [selectedBook]);

  // Persist the current page as the user reads (reported by the pdf.js viewer).
  // saveScroll also refreshes the resume pointer's page since the key matches
  // the book's recents href.
  useEffect(() => {
    if (!selectedBook) return;
    const onMsg = createPdfPageReportHandler(selectedBook.id);
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [selectedBook]);

  const saveState = async (newState: LibraryState) => {
    setState(newState);
    try {
      await fetch(`${getBackendUrl()}/library/state`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newState),
      });
    } catch (e) { console.error("Save failed", e); }
  };

  const handleDeleteBook = useCallback(async (book: RemoteBook) => {
    const normalizedPath = book.id.replaceAll("\\", "/");
    const confirmed = window.confirm(
      `Delete "${book.title}" from the bookshelf?\n\nThis removes the PDF and its search index entries.`
    );
    if (!confirmed) return;

    setDeletingBookId(book.id);
    try {
      const res = await fetch(`${getBackendUrl()}/library/book?path=${encodeURIComponent(normalizedPath)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.detail === "string" ? data.detail : `Delete failed: ${res.status}`);
      }

      const remainingBooks = books.filter(b => b.id !== book.id);
      const nextAssignments = { ...state.books };
      delete nextAssignments[book.id];
      delete nextAssignments[normalizedPath];
      const nextState = { ...state, books: nextAssignments };

      setSelectedBook(null);
      setBooks(remainingBooks);
      setState(nextState);
      writeShelfCache(remainingBooks, nextState.shelves);
      router.replace("/library", { scroll: false });
      await fetchData();
      await fetchLibraryStatus();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingBookId(null);
    }
  }, [books, fetchData, fetchLibraryStatus, router, state]);

  const onDrop = (e: React.DragEvent, shelfId: string) => {
    const bookId = e.dataTransfer.getData("book_id");
    if (bookId) {
      const newState = { ...state, books: { ...state.books, [bookId]: shelfId } };
      saveState(newState);
    }
  };

  const filteredBooks = useMemo(() => rankBookMatches(books, searchQuery), [books, searchQuery]);
  const searchActive = Boolean(searchQuery.trim());

  useEffect(() => {
    const query = searchQuery.replace(/\s+/g, " ").trim();
    if (query.length < 2) {
      setChapterMatches([]);
      setArchiveSearchStatus(query ? "ready" : "idle");
      return;
    }

    const controller = new AbortController();
    setArchiveSearchStatus("loading");
    const timer = window.setTimeout(async () => {
      const params = buildPreviewSearchParams(query, "books");
      params.set("limit", "24");
      try {
        const response = await fetch(`${getBackendUrl()}/search?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Chapter search failed (${response.status})`);
        const payload = await response.json() as { results?: LibrarySearchHit[] };
        const next = (Array.isArray(payload.results) ? payload.results : [])
          .filter((item) => item.scope === "books" && item.kind === "chapter" && Boolean(item.href))
          .slice(0, 24);
        if (!controller.signal.aborted) {
          setChapterMatches(next);
          setArchiveSearchStatus("ready");
        }
      } catch {
        if (!controller.signal.aborted) {
          setChapterMatches([]);
          setArchiveSearchStatus("error");
        }
      }
    }, 130);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);

  if (selectedBook) {
    const normalizedBookPath = pdfViewerKeyForBook(selectedBook.id);
    const rawPdfUrl = `${getBackendUrl()}/library/pdf?path=${encodeURIComponent(normalizedBookPath)}`;
    const page = pdfStartPage ?? 1;
    const pdfReady = pdfStartPage !== null;
    return (
      <div
        ref={readerShellRef}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: readerFullscreen ? "100vh" : "100%",
          width: readerFullscreen ? "100vw" : "100%",
          overflow: "hidden",
          background: "#1f1f1f",
          position: "relative",
        }}
      >
        {/* ── Viewer header ── */}
        <div style={{
          padding: "10px 20px", background: "var(--bg-card)",
          display: readerFullscreen ? "none" : "flex", alignItems: "center", gap: 16,
          borderBottom: "1px solid var(--border)", flexShrink: 0,
        }}>
          <button
            onClick={() => { setSelectedBook(null); router.replace("/library", { scroll: false }); }}
            style={{
              background: "none", border: "none", cursor: "pointer", color: libraryAccent,
              display: "flex", alignItems: "center", gap: 6,
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
              letterSpacing: "0.12em", textTransform: "uppercase",
            }}
          >
            <ArrowLeft size={13} /> Back to Library
          </button>

          <h2 style={{
            fontFamily: "'Newsreader', Georgia, serif", fontSize: 15,
            color: "var(--text-primary)", margin: 0, flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {selectedBook.title}
          </h2>

          {(() => {
            const isPriority = Boolean(priorityBooks[selectedBook.id.replaceAll("\\", "/")]);
            return (
              <button
                onClick={() => void togglePriority(selectedBook)}
                disabled={priorityBusy}
                title={isPriority ? "Priority reference — ranked first in search. Click to unmark." : "Mark as a priority (gold-standard) reference so it ranks first in search"}
                style={{
                  border: `1px solid ${isPriority ? "#c9973c" : "var(--border)"}`,
                  background: isPriority ? "rgba(201,151,60,0.12)" : "transparent",
                  color: isPriority ? "#c9973c" : "var(--text-muted)",
                  cursor: priorityBusy ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 8px",
                  borderRadius: 6,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 9,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  flexShrink: 0,
                }}
              >
                <Star size={13} fill={isPriority ? "#c9973c" : "none"} />
                {isPriority ? "Priority" : "Prioritize"}
              </button>
            );
          })()}

          <button
            onClick={() => void handleDeleteBook(selectedBook)}
            disabled={deletingBookId === selectedBook.id}
            title="Delete book"
            style={{
              border: "1px solid var(--border)",
              background: deletingBookId === selectedBook.id ? "var(--bg-subtle)" : "transparent",
              color: "#9f1239",
              cursor: deletingBookId === selectedBook.id ? "wait" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 8px",
              borderRadius: 6,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              flexShrink: 0,
            }}
          >
            <Trash2 size={13} />
            {deletingBookId === selectedBook.id ? "Deleting" : "Delete"}
          </button>

          <button
            onClick={toggleReaderFullscreen}
            title="Full screen (F)"
            style={{
              border: "1px solid var(--border)",
              background: "transparent",
              color: libraryAccent,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 8px",
              borderRadius: 6,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              flexShrink: 0,
            }}
          >
            <Maximize2 size={13} />
            Full
          </button>

          <a
            href={rawPdfUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
              letterSpacing: "0.12em", textTransform: "uppercase",
              color: libraryAccent, textDecoration: "none", flexShrink: 0,
            }}
          >
            Open direct ↗
          </a>
        </div>

        {readerFullscreen && (
          <button
            onClick={exitReaderFullscreen}
            title="Exit full screen"
            aria-label="Exit full screen"
            style={{
              position: "absolute",
              right: 18,
              bottom: 18,
              zIndex: 20,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "rgba(20,20,20,0.72)",
              color: "#f5f3ef",
              cursor: "pointer",
              width: 34,
              height: 34,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backdropFilter: "blur(8px)",
            }}
          >
            <Minimize2 size={15} />
          </button>
        )}

        {pdfReady ? (
          <PdfViewer
            key={normalizedBookPath}
            url={rawPdfUrl}
            initialPage={page}
            navigationRequest={pdfNavigationRequest}
          />
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#2d2d2d", color: "#9ca3af", fontSize: 13 }}>
            <div className="loader" style={{ marginRight: 10 }} /> Opening…
          </div>
        )}
      </div>
    );
  }

  // Map books to shelves
  const shelfMap: Record<string, RemoteBook[]> = {};
  state.shelves.forEach(s => shelfMap[s.id] = []);
  shelfMap["general"] = shelfMap["general"] || [];

  filteredBooks.forEach(book => {
    // Check if user specifically assigned it
    let sid = state.books[book.id];
    // Auto-assignment rules based on the folder it is currently in
    if (!sid) {
      sid = book.folder.toLowerCase().replace(/[^a-z0-9]/g, "-");
    }
    
    // Fallback if the shelf doesn't exist for some reason
    if (!shelfMap[sid]) {
       // Just put it in the first available shelf if it somehow gets orphaned
       sid = Object.keys(shelfMap)[0];
    }
    if (shelfMap[sid]) {
       shelfMap[sid].push(book);
    }
  });

  return (
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg-base)" }}>
      {/* Header */}
      <div style={{ padding: coarsePointer ? "14px 18px" : "16px 36px 14px", background: "var(--chrome-bg)", backdropFilter: "blur(8px)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, flexWrap: coarsePointer ? "wrap" : "nowrap", gap: coarsePointer ? 12 : 0 }}>
        <div>
          <h1 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 22, fontWeight: 600, color: libraryAccent, letterSpacing: "-0.02em" }}>Clinical Archivist</h1>
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-muted)", marginTop: 2 }}>
            Medical Library · {indexing ? (
              <span style={{ color: "#c9973c" }}>indexing…</span>
            ) : `${books.length} volumes`}
            {searchIndexing && (
              <span style={{ color: "#c9973c" }}>
                {" · "}
                {searchIndexing.status === "indexing_search"
                  ? "updating search index…"
                  : searchIndexing.total
                    ? `indexing chapters ${searchIndexing.processed ?? 0}/${searchIndexing.total}…`
                    : "indexing chapters…"}
              </span>
            )}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ position: "relative" }}>
            <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search titles or chapters…" aria-label="Search book titles and chapters" style={{ background: "var(--bg-card)", border: "none", borderBottom: "1.5px solid var(--border)", padding: "6px 12px 6px 30px", fontFamily: "'Newsreader', serif", fontSize: coarsePointer ? 16 : 13, color: "var(--text-primary)", outline: "none", width: coarsePointer ? "min(52vw, 320px)" : 220 }} />
          </div>
          <button onClick={() => setAddPanelOpen(true)} style={{ background: libraryAccent, color: libraryAccentInk, padding: "6px 12px", border: "none", borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.1em", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={12} /> ADD BOOK
          </button>
        </div>
      </div>

      {/* Main Shelves */}
      <div style={{ flex: 1, overflowY: "auto", padding: coarsePointer ? "24px 18px 72px" : "32px 36px 60px", WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}>
        {searchActive ? (
          <div>
            <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 20, color: "var(--text-muted)", fontSize: 12 }}>
              <span>{filteredBooks.length} book match{filteredBooks.length === 1 ? "" : "es"} · {chapterMatches.length} chapter match{chapterMatches.length === 1 ? "" : "es"}</span>
              {archiveSearchStatus === "loading" && <span>Searching the chapter index…</span>}
              {archiveSearchStatus === "error" && <span>Chapter index unavailable; title matches are still shown.</span>}
            </div>

            {filteredBooks.length > 0 && (
              <ShelfSection
                shelf={{ id: "search-results", label: "Book matches", size: "large", color: libraryAccent }}
                booksOnShelf={filteredBooks}
                coarsePointer={coarsePointer}
                darkModeOn={darkModeOn}
                onSelectBook={openBook}
                onDrop={() => undefined}
                onDragOver={(event) => event.preventDefault()}
              />
            )}

            {chapterMatches.length > 0 && (
              <section style={{ marginTop: filteredBooks.length ? 4 : 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
                  <h2 style={{ margin: 0, fontFamily: "'Newsreader', Georgia, serif", fontSize: 24, color: "var(--text-primary)" }}>Chapter matches</h2>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.12em" }}>{chapterMatches.length} RESULTS</span>
                </div>
                <div style={{ display: "grid", gap: 7 }}>
                  {chapterMatches.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => router.push(item.href)}
                      style={{ display: "grid", gap: 3, width: "100%", padding: "11px 13px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)", color: "var(--text-primary)", textAlign: "left", cursor: "pointer" }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{item.title}</span>
                      {item.subtitle && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{item.subtitle}</span>}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {archiveSearchStatus !== "loading" && filteredBooks.length === 0 && chapterMatches.length === 0 && (
              <div style={{ display: "grid", placeItems: "center", minHeight: 220, padding: 24, border: "1px dashed var(--border)", borderRadius: 12, color: "var(--text-muted)", textAlign: "center" }}>
                <div><Search size={24} style={{ margin: "0 auto 10px" }} /><strong style={{ display: "block", color: "var(--text-primary)", marginBottom: 4 }}>No matching books or chapters</strong><span>Try a book title, author, specialty, or chapter topic.</span></div>
              </div>
            )}
          </div>
        ) : (
          state.shelves.map(shelf => (
            <ShelfSection key={shelf.id} shelf={shelf} booksOnShelf={shelfMap[shelf.id]} coarsePointer={coarsePointer} darkModeOn={darkModeOn} onSelectBook={openBook} onDrop={(e) => onDrop(e, shelf.id)} onDragOver={(e) => e.preventDefault()} />
          ))
        )}
      </div>
      
      <AddBookPanel 
        open={addPanelOpen} 
        onClose={() => setAddPanelOpen(false)} 
        onBookAdded={() => {}} 
        processFile={processFile} 
        processing={processing} 
        importFolder={handleFolderImport}
        folderImportJob={folderImportJob}
        folderImporting={folderImporting}
        folderImportError={folderImportError}
        libraryPath={libraryPath}
      />
    </div>
  );
}
