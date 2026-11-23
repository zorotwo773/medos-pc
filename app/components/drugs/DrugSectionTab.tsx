"use client";
import { createContext, useContext, useState } from "react";
import { ReferenceLayer } from "@/components/common/ReferenceLayer";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import type { DrugSection } from "@/types/drugs";

/** Drug id for the profile currently on screen. Lets reference underlines use the
 *  precomputed /reference/doc-terms list (hub source "drugs") instead of a live
 *  whole-section scan. Null → live-scan fallback (no regression). */
export const DrugIdContext = createContext<number | string | null>(null);

interface Props {
  section: DrugSection | undefined;
  label?: string;
  defaultExpanded?: boolean;
}

const SourceBadge = ({ source }: { source: "mm" | "utd" }) => (
  <span className={`drug-section-badge ${source}`} style={{ marginLeft: 6 }}>
    {source === "mm" ? "Micromedex" : "UpToDate"}
  </span>
);

function textToHtml(value?: string) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br />")
    .replace(/^(.+)$/, "<p>$1</p>");
}

export function DrugSectionContent({ section }: { section: DrugSection }) {
  const drugId = useContext(DrugIdContext);
  const html = section.html ? sanitizeHtml(section.html) : textToHtml(section.text);
  return (
    <div>
      <div
        className="drug-content"
        style={{ fontSize: 13, lineHeight: 1.7, color: "var(--text-secondary)" }}
      >
        <ReferenceLayer
          html={html}
          source={drugId != null ? "drugs" : undefined}
          sourceId={drugId != null ? String(drugId) : undefined}
        />
      </div>
      <div style={{ marginTop: 8 }}>
        <SourceBadge source={section.source} />
      </div>
    </div>
  );
}

export default function DrugSectionTab({ section, label, defaultExpanded = true }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!section || (!section.html && !section.text)) {
    return (
      <div style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>
        {label ? `${label}: ` : ""}No data available for this section.
      </div>
    );
  }

  if (!label) {
    return <DrugSectionContent section={section} />;
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 12, marginBottom: 12 }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          background: "none", border: "none", padding: "6px 0", cursor: "pointer",
          color: "var(--text-primary)", fontWeight: 600, fontSize: 13, textAlign: "left",
        }}
      >
        <span style={{
          fontSize: 11, display: "inline-block", width: 10, textAlign: "center",
          color: "var(--text-muted)", transition: "transform 0.15s",
          transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        }}>▶</span>
        {label}
        <SourceBadge source={section.source} />
      </button>
      {expanded && (
        <div style={{ paddingLeft: 16, paddingTop: 4 }}>
          <DrugSectionContent section={section} />
        </div>
      )}
    </div>
  );
}
