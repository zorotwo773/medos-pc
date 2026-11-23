"use client";

import { useEffect, useState, type RefObject } from "react";
import MediaViewer from "@/components/common/MediaViewer";
import type { MediaDescriptor } from "@/lib/mediaInterop";
import { readerMediaFromMessage } from "@/lib/readerMediaBridge.mjs";

export default function ReaderFrameMediaViewer({
  frameRef,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
}) {
  const [descriptor, setDescriptor] = useState<Readonly<MediaDescriptor> | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = readerMediaFromMessage(
        event,
        frameRef.current?.contentWindow ?? null,
        { origin: window.location.origin },
      );
      if (next) setDescriptor(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef]);

  if (!descriptor) return null;
  return (
    <MediaViewer
      open
      onClose={() => setDescriptor(null)}
      title={descriptor.title}
      source={descriptor.source}
      sourceUrl={descriptor.sourceUrl}
      fileName={descriptor.fileName}
      imageUrl={descriptor.kind === "image" ? descriptor.resourceUrl : undefined}
      html={descriptor.kind === "table" ? descriptor.html : undefined}
      mediaDescriptor={descriptor}
    />
  );
}
