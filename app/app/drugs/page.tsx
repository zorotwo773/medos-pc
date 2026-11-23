import { Suspense } from "react";
import DrugReference from "@/components/drugs/DrugReference";

export default function DrugsPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<div style={{ padding: 20, color: "var(--text-muted)", fontSize: 13 }}>Loading drug reference…</div>}>
        <DrugReference />
      </Suspense>
    </div>
  );
}
