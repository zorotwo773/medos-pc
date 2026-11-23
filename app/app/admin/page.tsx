"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { exportProgression, importProgression, type ImportSummary } from "@/lib/activity";

interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: number;
  created_at: string;
  last_login: string | null;
}

const MONO = "var(--font-mono, 'JetBrains Mono', monospace)";

function fmt(ts: string | null) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

export default function AdminPage() {
  const router = useRouter();
  const { user, loading: authLoading, isAdmin } = useAuth();

  // ── Auth guard ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authLoading && !isAdmin) {
      router.replace("/");
    }
  }, [authLoading, isAdmin, router]);

  // ── User list state ───────────────────────────────────────────────────────
  const [users, setUsers]           = useState<User[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError]   = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // create-user form
  const [newUsername, setNewUsername] = useState("");
  const [newDisplay, setNewDisplay]   = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin]   = useState(false);
  const [createErr, setCreateErr]     = useState<string | null>(null);
  const [creating, setCreating]       = useState(false);

  // progression sync (export / import across app versions)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [syncBusy, setSyncBusy]   = useState<"export" | "import" | null>(null);
  const [syncMsg, setSyncMsg]     = useState<string | null>(null);
  const [syncErr, setSyncErr]     = useState<string | null>(null);
  const [syncReplace, setSyncReplace] = useState(false);

  // inline edit
  const [editId, setEditId]       = useState<number | null>(null);
  const [editField, setEditField] = useState<"password" | "display_name" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editErr, setEditErr]     = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);

  const loadUsers = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (!res.ok) { setListError(`Error ${res.status}`); return; }
      setUsers(await res.json());
      setListError(null);
    } catch {
      setListError("Could not reach backend.");
    } finally {
      setListLoading(false);
    }
  }, []);

  // Only load user list once we've confirmed the visitor is an admin.
  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin, loadUsers]);

  // ── Render guard: show nothing while auth resolves or redirecting ─────────
  if (authLoading || !isAdmin) {
    return (
      <div style={{ padding: 40, fontFamily: MONO, fontSize: 12, color: "var(--text-muted)" }}>
        {authLoading ? "Checking permissions…" : "Access denied."}
      </div>
    );
  }

  // ── Handlers ──────────────────────────────────────────────────────────────
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateErr(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: newUsername.trim(), display_name: newDisplay.trim(), password: newPassword, is_admin: newIsAdmin }),
      });
      const body = await res.json().catch(() => ({})) as { detail?: string };
      if (!res.ok) { setCreateErr(body.detail || `Error ${res.status}`); return; }
      setNewUsername(""); setNewDisplay(""); setNewPassword(""); setNewIsAdmin(false);
      setShowCreate(false);
      loadUsers();
    } catch {
      setCreateErr("Request failed.");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: number, name: string) {
    const myUsername = (user?.email || "").split("@")[0];
    if (name === myUsername) return; // prevent self-deletion
    if (!confirm(`Delete user "${name}"? Their QBank progress stays in the database.`)) return;
    await fetch(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" });
    loadUsers();
  }

  async function handleSaveEdit() {
    if (editId === null || !editField) return;
    setSaving(true); setEditErr(null);
    try {
      const body: Record<string, string | boolean> = {};
      body[editField] = editValue;
      const res = await fetch(`/api/admin/users/${editId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { detail?: string };
        setEditErr(b.detail || `Error ${res.status}`);
        return;
      }
      setEditId(null); setEditField(null); setEditValue(""); loadUsers();
    } catch {
      setEditErr("Request failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleAdmin(u: User) {
    await fetch(`/api/admin/users/${u.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ is_admin: !u.is_admin }),
    });
    loadUsers();
  }

  // ── Progression sync ──────────────────────────────────────────────────────
  async function handleExportProgression() {
    setSyncBusy("export"); setSyncErr(null); setSyncMsg(null);
    try {
      const data = await exportProgression();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `medos-progression-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSyncMsg("Exported your progression file. Keep it to restore after a version update.");
    } catch (e) {
      setSyncErr((e as Error).message || "Export failed.");
    } finally {
      setSyncBusy(null);
    }
  }

  async function handleImportFile(file: File) {
    setSyncBusy("import"); setSyncErr(null); setSyncMsg(null);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const summary: ImportSummary = await importProgression(payload, syncReplace ? "replace" : "merge");
      setSyncMsg(
        `Imported ${summary.usedAdded} used + ${summary.markedAdded} marked QIDs across ${summary.banksTouched} bank(s)` +
        (summary.searchesImported ? `, ${summary.searchesImported} searches` : "") +
        ". Restart the backend if bank counts look stale.",
      );
    } catch (e) {
      setSyncErr((e as Error).message || "Import failed — is this a MedOS progression file?");
    } finally {
      setSyncBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "28px 32px", maxWidth: 880, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>User Management</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            Create and manage accounts. QBank progress is tracked per username.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(v => !v)}
          style={{ padding: "8px 16px", borderRadius: 8, background: "var(--text-primary)", color: "var(--bg-base)", border: "none", fontFamily: MONO, fontSize: 11, letterSpacing: "0.08em", cursor: "pointer" }}
        >
          {showCreate ? "Cancel" : "+ New User"}
        </button>
      </div>

      {/* Progression Sync — carry QBank progress across versions / DB refreshes */}
      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 22px", marginBottom: 24 }}>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>Progression Sync</div>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, maxWidth: 640 }}>
          Export your study progression (used &amp; marked QIDs per bank — UWorld, NBME, CMS — plus search history)
          to a portable file. After moving to a newer MedOS build, or once the UWorld database is refreshed to the
          current form, <strong>import</strong> that file to carry your progress forward so blocks keep generating from
          unused questions — you never start over. Import merges by QID (idempotent).
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            onClick={handleExportProgression}
            disabled={syncBusy !== null}
            style={{ padding: "8px 18px", borderRadius: 8, background: "var(--text-primary)", color: "var(--bg-base)", border: "none", fontFamily: MONO, fontSize: 11, letterSpacing: "0.06em", cursor: syncBusy ? "wait" : "pointer" }}
          >
            {syncBusy === "export" ? "Exporting…" : "↓ Export progression"}
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={syncBusy !== null}
            style={{ padding: "8px 18px", borderRadius: 8, background: "#f97316", color: "#fff", border: "none", fontFamily: MONO, fontSize: 11, letterSpacing: "0.06em", cursor: syncBusy ? "wait" : "pointer" }}
          >
            {syncBusy === "import" ? "Importing…" : "↑ Import progression"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={syncReplace} onChange={e => setSyncReplace(e.target.checked)} />
            Replace instead of merge
          </label>
        </div>
        {syncMsg && <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--accent, #0f766e)" }}>{syncMsg}</div>}
        {syncErr && <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--red-dim, #ef4444)" }}>{syncErr}</div>}
      </div>

      {/* Create form */}
      {showCreate && (
        <form onSubmit={handleCreate} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", marginBottom: 24, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-muted)" }}>New Account</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>Username</span>
              <input value={newUsername} onChange={e => setNewUsername(e.target.value)} required maxLength={40} placeholder="alice" style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", fontSize: 13 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>Display Name</span>
              <input value={newDisplay} onChange={e => setNewDisplay(e.target.value)} required maxLength={80} placeholder="Alice Chen" style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", fontSize: 13 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>Password</span>
              <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={4} style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", fontSize: 13 }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 20 }}>
              <input type="checkbox" checked={newIsAdmin} onChange={e => setNewIsAdmin(e.target.checked)} />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Admin (can manage users)</span>
            </label>
          </div>
          {createErr && <div style={{ fontSize: 12, color: "var(--red-dim)" }}>{createErr}</div>}
          <button type="submit" disabled={creating} style={{ alignSelf: "flex-start", padding: "8px 20px", borderRadius: 8, background: "#f97316", color: "#fff", border: "none", fontWeight: 600, fontSize: 13, cursor: creating ? "wait" : "pointer" }}>
            {creating ? "Creating…" : "Create User"}
          </button>
        </form>
      )}

      {listError && <div style={{ color: "var(--red-dim)", marginBottom: 16, fontSize: 13 }}>{listError}</div>}
      {listLoading && <div style={{ color: "var(--text-muted)", fontFamily: MONO, fontSize: 12 }}>Loading…</div>}

      {!listLoading && users.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontFamily: MONO, fontSize: 12, padding: "32px 0", textAlign: "center" }}>No users yet. Create one above.</div>
      )}

      {!listLoading && users.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {users.map(u => (
            <div key={u.id} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: u.is_admin ? "#f97316" : "var(--text-primary)", color: u.is_admin ? "#fff" : "var(--bg-base)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                {u.display_name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>{u.display_name}</span>
                  {u.is_admin ? <span style={{ fontFamily: MONO, fontSize: 9, padding: "1px 6px", background: "rgba(249,115,22,0.12)", border: "1px solid rgba(249,115,22,0.32)", borderRadius: 4, color: "var(--amber-dim)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Admin</span> : null}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  @{u.username} · Last login: {fmt(u.last_login)}
                </div>
              </div>

              {editId === u.id && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type={editField === "password" ? "password" : "text"}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    placeholder={editField === "password" ? "New password" : "New display name"}
                    style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 13, width: 160 }}
                    autoFocus
                  />
                  {editErr && <span style={{ fontSize: 11, color: "var(--red-dim)" }}>{editErr}</span>}
                  <button onClick={handleSaveEdit} disabled={saving || !editValue} style={{ padding: "5px 12px", borderRadius: 6, background: "var(--text-primary)", color: "var(--bg-base)", border: "none", fontSize: 12, cursor: "pointer" }}>
                    {saving ? "…" : "Save"}
                  </button>
                  <button onClick={() => { setEditId(null); setEditField(null); setEditValue(""); setEditErr(null); }} style={{ padding: "5px 10px", borderRadius: 6, background: "none", border: "1px solid var(--border)", fontSize: 12, cursor: "pointer", color: "var(--text-muted)" }}>
                    Cancel
                  </button>
                </div>
              )}

              {editId !== u.id && (
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button onClick={() => { setEditId(u.id); setEditField("display_name"); setEditValue(u.display_name); setEditErr(null); }} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "none", fontSize: 11, cursor: "pointer", color: "var(--text-secondary)", fontFamily: MONO }}>
                    Rename
                  </button>
                  <button onClick={() => { setEditId(u.id); setEditField("password"); setEditValue(""); setEditErr(null); }} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "none", fontSize: 11, cursor: "pointer", color: "var(--text-secondary)", fontFamily: MONO }}>
                    Password
                  </button>
                  <button onClick={() => handleToggleAdmin(u)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "none", fontSize: 11, cursor: "pointer", color: u.is_admin ? "#c2410c" : "var(--text-secondary)", fontFamily: MONO }}>
                    {u.is_admin ? "Demote" : "Make Admin"}
                  </button>
                  <button onClick={() => handleDelete(u.id, u.username)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(239,68,68,0.35)", background: "none", fontSize: 11, cursor: "pointer", color: "var(--red-dim)", fontFamily: MONO }}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
