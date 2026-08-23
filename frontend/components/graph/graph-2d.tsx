"use client";

import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphTopology, NodeType } from "@underhood/types";
import { buildTopologyView, TYPE_STYLES } from "../../lib/topology-view";

type CodeStepData = {
  label: string;
  nodeType: NodeType;
  plainDescription: string;
};

function CodeStepNode({ data }: NodeProps) {
  // xyflow types node data loosely; our builder guarantees the shape.
  const { label, nodeType, plainDescription } = data as unknown as CodeStepData;
  const style = TYPE_STYLES[nodeType] ?? TYPE_STYLES.process; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
  return (
    <div
      className={`group relative rounded-lg border px-3 py-2 text-xs shadow-lg ${style.className}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />
      <div className="flex items-center gap-2">
        <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
          {style.label}
        </span>
        <span className="font-medium text-slate-100">{label}</span>
      </div>
      {/* Hover toast: jargon-free explanation (SDD §0 plain-language mandate) */}
      <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-56 -translate-x-1/2 rounded-md border border-slate-600 bg-slate-900 p-2 text-[11px] leading-snug text-slate-200 opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">
        {plainDescription}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}

const nodeTypes = { codeStep: CodeStepNode };

export default function Graph2D({ topology }: { topology: GraphTopology }) {
  const view = useMemo(() => buildTopologyView(topology), [topology]);

  return (
    <div className="h-[480px] w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
      <ReactFlow
        nodes={view.nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} color="#1e293b" />
        <Controls className="!border-slate-700 !bg-slate-900 [&>button]:!border-slate-700 [&>button]:!bg-slate-900 [&>button]:!fill-slate-300" />
      </ReactFlow>
    </div>
  );
}
