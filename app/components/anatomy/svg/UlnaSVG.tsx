"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "proximal", d: "M 84,18 C 110,28 121,55 109,85 L 95,122 L 61,114 L 72,83 C 52,63 58,31 84,18 Z", color: "#f59e0b" },
  { id: "shaft", d: "M 63,118 L 96,126 L 99,278 L 70,278 Z", color: "#3b82f6" },
  { id: "distal", d: "M 70,280 L 100,280 L 113,327 C 98,340 72,340 58,326 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "proximal", x: 113, y: 78, text: "Olecranon" },
  { id: "shaft", x: 105, y: 198, text: "Shaft" },
  { id: "distal", x: 110, y: 314, text: "Distal" },
];

export default function UlnaSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
