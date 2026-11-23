"use client";

import { PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type ReaderScrollSource = "article" | "qbank";

const ARTICLE_SCROLL_TUNING = {
  hideAtY: 80,
  hideDelta: 18,
  showAtY: 48,
  showDelta: 18,
  wheelDelta: 18,
  edgeRevealPx: 28,
};
const QBANK_SCROLL_TUNING = {
  hideAtY: 220,
  hideDelta: 140,
  showAtY: 56,
  showDelta: 120,
  wheelDelta: 80,
  edgeRevealPx: 28,
};

function scrollTuningFor(source: ReaderScrollSource) {
  return source === "qbank" ? QBANK_SCROLL_TUNING : ARTICLE_SCROLL_TUNING;
}

function scrollSourceForPath(pathname: string): ReaderScrollSource {
  return pathname.startsWith("/qbank") ? "qbank" : "article";
}

function isReaderPath(pathname: string) {
  return (
    pathname.startsWith("/uptodate") ||
    pathname.startsWith("/amboss") ||
    pathname.startsWith("/library/uworld") ||
    pathname.startsWith("/qbank")
  );
}

export default function ReadingChromeController() {
  const pathname = usePathname() || "";
  const [readerActive, setReaderActive] = useState(false);

  const openReaderTools = useCallback(() => {
    document.body.classList.remove("medos-reading-chrome-hidden");
    window.dispatchEvent(new CustomEvent("medos:reader-tools-toggle"));
  }, []);

  useEffect(() => {
    const body = document.body;
    let active = false;
    let hidden = false;
    let lastY = 0;
    let anchorY = 0;
    let lastSource: ReaderScrollSource = scrollSourceForPath(pathname);

    const setHidden = (next: boolean) => {
      hidden = active && next;
      body.classList.toggle("medos-reading-chrome-hidden", hidden);
    };

    const syncActive = () => {
      const wasActive = active;
      const qbankReady = !pathname.startsWith("/qbank") || body.classList.contains("qbank-tutor-active");
      active = isReaderPath(pathname) && qbankReady;
      body.classList.toggle("medos-reading-active", active);
      setReaderActive(active);
      if (!active) setHidden(false);
      if (active && !wasActive) {
        lastY = 0;
        anchorY = 0;
        lastSource = scrollSourceForPath(pathname);
      }
    };

    const handleY = (rawY: number, source: ReaderScrollSource = scrollSourceForPath(pathname), atBottom = false) => {
      if (!active) return;
      const y = Math.max(0, Math.round(rawY || 0));
      const tuning = scrollTuningFor(source);
      // At/near the end of the page, keep the chrome visible and stop toggling so
      // overscroll jitter can't flicker the top/status bars or hide the footer.
      if (atBottom) {
        setHidden(false);
        anchorY = y;
        lastY = y;
        lastSource = source;
        return;
      }
      if (source !== lastSource) {
        lastSource = source;
        lastY = y;
        anchorY = y;
      }
      const scrollingDown = y > lastY;
      const scrollingUp = y < lastY;
      if (!hidden) {
        if (scrollingUp || y < tuning.showAtY) anchorY = y;
        if (scrollingDown && y > tuning.hideAtY && y - anchorY >= tuning.hideDelta) {
          setHidden(true);
          anchorY = y;
        }
      } else {
        if (scrollingDown) anchorY = y;
        if (y < tuning.showAtY || (scrollingUp && anchorY - y >= tuning.showDelta)) {
          setHidden(false);
          anchorY = y;
        }
      }
      lastY = y;
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "utd-scroll" || data.type === "amboss_scroll" || data.type === "medos_reader_scroll") {
        handleY(Number(data.y ?? data.scrollY ?? 0), data.source === "qbank" ? "qbank" : "article");
      }
    };

    const onReaderScroll = (event: Event) => {
      const detail = (event as CustomEvent<{ y?: number; scrollY?: number; source?: ReaderScrollSource; atBottom?: boolean }>).detail;
      handleY(
        Number(detail?.y ?? detail?.scrollY ?? 0),
        detail?.source === "qbank" ? "qbank" : scrollSourceForPath(pathname),
        Boolean(detail?.atBottom),
      );
    };

    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement | Document | null;
      const node = target instanceof Document ? target.scrollingElement : target;
      const y = node && "scrollTop" in node ? Number(node.scrollTop) : window.scrollY;
      handleY(y, scrollSourceForPath(pathname));
    };

    const onWheel = (event: WheelEvent) => {
      if (!active) return;
      const source = scrollSourceForPath(pathname);
      const tuning = scrollTuningFor(source);
      if (event.deltaY < -tuning.wheelDelta) setHidden(false);
      else if (source !== "qbank" && event.deltaY > tuning.wheelDelta) setHidden(true);
    };

    const onPointerMove = (event: PointerEvent | MouseEvent) => {
      if (!active) return;
      const source = scrollSourceForPath(pathname);
      const tuning = scrollTuningFor(source);
      const nearTop = event.clientY < tuning.edgeRevealPx;
      const nearBottom = window.innerHeight - event.clientY < tuning.edgeRevealPx;
      if (nearTop || (source !== "qbank" && nearBottom)) setHidden(false);
    };

    const showChrome = () => {
      if (active) setHidden(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      showChrome();
      if (!active || !event.altKey || event.key.toLowerCase() !== "r") return;
      event.preventDefault();
      openReaderTools();
    };

    syncActive();
    const observer = new MutationObserver(syncActive);
    observer.observe(body, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("message", onMessage);
    window.addEventListener("medos:reader-scroll", onReaderScroll);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("focusin", showChrome);
    window.addEventListener("medos:reader-active-change", syncActive);

    return () => {
      observer.disconnect();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("medos:reader-scroll", onReaderScroll);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("focusin", showChrome);
      window.removeEventListener("medos:reader-active-change", syncActive);
      body.classList.remove("medos-reading-active", "medos-reading-chrome-hidden");
    };
  }, [pathname, openReaderTools]);

  if (!readerActive) return null;

  return (
    <button
      type="button"
      className="medos-reader-tools-shortcut"
      onClick={openReaderTools}
      title="Reader tools"
      aria-label="Toggle reader tools"
    >
      <PanelRightOpen size={18} />
    </button>
  );
}
