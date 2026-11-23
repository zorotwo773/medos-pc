"use client";

import { ArrowLeft, Box, Maximize2, Minimize2, X } from "lucide-react";
import type { ReactNode } from "react";

export interface BoneSVGProps {
  onSelect: (id: string) => void;
  activeId?: string;
}

export function LevelDots({ level, color }: { level: 1 | 2 | 3; color: string }) {
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {[1, 2, 3].map(i => (
        <div
          key={i}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: i <= level ? color : "var(--border)",
            border: `1px solid ${i <= level ? color : "var(--border)"}`,
          }}
        />
      ))}
    </div>
  );
}

export function FigureZoom({
  src,
  caption,
  onClose,
}: {
  src: string;
  caption: string;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: "90vw", maxHeight: "90vh", textAlign: "center" }}>
        <img src={src} alt={caption} style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 8 }} />
        {caption && <p style={{ color: "#fff", fontSize: 12, marginTop: 8, opacity: 0.8 }}>{caption}</p>}
        <button
          onClick={onClose}
          style={{
            marginTop: 12,
            padding: "6px 18px",
            background: "rgba(255,255,255,0.15)",
            border: "1px solid rgba(255,255,255,0.3)",
            borderRadius: 4,
            color: "#fff",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function ReadingModeBanner({ onExitFullscreen }: { onExitFullscreen: () => void }) {
  return (
    <div
      style={{
        padding: "6px 12px",
        background: "var(--bg-card)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>Reading mode - 3D model hidden</span>
      <button
        onClick={onExitFullscreen}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "4px 9px",
          borderRadius: 5,
          border: "1px solid var(--border)",
          background: "var(--bg-base)",
          color: "var(--text-secondary)",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        <Box size={12} /> Show 3D model
      </button>
    </div>
  );
}

export function PanelHeader({
  onBack,
  onClose,
  fullscreen,
  onFullscreen,
  onExitFullscreen,
  children,
}: {
  onBack?: () => void;
  onClose: () => void;
  fullscreen?: boolean;
  onFullscreen?: () => void;
  onExitFullscreen?: () => void;
  children: ReactNode;
}) {
  const canToggleFullscreen = Boolean(onFullscreen && onExitFullscreen);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-card)",
        flexShrink: 0,
      }}
    >
      {onBack && (
        <button
          onClick={onBack}
          title="Back"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            display: "flex",
            padding: 0,
            flexShrink: 0,
          }}
        >
          <ArrowLeft size={14} />
        </button>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {canToggleFullscreen && (
        <button
          onClick={fullscreen ? onExitFullscreen : onFullscreen}
          title={fullscreen ? "Show 3D model" : "Maximize"}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            display: "flex",
            padding: 0,
            flexShrink: 0,
          }}
        >
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      )}
      <button
        onClick={onClose}
        title="Close"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          display: "flex",
          padding: 0,
          flexShrink: 0,
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
