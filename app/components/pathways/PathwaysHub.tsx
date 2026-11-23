"use client";
/* PathwaysHub — the landing gallery: a wayfinding grid of clinical decision
   journeys grouped by specialty, with search and quick specialty nav. */

import { useEffect, useMemo, useState } from "react";
import { getBackendUrl } from "@/lib/api";
import type { SpecialtyGroup } from "@/lib/pathways/types";
import { specialtyVisual } from "@/lib/pathways/resources";
import { M, cardStyle, monoLabel, PW_CSS } from "./ui";

export default function PathwaysHub({ onOpen }: { onOpen: (id: number) => void }) {
  const [groups, setGroups] = useState<SpecialtyGroup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${getBackendUrl()}/pathways/specialties`);
        if (!r.ok) throw new Error(`specialties ${r.status}`);
        const d = await r.json();
        setGroups(d.specialties);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "failed to load");
      }
    })();
  }, []);

  const totals = useMemo(() => {
    if (!groups) return { paths: 0, specs: 0, decisions: 0 };
    let paths = 0, decisions = 0;
    for (const g of groups) { paths += g.pathways.length; for (const p of g.pathways) decisions += p.num_decisions; }
    return { paths, specs: groups.length, decisions };
  }, [groups]);

  const filtered = useMemo(() => {
    if (!groups) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({ ...g, pathways: g.pathways.filter((p) => p.title.toLowerCase().includes(needle)) }))
      .filter((g) => g.pathways.length > 0);
  }, [groups, q]);

  if (err) return <div style={{ padding: 30, color: "var(--red)" }}>Could not load pathways: {err}. Run <code>build_pathways.py</code> and restart the backend.</div>;

  return (
    <div className="pw-scroll" style={{ height: "100%", overflowY: "auto" }}>
      <style>{PW_CSS}</style>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "26px 24px 60px" }}>
        {/* Hero */}
        <div style={{ ...cardStyle, padding: "26px 28px", marginBottom: 22, position: "relative", overflow: "hidden", background: "linear-gradient(135deg, color-mix(in srgb, var(--mod-pathways) 12%, var(--bg-card)), var(--bg-card) 60%)", borderTop: "3px solid var(--mod-pathways)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, overflow: "hidden", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--mod-pathways) 18%, var(--bg-card))", color: "var(--mod-pathways)" }}>
              <M name="fork_right" size={25} fill />
            </span>
            <div>
              <div style={{ ...monoLabel, color: "var(--mod-pathways)" }}>UpToDate-style · learn by doing</div>
              <h1 style={{ margin: "2px 0 0", fontFamily: "var(--font-serif)", fontSize: 27, fontWeight: 660, color: "var(--text-primary)" }}>Clinical Pathways</h1>
            </div>
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 14, lineHeight: 1.55, color: "var(--text-secondary)", maxWidth: 640 }}>
            Walk real clinical decision algorithms one choice at a time. <b style={{ color: "var(--text-primary)" }}>Explore</b> to learn the reasoning at every branch, or run a <b style={{ color: "var(--text-primary)" }}>Case Sim</b> with a virtual patient — decide, get instant right/wrong coaching, and see how your calls shape the outcome. Every step links back to the UpToDate library.
          </p>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            <Stat n={totals.paths} label="pathways" />
            <Stat n={totals.specs} label="specialties" />
            <Stat n={totals.decisions} label="decision points" />
          </div>
        </div>

        {/* Search + specialty nav */}
        <div style={{ position: "sticky", top: 0, zIndex: 5, background: "var(--bg-base)", paddingBottom: 12, marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, ...cardStyle, padding: "9px 14px", marginBottom: 12 }}>
            <M name="search" size={19} style={{ color: "var(--text-muted)" }} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search pathways — e.g. hypertension, sepsis, pulmonary embolism…"
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 14, color: "var(--text-primary)" }}
            />
            {q && <button type="button" onClick={() => setQ("")} className="pw-btn" style={{ background: "transparent", border: "none", color: "var(--text-muted)", display: "flex", cursor: "pointer" }}><M name="close" size={18} /></button>}
          </div>
          {!q && groups && (
            <div className="pw-scroll" style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2 }}>
              {groups.map((g) => {
                const v = specialtyVisual(g.name);
                return (
                  <a key={g.id} href={`#spec-${g.id}`} className="pw-chip" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-card)", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: v.color }} />
                    {g.name} <span style={{ color: "var(--text-muted)" }}>{g.count}</span>
                  </a>
                );
              })}
            </div>
          )}
        </div>

        {/* Specialty sections */}
        {!groups && <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}><M name="progress_activity" size={26} /><div style={{ marginTop: 8 }}>Loading pathways…</div></div>}
        {filtered.map((g) => {
          const v = specialtyVisual(g.name);
          return (
            <section key={g.id} id={`spec-${g.id}`} style={{ marginBottom: 30, scrollMarginTop: 70 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
                <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, overflow: "hidden", display: "inline-flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${v.color} 15%, var(--bg-card))`, color: v.color }}>
                  <M name={v.glyph} size={18} fill />
                </span>
                <h2 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 620, color: "var(--text-primary)" }}>{g.name}</h2>
                <span style={{ ...monoLabel }}>{g.pathways.length}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                {g.pathways.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onOpen(p.id)}
                    className="pw-card"
                    style={{ ...cardStyle, textAlign: "left", padding: "15px 16px", borderLeft: `3px solid ${v.color}`, display: "flex", flexDirection: "column", gap: 10, minHeight: 108 }}
                  >
                    <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.32, color: "var(--text-primary)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {p.title}
                    </div>
                    <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--text-muted)" }}><M name="help" size={13} style={{ color: v.color }} />{p.num_decisions}</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--text-muted)" }}><M name="flag" size={13} style={{ color: v.color }} />{p.num_outcomes}</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--text-muted)" }}><M name="timer" size={13} />~{p.est_minutes}m</span>
                      <span style={{ flex: 1 }} />
                      <M name="arrow_forward" size={16} style={{ color: v.color }} />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {groups && filtered.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>No pathways match “{q}”.</div>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 720, fontFamily: "var(--font-serif)", color: "var(--mod-pathways)", lineHeight: 1 }}>{n.toLocaleString()}</div>
      <div style={{ ...monoLabel, marginTop: 3 }}>{label}</div>
    </div>
  );
}
