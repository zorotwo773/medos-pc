/** @typedef {"idle" | "success" | "failure"} LanCopyFeedback */

/**
 * @typedef {object} ClipboardWriter
 * @property {(text: string) => Promise<void>} writeText
 */

/**
 * Copy a LAN URL and report only if this is still the active mounted request.
 *
 * @param {string} lanUrl
 * @param {ClipboardWriter | null | undefined} clipboard
 * @param {(feedback: LanCopyFeedback) => void} setFeedback
 * @param {() => boolean} isActive
 * @returns {Promise<boolean>}
 */
export async function copyLanUrlToClipboard(lanUrl, clipboard, setFeedback, isActive) {
  if (!isActive()) return false;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    if (isActive()) setFeedback("failure");
    return false;
  }

  try {
    await clipboard.writeText(lanUrl);
  } catch {
    if (!isActive()) return false;
    setFeedback("failure");
    return false;
  }

  if (!isActive()) return false;
  setFeedback("success");
  return true;
}

/**
 * Build the exact production LAN status-bar subtree without depending on React.
 *
 * @template T
 * @param {(type: string, props: any, ...children: any[]) => T} createElement
 * @param {string | null} lanUrl
 * @param {LanCopyFeedback} feedback
 * @param {() => void} onCopy
 * @returns {T | null}
 */
export function createLanUrlStatusElement(createElement, lanUrl, feedback, onCopy) {
  if (!lanUrl) return null;

  const feedbackElement = feedback === "idle"
    ? null
    : createElement(
        "span",
        {
          className: "app-statusbar-lan-feedback",
          "data-kind": feedback,
          role: "status",
          "aria-live": "polite",
        },
        feedback === "success"
          ? "Network address copied."
          : "Copy failed. Select the network address and copy it manually.",
      );

  return createElement(
    "span",
    { className: "app-statusbar-lan-control" },
    createElement(
      "button",
      {
        type: "button",
        className: "app-statusbar-lan-url",
        "aria-label": "Copy network address",
        title: `Copy network address ${lanUrl}`,
        onClick: onCopy,
      },
      `Network: ${lanUrl}`,
    ),
    feedbackElement,
    createElement(
      "span",
      { className: "app-statusbar-lan-separator", "aria-hidden": "true" },
      "·",
    ),
  );
}
