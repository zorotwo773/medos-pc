"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, FC, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { getBackendUrl } from "@/lib/api";
import ScrapedContent from "./ScrapedContent";
import { LevelDots, PanelHeader, ReadingModeBanner, type BoneSVGProps } from "./BonePanelShared";

export interface Treatment {
  id: string;
  label: string;
  skill_level: 1 | 2 | 3;
  equipment_level: 1 | 2 | 3;
  main_indications: string;
  approach_slug: string | null;
  content_slug: string | null;
}

export interface Variant {
  id: string;
  label: string;
  description: string;
}

export interface Group {
  id: string;
  label: string;
  ao_code: string;
  description: string;
  complexity: 1 | 2 | 3;
  variants: Variant[];
  treatments: Treatment[];
}

export interface Segment {
  id: string;
  label: string;
  ao_code: string;
  color: string;
  slug?: string;
  description?: string;
  approaches_slug: string | null;
  preparation_slug: string | null;
  further_reading_slug: string | null;
  groups: Group[];
}

type View =
  | { type: "segments" }
  | { type: "fractures"; segment: Segment }
  | { type: "treatments"; segment: Segment; group: Group; variant: Variant }
  | { type: "detail"; segment: Segment; group: Group; variant: Variant; treatment: Treatment };

interface BonePanelProps {
  boneName: string;
  displayName: string;
  BoneSVG: FC<BoneSVGProps>;
  focusMeshHint: string;
  onFocusSegment: (hint: string) => void;
  onClose: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
  fullscreen: boolean;
}

const COMPLEXITY_LABEL = ["", "Simple", "Moderate", "Complex"];
const EMPTY_VARIANT: Variant = { id: "", label: "", description: "" };
const EMPTY_GROUP: Group = {
  id: "",
  label: "",
  ao_code: "",
  description: "",
  complexity: 1,
  variants: [],
  treatments: [],
};

function segmentSummary(seg: Segment) {
  if (seg.description) return seg.description;
  if (seg.groups.length === 1) return seg.groups[0].description;

  const groupLabels = seg.groups.map(g => g.label).filter(Boolean);
  const variants = seg.groups.reduce((a, g) => a + g.variants.length, 0);
  if (groupLabels.length) {
    return `${groupLabels.join(", ")} - ${seg.groups.length} fracture groups, ${variants} variants`;
  }
  return `${seg.groups.length} fracture groups - ${variants} variants`;
}

