"use client";
/**
 * Q-Bank → Custom workspace tab.
 *
 * Mirrors the Custom Library organizer, but for saved question sessions. Every
 * session the user creates appears here automatically. Folders nest without a
 * depth limit; sessions and folders can be dragged anywhere, reordered, renamed
 * and deleted. The organizer metadata is local (like the sessions themselves),
 * stored under `medos.qbank.custom.v1`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, Folder, FolderOpen,
  FolderPlus, GripVertical, Move, Pencil, Play, RotateCcw, Trash2, X,
} from "lucide-react";
import type { Session } from "./QuizEngine";

const ORG_KEY = "medos.qbank.custom.v1";
const ROOT_DROP = "__root__";

interface OrgFolder {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
}

interface OrgPlacement {
  folderId: string | null;
  position: number;
}

interface OrgState {
  folders: OrgFolder[];
  placements: Record<string, OrgPlacement>;
}

const EMPTY_ORG: OrgState = { folders: [], placements: {} };

type Dialog =
  | { type: "newFolder"; parentId: string | null; value: string }
  | { type: "renameFolder"; folderId: string; value: string }
  | { type: "renameSession"; sessionId: string; value: string }
  | { type: "moveSession"; sessionId: string; value: string }
  | { type: "moveFolder"; folderId: string; value: string }
  | null;

interface Props {
  sessions: Session[];
  activeSessionId?: string;
  labelForDb: (db: string) => string;
  onOpen: (session: Session) => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (session: Session) => void;
  onRegenerate: (session: Session) => void;
}

function parseOrg(raw: unknown): OrgState {
  if (!raw || typeof raw !== "object") return EMPTY_ORG;
  const value = raw as { folders?: unknown; placements?: unknown };
  const folders: OrgFolder[] = Array.isArray(value.folders)
    ? value.folders
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map(item => ({
          id: String(item.id || ""),
          name: String(item.name || "Folder").slice(0, 120),
          parentId: item.parentId == null ? null : String(item.parentId),
          position: Number.isFinite(Number(item.position)) ? Number(item.position) : 0,
        }))
        .filter(item => item.id)
    : [];
  const placements: Record<string, OrgPlacement> = {};
  if (value.placements && typeof value.placements === "object") {
    for (const [sessionId, entry] of Object.entries(value.placements as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as { folderId?: unknown; position?: unknown };
      placements[sessionId] = {
        folderId: item.folderId == null ? null : String(item.folderId),
        position: Number.isFinite(Number(item.position)) ? Number(item.position) : 0,
      };
    }
  }
  const known = new Set(folders.map(folder => folder.id));
  for (const placement of Object.values(placements)) {
    if (placement.folderId && !known.has(placement.folderId)) placement.folderId = null;
  }
  return { folders, placements };
}

function readOrg(): OrgState {
  if (typeof window === "undefined") return EMPTY_ORG;
  try {
    return parseOrg(JSON.parse(window.localStorage.getItem(ORG_KEY) || "null"));
  } catch {
    return EMPTY_ORG;
  }
}

function writeOrg(org: OrgState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ORG_KEY, JSON.stringify(org));
  } catch { /* storage full — organizer still works for this tab session */ }
}

