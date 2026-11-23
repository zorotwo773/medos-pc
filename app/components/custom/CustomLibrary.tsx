"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Bookmark, Bold, ChevronDown, ChevronRight, ChevronUp, ExternalLink, FilePenLine,
  FileText, Folder, FolderOpen, Heading2, ImagePlus, Italic, Link2, List as ListIcon,
  ListOrdered, Loader2, Move, Pencil, Plus, Quote, Save, Trash2, Underline, X,
} from "lucide-react";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import {
  createFolder, createNote, deleteNode, fetchNode, fetchTree, updateNode, uploadImage,
  type CustomNode,
} from "@/lib/customLibrary";

type Modal =
  | { type: "newFolder"; parentId: string | null; value: string }
  | { type: "rename"; nodeId: string; value: string }
  | { type: "move"; nodeId: string; parentId: string | null }
  | { type: "delete"; nodeId: string; title: string }
  | null;

type DocDraft = { id: string; title: string; html: string };

const ACCENT = "#4f46e5";

const STYLES = `
.custom-lib-shell{display:flex;height:100%;min-height:0;background:var(--bg-base);color:var(--text-primary);}
.custom-lib-side{width:300px;min-width:232px;max-width:38vw;border-right:1px solid var(--border);background:var(--bg-card);display:flex;flex-direction:column;min-height:0;}
.custom-lib-side-head{padding:14px 14px 10px;border-bottom:1px solid var(--border);}
.custom-lib-side-actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;}
.custom-lib-tree{flex:1;overflow:auto;padding:8px;min-height:0;}
.custom-lib-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:hidden;}
.custom-lib-main-head{padding:12px 18px;border-bottom:1px solid var(--border);background:var(--bg-card);display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.custom-lib-scroll{flex:1;overflow:auto;padding:18px;min-height:0;}
.custom-tree-row{display:flex;align-items:center;gap:5px;padding:6px 7px;border-radius:7px;cursor:pointer;border:1px solid transparent;min-height:32px;}
.custom-tree-row:hover{background:var(--bg-card-hover);}
.custom-tree-row.is-selected{background:color-mix(in srgb, ${ACCENT} 13%, transparent);border-color:color-mix(in srgb, ${ACCENT} 32%, transparent);}
.custom-tree-row.is-drop{border-color:${ACCENT};background:color-mix(in srgb, ${ACCENT} 16%, transparent);}
.custom-tree-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;line-height:1.35;}
.custom-tree-count{font-size:10px;color:var(--text-muted);font-variant-numeric:tabular-nums;}
.custom-tree-toggle{width:18px;height:18px;flex-shrink:0;border:none;background:transparent;color:var(--text-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:4px;padding:0;}
.custom-tree-toggle:hover{background:var(--bg-subtle);}
.custom-lib-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;}
.custom-lib-btn:hover{background:var(--bg-card-hover);color:var(--text-primary);}
.custom-lib-btn.is-primary{background:${ACCENT};border-color:${ACCENT};color:#fff;}
.custom-lib-btn.is-primary:hover{filter:brightness(1.06);}
.custom-lib-btn.is-danger{color:#dc2626;border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.08);}
.custom-lib-btn:disabled{opacity:.55;cursor:default;}
.custom-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:none;background:transparent;color:var(--text-muted);cursor:pointer;flex-shrink:0;}
.custom-icon-btn:hover{background:var(--bg-subtle);color:var(--text-primary);}
.custom-item-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--border);background:var(--bg-card);border-radius:9px;cursor:pointer;min-width:0;}
.custom-item-row:hover{background:var(--bg-card-hover);}
.custom-item-row.is-selected{border-color:color-mix(in srgb, ${ACCENT} 45%, transparent);}
.custom-item-title{font-size:13px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.custom-item-sub{font-size:10.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}
.custom-item-actions{display:flex;align-items:center;gap:1px;margin-left:auto;flex-shrink:0;}
.custom-badge{font-size:9.5px;font-weight:800;letter-spacing:.04em;padding:2px 6px;border-radius:999px;white-space:nowrap;}
.custom-doc-title{font-size:17px;font-weight:700;color:var(--text-primary);border:none;background:transparent;outline:none;flex:1;min-width:120px;padding:2px 4px;border-radius:6px;}
.custom-doc-title:focus{background:var(--bg-subtle);}
.custom-doc-toolbar{display:flex;align-items:center;gap:3px;padding:6px 14px;border-bottom:1px solid var(--border);background:var(--bg-card);flex-wrap:wrap;}
.custom-doc-tool{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--text-secondary);cursor:pointer;}
.custom-doc-tool:hover{background:var(--bg-subtle);color:var(--text-primary);border-color:var(--border);}
.custom-doc-body{flex:1;overflow:auto;padding:22px 26px;line-height:1.7;font-size:14px;outline:none;background:var(--bg-base);min-height:180px;}
.custom-doc-body:empty:before{content:"Start writing…";color:var(--text-muted);}
.custom-doc-body img{max-width:100%;height:auto;display:block;margin:10px 0;border-radius:8px;border:1px solid var(--border);}
.custom-doc-body h1,.custom-doc-body h2,.custom-doc-body h3,.custom-doc-body h4{color:var(--text-primary);line-height:1.3;margin:18px 0 8px;}
.custom-doc-body p{margin:0 0 10px;}
.custom-doc-body table{border-collapse:collapse;width:100%;margin:10px 0;font-size:12.5px;}
.custom-doc-body td,.custom-doc-body th{border:1px solid var(--border);padding:6px 8px;text-align:left;}
.custom-doc-body blockquote{border-left:3px solid ${ACCENT};margin:10px 0;padding:4px 12px;color:var(--text-secondary);background:var(--bg-subtle);border-radius:0 7px 7px 0;}
.custom-doc-body pre{background:var(--bg-subtle);padding:10px;border-radius:8px;overflow:auto;}
.custom-doc-body a{color:${ACCENT};text-decoration:underline;}
.custom-doc-body mark{background:#fde68a;color:inherit;}
.custom-modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:5000;display:flex;align-items:center;justify-content:center;padding:18px;}
.custom-modal{width:min(460px,100%);background:var(--bg-card);border:1px solid var(--border);border-radius:14px;box-shadow:0 24px 70px rgba(15,23,42,.35);padding:18px;}
.custom-modal-title{font-size:15px;font-weight:800;margin:0 0 10px;}
.custom-modal-input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-base);color:var(--text-primary);font-size:13px;outline:none;}
.custom-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}
.custom-move-list{max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:9px;padding:6px;background:var(--bg-base);}
.custom-move-row{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:6px 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--text-secondary);font-size:12.5px;cursor:pointer;}
.custom-move-row:hover{background:var(--bg-card-hover);color:var(--text-primary);}
.custom-move-row.is-active{border-color:${ACCENT};background:color-mix(in srgb, ${ACCENT} 12%, transparent);color:var(--text-primary);font-weight:700;}
.custom-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text-muted);padding:60px 20px;text-align:center;font-size:13px;line-height:1.5;}
.custom-toast{position:fixed;right:18px;bottom:18px;z-index:6000;padding:9px 14px;border-radius:9px;font-size:12.5px;font-weight:700;box-shadow:0 12px 34px rgba(15,23,42,.24);background:var(--bg-card);border:1px solid var(--border);color:var(--text-primary);max-width:min(420px,90vw);}
.custom-toast.is-error{border-color:rgba(239,68,68,.45);color:#dc2626;background:color-mix(in srgb, #ef4444 10%, var(--bg-card));}
.custom-crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;min-width:0;}
.custom-crumb{border:none;background:transparent;color:var(--text-muted);font-size:11.5px;font-weight:700;cursor:pointer;padding:2px 5px;border-radius:5px;white-space:nowrap;}
.custom-crumb:hover{background:var(--bg-subtle);color:var(--text-primary);}
.custom-crumb.is-drop{background:color-mix(in srgb, ${ACCENT} 16%, transparent);color:var(--text-primary);}
.custom-spin{animation:custom-spin 1s linear infinite;}
@keyframes custom-spin{to{transform:rotate(360deg)}}
@media(max-width:760px){
  .custom-lib-side{width:210px;min-width:186px}
  .custom-doc-body{padding:16px}
  .custom-lib-scroll{padding:12px}
}
@media(max-width:560px){
  .custom-lib-shell{flex-direction:column}
  .custom-lib-side{width:100%;max-width:none;max-height:42dvh;border-right:none;border-bottom:1px solid var(--border)}
}
`;