export default function BonePanel({
  boneName,
  displayName,
  BoneSVG,
  focusMeshHint,
  onFocusSegment,
  onClose,
  onFullscreen,
  onExitFullscreen,
  fullscreen,
}: BonePanelProps) {
  const [data, setData] = useState<{ segments: Segment[] } | null>(null);
  const [view, setView] = useState<View>({ type: "segments" });

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setView({ type: "segments" });

    fetch(`${getBackendUrl()}/ao/bone/${encodeURIComponent(boneName)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { segments: Segment[] } | null) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });

    return () => {
      cancelled = true;
    };
  }, [boneName]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExitFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, onExitFullscreen]);

  const goSegment = useCallback(
    (seg: Segment) => {
      setView({ type: "fractures", segment: seg });
      onFocusSegment(focusMeshHint);
    },
    [focusMeshHint, onFocusSegment]
  );

  const rootStyle: CSSProperties = {
    width: "100%",
    borderLeft: "1px solid var(--border)",
    background: "var(--bg-sidebar)",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  };

  const renderShell = (header: ReactNode, body: ReactNode, onBack?: () => void) => (
    <div style={rootStyle}>
      <PanelHeader
        onBack={onBack}
        onClose={onClose}
        fullscreen={fullscreen}
        onFullscreen={onFullscreen}
        onExitFullscreen={onExitFullscreen}
      >
        {header}
      </PanelHeader>
      {fullscreen && <ReadingModeBanner onExitFullscreen={onExitFullscreen} />}
      {body}
    </div>
  );

  if (!data) {
    return renderShell(
      <span style={{ fontSize: 13, fontWeight: 700 }}>{displayName}</span>,
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        Loading...
      </div>
    );
  }

  if (view.type === "segments") {
    return renderShell(
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
        {displayName} - AO/OTA Classification
      </span>,
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div
          style={{
            padding: "16px 16px 10px",
            display: "flex",
            gap: 14,
            alignItems: "flex-start",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <BoneSVG
            onSelect={id => {
              const seg = data.segments.find(s => s.id === id);
              if (seg) goSegment(seg);
            }}
          />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
              Select a segment
            </p>
            <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.55 }}>
              Choose a region to browse fracture types, AO/OTA codes, and treatment options.
            </p>
            <div style={{ display: "flex", gap: 4, marginTop: 10, flexWrap: "wrap" }}>
              {data.segments.map(seg => (
                <button
                  key={seg.id}
                  onClick={() => goSegment(seg)}
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "3px 8px",
                    borderRadius: 4,
                    background: `${seg.color}18`,
                    border: `1px solid ${seg.color}50`,
                    color: seg.color,
                    cursor: "pointer",
                  }}
                >
                  {seg.ao_code} - {seg.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {data.segments.map(seg => (
          <div
            key={seg.id}
            onClick={() => goSegment(seg)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "14px 16px",
              borderBottom: "1px solid var(--border)",
              cursor: "pointer",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = "var(--bg-card-hover)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <div style={{ width: 5, alignSelf: "stretch", borderRadius: 3, background: seg.color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontWeight: 800,
                    background: seg.color,
                    color: "#fff",
                    padding: "1px 7px",
                    borderRadius: 4,
                  }}
                >
                  {seg.ao_code}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{seg.label}</span>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.45 }}>
                {segmentSummary(seg)}
              </p>
            </div>
            <ChevronRight size={15} color="var(--text-muted)" />
          </div>
        ))}
      </div>
    );
  }

  if (view.type === "fractures") {
    const { segment: seg } = view;
    const firstGroup = seg.groups[0] ?? EMPTY_GROUP;
    const firstVariant = firstGroup.variants[0] ?? EMPTY_VARIANT;

    return renderShell(
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 800,
            background: seg.color,
            color: "#fff",
            padding: "1px 7px",
            borderRadius: 4,
          }}
        >
          {seg.ao_code}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>{seg.label}</span>
      </div>,
      <>
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-card)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <BoneSVG
            activeId={seg.id}
            onSelect={id => {
              const s = data.segments.find(x => x.id === id);
              if (s) setView({ type: "fractures", segment: s });
            }}
          />
          <div>
            <p
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
              }}
            >
              Choose fracture type
            </p>
            <p style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              Select a fracture pattern to view treatment options and surgical approaches.
            </p>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
          {seg.groups.map(group => (
            <div key={group.id} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      fontWeight: 700,
                      color: seg.color,
                      border: `1px solid ${seg.color}`,
                      padding: "1px 5px",
                      borderRadius: 3,
                    }}
                  >
                    {group.ao_code}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    {group.label}
                  </span>
                  <LevelDots level={group.complexity} color={seg.color} />
                  <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{COMPLEXITY_LABEL[group.complexity]}</span>
                </div>
                <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
              </div>

              {group.variants.map(v => (
                <div
                  key={v.id}
                  onClick={() => setView({ type: "treatments", segment: seg, group, variant: v })}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "11px 12px",
                    marginBottom: 6,
                    borderRadius: 8,
                    cursor: "pointer",
                    border: "1px solid var(--border)",
                    background: "var(--bg-card)",
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLElement).style.borderColor = seg.color;
                    (e.currentTarget as HTMLElement).style.background = `${seg.color}08`;
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
                    (e.currentTarget as HTMLElement).style.background = "var(--bg-card)";
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      fontWeight: 800,
                      color: "#fff",
                      background: seg.color,
                      padding: "2px 6px",
                      borderRadius: 4,
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    {v.id}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 3 }}>
                      {v.label}
                    </p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45, margin: 0 }}>
                      {v.description}
                    </p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                    <span style={{ fontSize: 9, color: seg.color, fontWeight: 700 }}>
                      {group.treatments?.length ?? 0} tx options
                    </span>
                    <ChevronRight size={13} color={seg.color} />
                  </div>
                </div>
              ))}
            </div>
          ))}

          {(seg.approaches_slug || seg.preparation_slug || seg.further_reading_slug) && (
            <div
              style={{
                marginTop: 6,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-card)",
              }}
            >
              <p
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  marginBottom: 8,
                }}
              >
                References for this segment
              </p>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {seg.approaches_slug && (
                  <button
                    onClick={() =>
                      setView({
                        type: "detail",
                        segment: seg,
                        group: firstGroup,
                        variant: firstVariant,
                        treatment: {
                          id: "approach",
                          label: "Surgical Approaches",
                          skill_level: 1,
                          equipment_level: 1,
                          main_indications: "",
                          approach_slug: seg.approaches_slug,
                          content_slug: seg.approaches_slug,
                        },
                      })
                    }
                    style={referenceButtonStyle}
                  >
                    Approaches
                  </button>
                )}
                {seg.preparation_slug && (
                  <button
                    onClick={() =>
                      setView({
                        type: "detail",
                        segment: seg,
                        group: firstGroup,
                        variant: firstVariant,
                        treatment: {
                          id: "prep",
                          label: "Patient Preparation",
                          skill_level: 1,
                          equipment_level: 1,
                          main_indications: "",
                          approach_slug: seg.preparation_slug,
                          content_slug: seg.preparation_slug,
                        },
                      })
                    }
                    style={referenceButtonStyle}
                  >
                    Preparation
                  </button>
                )}
                {seg.further_reading_slug && (
                  <button
                    onClick={() =>
                      setView({
                        type: "detail",
                        segment: seg,
                        group: firstGroup,
                        variant: firstVariant,
                        treatment: {
                          id: "fr",
                          label: "Further Reading",
                          skill_level: 1,
                          equipment_level: 1,
                          main_indications: "",
                          approach_slug: seg.further_reading_slug,
                          content_slug: seg.further_reading_slug,
                        },
                      })
                    }
                    style={referenceButtonStyle}
                  >
                    Further Reading
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </>,
      () => setView({ type: "segments" })
    );
  }

  if (view.type === "treatments") {
    const { segment: seg, group, variant } = view;

    return renderShell(
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              fontWeight: 800,
              background: seg.color,
              color: "#fff",
              padding: "1px 6px",
              borderRadius: 3,
            }}
          >
            {variant.id}
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>{variant.label}</span>
        </div>
        <p style={{ fontSize: 10, color: "var(--text-muted)", margin: 0, lineHeight: 1.4 }}>
          {seg.label} - {group.label}
        </p>
      </div>,
      <>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", background: `${seg.color}08`, flexShrink: 0 }}>
          <p style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>{variant.description}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <LevelDots level={group.complexity} color={seg.color} />
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{group.label}</span>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px" }}>
          <p
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: 10,
            }}
          >
            Choose treatment
          </p>

          {(group.treatments ?? []).map(tx => (
            <div
              key={tx.id}
              onClick={() => setView({ type: "detail", segment: seg, group, variant, treatment: tx })}
              style={{
                marginBottom: 10,
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--bg-card)",
                cursor: "pointer",
                overflow: "hidden",
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.borderColor = seg.color;
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
              }}
            >
              <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{tx.label}</span>
                  <ChevronRight size={14} color={seg.color} />
                </div>
                <div style={{ display: "flex", gap: 16 }}>
                  <div>
                    <p style={metricLabelStyle}>Skill level</p>
                    <LevelDots level={tx.skill_level} color={seg.color} />
                  </div>
                  <div>
                    <p style={metricLabelStyle}>Equipment</p>
                    <LevelDots level={tx.equipment_level} color={seg.color} />
                  </div>
                </div>
              </div>
              <div style={{ padding: "9px 14px" }}>
                <p style={metricLabelStyle}>Main indications</p>
                <p style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5, margin: 0 }}>
                  {tx.main_indications}
                </p>
              </div>
            </div>
          ))}
        </div>
      </>,
      () => setView({ type: "fractures", segment: seg })
    );
  }

  if (view.type === "detail") {
    const { segment: seg, group, variant, treatment: tx } = view;
    const backView: View = tx.id === "approach" || tx.id === "prep" || tx.id === "fr"
      ? { type: "fractures", segment: seg }
      : { type: "treatments", segment: seg, group, variant };

    return renderShell(
      <div>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>{tx.label}</span>
        <p style={{ fontSize: 10, color: "var(--text-muted)", margin: 0, marginTop: 1 }}>
          {variant.id && `${variant.id} - `}
          {seg.label}
        </p>
      </div>,
      <>
        {tx.main_indications && (
          <div
            style={{
              padding: "8px 16px",
              borderBottom: "1px solid var(--border)",
              background: `${seg.color}08`,
              display: "flex",
              gap: 20,
              flexShrink: 0,
            }}
          >
            <div>
              <p style={metricLabelStyle}>Skill level</p>
              <LevelDots level={tx.skill_level} color={seg.color} />
            </div>
            <div>
              <p style={metricLabelStyle}>Equipment</p>
              <LevelDots level={tx.equipment_level} color={seg.color} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={metricLabelStyle}>Indications</p>
              <p style={{ fontSize: 10, color: "var(--text-secondary)", margin: 0, lineHeight: 1.4 }}>{tx.main_indications}</p>
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: fullscreen ? "18px 24px" : "14px 16px" }}>
          {tx.content_slug ? (
            <div style={fullscreen ? { maxWidth: 980, margin: "0 auto" } : undefined}>
              <ScrapedContent slug={tx.content_slug} color={seg.color} />
            </div>
          ) : (
            <div style={{ padding: 20, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
              Detailed content not yet available for this treatment.
            </div>
          )}
        </div>
      </>,
      () => setView(backView)
    );
  }

  return null;
}

const referenceButtonStyle: CSSProperties = {
  fontSize: 10,
  padding: "3px 9px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--bg-base)",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontWeight: 600,
};

const metricLabelStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 4,
};
