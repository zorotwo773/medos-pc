import { Suspense } from "react";
import UpToDateReader from "@/components/uptodate/UpToDateReader";
import RouteFallback from "@/components/common/RouteFallback";

export default function UpToDatePage() {
  return (
    <div style={{ flex: 1, display: "flex", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading UpToDate" />}>
        <UpToDateReader />
      </Suspense>
    </div>
  );
}
