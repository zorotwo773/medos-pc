import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

interface MdCalcCatalogEntry {
  id: number;
  title: string;
  shortTitle?: string;
  slug?: string;
  system?: string;
  disease?: string;
  description?: string;
  shortDescription?: string;
  mediumDescription?: string;
  systems?: string[];
  diseases?: string[];
  searchAbbreviations?: string[];
  type?: string;
  inputs?: unknown[];
  formula?: string;
  equationLogicText?: string;
  details?: unknown;
  references?: unknown;
}

interface MdCalcCatalog {
  count?: number;
  calculators?: MdCalcCatalogEntry[];
}

async function getMdCalcFallback(limit: number, q: string, category: string) {
  const catalogPath = path.resolve(process.cwd(), "..", "data", "WSA", "mdcalc-live", "catalog", "mdcalc-live-catalog.compact.json");
  const raw = await readFile(catalogPath, "utf8");
  const data = JSON.parse(raw) as MdCalcCatalog;
  const query = q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const queryTokens = query.split(/\s+/).filter(Boolean);
  const categoryQuery = category.toLowerCase();
  const rows = (data.calculators || [])
    .filter(item => {
      const systems = (item.systems?.length ? item.systems : String(item.system || "MDCalc Live").split(",")).map(s => String(s).trim()).filter(Boolean);
      const haystack = [item.title, item.shortTitle, item.slug, item.system, item.disease, item.description, item.shortDescription, item.mediumDescription, item.type, ...(item.searchAbbreviations || [])].join(" ").toLowerCase();
      const searchMatch = !query || queryTokens.every(token => haystack.includes(token));
      const categoryMatch = !categoryQuery || categoryQuery === "all" || systems.some(system => system.toLowerCase() === categoryQuery);
      return searchMatch && categoryMatch;
    })
    .sort((a, b) => {
      if (!query) return 0;
      const titleA = normalizeKey([a.title, a.shortTitle].join(" "));
      const titleB = normalizeKey([b.title, b.shortTitle].join(" "));
      const score = (title: string) => {
        if (title === query) return 0;
        if (title.includes(query)) return 1;
        if (queryTokens.length && queryTokens.every(token => title.includes(token))) return 2;
        if (queryTokens.length && queryTokens.some(token => title.includes(token))) return 3;
        return 4;
      };
      return score(titleA) - score(titleB) || String(a.title).localeCompare(String(b.title));
    })
    .slice(0, Math.max(1, limit))
    .map(item => {
      const categories = (item.systems?.length ? item.systems : String(item.system || "MDCalc Live").split(",")).map(s => String(s).trim()).filter(Boolean);
      const primary = categories[0] || "MDCalc Live";
      return {
        id: `mdcalc_${item.id}`,
        title: item.title,
        category: primary,
        categories,
        subtitle: [item.disease, item.type, item.slug].filter(Boolean).join(" · "),
        description: item.description || item.mediumDescription || item.shortDescription || `Live MDCalc catalog entry from the copied app data. ${item.disease ? `Clinical area: ${item.disease}.` : ""}`.trim(),
        inputs: item.inputs || [],
        formula: item.formula || "",
        equationLogicText: item.equationLogicText || "",
        details: item.details || null,
        references: item.references || null,
        source: "mdcalc-live",
      };
    });
  return {
    configured: true,
    exists: true,
    source: "mdcalc-live",
    count: rows.length,
    totalCount: data.count || rows.length,
    results: rows,
  };
}

function normalizeKey(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function mergeResults(primary: unknown[], mdcalc: unknown[], limit: number) {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const row of [...primary, ...mdcalc] as Record<string, unknown>[]) {
    const key = normalizeKey(row.title) || normalizeKey(row.id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const limit = searchParams.get("limit") || "1500";
  const requestedLimit = Number(limit) || 1500;
  const upstreamLimit = Math.min(1000, Math.max(1, requestedLimit));
  const q = searchParams.get("q") || "";
  const category = searchParams.get("category") || "";
  const upstream = new URL("http://127.0.0.1:8002/lexi/calc/list");
  upstream.searchParams.set("limit", String(upstreamLimit));
  if (q) upstream.searchParams.set("q", q);
  if (category) upstream.searchParams.set("category", category);

  try {
    const mdcalc = await getMdCalcFallback(requestedLimit, q, category);
    const response = await fetch(upstream, { cache: "no-store" });
    const data = await response.json();
    if (response.ok && Array.isArray(data?.results) && data.results.length > 0) {
      const results = mergeResults(data.results, mdcalc.results, requestedLimit);
      return NextResponse.json({
        ...data,
        configured: true,
        exists: true,
        source: "lexi+mdcalc-live",
        count: results.length,
        results,
      }, { status: 200 });
    }
    return NextResponse.json(mdcalc, { status: 200 });
  } catch {
    try {
      return NextResponse.json(await getMdCalcFallback(requestedLimit, q, category), { status: 200 });
    } catch {
      return NextResponse.json(
        { configured: true, exists: false, count: 0, results: [] },
        { status: 200 },
      );
    }
  }
}
