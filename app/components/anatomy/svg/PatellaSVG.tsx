"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "pole", d: "M 88,265 C 65,245 54,218 55,188 L 146,188 C 147,218 136,245 112,265 C 104,273 96,273 88,265 Z", color: "#10b981" },
  { id: "body", d: "M 55,122 C 63,77 83,48 100,48 C 118,48 138,77 146,122 L 146,188 L 55,188 Z", color: "#3b82f6" },
  { id: "comminuted", d: "M 73,91 L 96,67 L 127,97 L 114,139 L 140,178 L 101,203 L 66,180 L 86,139 Z", color: "#f59e0b" },
];

const labels: ZoneLabel[] = [
  { id: "body", x: 150, y: 126, text: "Body" },
  { id: "pole", x: 126, y: 246, text: "Pole" },
  { id: "comminuted", x: 136, y: 164, text: "Comminuted" },
];

export default function PatellaSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
