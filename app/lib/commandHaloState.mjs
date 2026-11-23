export const COMMAND_HALO_MODES = Object.freeze(["navigate", "read", "collect"]);

export function normalizeDockSide(value, fallback = "left") {
  if (value === "left" || value === "right") return value;
  return fallback === "right" ? "right" : "left";
}

export function createCommandHaloState(dockSide = "left") {
  return {
    isOpen: false,
    mode: "navigate",
    sheetId: null,
    dockSide: normalizeDockSide(dockSide),
  };
}

export function transitionCommandHalo(state, action) {
  switch (action.type) {
    case "open":
      return { ...state, isOpen: true };
    case "close":
    case "route-change":
      return { ...state, isOpen: false, mode: "navigate", sheetId: null };
    case "toggle":
      return state.isOpen
        ? { ...state, isOpen: false, mode: "navigate", sheetId: null }
        : { ...state, isOpen: true };
    case "set-mode":
      return {
        ...state,
        mode: COMMAND_HALO_MODES.includes(action.mode) ? action.mode : "navigate",
        sheetId: null,
      };
    case "open-sheet":
      return { ...state, isOpen: true, sheetId: action.sheetId || null };
    case "close-sheet":
      return { ...state, sheetId: null };
    case "escape":
      return state.sheetId
        ? { ...state, sheetId: null }
        : { ...state, isOpen: false, mode: "navigate", sheetId: null };
    case "set-dock-side":
      return { ...state, dockSide: normalizeDockSide(action.dockSide, state.dockSide) };
    default:
      return state;
  }
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function calculateRadialCenter({
  dockSide,
  anchorY,
  viewportWidth,
  viewportHeight,
  radius,
  targetSize = 48,
  safeArea = {},
}) {
  const width = Math.max(0, finiteOr(viewportWidth, 0));
  const height = Math.max(0, finiteOr(viewportHeight, 0));
  const target = Math.max(0, finiteOr(targetSize, 48));
  const halfTarget = target / 2;
  const safe = {
    top: Math.max(0, finiteOr(safeArea.top, 0)),
    right: Math.max(0, finiteOr(safeArea.right, 0)),
    bottom: Math.max(0, finiteOr(safeArea.bottom, 0)),
    left: Math.max(0, finiteOr(safeArea.left, 0)),
  };
  const availableWidth = Math.max(0, width - safe.left - safe.right - target);
  const availableHalfHeight = Math.max(0, (height - safe.top - safe.bottom - target) / 2);
  const clampedRadius = Math.max(0, Math.min(finiteOr(radius, 0), availableWidth, availableHalfHeight));
  const minY = safe.top + halfTarget + clampedRadius;
  const maxY = height - safe.bottom - halfTarget - clampedRadius;
  const desiredY = finiteOr(anchorY, height / 2);
  const y = minY <= maxY ? Math.min(maxY, Math.max(minY, desiredY)) : height / 2;
  const side = normalizeDockSide(dockSide);
  const x = side === "left" ? safe.left + halfTarget : width - safe.right - halfTarget;

  return { x, y, radius: clampedRadius };
}

export function getRadialPetalCenter({ center, radius, dockSide, index, count }) {
  const safeCount = Math.max(1, Math.floor(count));
  const safeIndex = Math.min(safeCount - 1, Math.max(0, Math.floor(index)));
  const angle = -Math.PI / 2 + ((safeIndex + 0.5) * Math.PI) / safeCount;
  const direction = normalizeDockSide(dockSide) === "left" ? 1 : -1;
  return {
    x: center.x + direction * Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  };
}

export function hitTestCommandHalo({
  point,
  center,
  radius,
  dockSide,
  count,
  targetSize = 48,
}) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const distance = Math.hypot(dx, dy);
  const cancelRadius = targetSize / 2;
  const projectedX = normalizeDockSide(dockSide) === "left" ? dx : -dx;

  if (distance <= cancelRadius) return { kind: "cancel" };
  if (projectedX < 0 || distance > radius + targetSize / 2 || count < 1) return { kind: "outside" };

  const angle = Math.atan2(dy, projectedX);
  if (angle < -Math.PI / 2 || angle > Math.PI / 2) return { kind: "outside" };
  const index = Math.min(count - 1, Math.floor(((angle + Math.PI / 2) / Math.PI) * count));
  return { kind: "petal", index };
}

export function createDragSession(pointerId) {
  return { pointerId, released: false };
}

export function decideDragRelease(session, pointerId, hit) {
  if (!session || session.released || session.pointerId !== pointerId) {
    return { session, commandIndex: null };
  }
  const nextSession = { ...session, released: true };
  return {
    session: nextSession,
    commandIndex: hit?.kind === "petal" ? hit.index : null,
  };
}

const HALO_ORB_DRAG_THRESHOLD = 8;

export function createHaloOrbGestureState() {
  return {
    pointerId: null,
    origin: null,
    dragStarted: false,
    suppressClick: false,
  };
}

export function transitionHaloOrbGesture(state, event) {
  const noEffects = () => ({ state, effects: [] });
  const reset = (suppressClick = false) => ({
    pointerId: null,
    origin: null,
    dragStarted: false,
    suppressClick,
  });

  switch (event.type) {
    case "pointer-down":
      if (state.pointerId !== null) return noEffects();
      return {
        state: {
          pointerId: event.pointerId,
          origin: event.point,
          dragStarted: false,
          suppressClick: false,
        },
        effects: [],
      };
    case "pointer-move": {
      if (state.pointerId !== event.pointerId || !state.origin) return noEffects();
      if (state.dragStarted) {
        return {
          state,
          effects: [{ type: "update", pointerId: event.pointerId, point: event.point }],
        };
      }
      const distance = Math.hypot(event.point.x - state.origin.x, event.point.y - state.origin.y);
      if (distance <= HALO_ORB_DRAG_THRESHOLD) return noEffects();
      return {
        state: { ...state, dragStarted: true },
        effects: [
          { type: "begin", pointerId: event.pointerId, point: state.origin },
          { type: "update", pointerId: event.pointerId, point: event.point },
        ],
      };
    }
    case "pointer-up":
      if (state.pointerId !== event.pointerId) return noEffects();
      return {
        state: reset(state.dragStarted),
        effects: state.dragStarted
          ? [{ type: "end", pointerId: event.pointerId, point: event.point }]
          : [],
      };
    case "pointer-cancel":
      if (state.pointerId !== event.pointerId) return noEffects();
      return {
        state: reset(),
        effects: state.dragStarted
          ? [{ type: "cancel", pointerId: event.pointerId }]
          : [],
      };
    case "click":
      return state.suppressClick
        ? { state: { ...state, suppressClick: false }, effects: [{ type: "consume-click" }] }
        : { state, effects: [{ type: "open" }] };
    default:
      return noEffects();
  }
}
