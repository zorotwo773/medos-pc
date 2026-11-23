"use client";
/* Route root — Hub when no ?p=, else the Player for that pathway id. */

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PathwaysHub from "./PathwaysHub";
import PathwayPlayer from "./PathwayPlayer";
import { PW_CSS } from "./ui";

export default function PathwaysRoot() {
  const router = useRouter();
  const params = useSearchParams();
  const pRaw = params.get("p");
  const pid = pRaw && /^\d+$/.test(pRaw) ? Number(pRaw) : null;

  const open = useCallback((id: number) => router.push(`/pathways?p=${id}`), [router]);
  const back = useCallback(() => router.push("/pathways"), [router]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <style>{PW_CSS}</style>
      {pid == null
        ? <PathwaysHub onOpen={open} />
        : <PathwayPlayer key={pid} pathwayId={pid} onBack={back} />}
    </div>
  );
}
