"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "medial", d: "M 28,165 C 48,132 78,133 95,159 L 82,202 C 58,213 35,198 28,165 Z", color: "#f59e0b" },
  { id: "shaft", d: "M 90,158 C 118,139 150,140 171,165 L 154,204 C 127,189 103,190 82,202 Z", color: "#3b82f6" },
  { id: "lateral", d: "M 168,164 C 185,154 199,161 202,178 C 199,198 176,213 154,204 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "medial", x: 28, y: 130, text: "Medial" },
  { id: "shaft", x: 103, y: 132, text: "Mid-shaft" },
  { id: "lateral", x: 157, y: 226, text: "Lateral" },
];

export default function ClavicleSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
