/**
 * Pure topology -> view-model conversion + Dagre layout (SDD §8: ALL layout
 * math happens client-side; the AI never computes coordinates).
 */
import dagre from "@dagrejs/dagre";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { GraphTopology, NodeType } from "@underhood/types";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 56;
export const CLASS_GAP = 64; // Minimum gap between class boxes

/** Class container chrome around its member nodes. */
const GROUP_PADDING_X = 48;
const GROUP_PADDING_TOP = 64;
const GROUP_PADDING_BOTTOM = 48;

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

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 100 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of topology.nodes) {
    if (classIds.has(node.id)) continue;
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of topology.edges) {
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
      positions.set(node.id, {
        x: laid.x - NODE_WIDTH / 2,
        y: laid.y - NODE_HEIGHT / 2,
      });
    }
  }

  // Size and separate each class container.
  const groupBoxes = new Map<string, GroupBox>();
  const classList = [...classIds];
  
  for (const classId of classList) {
    const members = [...parents.entries()].filter(([, pId]) => pId === classId).map(([id]) => id);
    const boxes = members
      .map((id) => positions.get(id))
      .filter((p): p is { x: number; y: number } => !!p);
    
    if (boxes.length === 0) continue;
    const minX = Math.min(...boxes.map((b) => b.x)) - GROUP_PADDING_X;
    const minY = Math.min(...boxes.map((b) => b.y)) - GROUP_PADDING_TOP;
    const maxX = Math.max(...boxes.map((b) => b.x)) + NODE_WIDTH + GROUP_PADDING_X;
    const maxY = Math.max(...boxes.map((b) => b.y)) + NODE_HEIGHT + GROUP_PADDING_BOTTOM;
    const width = maxX - minX;
    const height = maxY - minY;

    // Simple separation: shift right when this box would overlap another within CLASS_GAP.
    let x = minX;
    const y = minY;
    let deltaX = 0;
    for (const other of groupBoxes.values()) {
      if (
        x < other.x + other.width + CLASS_GAP &&
        x + width > other.x - CLASS_GAP &&
        y < other.y + other.height + CLASS_GAP &&
        y + height > other.y - CLASS_GAP
      ) {
        const nextX = other.x + other.width + CLASS_GAP;
        deltaX += nextX - x;
        x = nextX;
      }
    }

    groupBoxes.set(classId, { x, y, width, height });
    // Keep members inside the shifted parent box.
    if (deltaX !== 0) {
      for (const mId of members) {
        const pos = positions.get(mId);
        if (pos) positions.set(mId, { x: pos.x + deltaX, y: pos.y });
      }
    }
  }

  const classNodes: FlowNode[] = topology.nodes
    .filter((n) => n.type === "class")
    .map((node) => {
      const box = groupBoxes.get(node.id) ?? { x: 0, y: 0, width: 200, height: 200 };
      return {
        id: node.id,
        type: "classGroup",
        position: { x: box.x, y: box.y },
        style: { width: box.width, height: box.height },
        data: { label: node.label, plainDescription: node.plainDescription },
      };
    });

  const nodes: FlowNode[] = [
    ...classNodes,
    ...topology.nodes
      .filter((n) => n.type !== "class")
      .map((node) => {
        const parentId = parents.get(node.id);
        const pos = positions.get(node.id) ?? { x: 0, y: 0 };
        const parentBox = parentId ? groupBoxes.get(parentId) : undefined;
        
        return {
          id: node.id,
          type: "codeStep",
          parentId,
          // Relative positioning if nested in a class group
          position: parentBox 
            ? { x: pos.x - parentBox.x, y: pos.y - parentBox.y }
            : pos,
          zIndex: 1,
          data: {
            label: node.label,
            nodeType: node.type,
            plainDescription: node.plainDescription,
            parent: parentId ? topology.nodes.find(n => n.id === parentId)?.label : undefined,
          },
        };
      }),
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
