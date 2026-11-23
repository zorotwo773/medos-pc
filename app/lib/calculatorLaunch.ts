export interface CalculatorLaunchItem {
  id?: string | number;
  title?: string;
  subtitle?: string;
  href?: string;
  scope?: string;
  kind?: string;
}

declare global {
  interface Window {
    medosCalc?: {
      openTarget?: (target: string) => void;
      openSearchResult?: (item: CalculatorLaunchItem) => boolean | Promise<boolean>;
      readShortcutTargets?: () => string[];
      targetLabel?: (target: string) => string;
      refreshShortcuts?: () => void;
    };
  }
}

export function isCalculatorResult(item: CalculatorLaunchItem | null | undefined) {
  if (!item) return false;
  const scope = String(item.scope || "").toLowerCase();
  const kind = String(item.kind || "").toLowerCase();
  const href = String(item.href || "");
  return (
    scope === "calc" ||
    scope === "calculators" ||
    kind.includes("calculator") ||
    href.startsWith("/calculators")
  );
}

export function openCalculatorResult(item: CalculatorLaunchItem) {
  if (typeof window === "undefined") return false;
  const detail = {
    ...(item as object),
    id: item.id,
    title: item.title || "Calculator",
    subtitle: item.subtitle || "",
    href: item.href || "",
    scope: item.scope || "",
    kind: item.kind || "",
  } as CalculatorLaunchItem;
  if (window.medosCalc?.openSearchResult) {
    void window.medosCalc.openSearchResult(detail);
    return true;
  }
  window.dispatchEvent(new CustomEvent("medos:open-calculator-result", { detail }));
  return true;
}
