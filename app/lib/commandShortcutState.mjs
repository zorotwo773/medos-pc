function tokens(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function sequences(command) {
  return [command?.keys, ...(Array.isArray(command?.aliases) ? command.aliases : [])]
    .map(tokens)
    .filter((value) => value.length > 0);
}

function samePrefix(sequence, prefix) {
  return prefix.length <= sequence.length && prefix.every((key, index) => sequence[index] === key);
}

export function advanceCommandShortcut(buffer = [], key = "", commands = []) {
  const normalizedKey = String(key || "").trim().toLowerCase();
  if (!normalizedKey) return { buffer: [], runId: null, pendingId: null, consumed: false };

  const next = [...buffer, normalizedKey];
  const matches = [];
  for (const command of commands) {
    for (const sequence of sequences(command)) {
      if (samePrefix(sequence, next)) matches.push({ command, sequence });
    }
  }
  if (!matches.length) return { buffer: [], runId: null, pendingId: null, consumed: buffer.length > 0 };

  const exact = matches.find(({ sequence }) => sequence.length === next.length)?.command || null;
  const hasLonger = matches.some(({ sequence }) => sequence.length > next.length);
  if (exact && !hasLonger) {
    return { buffer: [], runId: exact.id || null, pendingId: null, consumed: true };
  }
  return {
    buffer: next,
    runId: null,
    pendingId: exact?.id || null,
    consumed: true,
  };
}
