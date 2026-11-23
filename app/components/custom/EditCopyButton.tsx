"use client";
import { useState } from "react";
import { FilePenLine, Loader2 } from "lucide-react";
import { makeCopy } from "@/lib/customLibrary";

interface Props {
  source: "uworld" | "amboss" | "utd" | string;
  refId: string | number;
  title: string;
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

export function openCustomDoc(nodeId: string, title: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("TabBar:open", {
    detail: { href: `/library/custom?doc=${encodeURIComponent(nodeId)}`, title },
  }));
}

/**
 * Opens (or reopens) a private editable copy of the current vendor article.
 * The copy is stored in the custom library and never written back to the
 * vendor bundle, so the original stays untouched.
 */
export default function EditCopyButton({
  source,
  refId,
  title,
  className,
  showLabel = false,
}: Props) {
  const [busy, setBusy] = useState(false);

  async function editCopy() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await makeCopy({ source, refId: String(refId), title });
      openCustomDoc(result.node.id, `${title} · editable copy`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not create an editable copy.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={editCopy}
      className={className}
      style={className ? undefined : defaultStyle()}
      title="Edit a copy of this article"
      aria-label="Edit a copy of this article"
      disabled={busy}
    >
      {busy ? <Loader2 size={showLabel ? 14 : 17} className="medos-spin" /> : <FilePenLine size={showLabel ? 14 : 17} />}
      {showLabel && <span>Edit copy</span>}
    </button>
  );
}
