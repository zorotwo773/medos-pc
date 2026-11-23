import UWorldLibraryReader from "@/components/uworldlibrary/UWorldLibraryReader";
import RouteFallback from "@/components/common/RouteFallback";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default function UWorldLibraryPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading UWorld library" />}>
        <UWorldLibraryReader />
      </Suspense>
    </div>
  );
}
