import { Suspense } from "react";
import LexiView from "@/components/lexi/LexiView";
import RouteFallback from "@/components/common/RouteFallback";

export default function LexiPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading Lexicomp" />}>
        <LexiView />
      </Suspense>
    </div>
  );
}

