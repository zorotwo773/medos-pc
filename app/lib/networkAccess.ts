export interface NetworkAccessState {
  requested: { allow_public: boolean };
  effective: { allow_public: boolean };
  can_change: boolean;
  platform: string;
  needs_attention: boolean;
}

export interface NetworkAccessResult {
  state: NetworkAccessState;
  error: string | null;
  cancelled: boolean;
  unavailable: boolean;
}

export interface NetworkAccessStatusUpdate {
  state: NetworkAccessState | null;
  unavailable: boolean;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type NetworkAccessFetcher = (
  input: string,
  init: {
    body?: string;
    cache: "no-store";
    headers?: { "Content-Type": "application/json" };
    method: "GET" | "POST";
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export const DEFAULT_NETWORK_ACCESS_STATE: NetworkAccessState = {
  requested: { allow_public: false },
  effective: { allow_public: false },
  can_change: false,
  platform: "unknown",
  needs_attention: false,
};

export const NETWORK_ACCESS_ENDPOINT = "/api/network/access";

export const PUBLIC_NETWORK_CONFIRMATION =
  "Other people on the current network may be able to open MedOS. This does not configure router port forwarding and does not make MedOS reachable from the internet. Allow access on public networks?";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyBoolean(container: unknown, key: string): boolean | null {
  if (!isRecord(container) || typeof container[key] !== "boolean") return null;
  return container[key] as boolean;
}

export function parseNetworkAccessState(value: unknown): NetworkAccessState {
  if (!isRecord(value)) throw new Error("Invalid network access response");
  const requested = policyBoolean(value.requested, "allow_public");
  const effective = policyBoolean(value.effective, "allow_public");
  if (
    requested === null
    || effective === null
    || typeof value.can_change !== "boolean"
    || typeof value.platform !== "string"
    || !value.platform
    || typeof value.needs_attention !== "boolean"
  ) {
    throw new Error("Invalid network access response");
  }
  return {
    requested: { allow_public: requested },
    effective: { allow_public: effective },
    can_change: value.can_change,
    platform: value.platform,
    needs_attention: value.needs_attention,
  };
}

export function networkAccessNeedsAttention(state: NetworkAccessState): boolean {
  return state.needs_attention
    || state.requested.allow_public !== state.effective.allow_public;
}

export function networkAccessStatusLabel(state: NetworkAccessState): string {
  if (networkAccessNeedsAttention(state)) return "Network access needs attention";
  return state.effective.allow_public
    ? "Public networks enabled"
    : "Private network only";
}

export function networkAccessControlModel(
  state: NetworkAccessState,
  ui: { loading: boolean; busy: boolean; error: string | null; unavailable?: boolean },
) {
  const unavailable = ui.unavailable === true;
  const attention = networkAccessNeedsAttention(state);
  const isPublic = state.effective.allow_public;
  return {
    checked: isPublic,
    disabled: ui.loading || ui.busy || unavailable || !state.can_change,
    status: unavailable ? "Network access unavailable" : networkAccessStatusLabel(state),
    statusKind: unavailable || attention ? "attention" : isPublic ? "public" : "private",
    description: isPublic ? "Public networks enabled" : "Private network only",
    showHostOnlyGuidance: !ui.loading && !unavailable && !state.can_change,
    showRetry: unavailable && !ui.loading && !ui.busy,
  } as const;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  if (typeof payload.detail === "string") return payload.detail;
  if (isRecord(payload.detail) && typeof payload.detail.message === "string") {
    return payload.detail.message;
  }
  if (typeof payload.message === "string") return payload.message;
  return fallback;
}

async function readFailure(response: FetchResponse, fallback: string): Promise<string> {
  try {
    return errorMessage(await response.json(), fallback);
  } catch {
    return fallback;
  }
}

export function networkAccessGuidance(
  message: string,
  platform: string,
  canChange: boolean,
): string {
  if (!canChange) {
    return "Open Settings on the MedOS host laptop to change network access. Other devices can view this status but cannot change it.";
  }
  if (platform === "darwin") {
    if (/not saved|could not be saved|persist/i.test(message)) {
      return "MedOS could not save the app-access setting. Try again. If it still fails, restart MedOS and try again.";
    }
    if (/verif|mismatch|changed concurrently|inconsistent|state could not be read/i.test(message)) {
      return "MedOS could not verify the app-access setting. Try again. If it still fails, restart MedOS and try again.";
    }
    return "MedOS could not update the app-access setting. Try again. If it still fails, restart MedOS and try again.";
  }
  if (platform === "win32") {
    if (/cancel/i.test(message)) {
      return "MedOS remains private. Try again from this laptop and approve the Windows UAC prompt.";
    }
    return "The MedOS firewall helper could not update the Windows rules. Try again from this laptop and approve the UAC prompt.";
  }
  return "Network access could not be changed. MedOS kept the last verified policy; try again from the host laptop.";
}

export function networkAccessPlatformGuidance(state: NetworkAccessState): string | null {
  if (state.platform !== "darwin") return null;
  return "This changes MedOS app access only. macOS Firewall may still block incoming connections; allow MedOS or Node when prompted. Do not disable the firewall.";
}

export function networkAccessUnavailableLabel(state: NetworkAccessState | null): string {
  if (!state) return "Network access unavailable";
  return state.effective.allow_public
    ? "Public networks enabled · Network status unavailable"
    : "Private network only · Network status unavailable";
}

export async function loadNetworkAccess(
  fetcher: NetworkAccessFetcher,
  endpoint: string,
  signal?: AbortSignal,
): Promise<NetworkAccessState> {
  const response = await fetcher(endpoint, {
    cache: "no-store",
    method: "GET",
    signal,
  });
  if (!response.ok) {
    throw new Error(await readFailure(response, `Network access status failed (${response.status})`));
  }
  return parseNetworkAccessState(await response.json());
}

export async function changeNetworkAccess({
  allowPublic,
  confirmPublic,
  current,
  endpoint,
  fetcher,
  onBusy,
  signal,
}: {
  allowPublic: boolean;
  confirmPublic: (message: string) => boolean;
  current: NetworkAccessState;
  endpoint: string;
  fetcher: NetworkAccessFetcher;
  onBusy?: (busy: boolean) => void;
  signal?: AbortSignal;
}): Promise<NetworkAccessResult> {
  if (!current.can_change) {
    return {
      state: current,
      error: networkAccessGuidance("host-only network setting", current.platform, false),
      cancelled: false,
      unavailable: false,
    };
  }
  if (allowPublic && !confirmPublic(PUBLIC_NETWORK_CONFIRMATION)) {
    return { state: current, error: null, cancelled: true, unavailable: false };
  }

  onBusy?.(true);
  let changedError: string | null = null;
  let refreshed = current;
  let unavailable = false;
  try {
    try {
      const response = await fetcher(endpoint, {
        body: JSON.stringify({ allow_public: allowPublic }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal,
      });
      if (!response.ok) {
        changedError = await readFailure(
          response,
          `Network access change failed (${response.status})`,
        );
      }
    } catch (error) {
      changedError = error instanceof Error ? error.message : "Network access change failed";
    }

    try {
      refreshed = await loadNetworkAccess(fetcher, endpoint, signal);
    } catch (error) {
      unavailable = true;
      if (!changedError) {
        changedError = error instanceof Error
          ? error.message
          : "Network access verification failed";
      }
    }

    if (!changedError && refreshed.effective.allow_public !== allowPublic) {
      changedError = "network access verification mismatch";
    }

    return {
      state: refreshed,
      error: changedError
        ? networkAccessGuidance(changedError, refreshed.platform, refreshed.can_change)
        : null,
      cancelled: false,
      unavailable,
    };
  } finally {
    onBusy?.(false);
  }
}

export function createNetworkAccessStatusController({
  endpoint,
  fetcher,
  onUpdate,
}: {
  endpoint: string;
  fetcher: NetworkAccessFetcher;
  onUpdate: (update: NetworkAccessStatusUpdate) => void;
}) {
  let activeController: AbortController | null = null;
  let generation = 0;
  let lastKnown: NetworkAccessState | null = null;
  let stopped = false;

  function accept(value: unknown) {
    if (stopped) return;
    generation += 1;
    activeController?.abort();
    activeController = null;
    lastKnown = parseNetworkAccessState(value);
    onUpdate({ state: lastKnown, unavailable: false });
  }

  async function refresh(): Promise<void> {
    if (stopped) return;
    const request = ++generation;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    try {
      const next = await loadNetworkAccess(fetcher, endpoint, controller.signal);
      if (stopped || generation !== request || controller.signal.aborted) return;
      lastKnown = next;
      onUpdate({ state: next, unavailable: false });
    } catch {
      if (stopped || generation !== request || controller.signal.aborted) return;
      if (lastKnown) {
        lastKnown = {
          ...lastKnown,
          requested: { ...lastKnown.requested },
          effective: { ...lastKnown.effective },
          needs_attention: true,
        };
      }
      onUpdate({ state: lastKnown, unavailable: true });
    } finally {
      if (generation === request && activeController === controller) {
        activeController = null;
      }
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    activeController?.abort();
    activeController = null;
  }

  return { accept, refresh, stop };
}
