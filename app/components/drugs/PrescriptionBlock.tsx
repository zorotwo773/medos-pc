"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { Prescription } from "@/types/drugs";

interface Props {
  prescription: Prescription | null;
}

export default function PrescriptionBlock({ prescription }: Props) {
  const [copied, setCopied] = useState(false);

  if (!prescription) {
    return (
      <div style={{
        border: "1px dashed var(--border)",
        borderRadius: 8,
        padding: 12,
        color: "var(--text-muted)",
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        Prescription requires a prescription-ready dosing rule, formulation, frequency, and duration.
      </div>
    );
  }

  const text = [
    prescription.drug_display,
    `Sig: ${prescription.sig}`,
    `Disp: ${prescription.dispense}`,
    prescription.days_supply ? `Days supply: ${prescription.days_supply}` : null,
    `Refills: ${prescription.refills}`,
  ].filter(Boolean).join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: 8,
      background: "rgba(0,0,0,0.03)",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 10px",
        borderBottom: "1px solid var(--border)",
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)" }}>
          Prescription
        </div>
        <button
          type="button"
          onClick={copy}
          title="Copy prescription"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-card)",
            color: "var(--text-secondary)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: 12,
        whiteSpace: "pre-wrap",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.65,
        color: "var(--text-primary)",
      }}>{text}</pre>
    </div>
  );
}
