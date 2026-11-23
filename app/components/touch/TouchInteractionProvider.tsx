"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import CommandHalo from "./CommandHalo";
import MediaTray from "./MediaTray";
import {
  addTrayItem as addTrayItemToState,
  clearTray as clearTrayState,
  createTrayState,
  releaseOwnedObjectUrls,
  removeTrayItem as removeTrayItemFromState,
  reorderTrayItem as reorderTrayItemInState,
  selectTrayItem as selectTrayItemInState,
  type TrayItem,
  type TrayState,
} from "@/lib/mediaTrayModel";
import type { MediaDescriptor } from "@/lib/mediaInterop";
import {
  calculateRadialCenter,
  createCommandHaloState,
  createDragSession,
  decideDragRelease,
  hitTestCommandHalo,
  normalizeDockSide,
  transitionCommandHalo,
  type CommandHaloDockSide,
  type CommandHaloMode,
  type CommandHaloState,
  type DragSession,
  type Point,
  type RadialGeometry,
} from "@/lib/commandHaloState";
import { classifyTouchInputMode, type TouchInputMode } from "@/lib/touchInputMode";

const DOCK_STORAGE_KEY = "medos.command-halo.dock";
const HALO_RADIUS = 184;
const TARGET_SIZE = 48;

export interface ContextCommand {
  id: string;
  label: string;
  mode: Exclude<CommandHaloMode, "navigate">;
  run: () => void;
  glyph?: string;
  description?: string;
}

export interface CommandHaloGeometry extends RadialGeometry {
  viewportWidth: number;
  viewportHeight: number;
}

export interface TouchInteractionApi extends CommandHaloState {
  inputMode: TouchInputMode;
  isAvailable: boolean;
  contextCommands: readonly ContextCommand[];
  activePetalIndex: number | null;
  geometry: CommandHaloGeometry;
  tray: TrayState;
  addToTray: (descriptor: Readonly<MediaDescriptor>) => { outcome: "added" | "duplicate" | "limit" | "unavailable"; item?: TrayItem | null };
  removeFromTray: (trayItemId: string) => void;
  clearTray: () => void;
  reorderTray: (trayItemId: string, direction: number) => void;
  selectTrayItem: (trayItemId: string) => void;
  openTray: () => void;
  openHalo: () => void;
  closeHalo: () => void;
  toggleHalo: () => void;
  setMode: (mode: CommandHaloMode) => void;
  registerContextCommand: (command: ContextCommand) => () => void;
  openSheet: (sheetId: string) => void;
  closeSheet: () => void;
  escape: () => void;
  setDockSide: (side: CommandHaloDockSide) => void;
  setHaloOpener: (element: HTMLButtonElement | null) => void;
  beginHaloGesture: (pointerId: number, point: Point) => void;
  updateHaloGesture: (pointerId: number, point: Point) => void;
  endHaloGesture: (pointerId: number, point: Point) => void;
  cancelHaloGesture: (pointerId: number) => void;
  registerGestureCommitHandler: (handler: (commandIndex: number) => void) => () => void;
}

const NOOP = () => {};
const NOOP_UNREGISTER = () => NOOP;
const UNAVAILABLE_TRAY = createTrayState();

export interface ContextCommandRegistry {
  register: (command: ContextCommand) => () => void;
  values: () => ContextCommand[];
}

export function createContextCommandRegistry(onChange: () => void = NOOP): ContextCommandRegistry {
  const commands = new Map<string, { token: symbol; command: ContextCommand }>();
  return {
    register(command) {
      const token = Symbol(command.id);
      commands.set(command.id, { token, command });
      onChange();
      return () => {
        const current = commands.get(command.id);
        if (current?.token !== token) return;
        commands.delete(command.id);
        onChange();
      };
    },
    values() {
      return Array.from(commands.values(), ({ command }) => command);
    },
  };
}

function fallbackGeometry(): CommandHaloGeometry {
  return { x: 24, y: 320, radius: 184, viewportWidth: 768, viewportHeight: 640 };
}

