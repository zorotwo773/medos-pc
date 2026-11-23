"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlertCircle, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { getBackendUrl } from "@/lib/api";

interface GraphNode {
  cui: string;
  preferred_name: string;
  semantic_group?: string;
  href?: string;
  is_center?: boolean;
}

interface GraphEdge {
  source_cui: string;
  target_cui: string;
  label?: string;
}

interface GraphPayload {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: GraphPayload };

const GRAPH_TIMEOUT_MS = 12_000;

export default function SearchConceptGraph({ cui }: { cui: string }) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GRAPH_TIMEOUT_MS);
    setLoad({ status: "loading" });
    fetch(`${getBackendUrl()}/umls/concept/${encodeURIComponent(cui)}/causal-graph?limit=18&depth=2`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Graph request failed (${response.status})`);
        return await response.json() as GraphPayload;
      })
      .then((data) => {
        if (active) setLoad({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (!controller.signal.aborted) {
          setLoad({ status: "error", message: error instanceof Error ? error.message : "Concept graph is unavailable." });
        } else if (timedOut) {
          setLoad({ status: "error", message: "Concept graph timed out." });
        }
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt, cui]);

  const graph = useMemo(() => {
    if (load.status !== "ready") return { nodes: [] as Node[], edges: [] as Edge[] };
    const rawNodes = load.data.nodes || [];
    const radius = 230;
    const nodes: Node[] = rawNodes.map((node, index) => {
      const center = node.is_center || index === 0;
      const angle = ((Math.PI * 2) / Math.max(1, rawNodes.length - 1)) * Math.max(0, index - 1);
      return {
        id: node.cui,
        position: center ? { x: 300, y: 190 } : { x: 300 + Math.cos(angle) * radius, y: 190 + Math.sin(angle) * radius },
        data: { label: node.preferred_name || node.cui },
        draggable: false,
        style: {
          border: center ? "2px solid var(--mod-concepts)" : "1px solid var(--border-strong)",
          borderRadius: 9,
          background: "var(--bg-card)",
          color: "var(--text-primary)",
          fontSize: 11,
          fontWeight: center ? 750 : 600,
          width: center ? 170 : 145,
        },
      };
    });
    const edges: Edge[] = (load.data.edges || []).map((edge, index) => ({
      id: `${edge.source_cui}:${edge.target_cui}:${index}`,
      source: edge.source_cui,
      target: edge.target_cui,
      label: edge.label,
      style: { stroke: "var(--border-strong)" },
      labelStyle: { fill: "var(--text-muted)", fontSize: 9 },
    }));
    return { nodes, edges };
  }, [load]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return (
    <section className="search-enrichment-card search-concept-graph" aria-labelledby="search-concept-graph-title">
      <header>
        <GitBranch size={18} aria-hidden="true" />
        <div>
          <h2 id="search-concept-graph-title">Concept relationships</h2>
          <p>Bounded causal context for {cui}</p>
        </div>
      </header>
      {load.status === "loading" && (
        <div className="search-enrichment-state" role="status" aria-live="polite">
          <Loader2 className="search-results-spin" size={22} />
          Loading concept relationships…
        </div>
      )}
      {load.status === "error" && (
        <div className="search-enrichment-state is-error" role="status" aria-live="polite">
          <AlertCircle size={22} />
          <span>{load.message}</span>
          <button type="button" onClick={retry}><RefreshCw size={15} /> Retry</button>
        </div>
      )}
      {load.status === "ready" && graph.nodes.length === 0 && (
        <div className="search-enrichment-state" role="status">No bounded relationship data is available for this concept.</div>
      )}
      {load.status === "ready" && graph.nodes.length > 0 && (
        <div className="search-concept-graph-canvas" role="status" aria-label={`${graph.nodes.length} concept nodes loaded`}>
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            fitView
            fitViewOptions={{ padding: 0.22 }}
            minZoom={0.35}
            maxZoom={1.7}
            nodesConnectable={false}
            nodesDraggable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--border)" gap={22} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </section>
  );
}
