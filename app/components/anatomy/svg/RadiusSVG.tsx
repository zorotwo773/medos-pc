"use client";

import type { BoneSVGProps } from "../BonePanelShared";
import GenericZoneSVG, { type Zone, type ZoneLabel } from "./GenericZoneSVG";

const zones: Zone[] = [
  { id: "proximal", d: "M 94,24 C 115,24 129,39 126,59 C 123,77 110,87 96,88 L 83,120 L 58,113 L 77,82 C 64,71 61,49 73,36 C 78,29 85,24 94,24 Z", color: "#f59e0b" },
  { id: "shaft", d: "M 80,122 L 107,129 L 124,267 L 88,272 Z", color: "#3b82f6" },
  { id: "distal", d: "M 86,274 L 126,269 L 144,329 C 123,344 86,344 65,327 Z", color: "#10b981" },
];

const labels: ZoneLabel[] = [
  { id: "proximal", x: 130, y: 72, text: "Proximal" },
  { id: "shaft", x: 122, y: 196, text: "Shaft" },
  { id: "distal", x: 127, y: 314, text: "Distal" },
];

export default function RadiusSVG(props: BoneSVGProps) {
  return <GenericZoneSVG {...props} zones={zones} labels={labels} />;
}
