import { Suspense } from "react";
import ContentManagerRoot from "@/components/content/ContentManagerRoot";
import RouteFallback from "@/components/common/RouteFallback";

export const metadata = { title: "Content Manager · MedOS" };

export default function ContentPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading Content Manager" />}>
        <ContentManagerRoot />
      </Suspense>
    </div>
  );
}
