import { Agent } from "@mastra/core/agent";
import type { GraphTopology } from "@underhood/types";
import {
  GraphTopologySchema,
  TopologyGenerationSchema,
  withEdgeDefaults,
} from "@underhood/types";
import { loadEnv, type Env } from "../../env";
import type { StructuralAnalysis } from "./analyze-code";

// T2.2 — generateTopologyStep: LLM topology generation (SDD §4.1 step 2).
// Provider-agnostic per SDD §0: the model is resolved purely from env config.
// No provider SDK is imported here — Mastra's native model router handles
// OpenAI, Groq, or any OpenAI-compatible endpoint via MODEL_* variables.

export interface TopologyGenerationResult {
  object: unknown;
}

/** Minimal structural contract so tests can inject a mock generator. */
export interface TopologyGenerator {
  generate(
    messages: Array<{ role: "system" | "user"; content: string }>,
    options: { structuredOutput: { schema: typeof TopologyGenerationSchema } }
  ): Promise<TopologyGenerationResult>;
}

/** Resolve the model from validated env only (SDD §0 provider abstraction).
 * Accepts an already-validated env slice (tests) or runs fail-fast loadEnv()
 * against the FULL ambient environment — a partial source would drop
 * OPENAI_API_KEY/GROQ_API_KEY and fail the provider refinement.
 * Custom MODEL_BASE_URL endpoints bypass provider credential auto-wiring,
 * so the provider key is attached explicitly (Mastra openai-compatible path). */
export function resolveModel(
  validated?: Pick<
    Env,
    "MODEL_PROVIDER" | "MODEL_ID" | "MODEL_BASE_URL" | "OPENAI_API_KEY" | "GROQ_API_KEY"
  >
): {
  model:
    | string
    | { id: `${string}/${string}`; url: string; apiKey?: string };
} {
  const e = validated ?? loadEnv();
  if (e.MODEL_BASE_URL) {
    const apiKey =
      e.MODEL_PROVIDER === "groq" ? e.GROQ_API_KEY : e.OPENAI_API_KEY;
    return {
      model: {
        id: `custom/${e.MODEL_ID}`,
        url: e.MODEL_BASE_URL,
        ...(apiKey ? { apiKey } : {}),
      },
    };
  }
  return { model: `${e.MODEL_PROVIDER}/${e.MODEL_ID}` };
}

export const TOPOLOGY_INSTRUCTIONS = [
  "You convert code structure into an execution-flow graph for non-coders.",
  "Rules:",
  "- Every node MUST include plainDescription: a jargon-free, 1-3 sentence explanation a product manager could understand.",
  "- Node types: entry (start), process (computation), io (input/output like files, network, console), branch (decisions/loops), terminal (end).",
  "- Edges must reference existing node ids via source/target.",
  "- detectedPatterns lists engineering patterns you recognized (e.g., Retry Loop, State Machine).",
].join("\n");

export function buildTopologyPrompt(analysis: StructuralAnalysis): string {
  return [
    "Analyze this extracted code structure and produce the execution topology.",
    "",
    "Structural analysis (deterministic AST extraction):",
    JSON.stringify(analysis, null, 2),
    "",
    "Requirements:",
    `- Start from entry point(s): ${analysis.entryPoints.join(", ")}.`,
    "- Represent each meaningful entity as a process node using its real name as the label.",
    `- Model the ${analysis.branches.length} branch(es) and ${analysis.ioOperations.length} IO operation(s) faithfully.`,
    analysis.hasAsync
      ? "- The code is asynchronous; reflect awaits in the flow order."
      : "- The code is synchronous.",
    "- End with terminal node(s) for every completion path.",
  ].join("\n");
}

export function createTopologyAgent(): Agent {
  return new Agent({
    id: "topology-generator",
    name: "Topology Generator",
    instructions: TOPOLOGY_INSTRUCTIONS,
    ...resolveModel(),
  });
}

/** Run generation with strict structured output against the LLM wire
 * contract (TopologyGenerationSchema), then apply edge defaults and parse
 * defensively against the public GraphTopologySchema as the backstop. */
export async function generateTopology(
  analysis: StructuralAnalysis,
  generatorOverride?: TopologyGenerator
): Promise<GraphTopology> {
  const agent =
    (generatorOverride as unknown as Agent | undefined) ?? createTopologyAgent();
  const response = await agent.generate(
    [{ role: "user", content: buildTopologyPrompt(analysis) }],
    { structuredOutput: { schema: TopologyGenerationSchema } }
  );
  // Strict validation: never trust the wire format even with structured output enabled.
  return GraphTopologySchema.parse(withEdgeDefaults(response.object));
}

// Re-exported so validateGraphStep (T2.3) can share the same contract source.
export { GraphTopologySchema };
export type { GraphTopology, StructuralAnalysis };
