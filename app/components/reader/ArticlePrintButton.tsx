"use client";

import { useCallback, useEffect } from "react";
import type { RefObject } from "react";
import { Printer } from "lucide-react";
import { getBackendUrl } from "../../lib/api";

export type ArticlePrintSource = "utd" | "amboss" | "uworld";

const PRINT_PATHS = {
  utd: (id: number) => `/utd/topic/${id}/print`,
  amboss: (id: number) => `/amboss/article/${id}/print`,
  uworld: (id: number) => `/uworld-library/article/${id}/print`,
} as const;

export function openArticlePrint(
  source: ArticlePrintSource,
  articleId: number,
  title: string,
): boolean {
  if (typeof window === "undefined") return false;
  const url = `${getBackendUrl()}${PRINT_PATHS[source](articleId)}`;
  const opened = window.open("", "_blank");
  if (!opened) {
    window.MedOSMedia?.notify(
      `Allow pop-ups to open the complete print view for ${title}.`,
      "error",
    );
    return false;
  }
  opened.name = "medos-print-preview";
  opened.opener = null;
  opened.location.replace(url);
  return true;
}

interface PrintHandlerOptions {
  openPrint: () => void;
  getFrameWindow: () => Window | null;
  target?: Window;
}

export function installArticlePrintHandlers({
  openPrint,
  getFrameWindow,
  target = window,
}: PrintHandlerOptions): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "p") return;
    event.preventDefault();
    openPrint();
  };
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type !== "medos_print_article") return;
    const expectedFrame = getFrameWindow();
    if (!expectedFrame || event.source !== expectedFrame) return;
    openPrint();
  };
  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("message", onMessage);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("message", onMessage);
  };
}

interface ArticlePrintButtonProps {
  source: ArticlePrintSource;
  articleId: number;
  title: string;
  frameRef: RefObject<HTMLIFrameElement | null>;
  className?: string;
  compact?: boolean;
}

export default function ArticlePrintButton({
  source,
  articleId,
  title,
  frameRef,
  className,
  compact = false,
}: ArticlePrintButtonProps) {
  const openPrint = useCallback(
    () => openArticlePrint(source, articleId, title),
    [source, articleId, title],
  );

  useEffect(
    () => installArticlePrintHandlers({
      openPrint,
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
    }),
    [frameRef, openPrint],
  );

  return (
    <button
      type="button"
      className={className}
      onClick={openPrint}
      aria-label={`Print / PDF: ${title}`}
      title="Open complete article for native print or PDF"
      style={compact ? undefined : {
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 9px",
        fontSize: 11,
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        cursor: "pointer",
        color: "var(--text-secondary)",
      }}
    >
      <Printer size={compact ? 18 : 11} aria-hidden="true" />
      <span>{compact ? "Print" : "Print / PDF"}</span>
    </button>
  );
}
