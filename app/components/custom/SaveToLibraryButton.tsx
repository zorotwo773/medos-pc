"use client";
import { useEffect, useState } from "react";
import { Bookmark, BookmarkCheck, Loader2 } from "lucide-react";
import { saveItem } from "@/lib/customLibrary";

interface Props {
  source: "uworld" | "amboss" | "utd" | string;
  refId: string | number;
  title: string;
  href: string;
  className?: string;
  showLabel?: boolean;
}

function defaultStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: "3px 8px",
    minWidth: 30,
    height: 28,
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
    color: "var(--text-secondary)",
    fontSize: 10.5,
    fontWeight: 700,
    flexShrink: 0,
  };
}

/** Marks the open article into the Custom Library (root level). */
export default function SaveToLibraryButton({
  source,
  refId,
  title,
  href,
  className,
  showLabel = false,
}: Props) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // The toolbar stays mounted while the reader switches articles, so clear the
  // saved check when the target changes.
  useEffect(() => {
    setSaved(false);
  }, [source, refId]);

  async function mark() {
    if (busy) return;
    setBusy(true);
    try {
      await saveItem({ source, refId: String(refId), title, href });
      setSaved(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not save this article.");
    } finally {
      setBusy(false);
    }
  }

  const Icon = saved ? BookmarkCheck : Bookmark;

  return (
    <button
      type="button"
      onClick={mark}
      className={className}
      style={className ? undefined : defaultStyle()}
      title={saved ? "Saved to Custom Library" : "Save to Custom Library"}
      aria-label={saved ? "Saved to Custom Library" : "Save to Custom Library"}
      aria-pressed={saved}
      disabled={busy}
    >
      {busy ? (
        <Loader2 size={showLabel ? 14 : 17} className="medos-spin" />
      ) : (
        <Icon size={showLabel ? 14 : 17} color={saved ? "#16a34a" : undefined} />
      )}
      {showLabel && <span>{saved ? "Saved" : "Save"}</span>}
    </button>
  );
}
