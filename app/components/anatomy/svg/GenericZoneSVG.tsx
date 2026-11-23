"use client";

import type { BoneSVGProps } from "../BonePanelShared";

export interface Zone {
  id: string;
  d: string;
  color: string;
}

export interface ZoneLabel {
  id: string;
  x: number;
  y: number;
  text: string;
}

export default function GenericZoneSVG({
  zones,
  labels,
  onSelect,
  activeId,
}: BoneSVGProps & {
  zones: Zone[];
  labels?: ZoneLabel[];
}) {
  return (
    <svg viewBox="0 0 200 360" width={82} height={155} style={{ overflow: "visible", flexShrink: 0 }}>
      {zones.map(z => (
        <path
          key={z.id}
          d={z.d}
          fill={activeId === z.id ? z.color : `${z.color}30`}
          stroke={z.color}
          strokeWidth={activeId === z.id ? 2.5 : 1.5}
          style={{ cursor: "pointer", transition: "fill 0.15s" }}
          onClick={() => onSelect(z.id)}
          onMouseEnter={e => {
            (e.target as SVGPathElement).style.fill = `${z.color}70`;
          }}
          onMouseLeave={e => {
            (e.target as SVGPathElement).style.fill = activeId === z.id ? z.color : `${z.color}30`;
          }}
        />
      ))}
      {labels?.map(label => (
        <text
          key={label.id}
          x={label.x}
          y={label.y}
          fontSize={9}
          fill="var(--text-muted)"
          style={{ userSelect: "none", pointerEvents: "none" }}
        >
          {label.text}
        </text>
      ))}
    </svg>
  );
}