const SOURCE_META: Record<string, { label: string; color: string; bg: string }> = {
  uworld: { label: "UWorld", color: "#1f7ec4", bg: "rgba(31,126,196,0.14)" },
  amboss: { label: "AMBOSS", color: "#0dbf8f", bg: "rgba(13,191,143,0.14)" },
  utd: { label: "UpToDate", color: "#00857c", bg: "rgba(0,133,124,0.14)" },
};

function sourceBadge(source: string | null) {
  const meta = SOURCE_META[source || ""] || { label: source || "Link", color: "#64748b", bg: "rgba(100,116,139,0.14)" };
  return (
    <span className="custom-badge" style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.color}44` }}>
      {meta.label}
    </span>
  );
}

function openMedosTab(href: string, title?: string) {
  if (!href || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("TabBar:open", { detail: { href, title } }));
}

function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export default function CustomLibrary() {
  const searchParams = useSearchParams();
  const [nodes, setNodes] = useState<CustomNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [mounted, setMounted] = useState(false);

  const [docDraft, setDocDraft] = useState<DocDraft | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handledDocParam = useRef<string>("");

  const flash = useCallback((text: string, isError = false) => {
    setNotice({ text, error: isError });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(id);
  }, [notice]);

  useEffect(() => setMounted(true), []);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchTree();
      setNodes(data.nodes);
      setError("");
      return data.nodes;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the Custom Library.");
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nodeById = useMemo(() => {
    const map = new Map<string, CustomNode>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, CustomNode[]>();
    for (const node of nodes) {
      const key = node.parentId || null;
      const list = map.get(key) || [];
      list.push(node);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.kind === "folder" && b.kind !== "folder") return -1;
        if (b.kind === "folder" && a.kind !== "folder") return 1;
        return a.position - b.position || a.title.localeCompare(b.title);
      });
    }
    return map;
  }, [nodes]);

  const selected = selectedId ? nodeById.get(selectedId) || null : null;

  const folderPath = useMemo(() => {
    const chain: CustomNode[] = [];
    let current = selected?.kind === "folder" ? selected : selected ? nodeById.get(selected.parentId || "") : null;
    let guard = 0;
    while (current && guard < 400) {
      chain.unshift(current);
      current = current.parentId ? nodeById.get(current.parentId) || null : null;
      guard += 1;
    }
    return chain;
  }, [nodeById, selected]);

  const currentFolderId = selected?.kind === "folder" ? selected.id : selected?.parentId || null;

  const selectNode = useCallback((id: string | null) => {
    setSelectedId(id);
    const node = id ? nodeById.get(id) : null;
    if (typeof window !== "undefined") {
      const url = node && node.kind === "doc"
        ? `/library/custom?doc=${encodeURIComponent(id as string)}`
        : "/library/custom";
      window.history.replaceState(null, "", url);
    }
  }, [nodeById]);

  // Deep-link support: /library/custom?doc=<id> opens that document directly.
  const docParam = searchParams.get("doc") || "";
  useEffect(() => {
    if (!docParam || !nodes.length || handledDocParam.current === docParam) return;
    const node = nodes.find(candidate => candidate.id === docParam);
    if (!node) return;
    handledDocParam.current = docParam;
    setSelectedId(node.id);
  }, [docParam, nodes]);

  // Keep the tree path to the selected node expanded.
  useEffect(() => {
    if (!selectedId) return;
    const ids: string[] = [];
    let current = nodeById.get(selectedId);
    let guard = 0;
    while (current?.parentId && guard < 400) {
      ids.push(current.parentId);
      current = nodeById.get(current.parentId);
      guard += 1;
    }
    if (ids.length) setExpanded(prev => new Set([...prev, ...ids]));
  }, [selectedId, nodeById]);

  // Load the editable body of the selected document.
  useEffect(() => {
    if (!selected || selected.kind !== "doc") {
      setDocDraft(null);
      setDirty(false);
      return;
    }
    let cancelled = false;
    setDocLoading(true);
    fetchNode(selected.id)
      .then(node => {
        if (cancelled) return;
        setDocDraft({ id: node.id, title: node.title, html: node.bodyHtml || "" });
        setDirty(false);
      })
      .catch(err => {
        if (!cancelled) flash(err instanceof Error ? err.message : "Could not open this document.", true);
      })
      .finally(() => { if (!cancelled) setDocLoading(false); });
    return () => { cancelled = true; };
  }, [flash, selected?.id, selected?.kind, selected?.updatedAt]);

  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  // ─── Mutations ────────────────────────────────────────────────────────────

  async function moveTo(nodeId: string, parentId: string | null) {
    if (nodeId === parentId) return;
    try {
      await updateNode(nodeId, { hasParentField: true, parentId });
      if (parentId) setExpanded(prev => new Set(prev).add(parentId));
      await refresh();
      flash(parentId ? "Moved into folder" : "Moved to the top level");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not move that item.", true);
    } finally {
      setDragId(null);
      setDropId(null);
    }
  }

  async function submitModal() {
    if (!modal) return;
    setBusy(true);
    try {
      if (modal.type === "newFolder") {
        const node = await createFolder(modal.value.trim() || "New folder", modal.parentId);
        await refresh();
        setExpanded(prev => modal.parentId ? new Set(prev).add(modal.parentId) : prev);
        selectNode(node.id);
        flash("Folder created");
      } else if (modal.type === "rename") {
        const title = modal.value.trim();
        if (!title) { setBusy(false); return; }
        await updateNode(modal.nodeId, { title });
        await refresh();
        if (docDraft?.id === modal.nodeId) setDocDraft({ ...docDraft, title });
        flash("Renamed");
      } else if (modal.type === "move") {
        await updateNode(modal.nodeId, { hasParentField: true, parentId: modal.parentId });
        if (modal.parentId) setExpanded(prev => new Set(prev).add(modal.parentId as string));
        await refresh();
        flash(modal.parentId ? "Moved into folder" : "Moved to the top level");
      } else if (modal.type === "delete") {
        const removed = await deleteNode(modal.nodeId);
        const tree = await refresh();
        const stillPresent = tree.some(node => node.id === selectedId);
        if (!stillPresent) selectNode(null);
        flash(removed > 1 ? `Deleted ${removed} items` : "Deleted");
      }
      setModal(null);
    } catch (err) {
      flash(err instanceof Error ? err.message : "That action could not be completed.", true);
    } finally {
      setBusy(false);
    }
  }

  async function saveDoc() {
    if (!docDraft) return;
    setBusy(true);
    try {
      const html = sanitizeHtml(editorRef.current?.innerHTML || "");
      await updateNode(docDraft.id, { title: docDraft.title.trim() || "Untitled", bodyHtml: html });
      await refresh();
      setDirty(false);
      flash("Saved");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not save this document.", true);
    } finally {
      setBusy(false);
    }
  }

  async function cancelDoc() {
    if (!docDraft) return;
    try {
      const node = await fetchNode(docDraft.id);
      setDocDraft({ id: node.id, title: node.title, html: node.bodyHtml || "" });
      setDirty(false);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not reload this document.", true);
    }
  }

  async function newNote() {
    try {
      const node = await createNote("Untitled note", currentFolderId);
      await refresh();
      if (currentFolderId) setExpanded(prev => new Set(prev).add(currentFolderId));
      selectNode(node.id);
      flash("Note created");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not create a note.", true);
    }
  }

  async function insertImage(file: File | undefined) {
    if (!file) return;
    try {
      flash("Uploading image…");
      const { url } = await uploadImage(file);
      const editor = editorRef.current;
      if (editor) {
        editor.insertAdjacentHTML(
          "beforeend",
          `<p><img src="${url}" alt="${escapeAttr(file.name)}"></p>`,
        );
        setDirty(true);
      }
      flash("Image added — remember to save");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not upload that image.", true);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function format(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    setDirty(true);
  }

  // ─── Tree rendering ───────────────────────────────────────────────────────

  function descendantsOf(id: string): string[] {
    const out: string[] = [];
    const queue = [id];
    while (queue.length) {
      const current = queue.shift() as string;
      for (const child of childrenByParent.get(current) || []) {
        out.push(child.id);
        if (child.kind === "folder") queue.push(child.id);
      }
    }
    return out;
  }

  function renderTree(parentId: string | null, depth: number): React.ReactNode {
    const items = childrenByParent.get(parentId) || [];
    return items.map(node => {
      const isFolder = node.kind === "folder";
      const isOpen = expanded.has(node.id);
      const count = isFolder ? (childrenByParent.get(node.id) || []).length : 0;
      const isSelected = node.id === selectedId;
      const isDrop = dropId === node.id;
      return (
        <div key={node.id}>
          <div
            className={`custom-tree-row${isSelected ? " is-selected" : ""}${isDrop ? " is-drop" : ""}`}
            style={{ paddingLeft: 7 + depth * 13 }}
            onClick={() => {
              selectNode(node.id);
              if (isFolder) setExpanded(prev => new Set(prev).add(node.id));
            }}
            onDoubleClick={() => {
              if (isFolder) {
                setExpanded(prev => {
                  const next = new Set(prev);
                  if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
                  return next;
                });
              }
            }}
            draggable
            onDragStart={event => {
              setDragId(node.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", node.id);
            }}
            onDragEnd={() => { setDragId(null); setDropId(null); }}
            onDragOver={isFolder ? event => {
              if (!dragId || dragId === node.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropId(node.id);
            } : undefined}
            onDragLeave={isFolder ? () => setDropId(prev => prev === node.id ? null : prev) : undefined}
            onDrop={isFolder ? event => {
              event.preventDefault();
              const source = dragId || event.dataTransfer.getData("text/plain");
              if (source) void moveTo(source, node.id);
            } : undefined}
            title={node.title}
          >
            {isFolder ? (
              <button
                type="button"
                className="custom-tree-toggle"
                onClick={event => {
                  event.stopPropagation();
                  setExpanded(prev => {
                    const next = new Set(prev);
                    if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
                    return next;
                  });
                }}
                aria-label={isOpen ? "Collapse folder" : "Expand folder"}
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : (
              <span style={{ width: 18, flexShrink: 0 }} />
            )}
            {isFolder
              ? isOpen ? <FolderOpen size={15} color={ACCENT} /> : <Folder size={15} color={ACCENT} />
              : node.kind === "link" ? <Bookmark size={14} color="#0f766e" /> : <FileText size={14} color="#64748b" />}
            <span className="custom-tree-label">{node.title}</span>
            {isFolder && count > 0 && <span className="custom-tree-count">{count}</span>}
          </div>
          {isFolder && isOpen && renderTree(node.id, depth + 1)}
        </div>
      );
    });
  }

  // ─── Item rows (right pane) ───────────────────────────────────────────────

  function renderItems(folderId: string | null) {
    const items = childrenByParent.get(folderId) || [];
    if (!items.length) {
      return (
        <div className="custom-empty">
          <FolderOpen size={34} strokeWidth={1.4} />
          <div>
            <strong style={{ color: "var(--text-secondary)" }}>This folder is empty</strong>
            <div>Use the buttons above to add a folder, a note, or mark an article from any library.</div>
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 9 }}>
        {items.map(node => (
          <div
            key={node.id}
            className={`custom-item-row${node.id === selectedId ? " is-selected" : ""}`}
            onClick={() => selectNode(node.id)}
            onDragOver={node.kind === "folder" ? event => {
              if (!dragId || dragId === node.id) return;
              event.preventDefault();
              setDropId(node.id);
            } : undefined}
            onDragLeave={node.kind === "folder" ? () => setDropId(prev => prev === node.id ? null : prev) : undefined}
            onDrop={node.kind === "folder" ? event => {
              event.preventDefault();
              const source = dragId || event.dataTransfer.getData("text/plain");
              if (source) void moveTo(source, node.id);
            } : undefined}
            draggable
            onDragStart={event => {
              setDragId(node.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", node.id);
            }}
            onDragEnd={() => { setDragId(null); setDropId(null); }}
            title={node.title}
          >
            {node.kind === "folder" ? <Folder size={18} color={ACCENT} /> : node.kind === "link" ? <Bookmark size={18} color="#0f766e" /> : <FileText size={18} color="#64748b" />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="custom-item-title">{node.title}</div>
              <div className="custom-item-sub">
                {node.kind === "folder"
                  ? `${(childrenByParent.get(node.id) || []).length} item${(childrenByParent.get(node.id) || []).length === 1 ? "" : "s"}`
                  : node.kind === "link"
                    ? `${SOURCE_META[node.source || ""]?.label || node.source || "Link"}${node.refId ? ` · #${node.refId}` : ""}`
                    : node.meta?.origin === "copy"
                      ? `Editable copy${node.meta?.originSource ? ` of ${SOURCE_META[String(node.meta.originSource)]?.label || String(node.meta.originSource)}` : ""}`
                      : "Note"}
              </div>
            </div>
            <div className="custom-item-actions">
              <button type="button" className="custom-icon-btn" title="Rename" onClick={event => {
                event.stopPropagation();
                setModal({ type: "rename", nodeId: node.id, value: node.title });
              }}>
                <Pencil size={13} />
              </button>
              <button type="button" className="custom-icon-btn" title="Move" onClick={event => {
                event.stopPropagation();
                setModal({ type: "move", nodeId: node.id, parentId: node.parentId });
              }}>
                <Move size={13} />
              </button>
              <button type="button" className="custom-icon-btn" title="Delete" onClick={event => {
                event.stopPropagation();
                setModal({ type: "delete", nodeId: node.id, title: node.title });
              }}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderCrumbs(folderId: string | null) {
    const chain: CustomNode[] = [];
    let current = folderId ? nodeById.get(folderId) || null : null;
    let guard = 0;
    while (current && guard < 400) {
      chain.unshift(current);
      current = current.parentId ? nodeById.get(current.parentId) || null : null;
      guard += 1;
    }
    return (
      <div className="custom-crumbs">
        <button
          type="button"
          className="custom-crumb"
          onClick={() => selectNode(null)}
          onDragOver={event => { if (dragId) { event.preventDefault(); setDropId("__root__"); } }}
          onDragLeave={() => setDropId(prev => prev === "__root__" ? null : prev)}
          onDrop={event => {
            event.preventDefault();
            const source = dragId || event.dataTransfer.getData("text/plain");
            if (source) void moveTo(source, null);
          }}
          style={dropId === "__root__" ? { background: "color-mix(in srgb, #4f46e5 16%, transparent)", color: "var(--text-primary)" } : undefined}
        >
          Custom Library
        </button>
        {chain.map(folder => (
          <span key={folder.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <ChevronRight size={11} color="var(--text-muted)" />
            <button
              type="button"
              className="custom-crumb"
              onClick={() => selectNode(folder.id)}
              onDragOver={event => { if (dragId && dragId !== folder.id) { event.preventDefault(); setDropId(folder.id); } }}
              onDragLeave={() => setDropId(prev => prev === folder.id ? null : prev)}
              onDrop={event => {
                event.preventDefault();
                const source = dragId || event.dataTransfer.getData("text/plain");
                if (source) void moveTo(source, folder.id);
              }}
              style={dropId === folder.id ? { background: "color-mix(in srgb, #4f46e5 16%, transparent)", color: "var(--text-primary)" } : undefined}
            >
              {folder.title}
            </button>
          </span>
        ))}
        {selected && selected.kind !== "folder" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <ChevronRight size={11} color="var(--text-muted)" />
            <span style={{ fontSize: 11.5, fontWeight: 800, color: "var(--text-primary)", padding: "2px 5px" }}>
              {selected.title}
            </span>
          </span>
        )}
      </div>
    );
  }

  // ─── Right pane ───────────────────────────────────────────────────────────

  function renderFolderView(folderId: string | null) {
    const folder = folderId ? nodeById.get(folderId) || null : null;
    const items = childrenByParent.get(folderId) || [];
    return (
      <>
        <div className="custom-lib-main-head">
          {renderCrumbs(folderId)}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="custom-lib-btn" onClick={() => setModal({ type: "newFolder", parentId: folderId, value: "" })}>
              <Plus size={13} /> Folder
            </button>
            <button type="button" className="custom-lib-btn" onClick={() => void newNote()}>
              <FilePenLine size={13} /> Note
            </button>
            {folder && (
              <>
                <button type="button" className="custom-lib-btn" onClick={() => setModal({ type: "rename", nodeId: folder.id, value: folder.title })}>
                  <Pencil size={13} /> Rename
                </button>
                <button type="button" className="custom-lib-btn" onClick={() => setModal({ type: "move", nodeId: folder.id, parentId: folder.parentId })}>
                  <Move size={13} /> Move
                </button>
                <button type="button" className="custom-lib-btn is-danger" onClick={() => setModal({ type: "delete", nodeId: folder.id, title: folder.title })}>
                  <Trash2 size={13} /> Delete
                </button>
              </>
            )}
          </div>
        </div>
        <div className="custom-lib-scroll">
          <div style={{ marginBottom: 12, display: "flex", alignItems: "baseline", gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{folder ? folder.title : "All items"}</h2>
            <span style={{ fontSize: 11.5, color: "var(--text-muted)", fontWeight: 700 }}>
              {items.length} item{items.length === 1 ? "" : "s"}
            </span>
          </div>
          {renderItems(folderId)}
        </div>
      </>
    );
  }

  function renderLinkView(node: CustomNode) {
    const meta = SOURCE_META[node.source || ""];
    return (
      <>
        <div className="custom-lib-main-head">
          {renderCrumbs(node.parentId)}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button type="button" className="custom-lib-btn" onClick={() => setModal({ type: "rename", nodeId: node.id, value: node.title })}>
              <Pencil size={13} /> Rename
            </button>
            <button type="button" className="custom-lib-btn" onClick={() => setModal({ type: "move", nodeId: node.id, parentId: node.parentId })}>
              <Move size={13} /> Move
            </button>
            <button type="button" className="custom-lib-btn is-danger" onClick={() => setModal({ type: "delete", nodeId: node.id, title: node.title })}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </div>
        <div className="custom-lib-scroll">
          <div style={{
            maxWidth: 720, background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: 12, padding: 20,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Bookmark size={18} color="#0f766e" />
              {sourceBadge(node.source)}
              {node.refId && <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "ui-monospace, monospace" }}>#{node.refId}</span>}
            </div>
            <h2 style={{ margin: "0 0 8px", fontSize: 20, lineHeight: 1.35 }}>{node.title}</h2>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 16 }}>
              Saved {new Date(node.createdAt).toLocaleString()}
              {meta ? ` · from ${meta.label}` : ""}
              {node.parentId ? ` · in ${nodeById.get(node.parentId)?.title || "folder"}` : " · top level"}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="custom-lib-btn is-primary"
                onClick={() => openMedosTab(node.href || node.meta?.originHref as string || "", node.title)}
                disabled={!node.href}
              >
                <ExternalLink size={13} /> Open article
              </button>
              {node.source && node.refId && (
                <button
                  type="button"
                  className="custom-lib-btn"
                  onClick={() => openMedosTab(
                    node.source === "uworld" ? `/library/uworld?doc=${node.refId}`
                      : node.source === "amboss" ? `/amboss?doc=${node.refId}`
                        : node.source === "utd" ? `/uptodate?t=${node.refId}`
                          : node.href || "",
                    node.title,
                  )}
                >
                  <Link2 size={13} /> Open in {meta?.label || "reader"}
                </button>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  function renderDocView(node: CustomNode) {
    const originHref = typeof node.meta?.originHref === "string" ? node.meta.originHref : "";
    return (
      <>
        <div className="custom-lib-main-head">
          {renderCrumbs(node.parentId)}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            {originHref && (
              <button type="button" className="custom-lib-btn" onClick={() => openMedosTab(originHref, node.title)}>
                <ExternalLink size={13} /> Original
              </button>
            )}
            <button type="button" className="custom-lib-btn" onClick={() => setModal({ type: "move", nodeId: node.id, parentId: node.parentId })}>
              <Move size={13} /> Move
            </button>
            <button type="button" className="custom-lib-btn is-danger" onClick={() => setModal({ type: "delete", nodeId: node.id, title: node.title })}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
          <input
            className="custom-doc-title"
            value={docDraft?.title ?? node.title}
            onChange={event => {
              setDocDraft(prev => prev ? { ...prev, title: event.target.value } : prev);
              setDirty(true);
            }}
            placeholder="Document title"
            aria-label="Document title"
          />
          {dirty && <span style={{ fontSize: 10.5, fontWeight: 800, color: "#d97706", whiteSpace: "nowrap" }}>Unsaved</span>}
          <button type="button" className="custom-lib-btn" onClick={() => void cancelDoc()} disabled={!dirty || busy}>
            <X size={13} /> Cancel
          </button>
          <button type="button" className="custom-lib-btn is-primary" onClick={() => void saveDoc()} disabled={!dirty || busy}>
            {busy ? <Loader2 size={13} className="custom-spin" /> : <Save size={13} />} Save
          </button>
        </div>

        <div className="custom-doc-toolbar">
          <button type="button" className="custom-doc-tool" title="Bold" onMouseDown={event => event.preventDefault()} onClick={() => format("bold")}><Bold size={14} /></button>
          <button type="button" className="custom-doc-tool" title="Italic" onMouseDown={event => event.preventDefault()} onClick={() => format("italic")}><Italic size={14} /></button>
          <button type="button" className="custom-doc-tool" title="Underline" onMouseDown={event => event.preventDefault()} onClick={() => format("underline")}><Underline size={14} /></button>
          <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
          <button type="button" className="custom-doc-tool" title="Heading" onMouseDown={event => event.preventDefault()} onClick={() => format("formatBlock", "h2")}><Heading2 size={15} /></button>
          <button type="button" className="custom-doc-tool" title="Bulleted list" onMouseDown={event => event.preventDefault()} onClick={() => format("insertUnorderedList")}><ListIcon size={15} /></button>
          <button type="button" className="custom-doc-tool" title="Numbered list" onMouseDown={event => event.preventDefault()} onClick={() => format("insertOrderedList")}><ListOrdered size={15} /></button>
          <button type="button" className="custom-doc-tool" title="Quote" onMouseDown={event => event.preventDefault()} onClick={() => format("formatBlock", "blockquote")}><Quote size={14} /></button>
          <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
          <button type="button" className="custom-doc-tool" title="Insert image" onClick={() => fileInputRef.current?.click()}><ImagePlus size={15} /></button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={event => void insertImage(event.target.files?.[0])}
          />
          <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-muted)", fontWeight: 700 }}>
            {node.meta?.origin === "copy" ? "Editable copy — the original library is untouched" : "Note"}
          </span>
        </div>

        {docLoading || !docDraft ? (
          <div className="custom-empty"><Loader2 size={22} className="custom-spin" /> Loading document…</div>
        ) : mounted ? (
          <div
            key={docDraft.id}
            ref={editorRef}
            className="custom-doc-body"
            contentEditable
            suppressContentEditableWarning
            spellCheck
            onInput={() => setDirty(true)}
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(docDraft.html) }}
          />
        ) : (
          <div className="custom-empty">Loading editor…</div>
        )}
      </>
    );
  }

  // ─── Modal ────────────────────────────────────────────────────────────────

  function renderModal() {
    if (!modal) return null;
    const title =
      modal.type === "newFolder" ? "New folder"
        : modal.type === "rename" ? "Rename"
          : modal.type === "move" ? "Move to folder"
            : "Delete item";
    return (
      <div className="custom-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setModal(null); }}>
        <div className="custom-modal" role="dialog" aria-modal="true" aria-label={title}>
          <h3 className="custom-modal-title">{title}</h3>

          {modal.type === "newFolder" && (
            <>
              <input
                autoFocus
                className="custom-modal-input"
                placeholder="Folder name"
                value={modal.value}
                onChange={event => setModal({ ...modal, value: event.target.value })}
                onKeyDown={event => { if (event.key === "Enter") void submitModal(); }}
              />
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 7 }}>
                {modal.parentId ? `Inside “${nodeById.get(modal.parentId)?.title || "folder"}”` : "At the top level"}
              </div>
            </>
          )}

          {modal.type === "rename" && (
            <input
              autoFocus
              className="custom-modal-input"
              value={modal.value}
              onChange={event => setModal({ ...modal, value: event.target.value })}
              onKeyDown={event => { if (event.key === "Enter") void submitModal(); }}
            />
          )}

          {modal.type === "move" && (
            <div className="custom-move-list">
              <button
                type="button"
                className={`custom-move-row${modal.parentId === null ? " is-active" : ""}`}
                onClick={() => setModal({ ...modal, parentId: null })}
              >
                <FolderOpen size={14} color={ACCENT} /> Top level
              </button>
              {nodes.filter(node => node.kind === "folder").map(folder => {
                const blocked = folder.id === modal.nodeId
                  || descendantsOf(modal.nodeId).includes(folder.id);
                const depth = (() => {
                  let d = 0;
                  let current: CustomNode | undefined = folder;
                  while (current?.parentId && d < 200) {
                    d += 1;
                    current = nodeById.get(current.parentId);
                  }
                  return d;
                })();
                return (
                  <button
                    key={folder.id}
                    type="button"
                    className={`custom-move-row${modal.parentId === folder.id ? " is-active" : ""}`}
                    disabled={blocked}
                    onClick={() => setModal({ ...modal, parentId: folder.id })}
                    style={{ paddingLeft: 8 + depth * 14, opacity: blocked ? 0.4 : 1 }}
                  >
                    <Folder size={14} color={ACCENT} /> {folder.title}
                  </button>
                );
              })}
            </div>
          )}

          {modal.type === "delete" && (
            <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
              Delete <strong style={{ color: "var(--text-primary)" }}>{modal.title}</strong>?
              {nodes.find(node => node.id === modal.nodeId)?.kind === "folder" &&
                " Everything inside this folder will be deleted too."}{" "}
              This cannot be undone.
            </div>
          )}

          <div className="custom-modal-actions">
            <button type="button" className="custom-lib-btn" onClick={() => setModal(null)} disabled={busy}>Cancel</button>
            <button
              type="button"
              className={`custom-lib-btn ${modal.type === "delete" ? "is-danger" : "is-primary"}`}
              onClick={() => void submitModal()}
              disabled={busy || (modal.type === "rename" && !modal.value.trim()) || (modal.type === "newFolder" && !modal.value.trim())}
            >
              {busy && <Loader2 size={13} className="custom-spin" />}
              {modal.type === "delete" ? "Delete" : modal.type === "move" ? "Move here" : "Save"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Shell ────────────────────────────────────────────────────────────────

  return (
    <div className="custom-lib-shell">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <aside className="custom-lib-side">
        <div className="custom-lib-side-head">
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 9, display: "flex", alignItems: "center",
              justifyContent: "center", background: "color-mix(in srgb, #4f46e5 14%, transparent)",
              border: "1px solid color-mix(in srgb, #4f46e5 32%, transparent)",
            }}>
              <Bookmark size={16} color={ACCENT} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.2 }}>Custom Library</div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                {nodes.length} item{nodes.length === 1 ? "" : "s"} · your private space
              </div>
            </div>
          </div>
          <div className="custom-lib-side-actions">
            <button type="button" className="custom-lib-btn is-primary" onClick={() => setModal({ type: "newFolder", parentId: currentFolderId, value: "" })}>
              <Plus size={13} /> Folder
            </button>
            <button type="button" className="custom-lib-btn" onClick={() => void newNote()}>
              <FilePenLine size={13} /> Note
            </button>
            <button type="button" className="custom-lib-btn" onClick={() => void refresh()} title="Refresh">
              <ChevronUp size={13} /> Refresh
            </button>
          </div>
        </div>

        <div className="custom-lib-tree">
          <div
            className={`custom-tree-row${selectedId === null ? " is-selected" : ""}${dropId === "__root__" ? " is-drop" : ""}`}
            onClick={() => selectNode(null)}
            onDragOver={event => { if (dragId) { event.preventDefault(); setDropId("__root__"); } }}
            onDragLeave={() => setDropId(prev => prev === "__root__" ? null : prev)}
            onDrop={event => {
              event.preventDefault();
              const source = dragId || event.dataTransfer.getData("text/plain");
              if (source) void moveTo(source, null);
            }}
            title="Show everything at the top level"
          >
            <span style={{ width: 18, flexShrink: 0 }} />
            <Bookmark size={15} color={ACCENT} />
            <span className="custom-tree-label" style={{ fontWeight: 800 }}>All items</span>
            <span className="custom-tree-count">{childrenByParent.get(null)?.length || 0}</span>
          </div>
          {renderTree(null, 0)}
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: 12, fontSize: 12, color: "var(--text-muted)" }}>
              <Loader2 size={14} className="custom-spin" /> Loading…
            </div>
          )}
          {error && (
            <div style={{ padding: 10, fontSize: 11.5, color: "#dc2626", lineHeight: 1.5 }}>
              {error}
            </div>
          )}
          <div style={{ padding: "10px 8px", fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Drag any item onto a folder to move it. Folders can hold other folders, notes and marked articles.
          </div>
        </div>
      </aside>

      <main className="custom-lib-main">
        {selected?.kind === "folder"
          ? renderFolderView(selected.id)
          : selected?.kind === "link"
            ? renderLinkView(selected)
            : selected?.kind === "doc"
              ? renderDocView(selected)
              : renderFolderView(null)}
      </main>

      {renderModal()}

      {notice && (
        <div className={`custom-toast${notice.error ? " is-error" : ""}`} role="status">
          {notice.text}
        </div>
      )}
    </div>
  );
}
