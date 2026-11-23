import { Suspense } from "react";
import QuizEngine from "@/components/qbank/QuizEngine";
import RouteFallback from "@/components/common/RouteFallback";

export default function QBankPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading Q-Bank" />}>
        <QuizEngine />
      </Suspense>
    </div>
  );
}
