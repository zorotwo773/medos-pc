"use client";

import { useMemo, useState } from "react";
import { Copy, Download, ExternalLink, FolderPlus, Printer, Share2 } from "lucide-react";
import { useTouchInteraction } from "@/components/touch/TouchInteractionProvider";
import {
  runMediaAction,
  type MediaAction,
  type MediaDescriptor,
} from "../../lib/mediaInterop";

interface Props {
  descriptor: Readonly<MediaDescriptor>;
  compact?: boolean;
}

const actions: ReadonlyArray<{
  action: MediaAction;
  label: string;
  icon: typeof Share2;
}> = [
  { action: "share", label: "Share", icon: Share2 },
  { action: "save", label: "Save", icon: Download },
  { action: "copy", label: "Copy", icon: Copy },
  { action: "print", label: "Print / Save PDF", icon: Printer },
  { action: "open", label: "Open separately", icon: ExternalLink },
];

export default function MediaActions({ descriptor, compact = false }: Props) {
  const touch = useTouchInteraction();
  const [pending, setPending] = useState<MediaAction | null>(null);
  const immutableDescriptor = useMemo(
    () => Object.freeze({ ...descriptor }),
    [descriptor],
  );

  async function execute(action: MediaAction) {
    if (pending) return;
    setPending(action);
    try {
      await runMediaAction(action, immutableDescriptor);
    } catch {
      window.MedOSMedia?.notify("The media action could not be completed.", "error");
    } finally {
      setPending(null);
    }
  }

  function addToTray() {
    const result = touch.addToTray(immutableDescriptor);
    if (result.outcome === "unavailable") window.MedOSMedia?.notify("Media tray is unavailable on this view.", "warn");
  }

  return (
    <div className={`medos-media-actions${compact ? " is-compact" : ""}`} aria-label="Media actions">
      {actions.map(({ action, label, icon: Icon }) => (
        <button
          key={action}
          type="button"
          className="medos-media-action"
          aria-label={label}
          title={label}
          disabled={pending !== null}
          onClick={() => void execute(action)}
        >
          <Icon size={15} aria-hidden="true" />
          {!compact && <span>{label}</span>}
        </button>
      ))}
      <button type="button" className="medos-media-action" aria-label="Add to Tray" title="Add to Tray" disabled={pending !== null} onClick={addToTray}>
        <FolderPlus size={15} aria-hidden="true" />
        {!compact && <span>Add to Tray</span>}
      </button>
    </div>
  );
}
