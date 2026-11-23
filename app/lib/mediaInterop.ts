export type MediaAction = "share" | "save" | "copy" | "print" | "open";

export interface MediaDescriptor {
  kind: "image" | "table" | "document" | "excerpt";
  title: string;
  source: string;
  sourceUrl: string;
  resourceUrl?: string;
  fileName?: string;
  html?: string;
  plainText?: string;
  element?: Element;
}

interface MedOSMediaRuntime {
  descriptorFor(descriptor: MediaDescriptor): MediaDescriptor | null;
  run(action: MediaAction, descriptor: MediaDescriptor): Promise<boolean>;
  notify(message: string, tone?: "ok" | "warn" | "error"): void;
}

declare global {
  interface Window {
    MedOSMedia?: MedOSMediaRuntime;
  }
}

export async function runMediaAction(
  action: MediaAction,
  descriptor: Readonly<MediaDescriptor>,
): Promise<boolean> {
  if (window.MedOSMedia) {
    const normalized = window.MedOSMedia.descriptorFor(
      descriptor as MediaDescriptor,
    );
    return window.MedOSMedia.run(action, normalized || descriptor as MediaDescriptor);
  }
  return false;
}
