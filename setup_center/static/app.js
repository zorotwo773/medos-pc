"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const endpoints = Object.freeze({
    status: "api/status",
    destinations: "api/destinations",
    install: "api/install",
    startMedos: "api/start-medos",
    control: "api/control",
    diagnostics: "api/diagnostics",
  });
  const PORTABLE = "portable";
  const systemNames = Object.freeze({ windows: "Windows", macos: "macOS" });
  const phaseLabels = Object.freeze({
    preparing: "Preparing MedOS",
    "detecting-platform": "Detecting this computer",
    "validating-release": "Validating the portable release",
    "preparing-runtime": "Preparing the portable runtime",
    "creating-shortcut": "Creating the MedOS shortcut",
    "starting-medos": "Starting MedOS",
    "checking-health": "Checking that MedOS is ready",
    diagnosing: "Checking MedOS",
    diagnostics: "Saving diagnostics",
    complete: "MedOS is ready",
  });
  const state = {
    active: false,
    lastSequence: 0,
    lastUpdateAt: null,
    pollTimer: null,
    result: null,
    lastAnnouncedPhase: "",
    lastAnnouncedControl: "",
    failedOperationKind: "",
    plan: null,
    mode: "",
    destinationId: "",
  };

  const elements = {
    form: byId("setup-form"),
    start: byId("start-medos"),
    planHelp: byId("plan-help"),
    modeGroup: byId("mode"),
    destinationPanel: byId("destination-panel"),
    destinationGroup: byId("destination"),
    destinationHelp: byId("destination-help"),
    actionHelp: byId("action-help"),
    welcomeEyebrow: byId("welcome-eyebrow"),
    welcomeTitle: byId("welcome-title"),
    welcomeLede: byId("welcome-lede"),
    factPlatform: byId("fact-platform"),
    brandSubtitle: byId("brand-subtitle"),
    progressPanel: byId("progress-panel"),
    resultPanel: byId("result-panel"),
    progress: byId("progress"),
    percent: byId("progress-percent"),
    phase: byId("phase"),
    bytes: byId("bytes"),
    speed: byId("speed"),
    eta: byId("eta"),
    statusMessage: byId("status-message"),
    heartbeatText: byId("heartbeat-text"),
    pause: byId("pause"),
    resume: byId("resume"),
    cancel: byId("cancel"),
    retry: byId("retry"),
    diagnostics: byId("diagnostics"),
    open: byId("open-medos"),
    status: byId("status-announcer"),
    error: byId("error-announcer"),
    resultTitle: byId("result-title"),
    resultSummary: byId("result-summary"),
    resultTarget: byId("result-target"),
    resultData: byId("result-data"),
    resultHealth: byId("result-health"),
    diagnosticLocation: byId("diagnostic-location"),
    failureDetails: byId("failure-details"),
    failureSummary: byId("failure-summary"),
    failureActions: byId("failure-actions"),
  };

  async function request(name, options = {}) {
    if (!Object.hasOwn(endpoints, name)) throw new Error("Unknown MedOS action.");
    const response = await fetch(endpoints[name], {
      cache: "no-store",
      credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json" } : {},
      method: options.method || "GET",
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let value;
    try {
      value = await response.json();
    } catch (_error) {
      throw new Error(`MedOS returned ${response.status}.`);
    }
    if (!response.ok) {
      throw new Error(typeof value.error === "string" ? value.error : `MedOS returned ${response.status}.`);
    }
    return value;
  }

  function announce(message, isError = false) {
    const target = isError ? elements.error : elements.status;
    target.textContent = "";
    window.setTimeout(() => { target.textContent = message; }, 20);
  }

  function setText(element, value, fallback = "—") {
    element.textContent = value === null || value === undefined || value === "" ? fallback : String(value);
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let amount = bytes;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    const digits = unit === 0 || amount >= 10 ? 0 : 1;
    return `${amount.toFixed(digits)} ${units[unit]}`;
  }

  function formatEta(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return "Calculating…";
    if (seconds < 60) return `${Math.ceil(seconds)} sec`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
    return `${Math.floor(seconds / 3600)} hr ${Math.ceil((seconds % 3600) / 60)} min`;
  }

  function latestProgress(events) {
    const values = Array.isArray(events) ? events : [];
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (values[index] && values[index].phase) return values[index];
    }
    return null;
  }

  function phaseLabel(phase) {
    return Object.hasOwn(phaseLabels, phase) ? phaseLabels[phase] : "Working on MedOS";
  }

  function renderProgress(event, terminalSuccess = false) {
    if (!event) return;
    const completed = Math.max(0, Number(event.completed_bytes) || 0);
    const total = Math.max(0, Number(event.total_bytes) || 0);
    const phase = String(event.phase || "");
    const rawPercent = total > 0
      ? Math.min(100, Math.round((completed / total) * 100))
      : (phase === "complete" ? 100 : 0);
    const percent = terminalSuccess ? rawPercent : Math.min(99, rawPercent);
    const sequence = Number(event.sequence);
    if (Number.isFinite(sequence) && sequence > state.lastSequence) {
      state.lastSequence = sequence;
      state.lastUpdateAt = Date.now();
    }
    elements.progress.value = percent;
    elements.progress.textContent = `${percent}%`;
    setText(elements.percent, `${percent}%`);
    setText(elements.phase, phaseLabel(phase));
    setText(elements.bytes, `${formatBytes(completed)} of ${formatBytes(total)}`);
    setText(
      elements.speed,
      Number(event.bytes_per_second) > 0 ? `${formatBytes(event.bytes_per_second)}/s` : "Calculating…",
    );
    setText(elements.eta, formatEta(event.eta_seconds));
    setText(elements.statusMessage, event.message, phaseLabel(phase));
    if (phase && phase !== state.lastAnnouncedPhase) {
      state.lastAnnouncedPhase = phase;
      announce(phaseLabel(phase));
    }
  }

  function updateHeartbeat(operation, connected = true) {
    if (!connected) {
      setText(elements.heartbeatText, "Connection interrupted — MedOS keeps working. Reconnecting…");
      return;
    }
    if (!operation || operation.status !== "running") {
      setText(elements.heartbeatText, "Connected to the local MedOS service.");
      return;
    }
    const control = String(operation.control || "running");
    if (control === "paused") {
      setText(elements.heartbeatText, "Paused safely. Select Resume when you are ready.");
      return;
    }
    if (control === "waiting-for-drive") {
      setText(elements.heartbeatText, "MedOS folder is unavailable. Restore it, then select Resume.");
      return;
    }
    if (control.endsWith("-requested")) {
      setText(elements.heartbeatText, "Waiting for a safe checkpoint…");
      return;
    }
    const elapsed = state.lastUpdateAt === null ? 0 : Math.max(0, Date.now() - state.lastUpdateAt);
    const age = elapsed < 5000 ? "just now" : `${Math.floor(elapsed / 1000)} seconds ago`;
    setText(elements.heartbeatText, `Still working — connected. Progress updated ${age}.`);
  }

  function announceControlTransition(operation) {
    if (!operation || operation.status !== "running") return;
    const control = String(operation.control || "running");
    if (control === state.lastAnnouncedControl) return;
    const previous = state.lastAnnouncedControl;
    state.lastAnnouncedControl = control;
    if (!previous && control === "running") return;
    const messages = {
      "pause-requested": "Pause requested. Waiting for a safe checkpoint.",
      paused: "Paused safely. Select Resume when you are ready.",
      "waiting-for-drive": "MedOS folder is unavailable. Restore it, then select Resume.",
      "resume-requested": "Resume requested. Waiting for MedOS to continue.",
      running: "MedOS start resumed.",
      "cancel-requested": "Cancel requested. Waiting for a safe checkpoint.",
    };
    if (Object.hasOwn(messages, control)) announce(messages[control]);
  }

  function safeOpenUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, window.location.href);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
      return loopback && (url.protocol === "http:" || url.protocol === "https:") ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function selectedMode() {
    return state.plan ? state.plan.modes.find((item) => item.id === state.mode) || null : null;
  }

  function selectedDestination() {
    return state.plan
      ? state.plan.destinations.find((item) => item.id === state.destinationId) || null
      : null;
  }

  function isCopyingMode(modeId) {
    return typeof modeId === "string" && modeId !== "" && modeId !== PORTABLE;
  }

  function destinationUsable(destination, modeId) {
    if (!destination || destination.unusable) return false;
    return Boolean(destination.fits && destination.fits[modeId]);
  }

  function systemName(system) {
    return Object.hasOwn(systemNames, system) ? systemNames[system] : String(system || "this computer");
  }

  function renderPlatform(plan) {
    const name = systemName(plan.system);
    setText(elements.factPlatform, `${name} · ${plan.architecture}`);
    setText(elements.welcomeEyebrow, `Detected ${name}`);
    setText(elements.welcomeTitle, `Set up MedOS on ${name}`);
    setText(elements.brandSubtitle, `${name} setup`);
    setText(
      elements.welcomeLede,
      `MedOS brings its own Python and Node runtimes for ${name}, so nothing is downloaded and no internet connection is needed.`,
    );
  }

  function renderModes(plan) {
    elements.modeGroup.textContent = "";
    plan.modes.forEach((mode) => {
      const label = document.createElement("label");
      label.className = "choice-card";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "install-mode";
      input.value = mode.id;
      input.checked = mode.id === state.mode;
      input.addEventListener("change", () => {
        state.mode = mode.id;
        renderDestinations();
        updateActionHelp();
        updateStartAvailability();
      });
      const body = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = mode.label;
      const detail = document.createElement("small");
      detail.textContent = isCopyingMode(mode.id)
        ? `${mode.description} Copies ${formatBytes(mode.required_bytes)}.`
        : mode.description;
      body.append(title, detail);
      label.append(input, body);
      elements.modeGroup.append(label);
    });
  }

  function destinationReason(destination, mode) {
    if (destination.unusable) return destination.unusable;
    if (!destinationUsable(destination, mode.id)) {
      return `Needs ${formatBytes(mode.required_bytes)} plus a safety margin, but only ${formatBytes(destination.free_bytes)} is free.`;
    }
    const filesystem = destination.filesystem ? ` · ${destination.filesystem}` : "";
    return `${formatBytes(destination.free_bytes)} free${filesystem} · installs to ${destination.path}`;
  }

  function renderDestinations() {
    const plan = state.plan;
    if (!plan) return;
    const copying = isCopyingMode(state.mode);
    elements.destinationPanel.hidden = !copying;
    if (!copying) {
      state.destinationId = "";
      return;
    }
    const mode = selectedMode();
    if (!mode) return;
    if (!destinationUsable(selectedDestination(), mode.id)) {
      const fallback =
        plan.destinations.find(
          (item) => item.recommended && destinationUsable(item, mode.id),
        ) || plan.destinations.find((item) => destinationUsable(item, mode.id));
      state.destinationId = fallback ? fallback.id : "";
    }
    elements.destinationGroup.textContent = "";
    let usableCount = 0;
    plan.destinations.forEach((destination) => {
      const usable = destinationUsable(destination, mode.id);
      if (usable) usableCount += 1;
      const label = document.createElement("label");
      label.className = usable ? "choice-card" : "choice-card is-unavailable";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "install-destination";
      input.value = destination.id;
      input.disabled = !usable;
      input.checked = usable && destination.id === state.destinationId;
      input.addEventListener("change", () => {
        state.destinationId = destination.id;
        updateActionHelp();
        updateStartAvailability();
      });
      const body = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = destination.recommended
        ? `${destination.label} (recommended)`
        : destination.label;
      const detail = document.createElement("small");
      detail.textContent = destinationReason(destination, mode);
      body.append(title, detail);
      label.append(input, body);
      elements.destinationGroup.append(label);
    });
    setText(
      elements.destinationHelp,
      usableCount > 0
        ? `Pick a disk with enough free space for ${formatBytes(mode.required_bytes)}.`
        : `No connected disk has room for ${formatBytes(mode.required_bytes)}. Free up space, or choose a setup type that copies less.`,
    );
  }

  function updateActionHelp() {
    const mode = selectedMode();
    if (!mode) {
      setText(elements.actionHelp, "Choose a setup type above to continue.");
      setText(elements.start, "Start MedOS");
      return;
    }
    if (!isCopyingMode(mode.id)) {
      setText(elements.start, "Start MedOS here");
      setText(
        elements.actionHelp,
        "MedOS runs from this folder. Nothing large is copied. It prepares its writable state, creates one desktop shortcut, starts its bundled services, checks them, and opens MedOS.",
      );
      return;
    }
    setText(elements.start, "Install MedOS");
    const destination = selectedDestination();
    setText(
      elements.actionHelp,
      destination
        ? `MedOS copies ${formatBytes(mode.required_bytes)} to ${destination.path}, creates one desktop shortcut, starts its bundled services, checks them, and opens MedOS. You can pause or cancel safely at any point.`
        : "Choose a destination above to continue.",
    );
  }

  function updateStartAvailability() {
    if (state.active) {
      elements.start.disabled = true;
      return;
    }
    const mode = selectedMode();
    if (!mode) {
      elements.start.disabled = true;
      return;
    }
    elements.start.disabled =
      isCopyingMode(mode.id) && !destinationUsable(selectedDestination(), mode.id);
  }

  async function loadPlan() {
    setText(elements.planHelp, "Reading the release on this drive…");
    let plan;
    try {
      plan = await request("destinations");
    } catch (error) {
      setText(
        elements.planHelp,
        error.message || "MedOS could not read the release on this drive.",
      );
      announce(error.message || "MedOS could not read the release on this drive.", true);
      return null;
    }
    state.plan = plan;
    // Running in place is the safe default: it copies nothing, so it cannot
    // fail for lack of space.
    if (!state.mode) state.mode = PORTABLE;
    renderPlatform(plan);
    renderModes(plan);
    renderDestinations();
    updateActionHelp();
    updateStartAvailability();
    setText(
      elements.planHelp,
      `Release ${plan.release_root} is ready. Choose whether to copy MedOS to this computer or run it where it is.`,
    );
    return plan;
  }

  function renderResult(operation) {
    const result = operation && operation.result && typeof operation.result === "object" ? operation.result : {};
    state.result = result;
    state.failedOperationKind = "";
    state.active = false;
    elements.progress.value = 100;
    elements.progress.textContent = "100%";
    setText(elements.percent, "100%");
    elements.resultPanel.hidden = false;
    elements.failureDetails.hidden = true;
    elements.retry.hidden = true;
    setText(elements.resultTitle, operation && operation.kind === "diagnostics" ? "Diagnostics saved" : "MedOS is ready");
    setText(
      elements.resultSummary,
      result.summary,
      operation && operation.kind === "diagnostics"
        ? "The privacy-filtered diagnostic file is ready to share."
        : operation && operation.kind === "install"
          ? "MedOS was installed and passed its local health check."
          : "MedOS started from this folder. No large files were copied.",
    );
    setText(elements.resultTarget, result.target, "This folder");
    setText(elements.resultData, result.data_root || "Preserved");
    setText(elements.resultHealth, result.health || result.phase || "Verified");
    elements.open.disabled = !safeOpenUrl(result.open_url);
    if (result.path) setText(elements.diagnosticLocation, `Diagnostics saved at ${result.path}`);
    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    elements.resultPanel.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    announce(operation && operation.kind === "diagnostics" ? "Diagnostics saved." : "MedOS started and passed its local health check.");
    updateStartAvailability();
  }

  function renderFailure(operation) {
    const failure = operation && operation.failure && typeof operation.failure === "object"
      ? operation.failure
      : {
          summary: operation && operation.error,
          actions: ["Try again", "Save diagnostics"],
        };
    state.active = false;
    state.failedOperationKind =
      operation && (operation.kind === "start-medos" || operation.kind === "install")
        ? operation.kind
        : "";
    elements.resultPanel.hidden = false;
    elements.failureDetails.hidden = false;
    elements.retry.hidden = false;
    setText(elements.retry, "Try again");
    setText(elements.resultTitle, "MedOS needs attention");
    setText(elements.resultSummary, "The release folder and your existing work were not removed.");
    setText(elements.failureSummary, failure.summary || "MedOS did not become healthy in time.");
    const actions = Array.isArray(failure.actions)
      ? failure.actions.filter((item) => typeof item === "string")
      : [];
    setText(elements.failureActions, actions.join(" · "), "Try again or save diagnostics.");
    setText(elements.resultHealth, failure.code || "Needs attention");
    elements.open.disabled = true;
    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    elements.resultPanel.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    updateStartAvailability();
  }

  function renderSnapshot(snapshot) {
    const operation = snapshot && snapshot.operation;
    renderProgress(
      latestProgress(snapshot && snapshot.events),
      Boolean(operation && operation.status === "succeeded"),
    );
    if (!operation) {
      state.active = false;
      updateHeartbeat(null);
      updateStartAvailability();
      return;
    }
    elements.progressPanel.hidden = false;
    const active = operation.status === "running";
    state.active = active;
    elements.pause.disabled = !active || ["paused", "waiting-for-drive", "pause-requested", "cancel-requested", "cancelled"].includes(operation.control);
    elements.resume.disabled = !active || !["paused", "waiting-for-drive"].includes(operation.control);
    elements.cancel.disabled = !active || ["cancel-requested", "cancelled"].includes(operation.control);
    announceControlTransition(operation);
    updateHeartbeat(operation);
    updateStartAvailability();
    if (operation.status === "succeeded") {
      stopPolling();
      renderResult(operation);
    } else if (operation.status === "failed") {
      stopPolling();
      announce(operation.error || "MedOS did not start. Your existing data was not removed.", true);
      setText(elements.phase, "MedOS needs attention");
      setText(elements.statusMessage, "Review the message below, then try again or save diagnostics.");
      renderFailure(operation);
    } else if (operation.status === "cancelled") {
      stopPolling();
      state.active = false;
      announce("MedOS start was cancelled safely.");
      setText(elements.phase, "Cancelled safely");
      setText(elements.statusMessage, "No large data was copied or removed.");
      updateStartAvailability();
    } else {
      startPolling();
    }
  }

  async function connect() {
    try {
      const snapshot = await request("status");
      renderSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      updateHeartbeat(null, false);
      announce(error.message || "Cannot connect to the local MedOS service.", true);
      throw error;
    }
  }

  async function begin(name, body = {}) {
    elements.resultPanel.hidden = true;
    elements.failureDetails.hidden = true;
    elements.progressPanel.hidden = false;
    state.active = true;
    state.lastSequence = 0;
    state.lastUpdateAt = Date.now();
    state.lastAnnouncedControl = "running";
    updateStartAvailability();
    setText(elements.phase, name === "diagnostics" ? phaseLabels.diagnostics : phaseLabels.preparing);
    setText(
      elements.statusMessage,
      name === "diagnostics"
        ? "Saving diagnostics…"
        : name === "install"
          ? "Copying MedOS to the destination…"
          : "Starting MedOS from this folder…",
    );
    updateHeartbeat({ status: "running", control: "running" });
    try {
      const result = await request(name, { method: "POST", body });
      announce(name === "diagnostics" ? "Diagnostic collection started." : "MedOS start began. This page may be reopened without stopping it.");
      startPolling();
      await connect();
      return result;
    } catch (error) {
      state.active = false;
      updateStartAvailability();
      throw error;
    }
  }

  async function startMedos() {
    const mode = selectedMode();
    if (!mode || !isCopyingMode(mode.id)) return begin("startMedos", {});
    const destination = selectedDestination();
    if (!destinationUsable(destination, mode.id)) {
      throw new Error("Choose a destination with enough free space.");
    }
    // The destination travels as the id the server issued, never as a path.
    return begin("install", {
      mode: mode.id,
      destination_id: destination.id,
      launch_after: true,
    });
  }

  async function control(action) {
    const snapshot = await request("control", { method: "POST", body: { action } });
    renderSnapshot(snapshot);
    return snapshot;
  }

  async function retryFailure() {
    return startMedos();
  }

  async function downloadDiagnostics() {
    const mode = selectedMode();
    return begin("diagnostics", { mode: mode ? mode.id : PORTABLE });
  }

  async function poll() {
    try {
      const snapshot = await request("status");
      renderSnapshot(snapshot);
    } catch (_error) {
      updateHeartbeat({ status: "running", control: "running" }, false);
    }
  }

  function startPolling() {
    if (state.pollTimer === null) state.pollTimer = window.setInterval(poll, 750);
  }

  function stopPolling() {
    if (state.pollTimer !== null) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    startMedos().catch((error) => {
      announce(error.message || "MedOS could not start.", true);
    });
  });
  function reportControlError(error) {
    announce(error.message || "The control was not acknowledged at a safe checkpoint.", true);
  }
  elements.pause.addEventListener("click", () => { control("pause").catch(reportControlError); });
  elements.resume.addEventListener("click", () => { control("resume").catch(reportControlError); });
  elements.cancel.addEventListener("click", () => { control("cancel").catch(reportControlError); });
  elements.retry.addEventListener("click", () => { retryFailure().catch(() => {}); });
  elements.diagnostics.addEventListener("click", () => { downloadDiagnostics().catch(() => {}); });
  elements.open.addEventListener("click", () => {
    const target = safeOpenUrl(state.result && state.result.open_url);
    if (target) window.open(target, "_blank", "noopener,noreferrer");
  });

  window.MedOSSetup = Object.freeze({
    connect,
    loadPlan,
    startMedos,
    control,
    retryFailure,
    downloadDiagnostics,
  });

  loadPlan().catch(() => {});
  connect().catch(() => {});
})();
