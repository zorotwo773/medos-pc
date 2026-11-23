"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordRecent } from "@/lib/useRecent";
import { useAuth } from "@/lib/useAuth";
import { usePackSources, packAvailable } from "@/lib/usePackSources";
import { useTouchInteraction } from "@/components/touch/TouchInteractionProvider";
import {
  createHaloOrbGestureState,
  transitionHaloOrbGesture,
  type HaloOrbGestureEffect,
  type HaloOrbGestureEvent,
} from "@/lib/commandHaloState";
import { GROUPS, startsWith } from "./navigationModel";
import { classifyTouchInputMode, supportsPinnedNavigation, type TouchInputMode } from "@/lib/touchInputMode";

/* ──────────────────────────────────────────────────────────────
   MedOS sidebar — a hierarchical, collapsible system navigator.

   Two visual modes, both driven by the CSS-grid shell (column 1 =
   var(--rail-w)):
     • Rail (56px)      — icon-only. Hover peeks the full drawer as an
                          overlay; the toggle pins it open.
     • Expanded (210px) — full labels + per-group sub-trees. Pinned via
                          the header toggle (persisted) so page content
                          reflows around it.

   Icons are Material Symbols (matching the MedOS brand site); the active
   item renders filled. The active group auto-opens from the route, so the
   tree "changes from page to page". Brand mark is a rotating infinity that
   routes to the dashboard. Hidden entirely on the /login lock screen.
   ────────────────────────────────────────────────────────────── */

const EXPANDED_W = 210;
const RAIL_W = 56;
const STORE_KEY = "medos.sidebar.expanded";

export function getSidebarShellVariant(mode: TouchInputMode) {
  return mode === "phone-sheet" ? "phone-bottom-nav" : "rail";
}

export function createSidebarTabletOpener(mode: TouchInputMode, openHalo: () => void) {
  return () => {
    if (mode === "tablet-halo") openHalo();
  };
}

