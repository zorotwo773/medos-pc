"use client";
/**
 * Client for the backend /custom router (reached through the Next /api proxy).
 *
 * All calls use origin-relative `/api/custom/*` so the session cookie set by
 * the backend is sent from localhost and from LAN clients alike. Everything is
 * scoped server-side to the signed-in user.
 */

export type CustomNodeKind = "folder" | "link" | "doc";

export interface CustomNode {
  id: string;
  parentId: string | null;
  kind: CustomNodeKind;
  title: string;
  position: number;
  source: string | null;
  refId: string | null;
  href: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  hasBody: boolean;
  bodyHtml?: string;
}

export interface CustomAnnotation {
  id: string;
  source: string;
  refId: string;
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  color: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

const API = "/api/custom";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") {
        detail = body.detail;
      } else if (body && Array.isArray(body.detail)) {
        // FastAPI validation errors arrive as [{loc, msg, ...}].
        detail = body.detail
          .map((item: { loc?: (string | number)[]; msg?: string }) =>
            `${(item.loc || []).filter(part => part !== "body").join(".")}: ${item.msg || "invalid"}`)
          .join("; ") || detail;
      }
    } catch { /* keep the status text */ }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Nodes ──────────────────────────────────────────────────────────────────

export async function fetchTree(): Promise<{ nodes: CustomNode[]; annotationCount: number }> {
  return request("/tree");
}

export async function fetchFolders(): Promise<CustomNode[]> {
  const data = await request<{ nodes: CustomNode[] }>("/folders");
  return data.nodes;
}

export async function fetchNode(id: string): Promise<CustomNode> {
  const data = await request<{ node: CustomNode }>(`/nodes/${encodeURIComponent(id)}`);
  return data.node;
}

export async function createFolder(name: string, parentId: string | null): Promise<CustomNode> {
  const data = await request<{ node: CustomNode }>("/folders", {
    method: "POST",
    body: JSON.stringify({ name, parentId }),
  });
  return data.node;
}

export async function createNote(
  title: string,
  parentId: string | null,
  bodyHtml = "",
): Promise<CustomNode> {
  const data = await request<{ node: CustomNode }>("/docs", {
    method: "POST",
    body: JSON.stringify({ title, parentId, bodyHtml }),
  });
  return data.node;
}

export async function saveItem(input: {
  source: string;
  refId: string;
  title: string;
  href?: string;
  parentId?: string | null;
}): Promise<{ node: CustomNode; alreadySaved: boolean }> {
  return request("/items", { method: "POST", body: JSON.stringify(input) });
}

export async function updateNode(
  id: string,
  patch: {
    title?: string;
    parentId?: string | null;
    hasParentField?: boolean;
    position?: number;
    bodyHtml?: string;
    href?: string;
  },
): Promise<CustomNode> {
  const data = await request<{ node: CustomNode }>(`/nodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.node;
}

export async function deleteNode(id: string): Promise<number> {
  const data = await request<{ removed: number }>(`/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return data.removed;
}

// ─── Editable copies ────────────────────────────────────────────────────────

export async function makeCopy(input: {
  source: string;
  refId: string;
  title?: string;
  parentId?: string | null;
}): Promise<{ node: CustomNode; created: boolean }> {
  return request("/copy", { method: "POST", body: JSON.stringify(input) });
}

// ─── Images ─────────────────────────────────────────────────────────────────

export async function uploadImage(file: File): Promise<{ id: string; url: string }> {
  const form = new FormData();
  form.append("file", file);
  return request("/images", { method: "POST", body: form });
}

// ─── Annotations ────────────────────────────────────────────────────────────

export async function fetchAnnotations(
  source: string,
  refId: string | number,
): Promise<CustomAnnotation[]> {
  const data = await request<{ annotations: CustomAnnotation[] }>(
    `/annotations?source=${encodeURIComponent(source)}&ref_id=${encodeURIComponent(String(refId))}`,
  );
  return data.annotations;
}

export async function createAnnotation(input: {
  source: string;
  refId: string | number;
  quote: string;
  prefix?: string;
  suffix?: string;
  start?: number;
  end?: number;
  color?: string;
  note?: string;
}): Promise<CustomAnnotation> {
  const data = await request<{ annotation: CustomAnnotation }>("/annotations", {
    method: "POST",
    // Readers hold numeric vendor ids; the backend stores text ids.
    body: JSON.stringify({ ...input, refId: String(input.refId) }),
  });
  return data.annotation;
}

export async function updateAnnotation(
  id: string,
  patch: { color?: string; note?: string },
): Promise<void> {
  await request(`/annotations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteAnnotation(id: string): Promise<void> {
  await request(`/annotations/${encodeURIComponent(id)}`, { method: "DELETE" });
}
