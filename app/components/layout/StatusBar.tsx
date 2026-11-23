"use client";
import { createElement, useEffect, useRef, useState } from "react";
import { getBackendUrl } from "@/lib/api";
import {
  createNetworkAccessStatusController,
  NETWORK_ACCESS_ENDPOINT,
  networkAccessNeedsAttention,
  networkAccessStatusLabel,
  networkAccessUnavailableLabel,
  parseNetworkAccessState,
  type NetworkAccessState,
} from "@/lib/networkAccess";
import { copyLanUrlToClipboard, createLanUrlStatusElement } from "../../lib/statusBarLanUrl.mjs";

interface HealthData {
  lan_url: string | null;
  rag: boolean;
  chunks: number;
  nvidia_model: string | null;
  gemini: boolean;
  books: number;
  diseases: number;
  corpora: { utd: boolean; amboss: boolean; cliniccons?: boolean; harrisons?: boolean };
  models_available: string[];
}

type LanCopyFeedback = "idle" | "success" | "failure";

export default function StatusBar() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [networkAccess, setNetworkAccess] = useState<NetworkAccessState | null>(null);
  const [networkAccessUnavailable, setNetworkAccessUnavailable] = useState(false);
  const [lanCopyFeedback, setLanCopyFeedback] = useState<LanCopyFeedback>("idle");
  const mountedRef = useRef(false);
  const copyRequestRef = useRef(0);
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyRequestRef.current += 1;
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const endpoint = NETWORK_ACCESS_ENDPOINT;
    const controller = createNetworkAccessStatusController({
      endpoint,
      fetcher: fetch,
      onUpdate: update => {
        setNetworkAccess(update.state);
        setNetworkAccessUnavailable(update.unavailable);
      },
    });

    function onNetworkAccessState(event: Event) {
      try {
        const state = parseNetworkAccessState((event as CustomEvent<unknown>).detail);
        controller.accept(state);
      } catch {
        // Ignore untrusted or stale UI events; the guarded poll remains authoritative.
      }
    }

    void controller.refresh();
    window.addEventListener("medos:network-access-state", onNetworkAccessState);
    const id = window.setInterval(() => void controller.refresh(), 30_000);
    return () => {
      controller.stop();
      window.clearInterval(id);
      window.removeEventListener("medos:network-access-state", onNetworkAccessState);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch(`${getBackendUrl()}/health`, { cache: "no-store" });
        if (!r.ok) throw new Error("not ok");
        const d: HealthData = await r.json();
        if (!cancelled) {
          setHealth(d);
          setOnline(true);
          window.dispatchEvent(new CustomEvent("medos:backend-health", { detail: { online: true } }));
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
          setOnline(false);
          window.dispatchEvent(new CustomEvent("medos:backend-health", { detail: { online: false } }));
        }
      }
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    if (lanCopyFeedback !== "success") return;

    copyResetTimerRef.current = window.setTimeout(() => {
      copyResetTimerRef.current = null;
      if (mountedRef.current) setLanCopyFeedback("idle");
    }, 2_000);
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, [lanCopyFeedback]);

  const modelLabel = health?.nvidia_model
    ? health.nvidia_model.split("/").pop() ?? health.nvidia_model
    : health?.gemini ? "gemini-1.5-flash" : "no model";

  const corpusFlags = health ? [
    health.corpora.utd && "UTD",
    health.corpora.amboss && "AMBOSS",
    (health.corpora.cliniccons || health.corpora.harrisons) && "Cliniccons",
  ].filter(Boolean) : [];

  function handleCopyLanUrl() {
    if (!health?.lan_url) return;
    const request = ++copyRequestRef.current;
    void copyLanUrlToClipboard(
      health.lan_url,
      navigator.clipboard,
      setLanCopyFeedback,
      () => mountedRef.current && copyRequestRef.current === request,
    );
  }

  const lanUrlStatusElement = createLanUrlStatusElement(
    createElement,
    health?.lan_url ?? null,
    lanCopyFeedback,
    handleCopyLanUrl,
  );

  return (
    <div className="app-statusbar" style={{
      gridRow: 3,
      gridColumn: 2,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 20px",
      borderTop: "1px solid var(--border)",
      background: "var(--chrome-bg)",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      fontFamily: "var(--font-mono)",
      fontSize: 9,
      letterSpacing: "0.18em",
      textTransform: "uppercase",
      color: "var(--text-muted)",
      zIndex: 9,
    }}>
      <style>{`@media(max-width:640px){.app-statusbar{display:none!important}}`}</style>
      <div className="app-statusbar-primary" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          display: "inline-block",
          width: 5, height: 5,
          borderRadius: "50%",
          background: online === null ? "var(--amber)" : online ? "var(--accent)" : "var(--red)",
          boxShadow: online ? "0 0 5px var(--accent)" : "none",
          flexShrink: 0,
          transition: "background .4s",
        }} />
        {online === null ? "connecting…" : online ? "backend online" : "backend offline"}

        {online && health && (
          <>
            <span style={{ color: "var(--text-muted)" }}>·</span>
            {health.rag ? "RAG ready" : "RAG offline"}

            {health.chunks > 0 && (
              <>
                <span style={{ color: "var(--text-muted)" }}>·</span>
                {health.chunks.toLocaleString()} chunks
              </>
            )}

            {corpusFlags.length > 0 && (
              <>
                <span style={{ color: "var(--text-muted)" }}>·</span>
                {corpusFlags.join(" · ")}
              </>
            )}
          </>
        )}
      </div>

      <div className="app-statusbar-secondary" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {lanUrlStatusElement}
        {(networkAccess || networkAccessUnavailable) && (
          <>
            <span
              className="app-statusbar-network-access"
              data-kind={networkAccessUnavailable || !networkAccess || networkAccessNeedsAttention(networkAccess) ? "attention" : networkAccess.effective.allow_public ? "public" : "private"}
              role="status"
              aria-live="polite"
              title="Effective network access policy"
            >
              {networkAccessUnavailable
                ? networkAccessUnavailableLabel(networkAccess)
                : networkAccess && networkAccessStatusLabel(networkAccess)}
            </span>
            <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>·</span>
          </>
        )}
        {online && health ? (
          <>
            {modelLabel}
            {health.books > 0 && (
              <>
                <span style={{ color: "var(--text-muted)" }}>·</span>
                {health.books} {health.books === 1 ? "book" : "books"}
              </>
            )}
            {health.diseases > 0 && (
              <>
                <span style={{ color: "var(--text-muted)" }}>·</span>
                {health.diseases} diseases
              </>
            )}
          </>
        ) : (
          <span style={{ opacity: 0.5 }}>offline mode</span>
        )}
      </div>
    </div>
  );
}
