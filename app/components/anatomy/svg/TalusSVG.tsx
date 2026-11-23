"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "neck", d: "M 44,170 C 57,145 81,132 104,134 L 106,194 C 80,199 57,191 44,170 Z", color: "#f59e0b" },
  { id: "body", d: "M 104,132 C 141,121 177,139 188,170 C 176,203 137,218 106,195 Z", color: "#3b82f6" },
  { id: "process", d: "M 104,196 C 132,216 158,219 183,199 L 166,245 C 135,257 107,236 96,213 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "neck", x: 45, y: 137, text: "Neck" },
  { id: "body", x: 146, y: 128, text: "Body" },
  { id: "process", x: 124, y: 262, text: "Process" },
];

export default function TalusSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
