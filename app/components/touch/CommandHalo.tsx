"use client";

import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { GROUPS, type Group, type Leaf, type Vendor } from "@/components/layout/navigationModel";
import { packAvailable, usePackSources } from "@/lib/usePackSources";
import { recordRecent } from "@/lib/useRecent";
import type { CommandHaloState } from "@/lib/commandHaloState";
import type {
  CommandHaloGeometry,
  ContextCommand,
  TouchInteractionApi,
} from "./TouchInteractionProvider";
import "./command-halo.css";

type CommandKind = "search" | "route" | "sheet";
type CommandSource = Group | Leaf | Vendor | null;

export interface HaloCommand {
  id: string;
  label: string;
  glyph: string;
  kind: CommandKind;
  href?: string;
  tag?: string;
  description?: string;
  pack?: string;
  recentLabel?: string;
  source: CommandSource;
}

export interface HaloSheetSection {
  label: string;
  items: HaloCommand[];
}

export interface HaloSheet {
  id: string;
  label: string;
  items: HaloCommand[];
  sections: HaloSheetSection[];
}

export interface HaloCommandActions {
  dispatchSearch: (detail: { query: string }) => void;
  openSheet: (sheetId: string) => void;
  recordRecent: (entry: { tag: string; label: string; href: string }) => void;
  closeHalo: () => void;
  pushRoute: (href: string) => void;
  isPackAvailable?: (packId?: string) => boolean;
}

export function executeHaloCommand(command: HaloCommand, actions: HaloCommandActions) {
  if (command.kind === "search") {
    actions.dispatchSearch({ query: "" });
    actions.closeHalo();
    return;
  }
  if (command.kind === "sheet") {
    actions.openSheet(command.id);
    return;
  }
  if (!command.href) return;
  if (actions.isPackAvailable && !actions.isPackAvailable(command.pack)) {
    actions.closeHalo();
    actions.pushRoute("/content");
    return;
  }
  actions.recordRecent({
    tag: command.tag ?? command.label,
    label: command.recentLabel ?? command.label,
    href: command.href,
  });
  actions.closeHalo();
  actions.pushRoute(command.href);
}

export function shouldDismissCommandHaloBackdrop(target: EventTarget, surface: EventTarget) {
  return target === surface;
}

export function collectTrayCommands(count: number, openTray: () => void): ContextCommand[] {
  return count > 0 ? [{ id: "review-media-tray", label: "Review Tray", mode: "collect", glyph: "collections", description: `${count} item${count === 1 ? "" : "s"}`, run: openTray }] : [];
}

function asRoute(id: string, label: string, source: Leaf): HaloCommand {
  return {
    id,
    label,
    glyph: source.glyph,
    kind: "route",
    href: source.href,
    tag: source.tag,
    pack: source.pack,
    source,
  };
}

function asSheet(source: Group): HaloCommand {
  return {
    id: source.id,
    label: source.label,
    glyph: source.glyph,
    kind: "sheet",
    href: source.href,
    tag: source.tag,
    source,
  };
}

export function buildCommandHaloCommands(groups: readonly Group[] = GROUPS): HaloCommand[] {
  const qbank = groups.find((group) => group.id === "qbank");
  const databases = groups.find((group) => group.id === "db");
  const tools = groups.find((group) => group.id === "tools");
  const bookshelf = databases?.leaves?.find((leaf) => leaf.href === "/library");
  const diseases = databases?.leaves?.find((leaf) => leaf.href === "/diseases");
  const drugs = databases?.leaves?.find((leaf) => leaf.href === "/drugs");

  return [
    { id: "search", label: "Search", glyph: "search", kind: "search", source: null },
    qbank ? asSheet(qbank) : null,
    databases ? asSheet(databases) : null,
    bookshelf ? { ...asRoute("library", "Library", bookshelf), description: "Bookshelf" } : null,
    diseases ? asRoute("diseases", diseases.label, diseases) : null,
    drugs ? asRoute("drugs", drugs.label, drugs) : null,
    tools ? asSheet(tools) : null,
  ].filter((command): command is HaloCommand => command !== null).slice(0, 7);
}

