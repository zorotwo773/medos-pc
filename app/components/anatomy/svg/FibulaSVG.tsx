"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "proximal", d: "M 88,28 C 109,25 126,41 123,63 C 120,82 105,96 86,95 C 67,94 54,78 57,59 C 60,42 70,31 88,28 Z", color: "#f59e0b" },
  { id: "shaft", d: "M 78,98 L 110,98 L 101,264 L 70,264 Z", color: "#3b82f6" },
  { id: "distal", d: "M 70,266 L 102,266 L 121,326 C 106,345 72,342 56,322 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "proximal", x: 124, y: 66, text: "Head" },
  { id: "shaft", x: 112, y: 195, text: "Shaft" },
  { id: "distal", x: 123, y: 314, text: "Malleolus" },
];

export default function FibulaSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
