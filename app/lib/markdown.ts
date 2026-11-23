// Minimal, dependency-free Markdown → HTML for the in-app documentation viewer.
// The app ships offline with no markdown library, and the docs (README,
// MedOS_USER_GUIDE) use a predictable subset: headings, bold/italic, inline and
// fenced code, ordered/unordered lists, tables, blockquotes, horizontal rules,
// links and paragraphs. Everything is HTML-escaped first, so raw HTML in the
// source is shown as text (safe — the input is our own trusted docs).

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(raw: string): string {
  let t = esc(raw);
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, url) => {
    const safe = /^(https?:|mailto:|\/|#)/i.test(url) ? url : "#";
    const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${safe}"${ext}>${txt}</a>`;
  });
  return t;
}

function tableRow(line: string, cell: "td" | "th"): string {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return "<tr>" + cells.map(c => `<${cell}>${inline(c.trim())}</${cell}>`).join("") + `</tr>`;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let list: "ul" | "ol" | null = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
      i++; // closing fence
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // table: header row followed by a |---|---| separator
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      closeList();
      out.push('<div class="doc-table-wrap"><table>');
      out.push("<thead>" + tableRow(line, "th") + "</thead><tbody>");
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { out.push(tableRow(lines[i], "td")); i++; }
      out.push("</tbody></table></div>");
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`); i++; continue; }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(); out.push("<hr />"); i++; continue; }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^\s*>\s?/, ""))); i++; }
      out.push(`<blockquote>${buf.join("<br />")}</blockquote>`);
      continue;
    }

    // unordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); i++; continue; }

    // ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); i++; continue; }

    // blank line
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    // paragraph (gather consecutive non-blank, non-structural lines)
    closeList();
    const buf: string[] = [inline(line)];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s|\s*>\s?|\s*\|)/.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
      buf.push(inline(lines[i])); i++;
    }
    out.push(`<p>${buf.join("<br />")}</p>`);
  }
  closeList();
  return out.join("\n");
}
