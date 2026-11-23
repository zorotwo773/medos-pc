"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Images, Loader2, RefreshCw } from "lucide-react";
import MediaActions from "@/components/common/MediaActions";
import MediaViewer from "@/components/common/MediaViewer";
import { getBackendUrl } from "@/lib/api";
import type { MediaDescriptor } from "@/lib/mediaInterop";

interface MediaItem {
  source: string;
  source_id?: string;
  title: string;
  href: string;
  preview_href?: string;
  source_href?: string;
  media_type: "image" | "exhibit";
}

export interface RelatedMediaSummary {
  images: number;
  tables: number;
  total: number;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: MediaItem[] };

const MEDIA_TIMEOUT_MS = 12_000;

function absoluteBackendUrl(value = "") {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${getBackendUrl()}${value.startsWith("/") ? "" : "/"}${value}`;
}

function descriptorFor(item: MediaItem): MediaDescriptor {
  const sourceUrl = item.source_href
    ? (/^https?:\/\//i.test(item.source_href)
      ? item.source_href
      : typeof window === "undefined"
        ? item.source_href
        : new URL(item.source_href, window.location.origin).toString())
    : absoluteBackendUrl(item.href);
  return Object.freeze({
    kind: item.media_type === "image" ? "image" : "table",
    title: item.title || "Related media",
    source: item.source || "MedOS",
    sourceUrl,
    resourceUrl: absoluteBackendUrl(item.href),
  });
}

function SearchMediaCard({ item }: { item: MediaItem }) {
  const [open, setOpen] = useState(false);
  const descriptor = useMemo(() => descriptorFor(item), [item]);
  const previewUrl = absoluteBackendUrl(item.preview_href || item.href);
  return (
    <article className="search-media-card">
      <button type="button" className="search-media-preview" onClick={() => setOpen(true)} aria-label={`Open ${item.title}`}>
        {item.media_type === "image"
          ? <img src={previewUrl} alt={item.title} loading="lazy" />
          : <span><Images size={24} aria-hidden="true" /> Open table</span>}
      </button>
      <div className="search-media-card-copy">
        <span>{item.source}</span>
        <strong>{item.title}</strong>
      </div>
      <MediaActions descriptor={descriptor} />
      <MediaViewer
        open={open}
        onClose={() => setOpen(false)}
        title={item.title}
        source={item.source}
        sourceUrl={descriptor.sourceUrl}
        imageUrl={item.media_type === "image" ? descriptor.resourceUrl : undefined}
        frameUrl={item.media_type === "exhibit" ? descriptor.resourceUrl : undefined}
      />
    </article>
  );
}

const INITIAL_MEDIA_COUNT = 24;

export default function SearchMediaSection({
  cui,
  conceptName,
  allowedKinds,
  onSummary,
}: {
  cui: string;
  conceptName?: string;
  allowedKinds?: string[];
  onSummary?: (summary: RelatedMediaSummary) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MEDIA_TIMEOUT_MS);
    setLoad({ status: "loading" });
    setExpanded(false);
    onSummary?.({ images: 0, tables: 0, total: 0 });
    fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(cui)}/media?limit=120`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Media request failed (${response.status})`);
        return await response.json() as { items?: MediaItem[] };
      })
      .then((data) => {
        if (!active) return;
        const items = Array.isArray(data.items) ? data.items : [];
        setLoad({ status: "ready", items });
        onSummary?.({
          images: items.filter((item) => item.media_type === "image").length,
          tables: items.filter((item) => item.media_type === "exhibit").length,
          total: items.length,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (!controller.signal.aborted) {
          setLoad({ status: "error", message: error instanceof Error ? error.message : "Related media is unavailable." });
        } else if (timedOut) {
          setLoad({ status: "error", message: "Related media timed out." });
        }
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt, cui, onSummary]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const filteredItems = load.status === "ready"
    ? load.items.filter((item) => {
      if (!allowedKinds?.length) return true;
      return item.media_type === "image" ? allowedKinds.includes("images") : allowedKinds.includes("tables");
    })
    : [];
  const visibleItems = expanded ? filteredItems : filteredItems.slice(0, INITIAL_MEDIA_COUNT);
  const label = conceptName || cui;

  return (
    <section className="search-enrichment-card search-media-section" aria-labelledby="search-media-title">
      <header>
        <Images size={18} aria-hidden="true" />
        <div>
          <h2 id="search-media-title">Related images and tables</h2>
          <p>Concept Graph resources for {label}</p>
        </div>
      </header>
      {load.status === "loading" && (
        <div className="search-enrichment-state" role="status" aria-live="polite">
          <Loader2 className="search-results-spin" size={22} />
          Loading related media…
        </div>
      )}
      {load.status === "error" && (
        <div className="search-enrichment-state is-error" role="status" aria-live="polite">
          <AlertCircle size={22} />
          <span>{load.message}</span>
          <button type="button" onClick={retry}><RefreshCw size={15} /> Retry</button>
        </div>
      )}
      {load.status === "ready" && filteredItems.length === 0 && (
        <div className="search-enrichment-state" role="status">No related images or tables are available for this concept and filter.</div>
      )}
      {load.status === "ready" && filteredItems.length > 0 && (
        <>
          <div className="search-media-grid" role="status" aria-label={`${filteredItems.length} related media items loaded`}>
            {visibleItems.map((item, index) => <SearchMediaCard key={`${item.source}:${item.source_id || item.href}:${index}`} item={item} />)}
          </div>
          {filteredItems.length > INITIAL_MEDIA_COUNT && (
            <button type="button" className="search-media-show-all" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Show fewer" : `Show all ${filteredItems.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
