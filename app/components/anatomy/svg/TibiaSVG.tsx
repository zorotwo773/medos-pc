"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "proximal", d: "M 55,28 C 76,12 116,13 137,31 L 128,112 C 106,124 80,124 60,112 Z", color: "#f59e0b" },
  { id: "shaft", d: "M 62,116 C 80,126 107,126 125,116 L 112,270 C 97,277 78,276 66,268 Z", color: "#3b82f6" },
  { id: "distal", d: "M 66,272 C 80,280 97,281 112,274 L 126,326 C 107,343 73,342 54,326 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "proximal", x: 137, y: 76, text: "Plateau" },
  { id: "shaft", x: 122, y: 198, text: "Shaft" },
  { id: "distal", x: 125, y: 314, text: "Pilon" },
];

export default function TibiaSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
