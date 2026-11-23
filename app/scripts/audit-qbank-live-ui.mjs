import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const repoRoot = resolve(appRoot, "..");
const artifactsDir = resolve(repoRoot, ".codex-run");
mkdirSync(artifactsDir, { recursive: true });

const targetUrl = process.argv[2] || process.env.QBANK_AUDIT_URL || "http://127.0.0.1:3000/qbank";
const auditUsername = process.env.MEDOS_AUDIT_USERNAME || process.env.MEDOS_USERNAME || "admin";
const auditPasswordCandidates = [
  process.env.MEDOS_AUDIT_PASSWORD,
  process.env.MEDOS_ADMIN_PASSWORD,
  "NYC@727264",
].filter((value, index, values) => value && values.indexOf(value) === index);
const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const browserPath = chromeCandidates.find(candidate => existsSync(candidate));
if (!browserPath) {
  throw new Error("Chrome or Edge was not found. Set CHROME_PATH to run the live QBank audit.");
}
if (typeof WebSocket !== "function") {
  throw new Error("This Node runtime does not expose WebSocket; use Node 22+ or newer.");
}

const report = {
  targetUrl,
  browserPath,
  startedAt: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  pageErrors: [],
  warnings: [],
  screenshots: [],
  auth: { attempted: false, username: auditUsername, success: false },
};

function addCheck(name, passed, detail = "") {
  report.checks.push({ name, passed: Boolean(passed), detail });
  if (!passed) console.error(`FAIL: ${name}${detail ? ` - ${detail}` : ""}`);
  else console.log(`PASS: ${name}${detail ? ` - ${detail}` : ""}`);
}

function addWarning(name, detail = "") {
  report.warnings.push({ name, detail });
  console.warn(`WARN: ${name}${detail ? ` - ${detail}` : ""}`);
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = [];
    ws.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message || "CDP error"} (${message.error.code || "unknown"})`));
        else done(message.result || {});
        return;
      }
      for (const handler of this.eventHandlers) handler(message);
    });
  }

  static connect(url) {
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => rejectConnect(new Error("Timed out connecting to Chrome DevTools")), 15000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolveConnect(new CdpClient(ws));
      }, { once: true });
      ws.addEventListener("error", event => {
        clearTimeout(timer);
        rejectConnect(new Error(`Chrome DevTools websocket failed: ${event.message || "unknown error"}`));
      }, { once: true });
    });
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
  }

  waitForEvent(methods, timeoutMs = 60000) {
    const wanted = new Set(Array.isArray(methods) ? methods : [methods]);
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        this.eventHandlers = this.eventHandlers.filter(handler => handler !== handlerFn);
        rejectEvent(new Error(`Timed out waiting for event ${Array.from(wanted).join(", ")}`));
      }, timeoutMs);
      const handlerFn = message => {
        if (!wanted.has(message.method)) return;
        clearTimeout(timer);
        this.eventHandlers = this.eventHandlers.filter(handler => handler !== handlerFn);
        resolveEvent(message);
      };
      this.eventHandlers.push(handlerFn);
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer });
      this.ws.send(payload);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // best effort
    }
  }
}

async function waitForJson(url, timeoutMs = 15000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out fetching ${url}`);
}

function cookieHeaderList(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function sameSiteValue(rawCookie) {
  const match = /;\s*samesite=(strict|lax|none)/i.exec(rawCookie);
  if (!match) return undefined;
  const value = match[1].toLowerCase();
  if (value === "strict") return "Strict";
  if (value === "none") return "None";
  return "Lax";
}

async function setBrowserCookieFromHeader(client, originUrl, rawCookie) {
  const [pair] = rawCookie.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return false;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  const params = {
    url: originUrl,
    name,
    value,
    path: (/;\s*path=([^;]+)/i.exec(rawCookie)?.[1] || "/").trim(),
    httpOnly: /;\s*httponly/i.test(rawCookie),
    secure: /;\s*secure/i.test(rawCookie),
  };
  const sameSite = sameSiteValue(rawCookie);
  if (sameSite) params.sameSite = sameSite;
  const result = await client.send("Network.setCookie", params);
  return Boolean(result.success);
}

async function loginForAudit(client, pageUrl) {
  report.auth.attempted = true;
  const origin = new URL(pageUrl).origin;
  const loginUrl = `${origin}/api/auth/login`;
  if (!auditPasswordCandidates.length) {
    addWarning("auth login skipped", "No MEDOS_AUDIT_PASSWORD, MEDOS_ADMIN_PASSWORD, or default password candidate was available");
    return false;
  }
  for (const password of auditPasswordCandidates) {
    const response = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: auditUsername, password }),
      redirect: "manual",
    }).catch(error => ({ ok: false, status: 0, error }));
    if (!response.ok) continue;
    const cookies = cookieHeaderList(response.headers);
    let cookieSet = false;
    for (const cookie of cookies) {
      cookieSet = (await setBrowserCookieFromHeader(client, origin, cookie)) || cookieSet;
    }
    if (cookieSet) {
      report.auth.success = true;
      return true;
    }
  }
  addWarning("auth login failed", `Tried ${auditPasswordCandidates.length} password candidate(s) for ${auditUsername}`);
  return false;
}

