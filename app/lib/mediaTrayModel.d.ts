export type TrayKind = "image" | "table" | "document" | "excerpt";
export interface TrayItem { trayItemId: string; contentKey: string; kind: TrayKind; title: string; source: string; sourceUrl: string; resourceUrl?: string; fileName?: string; html?: string; plainText?: string; estimatedBytes: number; addedAt: number; ownedObjectUrl?: boolean; }
export interface TrayState { items: readonly TrayItem[]; selectedTrayItemId: string | null; }
export const MAX_TRAY_ITEMS: number;
export const MAX_TRAY_BYTES: number;
export const MAX_TRAY_TEXT_CHARS: number;
export interface TrayUrlOptions { origin?: string; }
export function sanitizeTrayHtml(value: unknown, options?: TrayUrlOptions): string;
export function normalizeTraySourceUrl(value: unknown, options?: TrayUrlOptions): string;
export function normalizeTrayResourceUrl(value: unknown, options?: TrayUrlOptions): string;
export function normalizeTrayDescriptor(descriptor: Partial<TrayItem> & { imageUrl?: string; displayedImageUrl?: string }, options?: TrayUrlOptions): Partial<TrayItem>;
export function trayContentKey(descriptor: Partial<TrayItem>): string;
export function snapshotTrayDescriptor(descriptor: Partial<TrayItem> & { imageUrl?: string; displayedImageUrl?: string }, options?: { now?: number; origin?: string }): TrayItem;
export function createTrayState(): TrayState;
export function addTrayItem(state: TrayState, descriptor: Partial<TrayItem> & { imageUrl?: string; displayedImageUrl?: string }, options?: { now?: number; origin?: string }): { outcome: "added" | "duplicate" | "limit"; state: TrayState; item: TrayItem | null };
export function selectTrayItem(state: TrayState, trayItemId: string): TrayState;
export function reorderTrayItem(state: TrayState, trayItemId: string, direction: number): TrayState;
export function removeTrayItem(state: TrayState, trayItemId: string): TrayState;
export function clearTray(state?: TrayState): TrayState;
export function releaseOwnedObjectUrls(items: readonly TrayItem[], revoke?: (url: string) => void): void;
