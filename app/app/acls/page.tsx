import { Suspense } from "react";
import AclsHub from "@/components/acls/AclsHub";
import RouteFallback from "@/components/common/RouteFallback";

export default function AclsPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Suspense fallback={<RouteFallback label="Loading ACLS" />}>
        <AclsHub />
      </Suspense>
    </div>
  );
}
