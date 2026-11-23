"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "proximal", d: "M 80,15 C 95,15 108,25 112,40 C 116,55 108,65 100,70 L 105,115 L 65,115 L 70,70 C 62,65 54,55 58,40 C 62,25 65,15 80,15 Z", color: "#f59e0b" },
  { id: "shaft", d: "M 65,120 L 60,270 L 100,270 L 95,120 Z", color: "#3b82f6" },
  { id: "distal", d: "M 60,274 L 50,295 C 45,310 42,325 48,340 L 72,345 L 88,345 L 112,345 C 118,325 115,310 110,295 L 100,274 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "proximal", x: 128, y: 70, text: "Proximal" },
  { id: "shaft", x: 112, y: 195, text: "Shaft" },
  { id: "distal", x: 116, y: 315, text: "Distal" },
];

export default function FemurSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
