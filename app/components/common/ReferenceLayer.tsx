"use client";

import { AmbossHtml } from "@/components/amboss/AmbossHtml";
import { type ReferenceMode, useReferenceLayerMode } from "./useReferenceLayerEnabled";

// Warm the next document's reference concepts ahead of navigation (used by the
// q-bank engine to prefetch the upcoming question's hover terms).
export { prefetchDocTerms } from "@/components/amboss/AmbossHtml";

// Any Q-bank key (UWorld step1/2/3 or NBME/CMS form keys); forwarded verbatim to backend URLs.
type QBankDb = string;

interface ReferenceMatch {
  id: number;
  title: string;
  href: string;
  source: string;
  kind?: string;
}

interface ReferenceLayerProps {
  html: string;
  className?: string;
  as?: "div" | "span";
  onOpenArticle?: (match: ReferenceMatch) => void;
  onOpenMatch?: (match: ReferenceMatch) => boolean | void;
  onMouseMove?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
  onClick?: React.MouseEventHandler<HTMLElement>;
  db?: QBankDb;
  /** Hub source slug for this document (e.g. "qbank", "drug", "amboss", "utd"). */
  source?: string;
  /** Hub source id for this document (e.g. "step2:12345" for a q-bank question). */
  sourceId?: string;
  /** Force a local scan mode for flows that must not follow the global toggle. */
  modeOverride?: ReferenceMode;
  /** Keep scanning mounted but suppress hover/tap/click reference actions. */
  hoverEnabled?: boolean;
}

export function ReferenceLayer({
  html,
  className,
  as = "div",
  onMouseMove,
  onMouseLeave,
  onClick,
  modeOverride,
  hoverEnabled = true,
  ...rest
}: ReferenceLayerProps) {
  const globalMode = useReferenceLayerMode();
  const mode = modeOverride ?? globalMode;

  if (mode === "off") {
    const Tag = as;
    // References are off, so AmbossHtml (and its exhibit/media click interceptor)
    // is NOT mounted on this path. A q-bank exhibit/media anchor must still NEVER
    // navigate the page — that tears down a running exam. Keep the "never navigate"
    // rule STRUCTURAL here: delegate to the host onClick (its MediaViewer) and, if
    // the host doesn't claim the click, neutralize the default navigation anyway.
    const guardedClick: React.MouseEventHandler<HTMLElement> = (event) => {
      const anchor = event.target instanceof Element
        ? event.target.closest("a[href*='/qbank/exhibit/'], a[href*='/qbank/media/']")
        : null;
      onClick?.(event);
      if (anchor && !event.defaultPrevented) event.preventDefault();
    };
    return (
      <Tag
        className={className}
        onMouseMove={onMouseMove as React.MouseEventHandler<HTMLDivElement> & React.MouseEventHandler<HTMLSpanElement>}
        onMouseLeave={onMouseLeave as React.MouseEventHandler<HTMLDivElement> & React.MouseEventHandler<HTMLSpanElement>}
        onClick={guardedClick as React.MouseEventHandler<HTMLDivElement> & React.MouseEventHandler<HTMLSpanElement>}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <AmbossHtml
      html={html}
      className={className}
      as={as}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      hoverEnabled={hoverEnabled}
      modeOverride={mode}
      {...rest}
    />
  );
}

export default ReferenceLayer;
