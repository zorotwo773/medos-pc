import AmbossReader from "@/components/amboss/AmbossReader";
import RouteFallback from "@/components/common/RouteFallback";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default function AmbossPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading AMBOSS" />}>
        <AmbossReader />
      </Suspense>
    </div>
  );
}
