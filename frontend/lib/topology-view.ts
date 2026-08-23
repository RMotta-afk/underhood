/**
 * Pure topology -> view-model conversion + Dagre layout (SDD §8: ALL layout
 * math happens client-side; the AI never computes coordinates).
 */
import dagre from "@dagrejs/dagre";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { GraphTopology, NodeType } from "@underhood/types";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 56;

export const TYPE_STYLES: Record<NodeType, { label: string; className: string }> = {
  entry: { label: "Start", className: "border-emerald-500 bg-emerald-950/60" },
  process: { label: "Step", className: "border-sky-500 bg-sky-950/60" },
  io: { label: "Input/Output", className: "border-amber-500 bg-amber-950/60" },
  branch: { label: "Decision", className: "border-violet-500 bg-violet-950/60" },
  terminal: { label: "End", className: "border-rose-500 bg-rose-950/60" },
};

export interface TopologyView {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** Convert a validated topology into positioned xyflow primitives. */
export function buildTopologyView(topology: GraphTopology): TopologyView {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 72 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of topology.nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of topology.edges) {
    // Defensive: dagre throws on dangling references; skip instead.
    if (
      topology.nodes.some((n) => n.id === edge.source) &&
      topology.nodes.some((n) => n.id === edge.target)
    ) {
      graph.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(graph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of topology.nodes) {
    const laid = graph.node(node.id);
    if (laid) {
      // Center coordinates from dagre -> top-left for xyflow.
      positions.set(node.id, {
        x: laid.x - NODE_WIDTH / 2,
        y: laid.y - NODE_HEIGHT / 2,
      });
    }
  }

  const nodes: FlowNode[] = topology.nodes.map((node) => ({
    id: node.id,
    type: "codeStep",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: {
      label: node.label,
      nodeType: node.type,
      plainDescription: node.plainDescription,
    },
  }));

  const edges: FlowEdge[] = topology.edges
    .filter(
      (e) =>
        topology.nodes.some((n) => n.id === e.source) &&
        topology.nodes.some((n) => n.id === e.target)
    )
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: edge.animated,
      label: edge.label || undefined,
      style: { stroke: "#38bdf8", strokeWidth: 1.5 },
    }));

  return { nodes, edges };
}
