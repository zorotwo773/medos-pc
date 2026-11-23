"use client";
/**
 * useScrollRestore — restore a scroll container's position on mount and persist
 * it (debounced) on scroll. Pairs with lib/activity's saveScroll/loadScroll so
 * back-navigation lands exactly where the user left, and the position survives
 * an app restart.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   useScrollRestore(ref, key);     // key = a stable id for this page
 *   <div ref={ref} style={{ overflow: "auto" }}> … </div>
 *
 * `key` should change when the page's content changes (e.g. include ?doc=… or
 * ?id=… so each article/drug restores its own position). Pass null/"" to skip.
 */
import { RefObject, useEffect } from "react";
import { saveScroll, loadScroll } from "@/lib/activity";

export function useScrollRestore(
  ref: RefObject<HTMLElement | null>,
  key: string | null | undefined,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !key) return;
    let cancelled = false;

    // ── restore ──
    // Content may still be loading/growing, so retry until the container is
    // tall enough to honor the saved offset (or we run out of attempts).
    loadScroll(key).then(saved => {
      if (cancelled || !saved || saved.y <= 0) return;
      let tries = 0;
      const apply = () => {
        if (cancelled || !ref.current) return;
        const node = ref.current;
        const max = node.scrollHeight - node.clientHeight;
        node.scrollTop = Math.min(saved.y, Math.max(0, max));
        tries += 1;
        if (max < saved.y - 2 && tries < 45) {
          setTimeout(apply, 80);   // not tall enough yet — wait for more content
        }
      };
      requestAnimationFrame(apply);
    });

    // ── persist (throttled, trailing) ──
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const persist = () => {
      if (!ref.current) return;
      saveScroll(key, ref.current.scrollTop);
    };
    const onScroll = () => {
      const now = Date.now();
      if (now - last >= 200) {
        last = now;
        persist();
      } else {
        if (trailing) clearTimeout(trailing);
        trailing = setTimeout(() => { last = Date.now(); persist(); }, 200);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      cancelled = true;
      if (trailing) clearTimeout(trailing);
      el.removeEventListener("scroll", onScroll);
      persist();   // final save (also writes the localStorage cache synchronously)
    };
  }, [ref, key]);
}
