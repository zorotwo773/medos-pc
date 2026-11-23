"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MarkerType,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  ReactFlowProvider,
  useReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import type { PathwayGraph } from "@/lib/pathways/types";
import { M } from "./ui";

const nodeWidth = 260;
const nodeHeight = 100;

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = "TB") => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, ranksep: 160, nodesep: 80 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const newNode = { ...node };
    newNode.targetPosition = direction === "LR" ? Position.Left : Position.Top;
    newNode.sourcePosition = direction === "LR" ? Position.Right : Position.Bottom;
    // We are shifting the dagre node position (anchor=center center) to the top left
    // so it matches the React Flow node anchor point (top left).
    newNode.position = {
      x: nodeWithPosition.x - nodeWidth / 2,
      y: nodeWithPosition.y - nodeHeight / 2,
    };
    return newNode;
  });

  return { nodes: newNodes, edges };
};

// Custom Node to render pathway steps
function PathwayNode({ data }: { data: any }) {
  const { node, isActive, isTraveled, accent } = data;
  const isOutcome = node.kind === "outcome";

  let borderColor = isTraveled ? accent : "var(--border)";
  if (isActive) borderColor = accent;

  return (
    <div
      style={{
        width: nodeWidth,
        minHeight: nodeHeight,
        background: isActive ? `color-mix(in srgb, ${accent} 10%, var(--bg-card))` : "var(--bg-card)",
        border: `2px solid ${borderColor}`,
        borderRadius: 8,
        padding: "10px 12px",
        boxShadow: isActive ? `0 0 0 4px color-mix(in srgb, ${accent} 20%, transparent)` : "0 1px 2px rgba(0,0,0,0.05)",
        opacity: isTraveled || isActive ? 1 : 0.6,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      <Handle type="target" position={data.direction === "LR" ? Position.Left : Position.Top} style={{ opacity: 0 }} />

      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <M
          name={isOutcome ? "flag" : node.kind === "decision" ? "help" : "arrow_forward"}
          size={16}
          style={{ color: (isActive || isTraveled) ? accent : "var(--text-muted)", marginTop: 2, flexShrink: 0 }}
        />
        <div style={{ fontSize: 13, fontWeight: (isActive || isTraveled) ? 600 : 500, color: (isActive || isTraveled) ? "var(--text-primary)" : "var(--text-secondary)", lineHeight: 1.3 }}>
          {node.title}
        </div>
      </div>

      <Handle type="source" position={data.direction === "LR" ? Position.Right : Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = {
  pathwayNode: PathwayNode,
};

function FlowInner({
  graph,
  path,
  accent,
  onNodeClick
}: {
  graph: PathwayGraph;
  path: string[];
  accent: string;
  onNodeClick: (id: string) => void;
}) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    const initialNodes: Node[] = [];
    const initialEdges: Edge[] = [];
    const activeId = path[path.length - 1];

    const traveledSet = new Set(path);
    const visibleNodes = new Set(path); // include traveled path

    // Reveal all possible choices for PREVIOUS steps, but keep the NEXT steps hidden
    const alternateNodes = new Set<string>();
    path.forEach((id) => {
      if (id !== activeId) {
        const node = graph.nodes[id];
        if (node) {
          node.branches.forEach(b => {
            visibleNodes.add(b.to);
            if (!traveledSet.has(b.to)) {
              alternateNodes.add(b.to);
            }
          });
        }
      }
    });

    // To prevent unchosen paths from looking like dead ends (and to fix Dagre layout overlaps),
    // reveal the immediate next steps of those alternate paths too.
    alternateNodes.forEach(altId => {
      const node = graph.nodes[altId];
      if (node) {
        node.branches.forEach(b => visibleNodes.add(b.to));
      }
    });

    Object.entries(graph.nodes).forEach(([id, node]) => {
      if (!visibleNodes.has(id)) return;

      const isActive = id === activeId;
      const isTraveled = traveledSet.has(id);

      initialNodes.push({
        id,
        type: "pathwayNode",
        position: { x: 0, y: 0 },
        data: { node, isActive, isTraveled, accent, direction: "TB" },
      });

      node.branches.forEach((b) => {
        if (!visibleNodes.has(b.to)) return;

        const edgeTraveled = traveledSet.has(id) && traveledSet.has(b.to) && path.indexOf(id) < path.indexOf(b.to);
        initialEdges.push({
          id: `${id}->${b.to}`,
          source: id,
          target: b.to,
          label: b.label || "",
          animated: edgeTraveled && !isActive, // slightly animate the traveled path
          style: {
            strokeWidth: edgeTraveled ? 2.5 : 1,
            stroke: edgeTraveled ? accent : "var(--border)",
            opacity: edgeTraveled ? 1 : 0.4
          },
          labelStyle: { fill: "var(--text-secondary)", fontWeight: 500, fontSize: 11 },
          labelBgStyle: { fill: "var(--bg-base)", fillOpacity: 0.8 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: edgeTraveled ? accent : "var(--border)",
          },
        });
      });
    });

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(initialNodes, initialEdges, "TB");
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);

    // Give it a tick to render then fit view, optionally center on active
    setTimeout(() => {
      fitView({ padding: 0.2, duration: 800 });
    }, 50);
  }, [graph, path, accent, setNodes, setEdges, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onNodeClick(node.id)}
      fitView
      minZoom={0.2}
      maxZoom={2}
      panOnScroll={true}
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="var(--border)" gap={20} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export default function PathwayFlow(props: {
  graph: PathwayGraph;
  path: string[];
  accent: string;
  onNodeClick: (id: string) => void;
}) {
  return (
    <div style={{ width: "100%", height: "100%", background: "var(--bg-base)" }}>
      <ReactFlowProvider>
        <FlowInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
