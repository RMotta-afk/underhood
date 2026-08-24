/**
 * Pure topology -> view-model conversion + Dagre layout (SDD §8: ALL layout
 * math happens client-side; the AI never computes coordinates).
 */
import dagre from "@dagrejs/dagre";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { GraphTopology, NodeType } from "@underhood/types";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 56;

/** Class container chrome around its member nodes. */
const GROUP_PADDING_X = 28;
const GROUP_PADDING_TOP = 52;
const GROUP_PADDING_BOTTOM = 28;

export const TYPE_STYLES: Record<NodeType, { label: string; className: string }> = {
  entry: { label: "Start", className: "border-emerald-500 bg-emerald-950/60" },
  process: { label: "Step", className: "border-sky-500 bg-sky-950/60" },
  io: { label: "Input/Output", className: "border-amber-500 bg-amber-950/60" },
  branch: { label: "Decision", className: "border-violet-500 bg-violet-950/60" },
  terminal: { label: "End", className: "border-rose-500 bg-rose-950/60" },
  class: { label: "Class", className: "border-teal-500 bg-teal-950/40" },
};

export interface TopologyView {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface GroupBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Convert a validated topology into positioned xyflow primitives. Nodes
 * carrying `parent` are enclosed by a class container box sized to fit the
 * laid-out members, so method workflows stay visibly anchored to their class. */
export function buildTopologyView(topology: GraphTopology): TopologyView {
  const knownIds = new Set(topology.nodes.map((n) => n.id));
  const parents = new Map<string, string>();
  for (const node of topology.nodes) {
    // Defensive: only trust parent links that resolve to real class nodes.
    if (
      node.parent &&
      node.type !== "class" &&
      topology.nodes.some((p) => p.id === node.parent && p.type === "class")
    ) {
      parents.set(node.id, node.parent);
    }
  }
  const classIds = new Set(
    topology.nodes.filter((n) => n.type === "class").map((n) => n.id)
  );
  const memberIds = new Set(parents.keys());

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 72 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of topology.nodes) {
    if (classIds.has(node.id)) continue; // containers are sized manually below
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of topology.edges) {
    // Defensive: dagre throws on dangling references; skip instead. Edges
    // into class containers are kept for rendering but not for ranking.
    if (!knownIds.has(edge.source) || !knownIds.has(edge.target)) continue;
    if (classIds.has(edge.source) || classIds.has(edge.target)) continue;
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of topology.nodes) {
    if (classIds.has(node.id)) continue;
    const laid = graph.node(node.id);
    if (laid) {
      // Center coordinates from dagre -> top-left for xyflow.
      positions.set(node.id, {
        x: laid.x - NODE_WIDTH / 2,
        y: laid.y - NODE_HEIGHT / 2,
      });
    }
  }

  // Size each class container to enclose its laid-out members.
  const groupBoxes = new Map<string, GroupBox>();
  for (const classId of classIds) {
    const members = [...memberIds].filter((id) => parents.get(id) === classId);
    const boxes = members
      .map((id) => positions.get(id))
      .filter((p): p is { x: number; y: number } => !!p);
    if (boxes.length === 0) continue;
    const minX = Math.min(...boxes.map((b) => b.x)) - GROUP_PADDING_X;
    const minY =
      Math.min(...boxes.map((b) => b.y)) - GROUP_PADDING_TOP;
    const maxX = Math.max(...boxes.map((b) => b.x)) + NODE_WIDTH + GROUP_PADDING_X;
    const maxY = Math.max(...boxes.map((b) => b.y)) + NODE_HEIGHT + GROUP_PADDING_BOTTOM;
    groupBoxes.set(classId, {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    });
  }

  // Containers first so member nodes (and their hover cards) layer above.
  const classNodes: FlowNode[] = topology.nodes
    .filter((n) => n.type === "class")
    .map((node) => {
      const box = groupBoxes.get(node.id);
      return {
        id: node.id,
        type: "classGroup",
        position: box ? { x: box.x, y: box.y } : { x: 0, y: 0 },
        draggable: false,
        selectable: false,
        style: box ? { width: box.width, height: box.height } : undefined,
        data: {
          label: node.label,
          plainDescription: node.plainDescription,
        },
      };
    });

  const nodes: FlowNode[] = [
    ...classNodes,
    ...topology.nodes
      .filter((n) => n.type !== "class")
      .map((node) => ({
        id: node.id,
        type: "codeStep",
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        zIndex: 1,
        data: {
          label: node.label,
          nodeType: node.type,
          plainDescription: node.plainDescription,
          parent: parents.has(node.id) ? node.label : undefined,
        },
      })),
  ];

  const edges: FlowEdge[] = topology.edges
    .filter((e) => knownIds.has(e.source) && knownIds.has(e.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: edge.animated,
      label: edge.label || undefined,
      zIndex: 1,
      style: { stroke: "#38bdf8", strokeWidth: 1.5 },
    }));

  return { nodes, edges };
}
