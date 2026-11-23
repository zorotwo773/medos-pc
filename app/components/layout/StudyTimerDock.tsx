"use client";
import { useState, useEffect, useRef } from "react";

const TIMER_KEY     = "medos_timer";
const TIMER_COL_KEY = "medos_timer_collapsed";
const RING_C = 2 * Math.PI * 21;

interface TimerState {
  duration: number;
  remaining: number;
  running: boolean;
  startedAt: number | null;
}

function loadTimer(): TimerState {
  try {
    const s = JSON.parse(localStorage.getItem(TIMER_KEY) || "null");
    if (s && typeof s.duration === "number") return s;
  } catch { /* empty */ }
  return { duration: 25 * 60 * 1000, remaining: 25 * 60 * 1000, running: false, startedAt: null };
}
function saveTimer(s: TimerState) { localStorage.setItem(TIMER_KEY, JSON.stringify(s)); }
function effectiveRemaining(s: TimerState) {
  if (s.running && s.startedAt) return Math.max(0, s.remaining - (Date.now() - s.startedAt));
  return s.remaining;
}
function fmt(ms: number) {
  return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
}

export default function StudyTimerDock() {
  const [timer,     setTimer]     = useState<TimerState>({ duration: 25*60*1000, remaining: 25*60*1000, running: false, startedAt: null });
  const [collapsed, setCollapsed] = useState(true);
  const [display,   setDisplay]   = useState("25:00");
  const [pct,       setPct]       = useState(0);
  const [qbankActive, setQbankActive] = useState(false);
  const [phoneHidden, setPhoneHidden] = useState(true);
  const mounted = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const sync = () => setPhoneHidden(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const t = loadTimer();
    setTimer(t);
    setCollapsed(localStorage.getItem(TIMER_COL_KEY) !== "0");
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setTimer(prev => {
        const ms = effectiveRemaining(prev);
        setDisplay(fmt(ms));
        setPct(prev.duration > 0 ? 1 - ms / prev.duration : 0);
        if (prev.running && ms === 0) {
          const next = { ...prev, running: false, startedAt: null, remaining: 0 };
          saveTimer(next);
          return next;
        }
        return prev;
      });
    }, 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const h = (e: StorageEvent) => { if (e.key === TIMER_KEY) setTimer(loadTimer()); };
    window.addEventListener("storage", h);
    return () => window.removeEventListener("storage", h);
  }, []);

  useEffect(() => {
    const sync = () => setQbankActive(
      document.body.classList.contains("qbank-tutor-active") ||
      document.body.classList.contains("qbank-exam-active"),
    );
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  function toggle() {
    setTimer(prev => {
      const next: TimerState = prev.running
        ? { ...prev, running: false, startedAt: null, remaining: effectiveRemaining(prev) }
        : { ...prev, running: true, startedAt: Date.now(), remaining: prev.remaining <= 0 ? prev.duration : prev.remaining };
      saveTimer(next);
      return next;
    });
  }
  function reset() {
    setTimer(prev => { const n = { ...prev, running: false, startedAt: null, remaining: prev.duration }; saveTimer(n); return n; });
  }
  function setPreset(min: number) {
    const ms = min * 60 * 1000;
    setTimer(() => { const n: TimerState = { duration: ms, remaining: ms, running: false, startedAt: null }; saveTimer(n); return n; });
  }
  function toggleCollapsed() {
    setCollapsed(c => { const n = !c; localStorage.setItem(TIMER_COL_KEY, n ? "1" : "0"); return n; });
  }

  const isDone   = effectiveRemaining(timer) === 0;
  const isActive = timer.running || (effectiveRemaining(timer) < timer.duration && effectiveRemaining(timer) > 0);
  const offset   = (RING_C * (1 - pct)).toFixed(2);

  if (qbankActive || phoneHidden) return null;

  // Inline all styles to avoid any CSS containment issues
  const dockStyle: React.CSSProperties = {
    position: "fixed",
    right: 0,
    top: "50%",
    transform: collapsed ? `translate(calc(100% - 44px), -50%)` : "translateY(-50%)",
    zIndex: 200,
    display: "flex",
    alignItems: "stretch",
    transition: "transform .35s cubic-bezier(.2,.8,.25,1)",
  };

  return (
    <div className="study-timer-dock" data-collapsed={collapsed ? "true" : "false"} style={dockStyle}>
      {/* Handle */}
      <button
        className="study-timer-handle"
        onClick={toggleCollapsed}
        style={{
          width: 44, minWidth: 44, background: "var(--bg-card)",
          border: "1px solid var(--border)", borderRight: "none",
          borderRadius: "12px 0 0 12px",
          cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 8, padding: "14px 0",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)", fontSize: 9,
          letterSpacing: "0.22em", textTransform: "uppercase",
          boxShadow: "-4px 0 12px rgba(15,23,42,0.04)",
          transition: "color .15s, background .15s",
          outline: "none",
        }}
        title={collapsed ? "Expand study timer" : "Collapse study timer"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
        </svg>
        <span style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontSize: 11, letterSpacing: "0.1em" }}>
          {display}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{collapsed ? "◀" : "▶"}</span>
      </button>

      {/* Body */}
      <div className="study-timer-body" style={{
        background: "var(--bg-card)", border: "1px solid var(--border)",
        borderRadius: "0 0 0 12px",
        padding: "14px 16px", width: 260,
        display: "flex", flexDirection: "column", gap: 12,
        boxShadow: "-8px 8px 24px rgba(15,23,42,0.08)",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Study Timer
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: isDone ? "var(--red)" : isActive ? "var(--green)" : "var(--text-muted)" }}>
            {isDone ? "Done" : timer.running ? "Focus" : isActive ? "Paused" : "Ready"}
          </span>
        </div>

        {/* Ring + display + controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ position: "relative", width: 48, height: 48, flexShrink: 0 }}>
            <svg width="48" height="48" viewBox="0 0 48 48" style={{ transform: "rotate(-90deg)" }}>
              <circle cx="24" cy="24" r="21" stroke="var(--border)" fill="none" strokeWidth="3" />
              <circle cx="24" cy="24" r="21"
                stroke={isDone ? "var(--red)" : "var(--green)"}
                fill="none" strokeWidth="3"
                style={{ strokeDasharray: RING_C, strokeDashoffset: offset, transition: "stroke-dashoffset .25s" }}
              />
            </svg>
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", fontSize: 26, fontWeight: 500, color: "var(--text-primary)", letterSpacing: "0.02em", lineHeight: 1 }}>
            {display}
          </div>
          <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <button onClick={toggle} style={{ width: 44, height: 44, borderRadius: "50%", border: "none", background: "#0f766e", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(15,118,110,0.3)" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                {timer.running ? <path d="M6 5h4v14H6zM14 5h4v14h-4z"/> : <path d="M8 5v14l11-7z"/>}
              </svg>
            </button>
            <button onClick={reset} style={{ width: 44, height: 44, borderRadius: "50%", border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }} title="Reset">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 1 4 7.6M3 12V6M3 12H9"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Presets */}
        <div style={{ display: "flex", gap: 6 }}>
          {[15, 25, 45, 60].map(min => {
            const active = timer.duration === min * 60 * 1000;
            return (
              <button key={min} onClick={() => setPreset(min)} style={{ flex: 1, minHeight: 44, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", padding: "4px 0", borderRadius: 5, border: `1px solid ${active ? "var(--green)" : "var(--border)"}`, background: active ? "var(--green-glow)" : "transparent", color: active ? "var(--green)" : "var(--text-muted)", cursor: "pointer" }}>
                {min}m
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