async function evaluate(client, expression, options = {}) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: Boolean(options.userGesture),
  }, options.timeoutMs || 60000);
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed";
    throw new Error(message);
  }
  return result.result?.value;
}

async function setViewport(client, width, height, mobile = false) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    mobile,
    deviceScaleFactor: 1,
    screenWidth: width,
    screenHeight: height,
  });
  if (mobile) await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  else await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

async function waitForText(client, needles, timeoutMs = 20000) {
  const wanted = Array.isArray(needles) ? needles : [needles];
  const start = Date.now();
  let lastText = "";
  while (Date.now() - start < timeoutMs) {
    lastText = await evaluate(client, "document.body ? document.body.innerText : ''");
    if (wanted.every(needle => lastText.toLowerCase().includes(String(needle).toLowerCase()))) return lastText;
    await sleep(350);
  }
  throw new Error(`Timed out waiting for text: ${wanted.join(", ")}. Last text: ${lastText.slice(0, 300)}`);
}

async function navigate(client, url) {
  const load = client.waitForEvent(["Page.loadEventFired", "Page.frameStoppedLoading"], 90000).catch(error => {
    addWarning("page load event wait timed out", error.message || String(error));
    return null;
  });
  await client.send("Page.navigate", { url });
  await load;
  await waitForText(client, ["Build", "UWorld"], 25000);
  await sleep(700);
}

async function screenshot(client, name) {
  const file = join(artifactsDir, `${name}.png`);
  try {
    await client.send("Page.bringToFront", {});
    const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }, 45000);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    report.screenshots.push(file);
    console.log(`SCREENSHOT: ${file}`);
  } catch (error) {
    addWarning(`screenshot failed: ${name}`, error.message || String(error));
  }
}

function clickByTextExpression(text) {
  return `(() => {
    const needle = ${JSON.stringify(text)}.toLowerCase();
    const selector = "button,a,[role='button'],label,summary";
    const candidates = Array.from(document.querySelectorAll(selector)).filter(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const exact = candidates.find(el => (el.innerText || el.textContent || "").trim().toLowerCase() === needle);
    const partial = candidates.find(el => (el.innerText || el.textContent || "").toLowerCase().includes(needle));
    const el = exact || partial;
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return true;
  })()`;
}

async function clickByText(client, text) {
  return evaluate(client, clickByTextExpression(text), { userGesture: true });
}

async function collectLayoutMetrics(client) {
  return evaluate(client, `(() => {
    const doc = document.documentElement;
    const viewportW = doc.clientWidth;
    const viewportH = doc.clientHeight;
    const overflowingElements = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (el.closest(".qbank-rich-html table, .qbank-answer-matrix, pre, code")) continue;
      if (rect.right > viewportW + 3 || rect.left < -3) {
        overflowingElements.push({
          tag: el.tagName.toLowerCase(),
          className: String(el.className || "").slice(0, 120),
          text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 90),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        });
        if (overflowingElements.length >= 15) break;
      }
    }
    const clippedControls = Array.from(document.querySelectorAll("button,[role='button'],.qbank-source-switch button,.qbank-session-main"))
      .filter(el => el.scrollWidth > el.clientWidth + 3 || el.scrollHeight > el.clientHeight + 3)
      .slice(0, 15)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        className: String(el.className || "").slice(0, 120),
        text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 90),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      }));
    return {
      viewportW,
      viewportH,
      scrollW: doc.scrollWidth,
      scrollH: doc.scrollHeight,
      overflowingElements,
      clippedControls
    };
  })()`);
}

