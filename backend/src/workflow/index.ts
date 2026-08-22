import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { GraphTopologySchema } from "@underhood/types";
import { analyzeCode, StructuralAnalysisSchema, type StructuralAnalysis } from "./steps/analyze-code";
import {
  createTopologyAgent,
  generateTopology,
  type TopologyGenerator,
} from "./steps/generate-topology";
import { generateWithHealing } from "./steps/validate-graph";

// T2.3 — Mastra durable workflow assembly (SDD §4).
// rawCode -> analyzeCodeStep -> generateTopologyStep (with selfHealBranch loop)
// Persistence of run snapshots is wired at T2.4 (@mastra/pg PostgresStore).

export const RawCodeInputSchema = z.object({
  rawCode: z.string().min(1),
  language: z.string().optional(),
});

export const analyzeCodeStep = createStep({
  id: "analyze-code",
  inputSchema: RawCodeInputSchema,
  outputSchema: StructuralAnalysisSchema,
  execute: async ({ inputData }: { inputData: z.infer<typeof RawCodeInputSchema> }) =>
    analyzeCode(inputData.rawCode),
});

export const generateTopologyStep = createStep({
  id: "generate-topology",
  inputSchema: StructuralAnalysisSchema,
  outputSchema: GraphTopologySchema,
  execute: async ({
    inputData,
  }: {
    inputData: StructuralAnalysis;
  }) => {
    // The real agent generator; tests inject mocks via generateWithHealing directly.
    const agent = createTopologyAgent();
    return generateTopology(inputData, agent as unknown as TopologyGenerator);
  },
});

export const topologyWorkflow = createWorkflow({
  id: "code-topology-workflow",
  inputSchema: RawCodeInputSchema,
  outputSchema: GraphTopologySchema,
})
  .then(analyzeCodeStep)
  .then(generateTopologyStep)
  .commit();

export { generateWithHealing };
