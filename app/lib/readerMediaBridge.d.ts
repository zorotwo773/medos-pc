import type { MediaDescriptor } from "./mediaInterop";

export function readerMediaFromMessage(
  event: Pick<MessageEvent, "source" | "data">,
  expectedFrameWindow: Window | null,
  options?: { origin?: string },
): Readonly<MediaDescriptor> | null;
