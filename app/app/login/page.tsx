"use client";

import { Suspense, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { invalidateAuth } from "@/lib/useAuth";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") || "/";

  const [username, setUsername]    = useState("");
  const [password, setPassword]    = useState("");
  const [error, setError]          = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const u = username.trim();
    const p = password;
    if (!u || !p) { setError("Both fields are required."); return; }

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: u, password: p }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        if (res.status === 401) {
          setError("Username or password is incorrect.");
        } else if (res.status === 503) {
          setError("MedOS can't reach its accounts database. If your MedOS data is on an external drive, reconnect that drive and try again — your account is still there.");
        } else {
          setError(body.detail || `Login failed (${res.status}).`);
        }
        return;
      }

      const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
      invalidateAuth(); // clear cached /me response so next page sees the new session
      startTransition(() => {
        router.replace(safeNext);
        router.refresh();
      });
    } catch {
      setError("Couldn't reach the server. Try again in a moment.");
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ width: "100%", maxWidth: 360, background: "var(--bg-card)", borderRadius: 16, border: "1px solid var(--border)", padding: "28px 24px", boxShadow: "var(--shadow-sm)", display: "flex", flexDirection: "column", gap: 18 }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-muted)" }}>MedOS</div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>Sign in</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Enter your username and password to continue.</p>
      </header>

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)" }}>Username</span>
        <input
          type="text"
          autoComplete="username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          maxLength={80}
          required
          placeholder="e.g. alice"
          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 14, outline: "none" }}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)" }}>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", fontSize: 14, outline: "none" }}
        />
      </label>

      {error && (
        <div role="alert" style={{ background: "var(--red-glow)", border: "1px solid var(--red-dim)", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "var(--red-dim)" }}>
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        style={{ padding: "10px 0", borderRadius: 8, background: "var(--text-primary)", color: "var(--bg-base)", fontSize: 14, fontWeight: 600, border: "none", cursor: pending ? "wait" : "pointer", opacity: pending ? 0.6 : 1 }}
      >
        {pending ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-base)", padding: "0 16px" }}>
      <Suspense fallback={<div style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: 13 }}>Loading…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
