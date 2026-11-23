"use client";

import { Image as ImageIcon, Maximize2 } from "lucide-react";
import { useMemo, useState } from "react";
import MediaViewer from "../common/MediaViewer";

export interface ReaderImageItem {
  src: string;
  title?: string;
  width?: number;
  height?: number;
}

interface Props {
  images: ReaderImageItem[];
  sourceHref?: string;
  sourceTitle?: string;
  emptyText?: string;
}

function displayTitle(item: ReaderImageItem, index: number) {
  const title = (item.title || "").replace(/\s+/g, " ").trim();
  if (title) return title;
  try {
    const leaf = new URL(item.src).pathname.split("/").pop();
    if (leaf) return decodeURIComponent(leaf);
  } catch {
    const leaf = item.src.split(/[/?#]/).filter(Boolean).pop();
    if (leaf) return decodeURIComponent(leaf);
  }
  return `Image ${index + 1}`;
}

export function readerImageDescriptor(active: ReaderImageItem, index: number, sourceTitle: string, sourceHref?: string) {
  const source = sourceTitle.match(/AMBOSS|UWorld|UpToDate|First Aid/i)?.[0] || "MedOS";
  return Object.freeze({
    kind: "image" as const,
    title: displayTitle(active, index),
    source,
    sourceUrl: sourceHref || active.src,
    resourceUrl: active.src,
  });
}

export default function ReaderImageRail({
  images,
  sourceHref,
  sourceTitle = "Open source article",
  emptyText = "Images will appear after the article finishes loading.",
}: Props) {
  const [active, setActive] = useState<ReaderImageItem | null>(null);
  const visibleImages = useMemo(() => {
    const seen = new Set<string>();
    return images.filter(item => {
      if (!item.src || seen.has(item.src)) return false;
      seen.add(item.src);
      return true;
    });
  }, [images]);
  const activeDescriptor = useMemo(() => {
    if (!active) return null;
    return readerImageDescriptor(active, visibleImages.indexOf(active), sourceTitle, sourceHref);
  }, [active, sourceHref, sourceTitle, visibleImages]);

  return (
    <>
      <div className="reader-image-rail">
        {visibleImages.length > 0 ? (
          <div className="reader-image-grid">
            {visibleImages.map((item, index) => {
              const title = displayTitle(item, index);
              return (
                <button
                  key={item.src}
                  type="button"
                  className="reader-image-card"
                  onClick={() => setActive(item)}
                  title={title}
                >
                  <img src={item.src} alt={title} loading="lazy" />
                  <span className="reader-image-card-title">{title}</span>
                  <span className="reader-image-card-action" aria-hidden="true">
                    <Maximize2 size={12} />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="reader-image-empty">
            <ImageIcon size={16} />
            <span>{emptyText}</span>
          </div>
        )}
      </div>

      {active && (
        <MediaViewer
          open
          onClose={() => setActive(null)}
          title={displayTitle(active, visibleImages.indexOf(active))}
          source={activeDescriptor?.source}
          sourceUrl={sourceHref || active.src}
          imageUrl={active.src}
          mediaDescriptor={activeDescriptor || undefined}
        />
      )}
    </>
  );
}
