"use client";

const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "dd", "del", "div",
  "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "hr", "i",
  "img", "ins", "li", "mark", "ol", "p", "pre", "s", "section", "span", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

const GLOBAL_ATTRS = new Set(["class", "title", "dir", "lang"]);
const TABLE_ATTRS = new Set(["colspan", "rowspan", "scope"]);
const IMAGE_ATTRS = new Set(["src", "srcset", "alt", "width", "height", "loading"]);
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function isSafeImageUrl(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("/") || value.startsWith("#")) return true;
  if (value.startsWith("data:image/")) return true;
  try {
    const parsed = new URL(value, window.location.origin);
    return SAFE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function sanitizeNode(node: Node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      const allowed =
        GLOBAL_ATTRS.has(name) ||
        (tag === "a" && name === "href") ||
        (tag === "img" && IMAGE_ATTRS.has(name)) ||
        (["td", "th"].includes(tag) && TABLE_ATTRS.has(name));

      if (!allowed || name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }

      if (tag === "a" && name === "href") {
        try {
          const parsed = new URL(value, window.location.origin);
          if (!SAFE_PROTOCOLS.has(parsed.protocol) && !value.startsWith("/") && !value.startsWith("#")) {
            el.removeAttribute(attr.name);
          } else {
            el.setAttribute("rel", "noopener noreferrer");
          }
        } catch {
          el.removeAttribute(attr.name);
        }
      }

      if (tag === "img" && (name === "src" || name === "srcset")) {
        const valid = name === "src"
          ? isSafeImageUrl(value)
          : value.split(",").every(part => isSafeImageUrl(part.trim().split(/\s+/)[0] || ""));
        if (!valid) el.removeAttribute(attr.name);
      }
    }

    sanitizeNode(el);
  }
}

export function sanitizeHtml(html: string): string {
  if (!html || typeof window === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}
