"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "scaphoid", d: "M 68,136 C 84,116 115,116 129,136 C 139,152 134,176 116,187 C 95,198 69,185 61,165 C 58,154 60,144 68,136 Z", color: "#f59e0b" },
  { id: "others", d: "M 42,191 C 57,172 85,170 104,189 C 124,169 155,172 170,194 C 186,218 177,252 151,267 C 129,280 108,270 96,251 C 82,269 58,273 40,255 C 21,236 24,210 42,191 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "scaphoid", x: 128, y: 130, text: "Scaphoid" },
  { id: "others", x: 124, y: 278, text: "Other carpals" },
];

export default function CarpalSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
