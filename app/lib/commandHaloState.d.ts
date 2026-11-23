export type CommandHaloMode = "navigate" | "read" | "collect";
export type CommandHaloDockSide = "left" | "right";

export interface CommandHaloState {
  isOpen: boolean;
  mode: CommandHaloMode;
  sheetId: string | null;
  dockSide: CommandHaloDockSide;
}

export type CommandHaloAction =
  | { type: "open" | "close" | "toggle" | "close-sheet" | "escape" | "route-change" }
  | { type: "set-mode"; mode: CommandHaloMode | string }
  | { type: "open-sheet"; sheetId: string }
  | { type: "set-dock-side"; dockSide: CommandHaloDockSide | string };

export interface Point { x: number; y: number }
export interface HaloOrbGestureState {
  pointerId: number | null;
  origin: Point | null;
  dragStarted: boolean;
  suppressClick: boolean;
}
export type HaloOrbGestureEvent =
  | { type: "pointer-down" | "pointer-move" | "pointer-up"; pointerId: number; point: Point }
  | { type: "pointer-cancel"; pointerId: number }
  | { type: "click" };
export type HaloOrbGestureEffect =
  | { type: "begin" | "update" | "end"; pointerId: number; point: Point }
  | { type: "cancel"; pointerId: number }
  | { type: "open" | "consume-click" };
export interface HaloOrbGestureTransition {
  state: HaloOrbGestureState;
  effects: HaloOrbGestureEffect[];
}
export interface SafeAreaInsets { top?: number; right?: number; bottom?: number; left?: number }
export interface RadialGeometryInput {
  dockSide: CommandHaloDockSide;
  anchorY: number;
  viewportWidth: number;
  viewportHeight: number;
  radius: number;
  targetSize?: number;
  safeArea?: SafeAreaInsets;
}
export interface RadialGeometry extends Point { radius: number }
export interface PetalCenterInput {
  center: Point;
  radius: number;
  dockSide: CommandHaloDockSide;
  index: number;
  count: number;
}
export type CommandHaloHit = { kind: "petal"; index: number } | { kind: "cancel" | "outside" };
export interface HitTestInput extends PetalCenterInput {
  point: Point;
  index: never;
  targetSize?: number;
}
export interface DragSession { pointerId: number; released: boolean }

export const COMMAND_HALO_MODES: readonly CommandHaloMode[];
export function normalizeDockSide(value: unknown, fallback?: CommandHaloDockSide): CommandHaloDockSide;
export function createCommandHaloState(dockSide?: CommandHaloDockSide | string): CommandHaloState;
export function transitionCommandHalo(state: CommandHaloState, action: CommandHaloAction): CommandHaloState;
export function calculateRadialCenter(input: RadialGeometryInput): RadialGeometry;
export function getRadialPetalCenter(input: PetalCenterInput): Point;
export function hitTestCommandHalo(input: Omit<HitTestInput, "index">): CommandHaloHit;
export function createDragSession(pointerId: number): DragSession;
export function decideDragRelease(
  session: DragSession | null,
  pointerId: number,
  hit: CommandHaloHit,
): { session: DragSession | null; commandIndex: number | null };
export function createHaloOrbGestureState(): HaloOrbGestureState;
export function transitionHaloOrbGesture(
  state: HaloOrbGestureState,
  event: HaloOrbGestureEvent,
): HaloOrbGestureTransition;
