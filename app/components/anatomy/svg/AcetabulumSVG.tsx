"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "wall", d: "M 52,110 C 75,66 131,62 160,101 C 137,103 116,115 99,137 C 82,130 67,121 52,110 Z", color: "#f59e0b" },
  { id: "column", d: "M 52,110 C 67,121 82,130 99,137 C 86,164 86,196 101,225 C 76,222 51,204 39,176 C 29,151 34,129 52,110 Z", color: "#3b82f6" },
  { id: "combined", d: "M 99,137 C 116,115 137,103 160,101 C 180,129 181,171 160,202 C 144,223 123,229 101,225 C 86,196 86,164 99,137 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "wall", x: 52, y: 72, text: "Wall" },
  { id: "column", x: 25, y: 213, text: "Column" },
  { id: "combined", x: 135, y: 229, text: "Combined" },
];

export default function AcetabulumSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