/* ── Material Symbol glyph ─────────────────────────────────────── */
function M({ name, size = 20, fill = false, weight, style }: { name: string; size?: number; fill?: boolean; weight?: number; style?: React.CSSProperties }) {
  const w = weight ?? (fill ? 420 : 300);
  return (
    <span
      className="material-symbols-outlined"
      aria-hidden="true"
      style={{ fontSize: size, fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' ${w}, 'GRAD' 0, 'opsz' ${size}`, ...style }}
    >
      {name}
    </span>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuth();
  const touchInteraction = useTouchInteraction();

  const [online, setOnline] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [hovering, setHovering] = useState(false);
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);
  const [inputMode, setInputMode] = useState<TouchInputMode>("desktop-pinned");
  const isMobile = getSidebarShellVariant(inputMode) === "phone-bottom-nav";
  const canPin = supportsPinnedNavigation(inputMode);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["qbank"]));
  const packState = usePackSources();
  const haloOrbGestureRef = useRef(createHaloOrbGestureState());

  const onLogin = pathname === "/login" || pathname.startsWith("/login/");
  const showFull = !onLogin && canPin && (expanded || (hovering && !commandCenterOpen));

  /* Backend health dot. */
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ online?: boolean }>).detail;
      setOnline(typeof detail?.online === "boolean" ? detail.online : false);
    };
    window.addEventListener("medos:backend-health", handler);
    return () => window.removeEventListener("medos:backend-health", handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      const open = Boolean(detail?.open);
      setCommandCenterOpen(open);
      if (open) setHovering(false);
    };
    window.addEventListener("medos:command-center-state", handler);
    return () => window.removeEventListener("medos:command-center-state", handler);
  }, []);

  /* Restore the pinned-expand preference (defaults to expanded). */
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORE_KEY) === "0") setExpanded(false);
    } catch {
      /* ignore */
    }
  }, []);

  /* Track viewport/input capability: phone sheet, touch tablet rail, desktop rail. */
  useEffect(() => {
    const primaryFineMq = window.matchMedia("(pointer: fine)");
    const primaryCoarseMq = window.matchMedia("(pointer: coarse)");
    const anyCoarseMq = window.matchMedia("(any-pointer: coarse)");
    const update = () => {
      setInputMode(classifyTouchInputMode({
        viewportWidth: window.innerWidth,
        primaryPointer: primaryFineMq.matches ? "fine" : primaryCoarseMq.matches ? "coarse" : "none",
        anyPointerCoarse: anyCoarseMq.matches,
      }));
    };
    update();
    primaryFineMq.addEventListener("change", update);
    primaryCoarseMq.addEventListener("change", update);
    anyCoarseMq.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      primaryFineMq.removeEventListener("change", update);
      primaryCoarseMq.removeEventListener("change", update);
      anyCoarseMq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  /* Reflow page content for a pinned expand on desktop; collapse the column
     entirely on the /login lock screen (no sidebar there). Hover-peek overlays
     instead, so it never shifts the layout. */
  useEffect(() => {
    const root = document.documentElement;
    if (onLogin) root.style.setProperty("--rail-w", "0px");
    else if (canPin && expanded) root.style.setProperty("--rail-w", `${EXPANDED_W}px`);
    else root.style.removeProperty("--rail-w");
    return () => {
      root.style.removeProperty("--rail-w");
    };
  }, [canPin, expanded, onLogin]);

  /* Auto-open the group that owns the current route so the tree tracks the
     page. We add (never force-close) so manual toggles stick. */
  const activeGroupId = useMemo(() => GROUPS.find((g) => g.isActive(pathname))?.id ?? null, [pathname]);
  const activeStepId = useMemo(() => {
    const m = /^(?:step|amboss)([123])$/.exec(searchParams.get("bank") || "");
    return m ? `qbank-${m[1]}` : null;
  }, [searchParams]);

  useEffect(() => {
    if (!activeGroupId && !activeStepId) return;
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (activeGroupId) next.add(activeGroupId);
      if (activeStepId) next.add(activeStepId);
      return next;
    });
  }, [activeGroupId, activeStepId]);

  const toggleNode = useCallback((id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePin = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const openSearch = useCallback(() => {
    setHovering(false);
    window.dispatchEvent(new CustomEvent("medos:open-search", { detail: { query: "" } }));
  }, []);
  const openCommand = useCallback(() => {
    setHovering(false);
    window.dispatchEvent(new CustomEvent("medos:open-command-center"));
  }, []);
  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) window.history.back();
  }, []);
  const openTabletHalo = useMemo(
    () => createSidebarTabletOpener(inputMode, touchInteraction.openHalo),
    [inputMode, touchInteraction.openHalo],
  );
  const setHaloOpener = touchInteraction.setHaloOpener;
  const dispatchHaloOrbEffects = useCallback((effects: readonly HaloOrbGestureEffect[]) => {
    for (const effect of effects) {
      switch (effect.type) {
        case "begin":
          touchInteraction.beginHaloGesture(effect.pointerId, effect.point);
          break;
        case "update":
          touchInteraction.updateHaloGesture(effect.pointerId, effect.point);
          break;
        case "end":
          touchInteraction.endHaloGesture(effect.pointerId, effect.point);
          break;
        case "cancel":
          touchInteraction.cancelHaloGesture(effect.pointerId);
          break;
        case "open":
          openTabletHalo();
          break;
      }
    }
  }, [openTabletHalo, touchInteraction]);
  const transitionHaloOrb = useCallback((event: HaloOrbGestureEvent) => {
    const transition = transitionHaloOrbGesture(haloOrbGestureRef.current, event);
    haloOrbGestureRef.current = transition.state;
    dispatchHaloOrbEffects(transition.effects);
    return transition;
  }, [dispatchHaloOrbEffects]);

  /* No sidebar on the lock screen. */
  if (onLogin) return null;

  /* ── Mobile: keep the existing bottom icon bar (one tap per group). ── */
  if (isMobile) {
    return (
      <aside
        className="app-sidebar"
        style={{
          gridRow: "1 / span 3",
          gridColumn: "1",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-around",
          background: "var(--chrome-bg)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
      >
        <Link href="/" className="app-sidebar-brand" aria-label="MedOS dashboard">
          <InfinityMark />
        </Link>
        {GROUPS.map((g) => {
          const active = g.isActive(pathname);
          return (
            <Link
              key={g.id}
              href={g.href}
              className="app-sidebar-link"
              title={g.label}
              onClick={() => recordRecent({ tag: g.tag, label: g.label, href: g.href })}
              style={{ color: active ? "var(--accent)" : "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8 }}
            >
              <M name={g.glyph} size={24} fill={active} />
            </Link>
          );
        })}
        <div className="app-sidebar-spacer" style={{ flex: 1 }} />
        <HealthDot online={online} />
      </aside>
    );
  }

  /* ── Desktop / tablet: rail + drawer ── */
  return (
    <aside
      className="app-sidebar medos-sb"
      data-full={showFull ? "true" : "false"}
      data-input-mode={inputMode}
      onMouseEnter={() => canPin && setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        gridRow: "1 / span 3",
        gridColumn: "1",
        position: "relative",
        width: "var(--rail-w, 56px)",
        overflow: "visible",
        zIndex: 40,
        background: "transparent",
        border: "none",
        padding: 0,
      }}
    >
      <style>{SIDEBAR_CSS}</style>

      <div
        className="medos-sb-inner"
        style={{
          position: "absolute",
          inset: "0 auto 0 0",
          width: showFull ? EXPANDED_W : RAIL_W,
          display: "flex",
          flexDirection: "column",
          background: "var(--chrome-bg)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          borderRight: "1px solid var(--border)",
          boxShadow: hovering && !expanded ? "var(--shadow-lg)" : "none",
          overflow: "hidden",
          transition: "width .2s cubic-bezier(.4,0,.2,1), box-shadow .2s",
        }}
      >
        {showFull ? (
          /* ── Expanded header ── */
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, height: 50, padding: "0 8px 0 12px" }}>
              <Link href="/" className="medos-sb-brand" title="MedOS — Dashboard" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none", flex: 1, minWidth: 0 }}>
                <InfinityMark />
                <span className="medos-fade" style={{ display: "flex", flexDirection: "column", lineHeight: 1.04, minWidth: 0 }}>
                  <span style={{ fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 16, color: "var(--text-primary)" }}>MedOS</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 7.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--accent)" }}>Clinical OS</span>
                </span>
              </Link>
              {canPin && (
                <button type="button" onClick={togglePin} className="medos-iconbtn" title={expanded ? "Collapse sidebar" : "Pin open"}>
                  <M name={expanded ? "keyboard_double_arrow_left" : "keyboard_double_arrow_right"} size={20} />
                </button>
              )}
            </div>

            <div className="medos-fade" style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px 10px 12px" }}>
              <button type="button" onClick={openSearch} style={searchPillStyle} title="Search MedOS (press /)">
                <M name="search" size={18} style={{ color: "var(--text-muted)" }} />
                <span style={{ fontSize: 12.5, color: "var(--text-muted)", flex: 1, textAlign: "left" }}>Search…</span>
                <kbd style={kbdStyle}>/</kbd>
              </button>
              <button type="button" onClick={goBack} className="medos-iconbtn" title="Go back">
                <M name="arrow_back" size={18} />
              </button>
            </div>
          </>
        ) : (
          /* ── Rail header ── */
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, paddingTop: 8 }}>
            <Link href="/" className="medos-sb-brand" title="MedOS — Dashboard" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 42, textDecoration: "none" }}>
              <InfinityMark />
            </Link>
            {canPin && (
              <RailButton label={expanded ? "Collapse" : "Expand"} onClick={togglePin}>
                <M name={expanded ? "keyboard_double_arrow_left" : "keyboard_double_arrow_right"} size={20} />
              </RailButton>
            )}
            <RailButton label="Search" onClick={openSearch}>
              <M name="search" size={21} />
            </RailButton>
            <RailButton label="Back" onClick={goBack}>
              <M name="arrow_back" size={20} />
            </RailButton>
          </div>
        )}

        <div style={{ height: 1, background: "var(--border)", margin: "0 12px 6px", opacity: 0.7 }} />

        {/* Nav tree */}
        <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "2px 0 8px" }} className="medos-sb-scroll">
          {GROUPS.map((g) => {
            const groupActive = g.isActive(pathname);
            const open = openGroups.has(g.id);
            const hasChildren = !!(g.steps || g.leaves);
            return (
              <div key={g.id} style={{ marginBottom: 1 }}>
                <div style={rowWrap(groupActive)}>
                  {groupActive && <span style={activeBar} />}
                  <Link
                    href={g.href}
                    className="medos-railbtn medos-row-link"
                    title={!showFull ? g.label : undefined}
                    onClick={() => recordRecent({ tag: g.tag, label: g.label, href: g.href })}
                    style={rowLink(showFull, groupActive)}
                  >
                    <M name={g.glyph} size={21} fill={groupActive} />
                    {showFull && <span className="medos-fade" style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{g.label}</span>}
                    {!showFull && <span className="medos-rail-tip">{g.label}</span>}
                  </Link>
                  {showFull && hasChildren && (
                    <button type="button" onClick={() => toggleNode(g.id)} style={chevBtnStyle} title={open ? "Collapse" : "Expand"} aria-label={open ? "Collapse" : "Expand"}>
                      <M name="chevron_right" size={18} style={{ color: "var(--text-muted)", transition: "transform .18s", transform: open ? "rotate(90deg)" : "none" }} />
                    </button>
                  )}
                </div>

                {showFull && open && (
                  <div className="medos-fade" style={{ marginBottom: 4 }}>
                    {g.steps?.map((step) => {
                      const stepOpen = openGroups.has(step.id);
                      return (
                        <div key={step.id}>
                          <button type="button" onClick={() => toggleNode(step.id)} style={subRowStyle} className="medos-row">
                            <M name="chevron_right" size={16} style={{ color: "var(--text-muted)", transition: "transform .18s", transform: stepOpen ? "rotate(90deg)" : "none" }} />
                            <span style={{ flex: 1, textAlign: "left", fontSize: 12.5, fontWeight: 500 }}>{step.label}</span>
                          </button>
                          {stepOpen &&
                            step.vendors.map((v) => {
                              const vActive = pathname.startsWith("/qbank") && searchParams.get("bank") === v.bank;
                              const vAvailable = packAvailable(packState, v.pack);
                              return (
                                <Link
                                  key={v.bank}
                                  href={vAvailable ? v.href : "/content"}
                                  className="medos-row"
                                  title={vAvailable ? undefined : `${v.label} not installed — open Content Manager`}
                                  onClick={() => vAvailable && recordRecent({ tag: v.label, label: `${v.label} · ${step.label}`, href: v.href })}
                                  style={{ ...vendorRowStyle(vActive), opacity: vAvailable ? 1 : 0.42 }}
                                >
                                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: v.color, flexShrink: 0, marginLeft: 2, boxShadow: vActive ? `0 0 0 3px ${v.color}33` : "none" }} />
                                  <span style={{ fontSize: 12.5, fontWeight: vActive ? 600 : 400 }}>{v.label}</span>
                                  {!vAvailable && <M name="cloud_download" size={13} style={{ marginLeft: "auto", color: "var(--text-muted)" }} />}
                                </Link>
                              );
                            })}
                        </div>
                      );
                    })}

                    {g.leaves?.map((leaf) => {
                      const leafActive = leaf.isActive(pathname, searchParams);
                      const leafAvailable = packAvailable(packState, leaf.pack);
                      return (
                        <Link
                          key={leaf.href}
                          href={leafAvailable ? leaf.href : "/content"}
                          className="medos-row"
                          title={leafAvailable ? undefined : `${leaf.label} not installed — open Content Manager`}
                          onClick={() => leafAvailable && recordRecent({ tag: leaf.tag, label: leaf.label, href: leaf.href })}
                          style={{ ...leafRowStyle(leafActive), opacity: leafAvailable ? 1 : 0.42 }}
                        >
                          <M name={leaf.glyph} size={18} fill={leafActive} style={{ flexShrink: 0 }} />
                          <span style={{ fontSize: 12.5, fontWeight: leafActive ? 600 : 400 }}>{leaf.label}</span>
                          {!leafAvailable && <M name="cloud_download" size={13} style={{ marginLeft: "auto", color: "var(--text-muted)" }} />}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Footer: content manager · admin (gated) · health */}
        <div style={{ borderTop: "1px solid var(--border)", padding: showFull ? "8px 12px" : "8px 0", display: "flex", flexDirection: "column", alignItems: showFull ? "stretch" : "center", gap: 4 }}>
          {showFull ? (
            <button type="button" onClick={openCommand} className="medos-row" title="Command Center (g k)" style={commandFooterButtonStyle}>
              <M name="bolt" size={18} />
              <span style={{ fontSize: 12.5 }}>Command Center</span>
              <kbd style={{ ...kbdStyle, marginLeft: "auto" }}>g k</kbd>
            </button>
          ) : (
            <RailButton label="Command Center" onClick={openCommand}>
              <M name="bolt" size={20} />
            </RailButton>
          )}
          {showFull ? (
            <Link href="/content" className="medos-row" style={leafRowStyle(startsWith(pathname, "/content"))} onClick={() => recordRecent({ tag: "Content", label: "Content Manager", href: "/content" })}>
              <M name="folder_managed" size={18} fill={startsWith(pathname, "/content")} />
              <span style={{ fontSize: 12.5 }}>Content Manager</span>
            </Link>
          ) : (
            <Link href="/content" className="medos-railbtn" title="Content Manager" style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", color: startsWith(pathname, "/content") ? "var(--accent)" : "var(--text-muted)", borderRadius: 9, textDecoration: "none", position: "relative" }}>
              <M name="folder_managed" size={20} fill={startsWith(pathname, "/content")} />
              <span className="medos-rail-tip">Content Manager</span>
            </Link>
          )}
          {isAdmin &&
            (showFull ? (
              <Link href="/admin" className="medos-row" style={leafRowStyle(startsWith(pathname, "/admin"))} onClick={() => recordRecent({ tag: "Admin", label: "Admin", href: "/admin" })}>
                <M name="admin_panel_settings" size={18} fill={startsWith(pathname, "/admin")} />
                <span style={{ fontSize: 12.5 }}>Admin</span>
              </Link>
            ) : (
              <Link href="/admin" className="medos-railbtn" title="Admin" style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", color: startsWith(pathname, "/admin") ? "var(--accent)" : "var(--text-muted)", borderRadius: 9, textDecoration: "none", position: "relative" }}>
                <M name="admin_panel_settings" size={20} fill={startsWith(pathname, "/admin")} />
                <span className="medos-rail-tip">Admin</span>
              </Link>
            ))}
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 2 }}>
            <HealthDot online={online} />
          </div>
        </div>
      </div>
      {inputMode === "tablet-halo" && touchInteraction.isAvailable ? (
        <button
          ref={setHaloOpener}
          type="button"
          className="medos-halo-orb"
          data-dock={touchInteraction.dockSide}
          aria-label="Open Command Halo"
          title="Open Command Halo"
          onPointerDown={(event) => {
            const transition = transitionHaloOrb({
              type: "pointer-down",
              pointerId: event.pointerId,
              point: { x: event.clientX, y: event.clientY },
            });
            if (transition.state.pointerId === event.pointerId) {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          }}
          onPointerMove={(event) => {
            transitionHaloOrb({
              type: "pointer-move",
              pointerId: event.pointerId,
              point: { x: event.clientX, y: event.clientY },
            });
          }}
          onPointerUp={(event) => {
            const matchedPointer = haloOrbGestureRef.current.pointerId === event.pointerId;
            transitionHaloOrb({
              type: "pointer-up",
              pointerId: event.pointerId,
              point: { x: event.clientX, y: event.clientY },
            });
            if (matchedPointer && event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            transitionHaloOrb({ type: "pointer-cancel", pointerId: event.pointerId });
          }}
          onClick={(event) => {
            const transition = transitionHaloOrb({ type: "click" });
            if (transition.effects.some((effect) => effect.type === "consume-click")) {
              event.preventDefault();
            }
          }}
          style={{ minWidth: 48, minHeight: 48 }}
        >
          <M name="flare" size={24} />
          <span className="medos-rail-tip">Command Halo</span>
        </button>
      ) : null}
    </aside>
  );
}

/* ── Sub-components ─────────────────────────────────────────────── */
function InfinityMark() {
  return (
    <span style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "var(--accent)" }}>
      <span className="material-symbols-outlined medos-inf" aria-hidden="true" style={{ fontSize: 27, fontVariationSettings: "'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 27" }}>
        all_inclusive
      </span>
    </span>
  );
}

function RailButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} className="medos-railbtn" style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", background: "transparent", border: "none", borderRadius: 9, cursor: "pointer", position: "relative" }}>
      {children}
      <span className="medos-rail-tip">{label}</span>
    </button>
  );
}

