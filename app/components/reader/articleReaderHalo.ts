import type { ContextCommand } from "@/components/touch/TouchInteractionProvider";
import type { MediaDescriptor } from "@/lib/mediaInterop";

type AddToTray = (descriptor: Readonly<MediaDescriptor>) => unknown;

interface SharedArticleCommandOptions {
  articleId: number;
  title: string;
  addToTray: AddToTray;
  openPrint: () => void;
  returnToReading: () => void;
}

interface UtdArticleCommandOptions extends SharedArticleCommandOptions {
  hasOutline: boolean;
  hasImages: boolean;
  hasRelated: boolean;
  openContents: (target: "outline" | "topics") => void;
  openFind: () => void;
  openImages: () => void;
  openRelated: () => void;
}

interface LibraryArticleCommandOptions extends SharedArticleCommandOptions {
  source: "amboss" | "uworld";
  hasImages: boolean;
  openPanel: (tab: "contents" | "images" | "related") => void;
  focusSearch: () => void;
}

const ARTICLE_TITLE_LIMIT = 160;

function boundedTitle(title: string, articleId: number) {
  return (title.trim().replace(/\s+/g, " ") || `Article ${articleId}`).slice(0, ARTICLE_TITLE_LIMIT);
}

function articleDescriptor(
  source: "utd" | "amboss" | "uworld",
  articleId: number,
  title: string,
): MediaDescriptor {
  const safeTitle = boundedTitle(title, articleId);
  const details = {
    utd: { label: "UpToDate", sourceUrl: `/uptodate?t=${articleId}` },
    amboss: { label: "AMBOSS", sourceUrl: `/amboss?doc=${articleId}` },
    uworld: { label: "UWorld Library", sourceUrl: `/library/uworld?doc=${articleId}` },
  }[source];
  return {
    kind: "excerpt",
    title: safeTitle,
    source: details.label,
    sourceUrl: details.sourceUrl,
    plainText: safeTitle,
  };
}

function coreCommands(
  source: "utd" | "amboss" | "uworld",
  options: SharedArticleCommandOptions,
): ContextCommand[] {
  return [
    {
      id: `${source}-reading`,
      label: "Reading",
      mode: "read",
      glyph: "menu_book",
      description: "Return focus to the article",
      run: options.returnToReading,
    },
    {
      id: `${source}-save`,
      label: "Save article",
      mode: "collect",
      glyph: "bookmark_add",
      description: "Add this article to the media tray",
      run: () => { options.addToTray(articleDescriptor(source, options.articleId, options.title)); },
    },
    {
      id: `${source}-print`,
      label: "Print / PDF",
      mode: "read",
      glyph: "print",
      description: "Open the complete print view",
      run: options.openPrint,
    },
  ];
}

export function buildUtdReaderHaloCommands(options: UtdArticleCommandOptions): ContextCommand[] {
  return [
    {
      id: "utd-contents",
      label: "Contents",
      mode: "read",
      glyph: "toc",
      description: "Open topic contents",
      run: () => options.openContents(options.hasOutline ? "outline" : "topics"),
    },
    {
      id: "utd-find",
      label: "Find",
      mode: "read",
      glyph: "find_in_page",
      description: "Find within this topic",
      run: options.openFind,
    },
    ...(options.hasImages ? [{
      id: "utd-images",
      label: "Images",
      mode: "read" as const,
      glyph: "image",
      description: "Open related figures and tables",
      run: options.openImages,
    }] : []),
    ...(options.hasRelated ? [{
      id: "utd-related",
      label: "Related",
      mode: "read" as const,
      glyph: "link",
      description: "Open related topics and graphics",
      run: options.openRelated,
    }] : []),
    ...coreCommands("utd", options),
  ];
}

export function buildLibraryReaderHaloCommands(options: LibraryArticleCommandOptions): ContextCommand[] {
  const prefix = options.source;
  return [
    {
      id: `${prefix}-contents`,
      label: "Contents",
      mode: "read",
      glyph: "toc",
      description: "Open the article library",
      run: () => options.openPanel("contents"),
    },
    {
      id: `${prefix}-find`,
      label: "Find",
      mode: "read",
      glyph: "find_in_page",
      description: "Focus the existing article search",
      run: () => {
        options.openPanel("contents");
        options.focusSearch();
      },
    },
    ...(options.hasImages ? [{
      id: `${prefix}-images`,
      label: "Images",
      mode: "read" as const,
      glyph: "image",
      description: "Open article images",
      run: () => options.openPanel("images"),
    }] : []),
    {
      id: `${prefix}-related`,
      label: "Related",
      mode: "read",
      glyph: "link",
      description: "Open related library content",
      run: () => options.openPanel("related"),
    },
    ...coreCommands(prefix, options),
  ];
}

export function registerArticleReaderHaloCommands(
  commands: readonly ContextCommand[],
  register: (command: ContextCommand) => () => void,
) {
  const disposers = commands.map(command => register(command));
  return () => disposers.forEach(dispose => dispose());
}

export function createDeferredFocusController(
  requestFrame: (callback: () => void) => number,
  cancelFrame: (frameId: number) => void,
) {
  let pendingFrame: number | null = null;
  return {
    schedule(focus: () => void) {
      if (pendingFrame !== null) cancelFrame(pendingFrame);
      pendingFrame = requestFrame(() => {
        pendingFrame = null;
        focus();
      });
    },
    cancel() {
      if (pendingFrame === null) return;
      cancelFrame(pendingFrame);
      pendingFrame = null;
    },
  };
}
