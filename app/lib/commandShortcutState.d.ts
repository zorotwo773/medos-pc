export interface CommandShortcut {
  id: string;
  keys: string;
  aliases?: string[];
}

export interface CommandShortcutTransition {
  buffer: string[];
  runId: string | null;
  pendingId: string | null;
  consumed: boolean;
}

export function advanceCommandShortcut(
  buffer: string[] | undefined,
  key: string,
  commands: CommandShortcut[],
): CommandShortcutTransition;
