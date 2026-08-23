"use client";

/**
 * Renderer host (T3.4): owns the single 2D/3D choice and swaps renderers
 * without losing the loaded topology (state survives re-render because this
 * component stays mounted). 3D is client-only — WebGL cannot SSR.
 */
import dynamic from "next/dynamic";
import { useState } from "react";
import type { GraphTopology } from "@underhood/types";
import Graph2D from "./graph/graph-2d";
import ModeToggle, { type ViewMode } from "./mode-toggle";

const Graph3D = dynamic(() => import("./graph/graph-3d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[480px] w-full items-center justify-center rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-400">
      Loading 3D view…
    </div>
  ),
});

export default function GraphView({ topology }: { topology: GraphTopology }) {
  const [mode, setMode] = useState<ViewMode>("2d");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-center">
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      {mode === "2d" ? (
        <Graph2D topology={topology} />
      ) : (
        <Graph3D topology={topology} />
      )}
    </div>
  );
}
