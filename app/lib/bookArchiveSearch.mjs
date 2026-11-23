function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreBook(book, query, tokens) {
  const title = normalize(book?.title);
  const filename = normalize(book?.filename);
  const folder = normalize(book?.folder);
  const id = normalize(book?.id);
  const haystack = `${title} ${filename} ${folder} ${id}`;
  if (!tokens.every((token) => haystack.includes(token))) return null;

  let score = 0;
  if (title === query) score += 1200;
  else if (title.startsWith(query)) score += 900;
  else if (title.includes(query)) score += 700;
  if (filename === query) score += 600;
  else if (filename.startsWith(query)) score += 450;
  else if (filename.includes(query)) score += 300;
  if (folder === query) score += 350;
  else if (folder.includes(query)) score += 180;
  score += tokens.reduce((total, token) => total + (title.includes(token) ? 30 : 0), 0);
  return score;
}

export function rankBookMatches(books, rawQuery) {
  const list = Array.isArray(books) ? books : [];
  const query = normalize(rawQuery);
  if (!query) return [...list];
  const tokens = query.split(" ").filter(Boolean);

  return list
    .map((book) => ({ book, score: scoreBook(book, query, tokens) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.book?.title || "").localeCompare(String(right.book?.title || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    })
    .map((entry) => entry.book);
}
