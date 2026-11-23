import { Suspense } from "react";
import SanfordRoot from "@/components/sanford/SanfordRoot";
import RouteFallback from "@/components/common/RouteFallback";

export const metadata = { title: "Sanford Guide · MedOS" };

export default function SanfordPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading Sanford Guide" />}>
        <SanfordRoot />
      </Suspense>
    </div>
  );
}
