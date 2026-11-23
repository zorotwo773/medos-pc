import BookLibrary from "@/components/library/BookLibrary";
import RouteFallback from "@/components/common/RouteFallback";
import { Suspense } from "react";

export default function LibraryPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading library" />}>
        <BookLibrary />
      </Suspense>
    </div>
  );
}
