"use client";

export interface OutlineItem {
  id: string;
  text: string;
  level: number;
}

/**
 * "On this page" navigator — the current article's heading hierarchy, sent up
 * from the (cross-origin) article iframe via a `medos_outline` postMessage.
 * Clicking an item asks the iframe to scroll to that heading.
 */
export default function ArticleOutline({
  items,
  activeId,
  onJump,
}: {
  items: OutlineItem[];
  activeId?: string | null;
  onJump: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="reader-outline">
      {items.map(it => (
        <button
          key={it.id}
          type="button"
          className={`reader-outline-item is-h${it.level === 3 ? 3 : 2}${activeId === it.id ? " is-active" : ""}`}
          onClick={() => onJump(it.id)}
          title={it.text}
        >
          {it.text}
        </button>
      ))}
    </div>
  );
}
