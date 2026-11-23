/**
 * RouteFallback — the standard Suspense fallback for heavy route components.
 *
 * Replaces the bare unstyled `<div>Loading...</div>` that several routes used,
 * giving a centered, branded spinner that fills the content area so navigation
 * into a large client component (QuizEngine, CalculatorHub, the 3D atlas, etc.)
 * shows consistent, non-janky feedback while its chunk loads. Server-component
 * safe (no hooks), so it can be used directly in a page's <Suspense fallback>.
 */
export default function RouteFallback({ label = "Loading" }: { label?: string }) {
  return (
    <div
      style={{
        flex: 1,
        width: "100%",
        minHeight: 240,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-base)",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div className="loader" style={{ width: 30, height: 30, margin: "0 auto 12px" }} />
        <p style={{ fontSize: 13, color: "var(--text-muted)", letterSpacing: "0.04em" }}>{label}…</p>
      </div>
    </div>
  );
}
