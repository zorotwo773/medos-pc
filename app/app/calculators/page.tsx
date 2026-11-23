import { Suspense } from "react";
import CalculatorHub from "@/components/calculators/CalculatorHub";
import RouteFallback from "@/components/common/RouteFallback";

export default function CalculatorsPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading calculators" />}>
        <CalculatorHub />
      </Suspense>
    </div>
  );
}
