"use client";

import dynamic from "next/dynamic";

const GraphClient = dynamic(() => import("./GraphClient"), {
  ssr: false,
  loading: () => (
    <div style={{ flex: 1, minHeight: "100%", display: "grid", placeItems: "center", background: "var(--bg-base)", color: "var(--text-muted)", fontSize: 13 }}>
      Loading graph...
    </div>
  ),
});

export default function GraphPage() {
  return <GraphClient />;
}
