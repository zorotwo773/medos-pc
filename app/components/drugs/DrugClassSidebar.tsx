"use client";
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { DrugClassArea } from "@/types/drugs";

interface Props {
  areas: DrugClassArea[];
  selectedNodeId: number | null;
  loading: boolean;
  onSelectNode: (nodeId: number, label: string) => void;
}

/**
 * Hierarchical medication browser: therapeutic areas (Cardiovascular, Infectious
 * Disease, …) that expand to their subclasses (Beta Blockers, Statins, …).
 * Mirrors how a professional drug reference arranges its formulary, replacing
 * the old flat list of ~1,100 granular class strings.
 */
export default function DrugClassSidebar({ areas, selectedNodeId, loading, onSelectNode }: Props) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const q = filter.trim().toLowerCase();

  // When filtering, keep only areas/subclasses that match, and auto-expand them.
  const visible = useMemo(() => {
    if (!q) return areas;
    return areas
      .map(area => {
        const areaHit = area.name.toLowerCase().includes(q);
        const subs = areaHit
          ? area.subclasses
          : area.subclasses.filter(s => s.name.toLowerCase().includes(q));
        if (!areaHit && subs.length === 0) return null;
        return { ...area, subclasses: subs };
      })
      .filter(Boolean) as DrugClassArea[];
  }, [areas, q]);

  const isOpen = (areaId: number) => (q ? true : expanded.has(areaId));

  const toggle = (areaId: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(areaId) ? next.delete(areaId) : next.add(areaId);
      return next;
    });
  };

  return (
    <aside style={{
      width: 268,
      minWidth: 268,
      borderRight: "1px solid var(--border)",
      background: "var(--bg-sidebar, var(--bg-card))",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
      <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--border)" }}>
        <div style={{
          fontSize: 11,
          fontWeight: 800,
          color: "var(--text-secondary)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 8,
        }}>
          Therapeutic Classes
        </div>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter classes..."
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 9px",
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-card)",
            color: "var(--text-primary)",
            fontSize: 12,
            outline: "none",
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "6px 6px 10px" }}>
        {loading && (
          <div style={{ padding: 10, fontSize: 12, color: "var(--text-muted)" }}>
            Loading classes...
          </div>
        )}
        {!loading && visible.length === 0 && (
          <div style={{ padding: 10, fontSize: 12, color: "var(--text-muted)" }}>
            No classes match “{filter}”.
          </div>
        )}
        {!loading && visible.map(area => {
          const open = isOpen(area.id);
          const areaActive = selectedNodeId === area.id;
          return (
            <div key={area.id} style={{ marginBottom: 1 }}>
              {/* Area row: chevron toggles, label selects whole area */}
              <div style={{
                display: "flex",
                alignItems: "stretch",
                borderRadius: 6,
                background: areaActive ? "rgba(14,165,233,0.1)" : "transparent",
              }}>
                <button
                  type="button"
                  onClick={() => toggle(area.id)}
                  title={open ? "Collapse" : "Expand"}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 24, flexShrink: 0, border: "none", background: "transparent",
                    cursor: "pointer", color: "var(--text-muted)", padding: 0,
                  }}
                >
                  <ChevronRight
                    size={13}
                    style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => onSelectNode(area.id, area.name)}
                  title={area.name}
                  style={{
                    flex: 1, minWidth: 0, display: "flex", alignItems: "center",
                    justifyContent: "space-between", gap: 8, padding: "7px 8px 7px 0",
                    border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{
                    minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontSize: 12.5, fontWeight: 800,
                    color: areaActive ? "var(--accent)" : "var(--text-primary)",
                  }}>
                    {area.name}
                  </span>
                  <span style={{
                    flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)",
                    color: areaActive ? "var(--accent)" : "var(--text-muted)",
                  }}>
                    {area.drug_count}
                  </span>
                </button>
              </div>

              {/* Subclasses */}
              {open && area.subclasses.map(sub => {
                const active = selectedNodeId === sub.id;
                return (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => onSelectNode(sub.id, sub.name)}
                    title={sub.name}
                    style={{
                      width: "100%", display: "flex", alignItems: "center",
                      justifyContent: "space-between", gap: 8,
                      padding: "5px 8px 5px 30px", border: "none", borderRadius: 6,
                      background: active ? "rgba(14,165,233,0.12)" : "transparent",
                      color: active ? "var(--accent)" : "var(--text-secondary)",
                      cursor: "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{
                      minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      fontSize: 11.5, fontWeight: active ? 700 : 500,
                    }}>
                      {sub.name}
                    </span>
                    <span style={{
                      flexShrink: 0, fontSize: 9.5, fontFamily: "var(--font-mono)",
                      color: active ? "var(--accent)" : "var(--text-muted)",
                    }}>
                      {sub.drug_count}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