function HealthDot({ online }: { online: boolean | null }) {
  return (
    <div
      className="app-sidebar-health"
      title={online === null ? "Connecting…" : online ? "Backend online" : "Backend offline"}
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: online === null ? "var(--amber)" : online ? "var(--green)" : "var(--red)",
        boxShadow: online ? "0 0 6px var(--green)" : "none",
      }}
    />
  );
}

/* ── Inline style helpers ───────────────────────────────────────── */
const rowWrap = (active: boolean): React.CSSProperties => ({
  position: "relative",
  display: "flex",
  alignItems: "center",
  margin: "0 8px",
  borderRadius: 9,
  background: active ? "var(--accent-glow)" : "transparent",
});

const activeBar: React.CSSProperties = {
  position: "absolute",
  left: -8,
  top: 9,
  bottom: 9,
  width: 3,
  borderRadius: "0 3px 3px 0",
  background: "var(--accent)",
};

const rowLink = (full: boolean, active: boolean): React.CSSProperties => ({
  flex: 1,
  display: "flex",
  alignItems: "center",
  gap: 11,
  height: 40,
  padding: full ? "0 10px" : "0",
  justifyContent: full ? "flex-start" : "center",
  color: active ? "var(--accent)" : "var(--text-secondary)",
  textDecoration: "none",
  borderRadius: 9,
  position: "relative",
  cursor: "pointer",
  minWidth: 0,
});

