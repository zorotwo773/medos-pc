import { Suspense } from "react";
import CustomLibrary from "@/components/custom/CustomLibrary";
import RouteFallback from "@/components/common/RouteFallback";

export default function CustomLibraryPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading Custom Library" />}>
        <CustomLibrary />
      </Suspense>
    </div>
  );
}
