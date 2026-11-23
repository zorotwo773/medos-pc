"use client";

/**
 * Topbar chip showing "Signed in as <name> · Sign out".
 *
 * Hits /api/me once on mount to fetch the identity from the signed cookie.
 * When the gate is disabled (dev mode), renders nothing.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Me = {
  authenticated: boolean;
  name: string | null;
  email: string | null;
  gate_enabled: boolean;
};

export default function SignedInChip() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json) setMe(json as Me);
      })
      .catch(() => {
        // Silent: an offline backend shouldn't break the topbar.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!me || !me.gate_enabled || !me.authenticated) return null;

  async function handleSignOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* best-effort */
    }
    startTransition(() => {
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <span
      title={me.email ?? undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-card)",
        fontSize: 10,
        letterSpacing: "0.04em",
        textTransform: "none",
        color: "var(--text-primary)",
      }}
    >
      <span style={{ color: "var(--text-muted)" }}>Signed in as</span>
      <b style={{ fontWeight: 500 }}>{me.name}</b>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={pending}
        style={{
          marginLeft: 4,
          padding: "1px 6px",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "transparent",
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          cursor: pending ? "default" : "pointer",
        }}
      >
        {pending ? "…" : "Sign out"}
      </button>
    </span>
  );
}
