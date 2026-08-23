import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { GraphTopologySchema } from "@underhood/types";
import { analyzeCode, StructuralAnalysisSchema, type StructuralAnalysis } from "./steps/analyze-code";
import {
  createTopologyAgent,
  type TopologyGenerator,
} from "./steps/generate-topology";
import { generateWithHealing } from "./steps/validate-graph";

// T6.3 — Mastra durable workflow assembly (SDD §4).
// rawCode -> analyzeCodeStep -> generateTopologyStep (with selfHealBranch loop)
// Run snapshots persist via @mastra/pg when the workflow is registered on the
// observability Mastra instance (T2.4/T5.4); the live executor starts runs
// programmatically so production traffic flows THROUGH this workflow.

export const RawCodeInputSchema = z.object({
  rawCode: z.string().min(1),
  language: z.string().optional(),
});

export interface TopologyWorkflowDeps {
  /** Generator used by generateTopologyStep. Inject the prompt-cached agent
   * in production; defaults to a bare env-resolved agent (tests/offline). */
  generator?: TopologyGenerator;
}

/** Build the topology workflow with injectable dependencies. */
export function createTopologyWorkflow(deps: TopologyWorkflowDeps = {}) {
  const analyzeCodeStep = createStep({
    id: "analyze-code",
    inputSchema: RawCodeInputSchema,
    outputSchema: StructuralAnalysisSchema,
    execute: async ({ inputData }: { inputData: z.infer<typeof RawCodeInputSchema> }) =>
      analyzeCode(inputData.rawCode, inputData.language),
  });

  // Fidelity-gated generation: lazy straight-line topologies are rejected by
  // validation and regenerated with injected errors (max 2 retries).
  const generateTopologyStep = createStep({
    id: "generate-topology",
    inputSchema: StructuralAnalysisSchema,
    outputSchema: GraphTopologySchema,
    execute: async ({
      inputData,
    }: {
      inputData: StructuralAnalysis;
    }) => {
      const generator =
        deps.generator ??
        (createTopologyAgent() as unknown as TopologyGenerator);
      return generateWithHealing(inputData, generator);
    },
  });

  const topologyWorkflow = createWorkflow({
    id: "code-topology-workflow",
    inputSchema: RawCodeInputSchema,
    outputSchema: GraphTopologySchema,
  })
    .then(analyzeCodeStep)
    .then(generateTopologyStep)
    .commit();

  return { analyzeCodeStep, generateTopologyStep, topologyWorkflow };
}

const defaults = createTopologyWorkflow();
export const analyzeCodeStep = defaults.analyzeCodeStep;
export const generateTopologyStep = defaults.generateTopologyStep;
export const topologyWorkflow = defaults.topologyWorkflow;

export { generateWithHealing };