function vendorCommand(stepId: string, stepLabel: string, vendor: Vendor): HaloCommand {
  return {
    id: `${stepId}-${vendor.bank}`,
    label: vendor.label,
    glyph: "quiz",
    kind: "route",
    href: vendor.href,
    tag: vendor.label,
    pack: vendor.pack,
    recentLabel: `${vendor.label} · ${stepLabel}`,
    source: vendor,
  };
}

function leafCommand(groupId: string, leaf: Leaf): HaloCommand {
  return {
    id: `${groupId}-${leaf.href}`,
    label: leaf.label,
    glyph: leaf.glyph,
    kind: "route",
    href: leaf.href,
    tag: leaf.tag,
    pack: leaf.pack,
    source: leaf,
  };
}

export function buildCommandHaloSheet(command: HaloCommand): HaloSheet {
  if (command.kind !== "sheet" || !command.source || !("id" in command.source)) {
    return { id: command.id, label: command.label, items: [], sections: [] };
  }
  const group = command.source as Group;
  if (group.id === "qbank") {
    const sections = (group.steps ?? []).map((step) => ({
      label: step.label,
      items: step.vendors.map((vendor) => vendorCommand(step.id, step.label, vendor)),
    }));
    if (group.leaves?.length) {
      sections.push({ label: "More", items: group.leaves.map((leaf) => leafCommand(group.id, leaf)) });
    }
    return { id: group.id, label: group.label, items: [], sections };
  }
  return {
    id: group.id,
    label: group.label,
    items: (group.leaves ?? []).map((leaf) => leafCommand(group.id, leaf)),
    sections: [],
  };
}

const DEFAULT_GEOMETRY: CommandHaloGeometry = {
  x: 24,
  y: 320,
  radius: 184,
  viewportWidth: 768,
  viewportHeight: 640,
};

interface CommandHaloSurfaceProps {
  state: CommandHaloState;
  commands: readonly HaloCommand[];
  contextCommands: readonly ContextCommand[];
  geometry?: CommandHaloGeometry;
  activePetalIndex: number | null;
  onBackdrop: () => void;
  onClose: () => void;
  onDock: () => void;
  onEscape: () => void;
  onMode: (mode: CommandHaloState["mode"]) => void;
  onSelect: (command: HaloCommand) => void;
  onContextSelect?: (command: ContextCommand) => void;
  isPackAvailable?: (packId?: string) => boolean;
}

function materialIcon(name: string) {
  return <span className="material-symbols-outlined command-halo-icon" aria-hidden="true">{name}</span>;
}

function petalStyle(
  geometry: CommandHaloGeometry,
  dockSide: CommandHaloState["dockSide"],
  index: number,
  count: number,
): CSSProperties {
  const angle = -Math.PI / 2 + ((index + 0.5) * Math.PI) / count;
  const direction = dockSide === "left" ? 1 : -1;
  const rawX = geometry.x + direction * Math.cos(angle) * geometry.radius;
  const rawY = geometry.y + Math.sin(angle) * geometry.radius;
  return {
    "--halo-petal-x": `${rawX}px`,
    "--halo-petal-y": `${rawY}px`,
    minWidth: 48,
    minHeight: 48,
  } as CSSProperties;
}

