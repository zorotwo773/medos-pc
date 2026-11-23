import type { TrayItem } from "./mediaTrayModel";
export function buildMediaTrayPrintDocument(items: readonly TrayItem[], options?: { printedAt?: Date; origin?: string }): string;
