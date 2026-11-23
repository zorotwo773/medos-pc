/**
 * Next.js 16 Proxy (formerly Middleware).
 *
 * Optimistic cookie check: redirect un-signed-in visitors to /login. The
 * backend still validates the cookie signature on every API call, so this
 * proxy is a UX shortcut, not a security boundary.
 *
 * Gate toggle — single knob, mirrors the backend (auth.py):
 *   MEDOS_SESSION_SECRET is set   →  gate ON:  /login is the entry point,
 *                                              all routes require a valid cookie.
 *   MEDOS_SESSION_SECRET is empty →  gate OFF: proxy is a no-op, vanilla app,
 *                                              no login page, no auth chip.
 *
 * Skipped paths (when gate is on):
 *   /login                  the form itself
 *   /api/auth/*             login + logout endpoints
 *   /api/me                 the topbar identity chip relies on this returning
 *                           {authenticated:false} so we don't redirect it
 *   /_next/*, /favicon.ico  Next.js internals + static
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Read env at REQUEST time via a computed key. Proxy runs in the Node.js runtime
// (Next 16 default), so process.env is the live runtime env — but a *static*
// `process.env.MEDOS_SESSION_SECRET` reference gets constant-folded at BUILD time
// by webpack. The shipped .next is built without the secret (it's generated per
// machine at launch), so a static read bakes GATE_ENABLED=false and the whole gate
// is tree-shaken away — that's the "login is skipped" bug. Computed-key access
// (process.env[k]) is NOT inlined, so it reflects the secret the launcher sets.
function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}
function cookieName(): string {
  return envValue("MEDOS_COOKIE_NAME") || "medos_session";
}
// Gate mirrors the backend exactly (auth.py: GATE_ENABLED = bool(SESSION_SECRET)):
// ON only when MEDOS_SESSION_SECRET is set at runtime. Blank it for the vanilla,
// no-login dev app.
function gateEnabled(): boolean {
  return !!envValue("MEDOS_SESSION_SECRET");
}

// Paths that must remain reachable when unauthenticated. Anything not on this
// list is gated.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/me",
  "/api/health",
  "/_next",
  "/favicon",
  // Self-hosted fonts (incl. the Material Symbols icon font). These live in a
  // subfolder so PUBLIC_FILE_RE (root-level files only) doesn't match them; the
  // login screen itself loads /fonts/fonts.css, so it must never be gated or the
  // page renders iconless with a serif fallback before sign-in.
  "/fonts",
];
const PUBLIC_FILE_RE = /^\/[^/]+\.(?:css|ico|js|json|mjs|png|svg|txt|wasm|webp)$/i;

function isPublic(pathname: string): boolean {
  return PUBLIC_FILE_RE.test(pathname) || PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function proxy(request: NextRequest) {
  if (!gateEnabled()) {
    // Vanilla mode: auth is fully off.
    // If someone somehow navigates to /login, redirect them home so the
    // login form never appears in the vanilla app.
    if (request.nextUrl.pathname.startsWith("/login")) {
      const home = request.nextUrl.clone();
      home.pathname = "/";
      home.search = "";
      return NextResponse.redirect(home);
    }
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const cookie = request.cookies.get(cookieName());
  if (cookie?.value) return NextResponse.next();

  // Bounce to /login, preserving the original destination so the page can
  // send the user back there after a successful sign-in.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(loginUrl);
}

// Run on every path except Next.js asset routes. Image optimisation and
// static files are noisy and don't need the redirect logic.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
