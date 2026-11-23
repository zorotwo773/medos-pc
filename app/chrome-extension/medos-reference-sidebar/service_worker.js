const LAST_REFERENCE_KEY = "medos:lastReference";
const API_BASE = "http://127.0.0.1:8002";
const API_ORIGIN = new URL(API_BASE).origin;
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

// All backend traffic from content scripts is proxied through here. A fetch made
// directly from a page's context is treated as that PAGE talking to the local
// network, so Chrome 138+ shows a "wants to access devices on your local network"
// permission prompt on every site, and the backend's CORS allowlist (localhost
// only) rejects the response anyway. The service worker runs on the extension
// origin with host permission for 127.0.0.1:8002 — no prompt, no CORS.
function resolveApiUrl(path) {
  const url = new URL(path, API_BASE);
  if (url.origin !== API_ORIGIN) {
    throw new Error("Blocked non-MedOS URL");
  }
  return url.toString();
}

async function apiJson(path, options = {}) {
  const init = { method: options.method || "GET", cache: "no-store" };
  if (options.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(resolveApiUrl(path), init);
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  return { ok: true, status: response.status, data: await response.json() };
}

async function apiDataUrl(path) {
  const response = await fetch(resolveApiUrl(path), { cache: "no-store" });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_MEDIA_BYTES) {
    return { ok: false, status: 413 };
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const contentType = response.headers.get("content-type") || "image/png";
  return { ok: true, status: response.status, dataUrl: `data:${contentType};base64,${btoa(binary)}` };
}

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || !chrome.sidePanel) {
    return;
  }
  await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

function setLastReference(payload) {
  const record = {
    ...payload,
    updatedAt: Date.now(),
  };
  return chrome.storage.session.set({ [LAST_REFERENCE_KEY]: record });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "MEDOS_API_JSON") {
    apiJson(message.path || "", message.options || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, status: 0, error: String(error) }));
    return true;
  }

  if (message.type === "MEDOS_API_DATAURL") {
    apiDataUrl(message.path || "")
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, status: 0, error: String(error) }));
    return true;
  }

  if (message.type === "MEDOS_OPEN_REFERENCE") {
    const tabId = sender && sender.tab && sender.tab.id;
    const payload = message.payload || {};
    if (tabId && chrome.sidePanel) {
      chrome.sidePanel.open({ tabId }).catch(() => {});
    }
    setLastReference(payload)
      .then(() => {
        chrome.runtime.sendMessage({ type: "MEDOS_REFERENCE_SELECTED", payload }).catch(() => {});
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "MEDOS_SELECTION_CHANGED") {
    const payload = message.payload || {};
    chrome.storage.session.set({ "medos:lastSelection": { ...payload, updatedAt: Date.now() } })
      .then(() => {
        chrome.runtime.sendMessage({ type: "MEDOS_SELECTION_CHANGED", payload }).catch(() => {});
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});
