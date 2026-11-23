export type ParamReader = { get(name: string): string | null };

export interface Vendor {
  label: string;
  href: string;
  bank: string;
  color: string;
  pack?: string;
}

export interface Leaf {
  label: string;
  href: string;
  tag: string;
  glyph: string;
  isActive: (path: string, sp: ParamReader) => boolean;
  /** Pack id gating this leaf (see PACKS in app/backend/packs.py); undefined = always-on (core). */
  pack?: string;
}

export interface Step {
  id: string;
  label: string;
  vendors: Vendor[];
}

export interface Group {
  id: string;
  label: string;
  href: string;
  tag: string;
  glyph: string;
  isActive: (path: string) => boolean;
  steps?: Step[];
  leaves?: Leaf[];
}

export const startsWith = (path: string, base: string) => path === base || path.startsWith(base + "/");

export const GROUPS: Group[] = [
  {
    id: "qbank", label: "Q-Bank", href: "/qbank", tag: "QBank", glyph: "quiz",
    isActive: (p) => startsWith(p, "/qbank"),
  },
  {
    id: "db", label: "Databases", href: "/uptodate", tag: "UTD", glyph: "database",
    isActive: (p) => ["/uptodate", "/amboss", "/library", "/diseases", "/drugs", "/sanford", "/utdddx"].some((b) => startsWith(p, b)),
    leaves: [
      { label: "My Library", href: "/library/custom", tag: "Custom", glyph: "bookmark", isActive: (p) => startsWith(p, "/library/custom") },
      { label: "UpToDate", href: "/uptodate", tag: "UTD", glyph: "clinical_notes", isActive: (p) => startsWith(p, "/uptodate"), pack: "uptodate" },
      { label: "AMBOSS", href: "/amboss", tag: "AMBOSS", glyph: "local_library", isActive: (p) => startsWith(p, "/amboss"), pack: "amboss" },
      { label: "UWorld Library", href: "/library/uworld", tag: "UWL", glyph: "library_books", isActive: (p) => startsWith(p, "/library/uworld"), pack: "uworld-step1" },
      { label: "Bookshelf", href: "/library", tag: "Book", glyph: "auto_stories", isActive: (p) => p === "/library", pack: "books" },
      { label: "Diseases", href: "/diseases", tag: "DB", glyph: "coronavirus", isActive: (p) => startsWith(p, "/diseases") },
      { label: "Drug Reference", href: "/drugs", tag: "Drug Ref", glyph: "medication", isActive: (p) => startsWith(p, "/drugs") },
      { label: "Sanford Guide", href: "/sanford", tag: "Sanford", glyph: "health_and_safety", isActive: (p) => startsWith(p, "/sanford") },
      { label: "UTD DDx", href: "/utdddx", tag: "DDx", glyph: "account_tree", isActive: (p) => startsWith(p, "/utdddx") },
    ],
  },
  {
    id: "atlas", label: "3D Atlas", href: "/anatomy", tag: "Anat", glyph: "view_in_ar",
    isActive: (p) => startsWith(p, "/anatomy"),
    leaves: [
      { label: "3D Anatomy", href: "/anatomy", tag: "Anat", glyph: "accessibility_new", isActive: (p, sp) => p === "/anatomy" && sp.get("ortho") !== "1" },
      { label: "Orthopedics", href: "/anatomy?ortho=1", tag: "Ortho", glyph: "orthopedics", isActive: (p, sp) => p === "/anatomy" && sp.get("ortho") === "1" },
    ],
  },
  {
    id: "emergency", label: "Emergency", href: "/acls", tag: "ACLS", glyph: "e911_emergency",
    isActive: (p) => startsWith(p, "/acls"),
    leaves: [
      { label: "Code — Cardiac Arrest", href: "/acls?algo=cardiac-arrest", tag: "CODE", glyph: "ecg_heart", isActive: (p, sp) => startsWith(p, "/acls") && sp.get("algo") === "cardiac-arrest" },
      { label: "Bradycardia", href: "/acls?algo=bradycardia", tag: "ACLS", glyph: "monitor_heart", isActive: (p, sp) => startsWith(p, "/acls") && sp.get("algo") === "bradycardia" },
      { label: "Tachycardia", href: "/acls?algo=tachycardia", tag: "ACLS", glyph: "cardiology", isActive: (p, sp) => startsWith(p, "/acls") && sp.get("algo") === "tachycardia" },
      { label: "Post-Arrest Care", href: "/acls?algo=post-arrest", tag: "ACLS", glyph: "respiratory_rate", isActive: (p, sp) => startsWith(p, "/acls") && sp.get("algo") === "post-arrest" },
    ],
  },
  {
    id: "tools", label: "Tools", href: "/calculators", tag: "Calc", glyph: "build",
    isActive: (p) => ["/calculators", "/umls", "/anki", "/differential", "/labs", "/graph", "/lexi", "/chat", "/pathways"].some((b) => startsWith(p, b)),
    leaves: [
      { label: "UpToDate Pathways", href: "/pathways", tag: "Path", glyph: "fork_right", isActive: (p) => startsWith(p, "/pathways") },
      { label: "Calculators", href: "/calculators", tag: "Calc", glyph: "calculate", isActive: (p) => startsWith(p, "/calculators") },
      { label: "Lexi", href: "/lexi", tag: "Lexi", glyph: "function", isActive: (p) => startsWith(p, "/lexi"), pack: "drugs-pro" },
      { label: "Chat", href: "/chat", tag: "Chat", glyph: "forum", isActive: (p) => startsWith(p, "/chat") },
      { label: "UMLS Lookup", href: "/umls", tag: "UMLS", glyph: "hub", isActive: (p) => startsWith(p, "/umls") },
      { label: "Flashcards", href: "/anki", tag: "Anki", glyph: "style", isActive: (p) => startsWith(p, "/anki"), pack: "anki" },
      { label: "Differential", href: "/differential", tag: "Ddx", glyph: "account_tree", isActive: (p) => startsWith(p, "/differential"), pack: "umls-full" },
      { label: "Lab Panels", href: "/labs", tag: "Labs", glyph: "science", isActive: (p) => startsWith(p, "/labs") },
      { label: "Concept Graph", href: "/graph", tag: "Graph", glyph: "bubble_chart", isActive: (p) => startsWith(p, "/graph"), pack: "umls-full" },
    ],
  },
];
