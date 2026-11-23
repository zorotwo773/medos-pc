import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const allowedDevOrigins = [
  "127.0.0.1",
  ...(process.env.MEDOS_LAN_IP ? [process.env.MEDOS_LAN_IP] : []),
].filter((origin, index, origins) => origins.indexOf(origin) === index);

// `output: "standalone"` only kicks in for the Docker production build
// (set by infra/Dockerfile.frontend). Local `next dev` stays untouched.
const standalone = process.env.NEXT_STANDALONE === "true";

const nextConfig: NextConfig = {
  turbopack: {},
  serverExternalPackages: ["pdfjs-dist"],
  allowedDevOrigins,
  ...(standalone ? { output: "standalone" as const } : {}),
  // In local dev (no nginx), proxy /api/* → backend on port 8002.
  // In production the Docker nginx layer intercepts /api/* before it
  // ever reaches this Next.js server, so these rewrites are a no-op there.
  // Use 127.0.0.1 (not "localhost"): on Windows + Node 18+, "localhost"
  // resolves to IPv6 ::1 first, but the backend binds IPv4 (0.0.0.0:8002)
  // only — so a "localhost" target makes every proxied call (/api/me,
  // /api/activity/*) fail with ECONNRESET while the backend is otherwise fine.
  ...(!standalone && {
    async rewrites() {
      return [
        {
          source: "/api/:path*",
          destination: "http://127.0.0.1:8002/:path*",
        },
      ];
    },
  }),
};

export default withBundleAnalyzer(nextConfig);