const chevBtnStyle: React.CSSProperties = {
  width: 28,
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  flexShrink: 0,
};

const subRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  width: "calc(100% - 16px)",
  margin: "1px 8px",
  height: 33,
  padding: "0 8px 0 14px",
  background: "transparent",
  border: "none",
  borderRadius: 8,
  color: "var(--text-secondary)",
  cursor: "pointer",
};

const vendorRowStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "calc(100% - 16px)",
  margin: "1px 8px",
  height: 31,
  padding: "0 8px 0 32px",
  borderRadius: 8,
  textDecoration: "none",
  color: active ? "var(--accent)" : "var(--text-muted)",
  background: active ? "var(--accent-glow)" : "transparent",
});

const leafRowStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "calc(100% - 16px)",
  margin: "1px 8px",
  height: 33,
  padding: "0 8px 0 14px",
  borderRadius: 8,
  textDecoration: "none",
  color: active ? "var(--accent)" : "var(--text-secondary)",
  background: active ? "var(--accent-glow)" : "transparent",
});

const commandFooterButtonStyle: React.CSSProperties = {
  ...leafRowStyle(false),
  border: "none",
  cursor: "pointer",
  font: "inherit",
  textAlign: "left",
};

const searchPillStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 36,
  padding: "0 9px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  cursor: "pointer",
  flex: 1,
  minWidth: 0,
};

const kbdStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "1px 5px",
  background: "var(--bg-base)",
  flexShrink: 0,
};

/* Scoped styles: infinity spin, hover states, rail tooltips, fade-in. */
const SIDEBAR_CSS = `
.medos-sb-inner { will-change: width; }
@keyframes medos-inf-spin { to { transform: rotate(360deg); } }
.medos-inf { display: inline-block; transform-origin: 50% 50%; animation: medos-inf-spin 11s linear infinite; }
.medos-sb-brand:hover .medos-inf { animation-duration: 1.1s; }
@media (prefers-reduced-motion: reduce) { .medos-inf { animation: none; } }

.medos-fade { animation: medos-sb-fade .18s ease both; }
@keyframes medos-sb-fade { from { opacity: 0; transform: translateX(-4px); } to { opacity: 1; transform: none; } }

.medos-row, .medos-row-link { transition: background .12s, color .12s; }
.medos-row:hover, .medos-railbtn:hover, .medos-sb[data-full="true"] .medos-row-link:hover { background: var(--bg-card-hover); color: var(--text-primary); }

.medos-iconbtn { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; background: transparent; border: none; border-radius: 7px; color: var(--text-muted); cursor: pointer; flex-shrink: 0; transition: background .12s, color .12s; }
.medos-iconbtn:hover { background: var(--bg-card-hover); color: var(--text-primary); }

.medos-railbtn { position: relative; }
.medos-rail-tip {
  position: absolute; left: 48px; top: 50%; transform: translateY(-50%);
  background: var(--text-primary); color: var(--bg-base);
  padding: 3px 8px; border-radius: 4px;
  font-family: var(--font-mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase;
  white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .12s; z-index: 100;
}
.medos-railbtn:hover .medos-rail-tip { opacity: 1; }
.medos-sb[data-full="true"] .medos-rail-tip { display: none; }

.medos-sb-scroll::-webkit-scrollbar { width: 5px; }
.medos-sb-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

.medos-halo-orb {
  position: fixed; top: 50%; z-index: 89;
  display: flex; width: 48px; height: 48px; align-items: center; justify-content: center;
  transform: translateY(-50%);
  border: 1px solid var(--border-strong); border-radius: 50%;
  background: var(--chrome-bg); box-shadow: var(--shadow-md);
  color: var(--accent); cursor: pointer; touch-action: none;
}
.medos-halo-orb[data-dock="left"] { left: max(calc(${RAIL_W}px - 24px), env(safe-area-inset-left)); }
.medos-halo-orb[data-dock="right"] { right: max(0px, env(safe-area-inset-right)); }
.medos-halo-orb:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.medos-halo-orb .medos-rail-tip { left: 54px; }
.medos-halo-orb[data-dock="right"] .medos-rail-tip { right: 54px; left: auto; }
@media (prefers-reduced-motion: reduce) { .medos-halo-orb { transition: none; } }
`;
