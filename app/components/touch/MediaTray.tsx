"use client";

import { useMemo, useRef } from "react";
import { ExternalLink, Printer, Share2, Trash2, X } from "lucide-react";
import { normalizeTrayResourceUrl, normalizeTraySourceUrl } from "@/lib/mediaTrayModel";
import { buildMediaTrayPrintDocument } from "@/lib/mediaTrayPrint";
import { shareTrayItems } from "@/lib/mediaTrayShare";
import type { TrayItem } from "@/lib/mediaTrayModel";
import { useModalA11y } from "@/lib/useModalA11y";
import { useTouchInteraction } from "./TouchInteractionProvider";
import "./media-tray.css";

export interface MediaTraySurfaceProps {
  items: readonly TrayItem[];
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onClear: () => void;
  onRemove: (id: string) => void;
  onReorder: (id: string, direction: number) => void;
  onSelect: (id: string) => void;
}

export function MediaTraySurface({ items, isOpen, onOpen, onClose, onClear, onRemove, onReorder, onSelect }: MediaTraySurfaceProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, isOpen);
  const countLabel = `Review media tray (${items.length} item${items.length === 1 ? "" : "s"})`;
  if (!items.length) return null;

  function printTray() {
    const popup = window.open("", "medos-media-tray-print", "noopener,noreferrer");
    if (!popup) return;
    popup.document.open();
    popup.document.write(buildMediaTrayPrintDocument(items, { origin: window.location.origin }));
    popup.document.close();
    popup.focus();
    popup.print();
  }
  async function shareTray() {
    const copyFallback = async (text: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
      } catch {
        // The prompt keeps the complete ordered fallback available.
      }
      window.prompt("Copy the media tray collection:", text);
    };
    const result = await shareTrayItems(items, { origin: window.location.origin, copyFallback });
    window.MedOSMedia?.notify(result.outcome === "shared" ? "Shared media tray collection." : "Copied the media tray collection for sharing.", result.outcome === "shared" ? "ok" : "warn");
  }

  return <>
    <button type="button" className="media-tray-indicator" aria-label={countLabel} onClick={onOpen}>
      <span aria-hidden="true">collections</span><span>{items.length}</span>
    </button>
    {isOpen ? <div className="media-tray-layer" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="media-tray-dialog" role="dialog" aria-modal="true" aria-label="Media tray" tabIndex={-1}>
        <header><h2>Media Tray</h2><button type="button" aria-label="Close media tray" onClick={onClose}><X aria-hidden="true" /></button></header>
        <ol>{items.map((item, index) => {
          const origin = typeof window === "undefined" ? "" : window.location.origin;
          const sourceUrl = normalizeTraySourceUrl(item.sourceUrl, { origin });
          const resourceUrl = normalizeTrayResourceUrl(item.resourceUrl, { origin });
          return <li key={item.trayItemId}>
          <button type="button" className="media-tray-item" onClick={() => onSelect(item.trayItemId)}>
            {item.kind === "image" && resourceUrl ? <img src={resourceUrl} alt="" /> : <span className="media-tray-kind">{item.kind}</span>}
            <span><strong>{item.title}</strong><small>{item.source}</small></span>
          </button>
          <div className="media-tray-item-controls">
            <button type="button" aria-label={`Move ${item.title} up`} disabled={index === 0} onClick={() => onReorder(item.trayItemId, -1)}>↑</button>
            <button type="button" aria-label={`Move ${item.title} down`} disabled={index === items.length - 1} onClick={() => onReorder(item.trayItemId, 1)}>↓</button>
            {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" aria-label={`Open source for ${item.title}`}><ExternalLink aria-hidden="true" /></a> : null}
            <button type="button" aria-label={`Remove ${item.title}`} onClick={() => onRemove(item.trayItemId)}><Trash2 aria-hidden="true" /></button>
          </div>
        </li>;
        })}</ol>
        <footer><button type="button" onClick={onClear} aria-label="Clear tray">Clear</button><button type="button" onClick={printTray} aria-label="Print or save PDF"><Printer aria-hidden="true" />Print / Save PDF</button><button type="button" onClick={() => void shareTray()} aria-label="Share tray"><Share2 aria-hidden="true" />Native share</button></footer>
      </section>
    </div> : null}
  </>;
}

export default function MediaTray({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const touch = useTouchInteraction();
  const items = useMemo(() => touch.tray.items, [touch.tray.items]);
  return <MediaTraySurface items={items} isOpen={isOpen} onOpen={touch.openTray} onClose={onClose} onClear={touch.clearTray} onRemove={touch.removeFromTray} onReorder={touch.reorderTray} onSelect={touch.selectTrayItem} />;
}