function newFolderId() {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function nextFolderPosition(folders: OrgFolder[], parentId: string | null, ignoreId?: string) {
  const siblings = folders.filter(folder => folder.parentId === parentId && folder.id !== ignoreId);
  return siblings.reduce((highest, folder) => Math.max(highest, folder.position), -1) + 1;
}

function descendantFolderIds(folders: OrgFolder[], folderId: string) {
  const children = new Map<string | null, OrgFolder[]>();
  for (const folder of folders) {
    const list = children.get(folder.parentId) || [];
    list.push(folder);
    children.set(folder.parentId, list);
  }
  const found = new Set<string>();
  const queue = [folderId];
  while (queue.length) {
    const id = queue.pop()!;
    for (const child of children.get(id) || []) {
      if (found.has(child.id)) continue;
      found.add(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

function sessionTitle(session: Session) {
  const label = (session.blockLabel || "").trim();
  if (label) return label;
  const query = (session.filters?.query || "").trim();
  if (query) return `${query} · ${session.questions.length} Qs`;
  return `${session.questions.length}-question block`;
}

function formatWhen(value: string | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function answeredCount(session: Session) {
  return Object.keys(session.answers || {}).length;
}

export default function SessionLibrary({
  sessions,
  activeSessionId,
  labelForDb,
  onOpen,
  onRename,
  onDelete,
  onRegenerate,
}: Props) {
  const [org, setOrg] = useState<OrgState>(EMPTY_ORG);
  const orgRef = useRef(org);
  orgRef.current = org;
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<{ kind: "session" | "folder"; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  // Loaded in an effect so server-rendered markup and the first client render
  // match (localStorage is unavailable during SSR).
  useEffect(() => {
    orgRef.current = readOrg();
    setOrg(orgRef.current);
  }, []);

  const commit = useCallback((next: OrgState) => {
    orgRef.current = next;
    setOrg(next);
    writeOrg(next);
  }, []);

  const visibleSessions = useMemo(
    () => sessions.filter(session => !session.transient),
    [sessions],
  );

  const folderById = useMemo(
    () => new Map(org.folders.map(folder => [folder.id, folder])),
    [org.folders],
  );

  const foldersOf = useCallback(
    (parentId: string | null) =>
      org.folders
        .filter(folder => folder.parentId === parentId)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [org.folders],
  );

  const sessionsOf = useCallback(
    (folderId: string | null) => {
      const list = visibleSessions.filter(
        session => (org.placements[session.id]?.folderId ?? null) === folderId,
      );
      return list.sort((a, b) => {
        const pa = org.placements[a.id]?.position;
        const pb = org.placements[b.id]?.position;
        if (pa != null && pb != null && pa !== pb) return pa - pb;
        if (pa != null && pb == null) return -1;
        if (pb != null && pa == null) return 1;
        return Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt);
      });
    },
    [org.placements, visibleSessions],
  );

  const countSessionsUnder = useCallback(
    (folderId: string): number => {
      const blocked = descendantFolderIds(org.folders, folderId);
      return visibleSessions.filter(session => {
        const placed = org.placements[session.id]?.folderId ?? null;
        return placed === folderId || (placed != null && blocked.has(placed));
      }).length;
    },
    [org.folders, org.placements, visibleSessions],
  );

  const roots = useMemo(() => {
    if (!selectedFolderId) return [] as OrgFolder[];
    const path: OrgFolder[] = [];
    let cursor = folderById.get(selectedFolderId);
    let guard = 0;
    while (cursor && guard < 200) {
      path.unshift(cursor);
      cursor = cursor.parentId ? folderById.get(cursor.parentId) : undefined;
      guard += 1;
    }
    return path;
  }, [folderById, selectedFolderId]);

  const selectedFolder = selectedFolderId ? folderById.get(selectedFolderId) || null : null;
  const currentFolders = foldersOf(selectedFolderId);
  const currentSessions = sessionsOf(selectedFolderId);

  // ─── Mutations ────────────────────────────────────────────────────────────

  const createFolder = useCallback((parentId: string | null, rawName: string) => {
    const name = rawName.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) return;
    const next: OrgState = {
      ...orgRef.current,
      folders: [
        ...orgRef.current.folders,
        {
          id: newFolderId(),
          name,
          parentId,
          position: nextFolderPosition(orgRef.current.folders, parentId),
        },
      ],
    };
    commit(next);
    if (parentId) {
      setOpenFolders(previous => new Set(previous).add(parentId));
    }
  }, [commit]);

  const renameFolder = useCallback((folderId: string, rawName: string) => {
    const name = rawName.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) return;
    commit({
      ...orgRef.current,
      folders: orgRef.current.folders.map(folder =>
        folder.id === folderId ? { ...folder, name } : folder),
    });
  }, [commit]);

  const deleteFolder = useCallback((folderId: string) => {
    const folder = orgRef.current.folders.find(item => item.id === folderId);
    if (!folder) return;
    const confirmed = window.confirm(
      `Delete "${folder.name}"?\n\nSessions and subfolders inside move up one level. Nothing is deleted.`,
    );
    if (!confirmed) return;
    const parentId = folder.parentId;
    const placements: Record<string, OrgPlacement> = {};
    for (const [sessionId, placement] of Object.entries(orgRef.current.placements)) {
      placements[sessionId] = placement.folderId === folderId ? { ...placement, folderId: parentId } : placement;
    }
    commit({
      folders: orgRef.current.folders
        .filter(item => item.id !== folderId)
        .map(item => item.parentId === folderId ? { ...item, parentId } : item),
      placements,
    });
    if (selectedFolderId === folderId) setSelectedFolderId(parentId);
  }, [commit, selectedFolderId]);

  const moveFolder = useCallback((folderId: string, parentId: string | null) => {
    if (folderId === parentId) return;
    const folder = orgRef.current.folders.find(item => item.id === folderId);
    if (!folder) return;
    const blocked = descendantFolderIds(orgRef.current.folders, folderId);
    if (parentId && blocked.has(parentId)) return;
    commit({
      ...orgRef.current,
      folders: orgRef.current.folders.map(item =>
        item.id === folderId
          ? { ...item, parentId, position: nextFolderPosition(orgRef.current.folders, parentId, folderId) }
          : item),
    });
    if (parentId) setOpenFolders(previous => new Set(previous).add(parentId));
  }, [commit]);

  const moveSession = useCallback((sessionId: string, folderId: string | null) => {
    const siblings = sessionsOf(folderId);
    const position = siblings.reduce(
      (highest, session) => Math.max(highest, orgRef.current.placements[session.id]?.position ?? -1),
      -1,
    ) + 1;
    commit({
      ...orgRef.current,
      placements: {
        ...orgRef.current.placements,
        [sessionId]: { folderId, position },
      },
    });
    if (folderId) setOpenFolders(previous => new Set(previous).add(folderId));
  }, [commit, sessionsOf]);

  const reorderSession = useCallback((sessionId: string, direction: -1 | 1) => {
    const folderId = orgRef.current.placements[sessionId]?.folderId ?? null;
    const list = sessionsOf(folderId);
    const index = list.findIndex(session => session.id === sessionId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    const placements = { ...orgRef.current.placements };
    list.forEach((session, position) => {
      placements[session.id] = { folderId, position };
    });
    const swap = list[target].id;
    placements[sessionId] = { folderId, position: target };
    placements[swap] = { folderId, position: index };
    commit({ ...orgRef.current, placements });
  }, [commit, sessionsOf]);

  // ─── Drag and drop ────────────────────────────────────────────────────────

  const beginDrag = (event: React.DragEvent, kind: "session" | "folder", id: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${kind}:${id}`);
    setDrag({ kind, id });
  };

  const dropOnFolder = (event: React.DragEvent, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    let payload = drag;
    if (!payload) {
      const raw = event.dataTransfer.getData("text/plain");
      const [kind, id] = raw.split(":");
      if ((kind === "session" || kind === "folder") && id) payload = { kind, id };
    }
    if (payload) {
      if (payload.kind === "session") moveSession(payload.id, folderId);
      else if (folderId) moveFolder(payload.id, folderId);
      else moveFolder(payload.id, null);
    }
    setDrag(null);
    setDropTarget(null);
  };

  const endDrag = () => {
    setDrag(null);
    setDropTarget(null);
  };

  // ─── Tree ─────────────────────────────────────────────────────────────────

  const renderFolders = (parentId: string | null, depth: number): React.ReactNode =>
    foldersOf(parentId).map(folder => {
      const children = foldersOf(folder.id);
      const open = openFolders.has(folder.id) || selectedFolderId === folder.id;
      const count = countSessionsUnder(folder.id);
      return (
        <div key={folder.id}>
          <div
            className={`qbank-custom-tree-row ${selectedFolderId === folder.id ? "is-selected" : ""} ${dropTarget === folder.id ? "is-drop" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => setSelectedFolderId(folder.id)}
            onDoubleClick={() => setDialog({ type: "renameFolder", folderId: folder.id, value: folder.name })}
            draggable
            onDragStart={event => beginDrag(event, "folder", folder.id)}
            onDragEnd={endDrag}
            onDragOver={event => { event.preventDefault(); event.stopPropagation(); setDropTarget(folder.id); }}
            onDragLeave={() => setDropTarget(current => current === folder.id ? null : current)}
            onDrop={event => dropOnFolder(event, folder.id)}
            role="treeitem"
            aria-selected={selectedFolderId === folder.id}
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedFolderId(folder.id);
              }
            }}
          >
            <button
              type="button"
              className="qbank-custom-caret"
              onClick={event => {
                event.stopPropagation();
                setOpenFolders(previous => {
                  const next = new Set(previous);
                  if (next.has(folder.id)) next.delete(folder.id);
                  else next.add(folder.id);
                  return next;
                });
              }}
              title={open ? "Collapse" : "Expand"}
              aria-label={open ? "Collapse folder" : "Expand folder"}
            >
              {children.length ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span style={{ width: 13 }} />}
            </button>
            {open ? <FolderOpen size={14} className="qbank-custom-folder-icon" /> : <Folder size={14} className="qbank-custom-folder-icon" />}
            <span className="qbank-custom-tree-label">{folder.name}</span>
            {count > 0 && <span className="qbank-custom-tree-count">{count}</span>}
          </div>
          {open && children.length > 0 && renderFolders(folder.id, depth + 1)}
        </div>
      );
    });

  // ─── Dialog ───────────────────────────────────────────────────────────────

  const folderOptions = useMemo(() => {
    const options: Array<{ id: string; label: string }> = [{ id: ROOT_DROP, label: "Unfiled (top level)" }];
    const walk = (parentId: string | null, depth: number) => {
      for (const folder of foldersOf(parentId)) {
        options.push({ id: folder.id, label: `${"– ".repeat(depth)}${folder.name}` });
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    return options;
  }, [foldersOf]);

  const submitDialog = () => {
    if (!dialog) return;
    if (dialog.type === "newFolder") createFolder(dialog.parentId, dialog.value);
    else if (dialog.type === "renameFolder") renameFolder(dialog.folderId, dialog.value);
    else if (dialog.type === "renameSession") onRename(dialog.sessionId, dialog.value);
    else if (dialog.type === "moveSession") moveSession(dialog.sessionId, dialog.value === ROOT_DROP ? null : dialog.value);
    else if (dialog.type === "moveFolder") moveFolder(dialog.folderId, dialog.value === ROOT_DROP ? null : dialog.value);
    setDialog(null);
  };

  const blockedFolderIds = dialog?.type === "moveFolder"
    ? descendantFolderIds(org.folders, dialog.folderId)
    : new Set<string>();

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="qbank-custom-shell">
      <aside className="qbank-custom-side">
        <div className="qbank-custom-side-head">
          <div className="qbank-custom-side-title">
            <FolderOpen size={16} />
            <div>
              <strong>Session library</strong>
              <small>{visibleSessions.length} sessions · {org.folders.length} folders</small>
            </div>
          </div>
          <button
            type="button"
            className="qbank-custom-btn is-primary"
            onClick={() => setDialog({ type: "newFolder", parentId: null, value: "" })}
          >
            <FolderPlus size={13} /> New folder
          </button>
        </div>

        <div className="qbank-custom-tree" role="tree" aria-label="Session folders">
          <div
            className={`qbank-custom-tree-row is-root ${selectedFolderId === null ? "is-selected" : ""} ${dropTarget === ROOT_DROP ? "is-drop" : ""}`}
            onClick={() => setSelectedFolderId(null)}
            onDragOver={event => { event.preventDefault(); setDropTarget(ROOT_DROP); }}
            onDragLeave={() => setDropTarget(current => current === ROOT_DROP ? null : current)}
            onDrop={event => dropOnFolder(event, null)}
            role="treeitem"
            aria-selected={selectedFolderId === null}
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedFolderId(null);
              }
            }}
          >
            <GripVertical size={13} className="qbank-custom-grip" />
            <Folder size={14} className="qbank-custom-folder-icon" />
            <span className="qbank-custom-tree-label">Unfiled</span>
            <span className="qbank-custom-tree-count">{sessionsOf(null).length}</span>
          </div>
          {renderFolders(null, 0)}
          {!org.folders.length && (
            <p className="qbank-custom-tree-empty">No folders yet. Create one, then drag sessions inside.</p>
          )}
        </div>

        <p className="qbank-custom-hint">
          Drag a session onto any folder to file it. Drag folders into each other to nest them. Rename a session with the pencil.
        </p>
      </aside>

      <div className="qbank-custom-main">
        <div className="qbank-custom-main-head">
          <div className="qbank-custom-crumbs">
            <button type="button" className="qbank-custom-crumb" onClick={() => setSelectedFolderId(null)}>
              Unfiled
            </button>
            {roots.map(folder => (
              <span key={folder.id} className="qbank-custom-crumb-wrap">
                <ChevronRight size={12} />
                <button
                  type="button"
                  className={`qbank-custom-crumb ${folder.id === selectedFolderId ? "is-current" : ""}`}
                  onClick={() => setSelectedFolderId(folder.id)}
                >
                  {folder.name}
                </button>
              </span>
            ))}
          </div>
          <div className="qbank-custom-main-actions">
            {selectedFolder && (
              <>
                <button
                  type="button"
                  className="qbank-custom-btn"
                  onClick={() => setDialog({ type: "newFolder", parentId: selectedFolder.id, value: "" })}
                  title="Create a folder inside this one"
                >
                  <FolderPlus size={13} /> Subfolder
                </button>
                <button
                  type="button"
                  className="qbank-custom-btn"
                  onClick={() => setDialog({ type: "renameFolder", folderId: selectedFolder.id, value: selectedFolder.name })}
                >
                  <Pencil size={13} /> Rename
                </button>
                <button
                  type="button"
                  className="qbank-custom-btn"
                  onClick={() => setDialog({ type: "moveFolder", folderId: selectedFolder.id, value: selectedFolder.parentId || ROOT_DROP })}
                >
                  <Move size={13} /> Move
                </button>
                <button
                  type="button"
                  className="qbank-custom-btn is-danger"
                  onClick={() => deleteFolder(selectedFolder.id)}
                >
                  <Trash2 size={13} /> Delete
                </button>
              </>
            )}
          </div>
        </div>

        <div
          className={`qbank-custom-scroll ${dropTarget === "MAIN" ? "is-drop" : ""}`}
          onDragOver={event => { event.preventDefault(); setDropTarget("MAIN"); }}
          onDragLeave={() => setDropTarget(current => current === "MAIN" ? null : current)}
          onDrop={event => {
            event.preventDefault();
            if (drag?.kind === "session") moveSession(drag.id, selectedFolderId);
            endDrag();
          }}
        >
          {currentFolders.length > 0 && (
            <div className="qbank-custom-foldercards">
              {currentFolders.map(folder => (
                <button
                  key={folder.id}
                  type="button"
                  className={`qbank-custom-foldercard ${dropTarget === folder.id ? "is-drop" : ""}`}
                  onClick={() => {
                    setSelectedFolderId(folder.id);
                    setOpenFolders(previous => new Set(previous).add(folder.id));
                  }}
                  onDragOver={event => { event.preventDefault(); event.stopPropagation(); setDropTarget(folder.id); }}
                  onDragLeave={() => setDropTarget(current => current === folder.id ? null : current)}
                  onDrop={event => dropOnFolder(event, folder.id)}
                >
                  <Folder size={20} />
                  <span>
                    <strong>{folder.name}</strong>
                    <small>{countSessionsUnder(folder.id)} sessions</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
          )}

          {currentSessions.length === 0 && currentFolders.length === 0 && (
            <div className="qbank-custom-empty">
              <FolderOpen size={26} />
              <strong>{selectedFolder ? "This folder is empty" : "No sessions yet"}</strong>
              <span>
                {selectedFolder
                  ? "Drag a session here, or build a new block from the Build tab."
                  : "Every block you start appears here automatically."}
              </span>
            </div>
          )}

          <div className="qbank-custom-sessions">
            {currentSessions.map((session, index) => {
              const completed = Boolean(session.completedAt);
              const answered = answeredCount(session);
              return (
                <article
                  key={session.id}
                  className={`qbank-custom-session ${session.id === activeSessionId ? "is-active" : ""}`}
                  draggable
                  onDragStart={event => beginDrag(event, "session", session.id)}
                  onDragEnd={endDrag}
                >
                  <span className="qbank-custom-grip" title="Drag into a folder"><GripVertical size={14} /></span>
                  <div className="qbank-custom-session-body">
                    <div className="qbank-custom-session-title">
                      <strong>{sessionTitle(session)}</strong>
                      {completed && <span className="qbank-custom-done" title="Completed block"><CheckCircle2 size={12} /> Done</span>}
                      {session.id === activeSessionId && <span className="qbank-custom-live">Open</span>}
                    </div>
                    <p className="qbank-custom-session-meta">
                      {labelForDb(session.db)} · {session.questions.length} Qs · {answered} answered · {session.mode === "exam" ? "Timed" : "Tutor"}
                    </p>
                    <p className="qbank-custom-session-time">Updated {formatWhen(session.updatedAt || session.createdAt)}</p>
                  </div>
                  <div className="qbank-custom-session-actions">
                    <button
                      type="button"
                      onClick={() => reorderSession(session.id, -1)}
                      disabled={index === 0}
                      title="Move up"
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => reorderSession(session.id, 1)}
                      disabled={index === currentSessions.length - 1}
                      title="Move down"
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      className="is-open"
                      onClick={() => onOpen(session)}
                      title={completed ? "Review this block" : "Continue this block"}
                    >
                      <Play size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDialog({ type: "renameSession", sessionId: session.id, value: sessionTitle(session) })}
                      title="Rename session"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDialog({ type: "moveSession", sessionId: session.id, value: org.placements[session.id]?.folderId || ROOT_DROP })}
                      title="Move to folder"
                    >
                      <Move size={13} />
                    </button>
                    <button type="button" onClick={() => onRegenerate(session)} title="Regenerate same filters">
                      <RotateCcw size={13} />
                    </button>
                    <button type="button" className="is-danger" onClick={() => onDelete(session)} title="Delete session">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </div>

      {dialog && (
        <div className="qbank-custom-modal-backdrop" role="presentation" onMouseDown={() => setDialog(null)}>
          <form
            className="qbank-custom-modal"
            onMouseDown={event => event.stopPropagation()}
            onSubmit={event => { event.preventDefault(); submitDialog(); }}
          >
            <div className="qbank-custom-modal-head">
              <strong>
                {dialog.type === "newFolder" ? "New folder"
                  : dialog.type === "renameFolder" ? "Rename folder"
                  : dialog.type === "renameSession" ? "Rename session"
                  : dialog.type === "moveSession" ? "Move session"
                  : "Move folder"}
              </strong>
              <button type="button" className="qbank-custom-icon-btn" onClick={() => setDialog(null)} title="Close">
                <X size={14} />
              </button>
            </div>

            {(dialog.type === "newFolder" || dialog.type === "renameFolder" || dialog.type === "renameSession") ? (
              <label className="qbank-custom-field">
                <span>Name</span>
                <input
                  autoFocus
                  value={dialog.value}
                  onChange={event => setDialog(current => current ? { ...current, value: event.target.value } : current)}
                  maxLength={160}
                  placeholder={dialog.type === "renameSession" ? "e.g. Cardiology weak spots" : "e.g. Cardiology"}
                />
              </label>
            ) : (
              <label className="qbank-custom-field">
                <span>Destination</span>
                <select
                  value={dialog.value}
                  onChange={event => setDialog(current => current ? { ...current, value: event.target.value } : current)}
                >
                  {folderOptions.map(option => {
                    if (dialog.type === "moveFolder") {
                      if (option.id === dialog.folderId) return null;
                      if (option.id !== ROOT_DROP && blockedFolderIds.has(option.id)) return null;
                    }
                    return <option key={option.id} value={option.id}>{option.label}</option>;
                  })}
                </select>
              </label>
            )}

            <div className="qbank-custom-modal-actions">
              <button type="button" className="qbank-custom-btn" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="qbank-custom-btn is-primary">
                {dialog.type === "newFolder" ? "Create folder" : dialog.type === "renameSession" || dialog.type === "renameFolder" ? "Save name" : "Move"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
