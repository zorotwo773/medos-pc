import { Suspense } from "react";
import AnatomyAtlas from "@/components/anatomy/AnatomyAtlas";
import RouteFallback from "@/components/common/RouteFallback";

export default function AnatomyPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Initialising 3D atlas" />}>
        <AnatomyAtlas />
      </Suspense>
    </div>
  );
}