export function createUnavailableTouchInteraction(): TouchInteractionApi {
  return {
    ...createCommandHaloState(),
    inputMode: "desktop-pinned",
    isAvailable: false,
    contextCommands: [],
    activePetalIndex: null,
    geometry: fallbackGeometry(),
    tray: UNAVAILABLE_TRAY,
    addToTray: () => ({ outcome: "unavailable" }),
    removeFromTray: NOOP,
    clearTray: NOOP,
    reorderTray: NOOP,
    selectTrayItem: NOOP,
    openTray: NOOP,
    openHalo: NOOP,
    closeHalo: NOOP,
    toggleHalo: NOOP,
    setMode: NOOP,
    registerContextCommand: NOOP_UNREGISTER,
    openSheet: NOOP,
    closeSheet: NOOP,
    escape: NOOP,
    setDockSide: NOOP,
    setHaloOpener: NOOP,
    beginHaloGesture: NOOP,
    updateHaloGesture: NOOP,
    endHaloGesture: NOOP,
    cancelHaloGesture: NOOP,
    registerGestureCommitHandler: NOOP_UNREGISTER,
  };
}

export function shouldRenderCommandHalo(mode: TouchInputMode) {
  return mode === "tablet-halo";
}

const TouchInteractionContext = createContext<TouchInteractionApi>(createUnavailableTouchInteraction());

export function useTouchInteraction() {
  return useContext(TouchInteractionContext);
}

function readViewportGeometry(dockSide: CommandHaloDockSide, anchorY: number): CommandHaloGeometry {
  if (typeof window === "undefined") return fallbackGeometry();
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  return {
    ...calculateRadialCenter({
      dockSide,
      anchorY,
      viewportWidth,
      viewportHeight,
      radius: HALO_RADIUS,
      targetSize: TARGET_SIZE,
    }),
    viewportWidth,
    viewportHeight,
  };
}

