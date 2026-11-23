"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "proximal", d: "M 80,20 C 60,20 40,35 40,60 L 50,130 L 110,130 L 120,60 C 120,35 100,20 80,20 Z", color: "#f59e0b" },
  { id: "shaft", d: "M 50,135 L 55,255 L 105,255 L 110,135 Z", color: "#3b82f6" },
  { id: "distal", d: "M 55,258 C 45,270 35,290 40,310 L 70,320 L 90,320 L 110,320 L 125,310 C 130,290 120,270 105,258 Z", color: "#10b981" },
];

export default function HumerusSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} />;
}