async function assertNoCriticalLayoutOverflow(client, name) {
  const metrics = await collectLayoutMetrics(client);
  const noHorizontalDocOverflow = metrics.scrollW <= metrics.viewportW + 8;
  addCheck(`${name}: no document horizontal overflow`, noHorizontalDocOverflow, `${metrics.scrollW}/${metrics.viewportW}`);
  if (metrics.overflowingElements.length) {
    addWarning(`${name}: elements extend outside viewport`, JSON.stringify(metrics.overflowingElements.slice(0, 5)));
  }
  if (metrics.clippedControls.length) {
    addWarning(`${name}: clipped controls/text candidates`, JSON.stringify(metrics.clippedControls.slice(0, 5)));
  }
  return metrics;
}

function appErrorExpression() {
  return `(() => {
    const text = document.body ? document.body.innerText : "";
    return /Unhandled Runtime Error|Application error|Hydration failed|Module not found|TypeError:|ReferenceError:/i.test(text);
  })()`;
}

async function assertNoAppError(client, name) {
  const hasError = await evaluate(client, appErrorExpression());
  addCheck(`${name}: no visible app error`, !hasError);
}

async function main() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profileDir = join(artifactsDir, `chrome-qbank-profile-${Date.now()}`);
  const browser = spawn(browserPath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-features=Translate,AutofillServerCommunication",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  let client;
  try {
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find(item => item.type === "page") || targets[0];
    if (!target?.webSocketDebuggerUrl) throw new Error("No Chrome page target was available");
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    client.onEvent(message => {
      if (message.method === "Runtime.exceptionThrown") {
        report.pageErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params?.type)) {
        report.consoleErrors.push((message.params.args || []).map(arg => arg.value || arg.description || arg.type).join(" "));
      }
      if (message.method === "Log.entryAdded" && ["error"].includes(message.params?.entry?.level)) {
        report.consoleErrors.push(message.params.entry.text);
      }
    });
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Log.enable");
    await client.send("Network.enable");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
    const loggedIn = await loginForAudit(client, targetUrl);
    addCheck("audit browser authenticated through app login route", loggedIn);

    await setViewport(client, 1440, 940, false);
    await navigate(client, targetUrl);
    const initialText = await waitForText(client, ["Build", "Review"], 25000);
    addCheck("builder loads workspace shell", /Build/i.test(initialText) && /Review/i.test(initialText));
    addCheck("source switch exposes UWorld and AMBOSS", /UWorld/i.test(initialText) && /AMBOSS/i.test(initialText));
    await assertNoAppError(client, "builder desktop");
    await screenshot(client, "qbank-builder-desktop");
    await assertNoCriticalLayoutOverflow(client, "builder desktop");

    addCheck("can select AMBOSS workflow", await clickByText(client, "AMBOSS"));
    await waitForText(client, ["AMBOSS custom session"], 15000);
    await screenshot(client, "qbank-amboss-builder-desktop");
    await assertNoCriticalLayoutOverflow(client, "amboss builder desktop");

    addCheck("can return to UWorld workflow", await clickByText(client, "UWorld"));
    await waitForText(client, ["Subjects and foundations"], 15000);
    addCheck("UWorld workflow exposes subjects/foundations", true);

    addCheck("can open Review tab", await clickByText(client, "Review"));
    const reviewText = await waitForText(client, ["Q-bank performance", "Past tests", "Progression breakdown"], 15000);
    addCheck("review page focuses qbank stats", /Q-bank performance/i.test(reviewText) && /Progression breakdown/i.test(reviewText));
    await screenshot(client, "qbank-review-desktop");
    await assertNoCriticalLayoutOverflow(client, "review desktop");

    addCheck("can return to Build tab", await clickByText(client, "Build"));
    await waitForText(client, ["Build a block"], 15000);
    addCheck("can open Browse Questions", await clickByText(client, "Browse"));
    await waitForText(client, ["Browse Questions"], 20000);
    await screenshot(client, "qbank-browse-desktop");
    await assertNoCriticalLayoutOverflow(client, "browse desktop");

    const deepUrl = new URL(targetUrl);
    deepUrl.search = "?db=amboss1&qid=1";
    await client.send("Page.navigate", { url: deepUrl.toString() });
    await waitForText(client, ["QID 1", "AMBOSS"], 25000);
    await sleep(900);
    const readerText = await evaluate(client, "document.body ? document.body.innerText : ''");
    addCheck("AMBOSS qid deep link stays on AMBOSS bank", /AMBOSS Step 1/i.test(readerText), readerText.slice(0, 180));
    addCheck("AMBOSS qid deep link does not fall back to UWorld Step 2", !/UWorld STEP 2/i.test(readerText));
    const choiceCount = await evaluate(client, `document.querySelectorAll(".qbank-tutor-choice,.qbank-answer-matrix-row,.qbank-exam-choice").length`);
    addCheck("reader exposes clickable answer choices", choiceCount > 0, `${choiceCount} choices`);
    const underlineState = await evaluate(client, `(() => {
      const nodes = Array.from(document.querySelectorAll(".qbank-rich-html .selected,.qbank-exam-html .selected,.qbank-exam-choice-content .selected,.qbank-answer-matrix .selected"));
      return {
        count: nodes.length,
        underlined: nodes.filter(node => getComputedStyle(node).textDecorationLine.includes("underline")).length,
        sample: nodes.slice(0, 4).map(node => (node.textContent || "").trim().slice(0, 60))
      };
    })()`);
    addCheck("selected source spans are present", underlineState.count > 0, JSON.stringify(underlineState));
    addCheck("selected source spans render as underlined", underlineState.underlined > 0, JSON.stringify(underlineState));
    await screenshot(client, "qbank-amboss-qid-reader-desktop");
    await assertNoCriticalLayoutOverflow(client, "amboss reader desktop");

    const clickedChoice = await evaluate(client, `(() => {
      const el = document.querySelector(".qbank-tutor-choice,.qbank-answer-matrix-row-tutor,.qbank-answer-matrix-row,.qbank-exam-choice");
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return true;
    })()`, { userGesture: true });
    addCheck("reader choice click succeeds", clickedChoice);
    await waitForText(client, ["time spent"], 12000);
    const answeredText = await evaluate(client, "document.body ? document.body.innerText : ''");
    addCheck("answered question shows correctness feedback", /Correct\\.|Incorrect\\./i.test(answeredText));
    addCheck("answered question shows time spent seconds", /\\b\\d+\\s*(sec|min)\\b[\\s\\S]{0,30}time spent/i.test(answeredText), answeredText.match(/.{0,40}time spent.{0,40}/i)?.[0] || "");
    await screenshot(client, "qbank-amboss-qid-answered-desktop");

    await setViewport(client, 390, 844, true);
    await client.send("Page.navigate", { url: deepUrl.toString() });
    await waitForText(client, ["QID 1", "AMBOSS"], 25000);
    await sleep(900);
    await screenshot(client, "qbank-amboss-qid-mobile");
    await assertNoCriticalLayoutOverflow(client, "amboss reader mobile");

    const keyboardResult = await evaluate(client, `(() => {
      const before = document.body.innerText;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
      return { before: before.length, after: document.body.innerText.length };
    })()`, { userGesture: true });
    addCheck("keyboard shortcut dispatch does not crash reader", keyboardResult.after >= keyboardResult.before);

    const criticalConsoleErrors = report.consoleErrors
      .filter(Boolean)
      .filter(text => !/favicon|ResizeObserver loop completed|Failed to load resource: the server responded with a status of 404/i.test(text));
    addCheck("no critical browser console errors", criticalConsoleErrors.length === 0, criticalConsoleErrors.slice(0, 5).join(" | "));
    addCheck("no page runtime exceptions", report.pageErrors.length === 0, report.pageErrors.slice(0, 5).join(" | "));
  } finally {
    report.finishedAt = new Date().toISOString();
    const reportPath = join(artifactsDir, "qbank-live-audit.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`REPORT: ${reportPath}`);
    if (client) client.close();
    browser.kill();
  }

  const failed = report.checks.filter(check => !check.passed);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  report.finishedAt = new Date().toISOString();
  report.fatal = error.stack || error.message || String(error);
  const reportPath = join(artifactsDir, "qbank-live-audit.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(error);
  console.log(`REPORT: ${reportPath}`);
  process.exit(1);
});
