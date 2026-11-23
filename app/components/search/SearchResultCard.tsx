"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, BookOpen, FileImage, Table2 } from "lucide-react";
import MediaActions from "@/components/common/MediaActions";
import MediaViewer from "@/components/common/MediaViewer";
import { openFirstAid } from "@/components/firstaid/FirstAidSnippet";
import { getBackendUrl } from "@/lib/api";
import { dispatchLibraryPdfActivation } from "@/lib/pdfNavigation";
import type { MediaDescriptor } from "@/lib/mediaInterop";
import type { SearchResultItem } from "@/lib/searchResultsState";

const SOURCE_LABELS: Record<string, string> = {
  utd: "UpToDate",
  uptodate: "UpToDate",
  amboss: "AMBOSS",
  uworld: "UWorld",
  firstaid: "First Aid",
  books: "Books",
  umls: "UMLS",
  qbank: "Q-Bank",
  sanford: "Sanford",
  utdddx: "UTD DDx",
  drugs: "Drugs",
  calc: "Calculators",
};

function absoluteBackendUrl(value = "") {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${getBackendUrl()}${value.startsWith("/") ? "" : "/"}${value}`;
}

function sourceUrl(value = "") {
  if (!value || /^https?:\/\//i.test(value)) return value;
  if (typeof window === "undefined") return value;
  return new URL(value, window.location.origin).toString();
}

function isImage(item: SearchResultItem) {
  return item.kind === "clinic_image" || item.preview?.type === "image";
}

function isTable(item: SearchResultItem) {
  return item.kind === "uworld_table" || item.preview?.type === "html" || item.preview?.type === "frame";
}

function firstAidIds(item: SearchResultItem) {
  const fromRefs = item.firstaid_refs
    ?.map((ref) => Number(ref.heading_id))
    .filter((id) => Number.isFinite(id) && id > 0) || [];
  if (fromRefs.length) return fromRefs;
  const raw = `${item.href || ""} ${item.id || ""}`;
  const id = Number(raw.match(/firstaid-(\d+)/)?.[1] || raw.match(/heading_id=(\d+)/)?.[1] || (item.scope === "firstaid" ? item.id : ""));
  return Number.isFinite(id) && id > 0 ? [id] : [];
}

export default function SearchResultCard({ item, index }: { item: SearchResultItem; index: number }) {
  const router = useRouter();
  const [mediaOpen, setMediaOpen] = useState(false);
  const title = item.title || "Untitled result";
  const source = SOURCE_LABELS[item.scope || ""] || item.scope || "MedOS";
  const media = isImage(item) || isTable(item);
  const mediaHref = item.preview?.url || item.href || "";
  const resourceUrl = media ? absoluteBackendUrl(mediaHref) : "";
  const descriptor = useMemo<MediaDescriptor | null>(() => {
    if (!media || (!resourceUrl && !item.preview?.html)) return null;
    return Object.freeze({
      kind: isImage(item) ? "image" : "table",
      title,
      source,
      sourceUrl: sourceUrl(item.href || mediaHref),
      resourceUrl: resourceUrl || undefined,
      html: item.preview?.html,
      plainText: item.subtitle,
    });
  }, [item, media, mediaHref, resourceUrl, source, title]);

  function openResult() {
    const headingIds = firstAidIds(item);
    if (headingIds.length) {
      openFirstAid(headingIds[0], headingIds, title);
      return;
    }
    if (descriptor) {
      setMediaOpen(true);
      return;
    }
    if (!item.href) return;
    dispatchLibraryPdfActivation(item.href, "search");
    window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href: item.href, title } }));
    router.push(item.href);
  }

  const MediaIcon = isImage(item) ? FileImage : isTable(item) ? Table2 : BookOpen;

  return (
    <article className="search-result-card">
      <div className="search-result-rank" aria-hidden="true">{index + 1}</div>
      <div className="search-result-body">
        <div className="search-result-meta">
          <span data-source={item.scope || "medos"}>{source}</span>
          <span>{String(item.kind || "reference").replaceAll("_", " ")}</span>
        </div>
        <button type="button" className="search-result-open" onClick={openResult} disabled={!item.href && !descriptor && firstAidIds(item).length === 0}>
          <MediaIcon size={17} aria-hidden="true" />
          <span>
            <strong>{title}</strong>
            {item.subtitle && <small>{item.subtitle}</small>}
          </span>
          <ArrowUpRight size={17} aria-hidden="true" />
        </button>
        {descriptor && <MediaActions descriptor={descriptor} />}
      </div>
      {descriptor && (
        <MediaViewer
          open={mediaOpen}
          onClose={() => setMediaOpen(false)}
          title={title}
          source={source}
          sourceUrl={descriptor.sourceUrl}
          imageUrl={descriptor.kind === "image" ? descriptor.resourceUrl : undefined}
          frameUrl={descriptor.kind === "table" && !descriptor.html ? descriptor.resourceUrl : undefined}
          html={descriptor.html}
        />
      )}
    </article>
  );
}
