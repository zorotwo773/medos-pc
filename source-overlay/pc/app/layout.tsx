import type { Metadata } from "next";
import Script from "next/script";
import { Suspense } from "react";
import "./globals.css";
import Sidebar from "@/components/layout/Sidebar";
import TopBar from "@/components/layout/TopBar";
import StatusBar from "@/components/layout/StatusBar";
import TabBarClient from "@/components/layout/TabBarClient";
import GlobalCommandCenter from "@/components/layout/GlobalCommandCenter";
import SettingsPanel from "@/components/layout/SettingsPanel";
import StudyTimerDock from "@/components/layout/StudyTimerDock";
import GlobalCardCreator from "@/components/layout/GlobalCardCreator";
import FirstAidSnippet from "@/components/firstaid/FirstAidSnippet";
import ReadingChromeController from "@/components/layout/ReadingChromeController";
import { canonicalLoopbackScript } from "@/lib/canonicalLoopback.mjs";
import TouchInteractionProvider from "@/components/touch/TouchInteractionProvider";

export const metadata: Metadata = {
  title: "MedOS — Clinical Intelligence Platform",
  description: "AMBOSS-style medical reference: AI chat, 3D anatomy, disease library, clinical calculators",
};

const themeInitScript = `
(() => {
  try {
    const stored = window.localStorage.getItem("medos.theme");
    const theme = stored === "dark" || stored === "yellow" ? stored : "light";
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    document.documentElement.setAttribute("data-theme", "light");
  }
  try {
    // Pre-size the sidebar rail so a pinned-expanded sidebar doesn't shift
    // page content on first paint. Defaults to expanded; only reflows on a
    // real desktop (the sidebar overlays on hover everywhere else).
    var path = window.location.pathname;
    if (path === "/login" || path.indexOf("/login/") === 0) {
      // No sidebar on the lock screen — collapse the rail column entirely.
      document.documentElement.style.setProperty("--rail-w", "0px");
    } else {
      var sb = window.localStorage.getItem("medos.sidebar.expanded");
      var canPin = window.matchMedia("(min-width: 900px) and (pointer: fine)").matches;
      if (sb !== "0" && canPin) document.documentElement.style.setProperty("--rail-w", "210px");
    }
  } catch {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-medos-app="true" suppressHydrationWarning>
      <head>
        <Script
          id="medos-loopback-guard"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: canonicalLoopbackScript }}
        />
        <Script
          id="medos-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        {/* Self-hosted fonts (incl. Material Symbols icon font). Served from
            /public/fonts so the app renders correctly with no internet — the
            previous Google Fonts CDN links left icons as raw ligature text and
            the body in a serif fallback whenever a user was offline or behind a
            locked-down network. */}
        <link rel="stylesheet" href="/fonts/fonts.css" />
      </head>
      <body suppressHydrationWarning>
        <TouchInteractionProvider>
          <div className="shell-frame">
            <Suspense fallback={null}>
              <Sidebar />
            </Suspense>
            <TopBar />
            <main className="app-main" style={{
              gridRow: 2,
              gridColumn: 2,
              position: "relative",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}>
              <TabBarClient />
              {children}
            </main>
            <StatusBar />
            <ReadingChromeController />
            <GlobalCommandCenter />
            <SettingsPanel />
          </div>
          <StudyTimerDock />
          <GlobalCardCreator />
          <FirstAidSnippet />
        </TouchInteractionProvider>
        <Script
          id="medos-media-interop"
          src="/medos-media-interop.mjs"
          type="module"
          strategy="afterInteractive"
        />
        <Script src="/calc-runtime.js?v=20260512-mdcalc-live-v5" strategy="afterInteractive" />
      </body>
    </html>
  );
}
