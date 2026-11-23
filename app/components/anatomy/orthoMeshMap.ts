import { getBackendUrl } from "@/lib/api";

const _regionCache = new Map<string, string[]>();
const _meshCache = new Map<string, string[]>();

/** Given a mesh cleanName, return matching AO region slugs. */
export async function getRegionForMesh(cleanName: string): Promise<string[]> {
  const key = cleanName.toLowerCase();
  if (_regionCache.has(key)) return _regionCache.get(key)!;
  try {
    const r = await fetch(`${getBackendUrl()}/ao/mesh?name=${encodeURIComponent(cleanName)}`);
    if (!r.ok) return [];
    const data: { slugs: string[] } = await r.json();
    _regionCache.set(key, data.slugs ?? []);
    return data.slugs ?? [];
  } catch {
    return [];
  }
}

/** Given an AO slug, return mesh cleanNames that match (reverse lookup via mesh_map). */
export async function getMeshesForRegion(slug: string): Promise<string[]> {
  if (_meshCache.has(slug)) return _meshCache.get(slug)!;
  try {
    const r = await fetch(`${getBackendUrl()}/ao/tree`);
    if (!r.ok) return [];
    // Build reverse map once: iterate mesh_map endpoint indirectly
    // We call the page to get breadcrumbs, then match terms against the slug
    const pageR = await fetch(`${getBackendUrl()}/ao/page?slug=${encodeURIComponent(slug)}`);
    if (!pageR.ok) return [];
    const page = await pageR.json();
    const crumbs: string[] = page.breadcrumbs ?? [];
    // Anatomy term is typically the last meaningful breadcrumb
    const term = crumbs[crumbs.length - 1] ?? "";
    const meshes = term ? [term] : [];
    _meshCache.set(slug, meshes);
    return meshes;
  } catch {
    return [];
  }
}
