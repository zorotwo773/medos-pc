"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "body", d: "M 42,88 L 118,118 L 139,310 L 58,258 Z", color: "#3b82f6" },
  { id: "neck", d: "M 118,117 C 136,96 153,86 168,86 L 173,127 C 156,130 143,140 130,158 Z", color: "#f59e0b" },
  { id: "glenoid", d: "M 168,78 C 188,82 196,98 191,119 C 187,138 173,147 158,138 C 167,118 169,98 168,78 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "body", x: 42, y: 292, text: "Body" },
  { id: "neck", x: 132, y: 82, text: "Neck" },
  { id: "glenoid", x: 146, y: 154, text: "Glenoid" },
];

export default function ScapulaSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
