"use client";
import { useEffect, useState } from "react";

export interface AuthUser {
  authenticated: boolean;
  name: string | null;
  email: string | null;
  is_admin: boolean;
  gate_enabled: boolean;
}

// Module-level promise — one network round-trip shared across every component
// that calls useAuth() in the same page load. Invalidated on sign-in/out by
// calling invalidateAuth() before navigating.
let _promise: Promise<AuthUser | null> | null = null;

function _fetchMe(): Promise<AuthUser | null> {
  if (!_promise) {
    _promise = fetch("/api/me", { credentials: "include" })
      .then(r => (r.ok ? r.json() as Promise<AuthUser> : null))
      .catch(() => null);
  }
  return _promise;
}

/** Call before router.replace("/login") or router.replace("/") so the next
 *  page load re-fetches fresh identity. */
export function invalidateAuth() {
  _promise = null;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    _fetchMe().then(data => {
      if (alive) { setUser(data); setLoading(false); }
    });
    return () => { alive = false; };
  }, []);

  return {
    user,
    loading,
    isAdmin:     !!(user?.is_admin),
    gateEnabled: !!(user?.gate_enabled),
  };
}
