import { Suspense } from "react";
import PathwaysRoot from "@/components/pathways/PathwaysRoot";
import RouteFallback from "@/components/common/RouteFallback";

export const metadata = { title: "Clinical Pathways · MedOS" };

export default function PathwaysPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading Pathways" />}>
        <PathwaysRoot />
      </Suspense>
    </div>
  );
}