export default function TouchInteractionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [inputMode, setInputMode] = useState<TouchInputMode>("desktop-pinned");
  const [haloState, setHaloState] = useState<CommandHaloState>(() => createCommandHaloState());
  const [contextVersion, setContextVersion] = useState(0);
  const [activePetalIndex, setActivePetalIndex] = useState<number | null>(null);
  const [geometry, setGeometry] = useState<CommandHaloGeometry>(fallbackGeometry);
  const [tray, setTray] = useState<TrayState>(createTrayState);
  const [trayOpen, setTrayOpen] = useState(false);
  const trayRef = useRef<TrayState>(tray);
  const contextRegistryRef = useRef<ContextCommandRegistry | null>(null);
  if (contextRegistryRef.current === null) {
    contextRegistryRef.current = createContextCommandRegistry(() => setContextVersion((version) => version + 1));
  }
  const openerElementRef = useRef<HTMLButtonElement | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const geometryRef = useRef(geometry);
  const commitHandlerRef = useRef<((commandIndex: number) => void) | null>(null);
  const wasOpenRef = useRef(false);
  const stateRef = useRef(haloState);

  useEffect(() => {
    stateRef.current = haloState;
  }, [haloState]);
  useEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);
  useEffect(() => {
    trayRef.current = tray;
  }, [tray]);

  const refreshGeometry = useCallback((side = stateRef.current.dockSide) => {
    const rect = openerElementRef.current?.getBoundingClientRect();
    const anchorY = rect ? rect.top + rect.height / 2 : (window.visualViewport?.height ?? window.innerHeight) / 2;
    const next = readViewportGeometry(side, anchorY);
    geometryRef.current = next;
    setGeometry(next);
    return next;
  }, []);

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
      if (stateRef.current.isOpen) refreshGeometry();
    };
    update();
    primaryFineMq.addEventListener("change", update);
    primaryCoarseMq.addEventListener("change", update);
    anyCoarseMq.addEventListener("change", update);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      primaryFineMq.removeEventListener("change", update);
      primaryCoarseMq.removeEventListener("change", update);
      anyCoarseMq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [refreshGeometry]);

  useEffect(() => {
    try {
      const dockSide = normalizeDockSide(window.localStorage.getItem(DOCK_STORAGE_KEY));
      stateRef.current = transitionCommandHalo(stateRef.current, { type: "set-dock-side", dockSide });
      setHaloState(stateRef.current);
      refreshGeometry(dockSide);
    } catch {
      refreshGeometry("left");
    }
  }, [refreshGeometry]);

  useEffect(() => {
    setHaloState((state) => transitionCommandHalo(state, { type: "route-change" }));
  }, [pathname]);

  useEffect(() => {
    if (!shouldRenderCommandHalo(inputMode)) {
      setHaloState((state) => transitionCommandHalo(state, { type: "close" }));
      dragSessionRef.current = null;
      setActivePetalIndex(null);
    }
  }, [inputMode]);

  useEffect(() => () => releaseOwnedObjectUrls(trayRef.current.items), []);

  useEffect(() => {
    if (wasOpenRef.current && !haloState.isOpen) openerElementRef.current?.focus();
    wasOpenRef.current = haloState.isOpen;
  }, [haloState.isOpen]);

  const apply = useCallback((action: Parameters<typeof transitionCommandHalo>[1]) => {
    setHaloState((state) => {
      const next = transitionCommandHalo(state, action);
      stateRef.current = next;
      return next;
    });
  }, []);

  const openHalo = useCallback(() => {
    refreshGeometry();
    apply({ type: "open" });
  }, [apply, refreshGeometry]);
  const closeHalo = useCallback(() => apply({ type: "close" }), [apply]);
  const toggleHalo = useCallback(() => {
    if (!stateRef.current.isOpen) refreshGeometry();
    apply({ type: "toggle" });
  }, [apply, refreshGeometry]);
  const setMode = useCallback((mode: CommandHaloMode) => apply({ type: "set-mode", mode }), [apply]);
  const openSheet = useCallback((sheetId: string) => apply({ type: "open-sheet", sheetId }), [apply]);
  const closeSheet = useCallback(() => apply({ type: "close-sheet" }), [apply]);
  const escape = useCallback(() => apply({ type: "escape" }), [apply]);

  const setDockSide = useCallback((requestedSide: CommandHaloDockSide) => {
    const dockSide = normalizeDockSide(requestedSide, stateRef.current.dockSide);
    apply({ type: "set-dock-side", dockSide });
    refreshGeometry(dockSide);
    try {
      window.localStorage.setItem(DOCK_STORAGE_KEY, dockSide);
    } catch {
      /* Local persistence is best-effort. */
    }
  }, [apply, refreshGeometry]);

  const registerContextCommand = useCallback((command: ContextCommand) => {
    return contextRegistryRef.current?.register(command) ?? NOOP;
  }, []);

  const addToTray = useCallback((descriptor: Readonly<MediaDescriptor>) => {
    const explicitDescriptor = descriptor.element && !descriptor.html
      ? { ...descriptor, html: descriptor.element.outerHTML, plainText: descriptor.element.textContent ?? "" }
      : descriptor;
    const result = addTrayItemToState(trayRef.current, explicitDescriptor, { origin: window.location.origin });
    trayRef.current = result.state;
    setTray(result.state);
    if (result.outcome === "added") window.MedOSMedia?.notify("Added to media tray.", "ok");
    else if (result.outcome === "duplicate") window.MedOSMedia?.notify("That media is already in the tray.", "warn");
    else window.MedOSMedia?.notify("The media tray has reached its session limit.", "warn");
    return result;
  }, []);
  const removeFromTray = useCallback((trayItemId: string) => {
    const current = trayRef.current;
    const removed = current.items.find((item) => item.trayItemId === trayItemId);
      if (removed) releaseOwnedObjectUrls([removed]);
    const next = removeTrayItemFromState(current, trayItemId);
    trayRef.current = next;
    setTray(next);
  }, []);
  const clearTray = useCallback(() => {
    releaseOwnedObjectUrls(trayRef.current.items);
    const next = clearTrayState();
    trayRef.current = next;
    setTray(next);
  }, []);
  const reorderTray = useCallback((trayItemId: string, direction: number) => {
    const next = reorderTrayItemInState(trayRef.current, trayItemId, direction);
    trayRef.current = next;
    setTray(next);
  }, []);
  const selectTrayItem = useCallback((trayItemId: string) => {
    const next = selectTrayItemInState(trayRef.current, trayItemId);
    trayRef.current = next;
    setTray(next);
  }, []);
  const openTray = useCallback(() => setTrayOpen(true), []);

  const setHaloOpener = useCallback((element: HTMLButtonElement | null) => {
    openerElementRef.current = element;
  }, []);

  const beginHaloGesture = useCallback((pointerId: number) => {
    const nextGeometry = refreshGeometry();
    dragSessionRef.current = createDragSession(pointerId);
    geometryRef.current = nextGeometry;
    setActivePetalIndex(null);
    apply({ type: "open" });
  }, [apply, refreshGeometry]);

  const updateHaloGesture = useCallback((pointerId: number, point: Point) => {
    if (dragSessionRef.current?.pointerId !== pointerId || dragSessionRef.current.released) return;
    const currentGeometry = geometryRef.current;
    const hit = hitTestCommandHalo({
      point,
      center: currentGeometry,
      radius: currentGeometry.radius,
      dockSide: stateRef.current.dockSide,
      count: 7,
      targetSize: TARGET_SIZE,
    });
    setActivePetalIndex(hit.kind === "petal" ? hit.index : null);
  }, []);

  const endHaloGesture = useCallback((pointerId: number, point: Point) => {
    const currentGeometry = geometryRef.current;
    const hit = hitTestCommandHalo({
      point,
      center: currentGeometry,
      radius: currentGeometry.radius,
      dockSide: stateRef.current.dockSide,
      count: 7,
      targetSize: TARGET_SIZE,
    });
    const decision = decideDragRelease(dragSessionRef.current, pointerId, hit);
    dragSessionRef.current = decision.session;
    setActivePetalIndex(null);
    if (decision.commandIndex !== null) commitHandlerRef.current?.(decision.commandIndex);
  }, []);

  const cancelHaloGesture = useCallback((pointerId: number) => {
    if (dragSessionRef.current?.pointerId !== pointerId) return;
    dragSessionRef.current = null;
    setActivePetalIndex(null);
  }, []);

  const registerGestureCommitHandler = useCallback((handler: (commandIndex: number) => void) => {
    commitHandlerRef.current = handler;
    return () => {
      if (commitHandlerRef.current === handler) commitHandlerRef.current = null;
    };
  }, []);

  const contextCommands = useMemo(
    () => contextVersion >= 0 ? contextRegistryRef.current?.values() ?? [] : [],
    [contextVersion],
  );
  const isAvailable = shouldRenderCommandHalo(inputMode);
  const value = useMemo<TouchInteractionApi>(() => ({
    ...haloState,
    inputMode,
    isAvailable,
    contextCommands,
    activePetalIndex,
    geometry,
    tray,
    addToTray,
    removeFromTray,
    clearTray,
    reorderTray,
    selectTrayItem,
    openTray,
    openHalo,
    closeHalo,
    toggleHalo,
    setMode,
    registerContextCommand,
    openSheet,
    closeSheet,
    escape,
    setDockSide,
    setHaloOpener,
    beginHaloGesture,
    updateHaloGesture,
    endHaloGesture,
    cancelHaloGesture,
    registerGestureCommitHandler,
  }), [
    activePetalIndex,
    addToTray,
    beginHaloGesture,
    cancelHaloGesture,
    closeHalo,
    clearTray,
    closeSheet,
    contextCommands,
    endHaloGesture,
    escape,
    geometry,
    haloState,
    inputMode,
    isAvailable,
    openHalo,
    openTray,
    openSheet,
    registerContextCommand,
    registerGestureCommitHandler,
    setDockSide,
    setHaloOpener,
    setMode,
    removeFromTray,
    reorderTray,
    selectTrayItem,
    toggleHalo,
    tray,
    updateHaloGesture,
  ]);

  return (
    <TouchInteractionContext.Provider value={value}>
      {children}
      {isAvailable ? <CommandHalo controller={value} /> : null}
      <MediaTray isOpen={trayOpen} onClose={() => setTrayOpen(false)} />
    </TouchInteractionContext.Provider>
  );
}
