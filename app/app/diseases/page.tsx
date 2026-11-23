import { Suspense } from "react";
import DiseaseReference from "@/components/diseases/DiseaseReference";
import RouteFallback from "@/components/common/RouteFallback";

export default function DiseasesPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading diseases" />}>
        <DiseaseReference />
      </Suspense>
    </div>
  );
}
