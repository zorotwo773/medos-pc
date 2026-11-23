/**
 * A browser must never navigate to 0.0.0.0. It is a server bind address, not a
 * usable destination. Older macOS launchers exposed it and relative Q-bank links
 * then failed with an address-invalid page. Run this before React navigation.
 */
export const canonicalLoopbackScript = `
(() => {
  try {
    if (window.location.hostname !== "0.0.0.0") return;
    const target = new URL(window.location.href);
    target.hostname = "127.0.0.1";
    window.location.replace(target.toString());
  } catch {}
})();
`;
