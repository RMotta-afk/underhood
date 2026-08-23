"use client";

/**
 * 3D renderer (T3.3): WebGL force-directed execution trace via 3d-force-graph.
 * Layout math happens client-side inside d3-force; this component only maps
 * validated topology primitives into graph data (SDD §8).
 */
import { useEffect, useRef } from "react";
import ForceGraph3D, {
  type ConfigOptions,
  type ForceGraph3DInstance,
  type LinkObject,
  type NodeObject,
} from "3d-force-graph";
import type { GraphTopology, NodeType } from "@underhood/types";
import { TYPE_STYLES } from "../../lib/topology-view";

// Mirrors TYPE_STYLES border colors (topology-view.ts) as WebGL-friendly hex.
const TYPE_COLORS: Record<NodeType, string> = {
  entry: "#10b981",
  process: "#0ea5e9",
  io: "#f59e0b",
  branch: "#8b5cf6",
  terminal: "#f43f5e",
};

type GraphNode3D = NodeObject & {
  name: string;
  description: string;
  nodeType: NodeType;
};

type GraphLink3D = LinkObject<GraphNode3D>;

// The library exports a non-generic const; re-type the constructor so
// accessors below receive our enriched node shape instead of bare NodeObject.
const TypedForceGraph3D = ForceGraph3D as unknown as new (
  element: HTMLElement,
  configOptions?: ConfigOptions
) => ForceGraph3DInstance<GraphNode3D, GraphLink3D>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Hover toast markup: plain-language mandate surfaced in 3D too (SDD §0). */
function nodeTooltip(node: GraphNode3D): string {
  const typeLabel = TYPE_STYLES[node.nodeType].label;
  return (
    `<div style="max-width:260px;padding:8px 10px;border-radius:8px;` +
    `background:#0f172a;border:1px solid #334155;color:#e2e8f0;` +
    `font-family:inherit;font-size:12px;line-height:1.45;">` +
    `<span style="display:inline-block;margin-bottom:4px;padding:1px 6px;` +
    `border-radius:4px;background:#1e293b;color:#94a3b8;font-size:10px;` +
    `text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(typeLabel)}</span>` +
    `<br/><strong>${escapeHtml(node.name)}</strong>` +
    `<br/>${escapeHtml(node.description)}</div>`
  );
}

export default function Graph3D({ topology }: { topology: GraphTopology }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Defensive: drop dangling references exactly like the 2D path.
    const validIds = new Set(topology.nodes.map((n) => n.id));
    const nodes: GraphNode3D[] = topology.nodes.map((node) => ({
      id: node.id,
      name: node.label,
      nodeType: node.type,
      description: node.plainDescription,
    }));
    const links: GraphLink3D[] = topology.edges
      .filter((e) => validIds.has(e.source) && validIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    const graph = new TypedForceGraph3D(container, {
      controlType: "orbit",
    })
      .backgroundColor("#020617")
      .showNavInfo(false)
      .graphData({ nodes, links })
      .nodeRelSize(6)
      .nodeColor((node) => TYPE_COLORS[node.nodeType])
      .nodeLabel(nodeTooltip)
      .linkColor("#334155")
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .zoomToFit(400, 48);

    const resize = () => {
      graph.width(container.clientWidth).height(container.clientHeight);
    };
    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      graph._destructor();
    };
  }, [topology]);

  return (
    <div className="h-[480px] w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
