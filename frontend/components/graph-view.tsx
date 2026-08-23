"use client";

/**
 * Renderer host: renders the 2D flowchart. The 3D renderer was retired —
 * the workflow emits a single renderer-agnostic topology and the 2D path
 * is the only user-facing visualization.
 */
import type { GraphTopology } from "@underhood/types";
import Graph2D from "./graph/graph-2d";

export default function GraphView({ topology }: { topology: GraphTopology }) {
  return <Graph2D topology={topology} />;
}
