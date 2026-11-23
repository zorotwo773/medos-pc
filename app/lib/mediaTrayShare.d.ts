import type { TrayItem } from "./mediaTrayModel";
export function buildTrayShareManifest(items: readonly TrayItem[]): { title: string; text: string };
export function shareTrayItems(items: readonly TrayItem[], options: { origin?: string; navigatorApi?: Navigator; fetchImpl?: typeof fetch; FileCtor?: typeof File; copyFallback?: (text: string) => Promise<void> | void }): Promise<{ outcome: "shared" | "fallback"; manifest: { title: string; text: string } }>;