function trapFocus(event: KeyboardEvent<HTMLElement>, onEscape: () => void) {
  if (event.key === "Escape") {
    event.preventDefault();
    onEscape();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
  if (focusable.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function HaloSheetButton({
  item,
  isPackAvailable,
  onSelect,
}: {
  item: HaloCommand;
  isPackAvailable: (packId?: string) => boolean;
  onSelect: (command: HaloCommand) => void;
}) {
  const available = isPackAvailable(item.pack);
  return (
    <button
      type="button"
      role="menuitem"
      data-available={available ? "true" : "false"}
      aria-label={available ? item.label : `${item.label}, not installed`}
      title={available ? undefined : `${item.label} not installed — open Content Manager`}
      onClick={() => onSelect(item)}
    >
      {materialIcon(item.glyph)}<span>{item.label}</span>
      {!available ? materialIcon("cloud_download") : null}
    </button>
  );
}

export function CommandHaloSurface({
  state,
  commands,
  contextCommands,
  geometry = DEFAULT_GEOMETRY,
  activePetalIndex,
  onBackdrop,
  onClose,
  onDock,
  onEscape,
  onMode,
  onSelect,
  onContextSelect = (command) => command.run(),
  isPackAvailable = () => true,
}: CommandHaloSurfaceProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const activeSheet = state.sheetId
    ? buildCommandHaloSheet(commands.find((command) => command.id === state.sheetId) ?? {
      id: state.sheetId,
      label: state.sheetId,
      glyph: "apps",
      kind: "sheet",
      source: null,
    })
    : null;
  const visibleContextCommands = contextCommands.filter((command) => command.mode === state.mode);

  useEffect(() => {
    if (!state.isOpen) return;
    const selector = state.sheetId ? "[data-halo-sheet-focus]" : "[data-halo-initial-focus]";
    const initial = dialogRef.current?.querySelector<HTMLElement>(selector);
    (initial ?? dialogRef.current)?.focus();
  }, [state.isOpen, state.sheetId]);

  if (!state.isOpen) return null;

  const radialStyle = {
    "--halo-center-x": `${geometry.x}px`,
    "--halo-center-y": `${geometry.y}px`,
    "--halo-diameter": `${geometry.radius * 2}px`,
  } as CSSProperties;

  return (
    <div
      className="command-halo-layer"
      data-dock={state.dockSide}
      onPointerDown={(event) => {
        if (shouldDismissCommandHaloBackdrop(event.target, event.currentTarget)) onBackdrop();
      }}
      style={radialStyle}
    >
      <section
        ref={dialogRef}
        className="command-halo-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command Halo"
        tabIndex={-1}
        onKeyDown={(event) => trapFocus(event, onEscape)}
        onPointerDown={(event) => {
          if (shouldDismissCommandHaloBackdrop(event.target, event.currentTarget)) onBackdrop();
        }}
      >
        <header className="command-halo-header">
          <span>Command Halo</span>
          <button type="button" className="command-halo-utility" onClick={onDock} aria-label={`Dock ${state.dockSide === "left" ? "right" : "left"}`}>
            {materialIcon(state.dockSide === "left" ? "dock_to_right" : "dock_to_left")}
            Dock {state.dockSide === "left" ? "right" : "left"}
          </button>
        </header>

        <div className="command-halo-mode-switcher" role="tablist" aria-label="Command mode">
          {(["navigate", "read", "collect"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={state.mode === mode}
              data-halo-initial-focus={state.mode === mode ? "true" : undefined}
              onClick={() => onMode(mode)}
            >
              {mode[0].toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>

        {state.mode === "navigate" ? (
          <>
            <div className="command-halo-radial" aria-hidden="true" />
            <div className="command-halo-menu" role="menu" aria-label="Navigate commands">
              {commands.map((command, index) => {
                const available = isPackAvailable(command.pack);
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="menuitem"
                    aria-label={available ? command.label : `${command.label}, not installed`}
                    aria-current={activePetalIndex === index ? "true" : undefined}
                    className="command-halo-petal"
                    data-active={activePetalIndex === index ? "true" : "false"}
                    data-available={available ? "true" : "false"}
                    title={available ? undefined : `${command.label} not installed — open Content Manager`}
                    onClick={() => onSelect(command)}
                    style={petalStyle(geometry, state.dockSide, index, commands.length)}
                  >
                    {materialIcon(command.glyph)}
                    <span className="command-halo-petal-copy">
                      <span>{command.label}</span>
                      {command.description ? <small>{command.description}</small> : null}
                    </span>
                    {!available
                      ? materialIcon("cloud_download")
                      : command.kind === "sheet" ? materialIcon("chevron_right") : null}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="command-halo-center"
              aria-label="Close Command Halo"
              onClick={onClose}
              style={{ minWidth: 48, minHeight: 48 }}
            >
              {materialIcon("close")}
            </button>
          </>
        ) : (
          <div className="command-halo-context-panel" role="menu" aria-label={`${state.mode} commands`}>
            <h2>{state.mode === "read" ? "Reading commands" : "Collection commands"}</h2>
            {visibleContextCommands.length ? visibleContextCommands.map((command) => (
              <button
                key={command.id}
                type="button"
                role="menuitem"
                aria-label={command.label}
                onClick={() => onContextSelect(command)}
                style={{ minWidth: 48, minHeight: 48 }}
              >
                {materialIcon(command.glyph ?? (state.mode === "read" ? "menu_book" : "bookmark_add"))}
                <span>{command.label}</span>
                {command.description ? <small>{command.description}</small> : null}
              </button>
            )) : <p>No commands are available for this view.</p>}
          </div>
        )}

        {activeSheet ? (
          <section className="command-halo-sheet" role="menu" aria-label={`${activeSheet.label} destinations`}>
            <header>
              <h2>{activeSheet.label}</h2>
              <button type="button" onClick={onEscape} aria-label={`Close ${activeSheet.label} destinations`} data-halo-sheet-focus="true">
                {materialIcon("close")}
              </button>
            </header>
            {activeSheet.sections.map((section) => (
              <div className="command-halo-sheet-section" key={section.label}>
                <h3>{section.label}</h3>
                {section.items.map((item) => (
                  <HaloSheetButton key={item.id} item={item} isPackAvailable={isPackAvailable} onSelect={onSelect} />
                ))}
              </div>
            ))}
            {activeSheet.items.map((item) => (
              <HaloSheetButton key={item.id} item={item} isPackAvailable={isPackAvailable} onSelect={onSelect} />
            ))}
          </section>
        ) : null}
      </section>
    </div>
  );
}

export default function CommandHalo({ controller }: { controller: TouchInteractionApi }) {
  const router = useRouter();
  const packState = usePackSources();
  const commands = useMemo(() => buildCommandHaloCommands(GROUPS), []);
  const isPackAvailable = useCallback((packId?: string) => packAvailable(packState, packId), [packState]);

  const selectCommand = useCallback((command: HaloCommand) => {
    executeHaloCommand(command, {
      dispatchSearch: (detail) => window.dispatchEvent(new CustomEvent("medos:open-search", { detail })),
      openSheet: controller.openSheet,
      recordRecent,
      closeHalo: controller.closeHalo,
      pushRoute: router.push,
      isPackAvailable,
    });
  }, [controller, isPackAvailable, router]);

  useEffect(
    () => controller.registerGestureCommitHandler((index) => {
      const command = commands[index];
      if (command) selectCommand(command);
    }),
    [commands, controller, selectCommand],
  );

  if (!controller.isAvailable || !controller.isOpen) return null;

  return (
    <CommandHaloSurface
      state={controller}
      commands={commands}
      contextCommands={[...controller.contextCommands, ...collectTrayCommands(controller.tray.items.length, controller.openTray)]}
      geometry={controller.geometry}
      activePetalIndex={controller.activePetalIndex}
      onBackdrop={controller.closeHalo}
      onClose={controller.closeHalo}
      onDock={() => controller.setDockSide(controller.dockSide === "left" ? "right" : "left")}
      onEscape={controller.escape}
      onMode={controller.setMode}
      onSelect={selectCommand}
      isPackAvailable={isPackAvailable}
      onContextSelect={(command) => {
        command.run();
        controller.closeHalo();
      }}
    />
  );
}
