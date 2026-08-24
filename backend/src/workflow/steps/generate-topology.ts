import { Agent } from "@mastra/core/agent";
import type { GraphTopology } from "@underhood/types";
import {
  GraphTopologySchema,
  TopologyGenerationSchema,
  withEdgeDefaults,
} from "@underhood/types";
import { env, loadEnv, type Env } from "../../env";
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
  "- For every class declared in the entities, include ONE container node of type \"class\" labeled with the class name; it explains what the class is responsible for.",
  "- Nodes representing methods of a class MUST set parent to that class container node's id.",
  "- The output is ALWAYS ONE connected graph rooted at the entry point(s): every function/method flow must be reachable from an entry through call edges. NEVER emit separate unrelated trees per function or method — methods belong to their class's workflow via caller edges.",
  "- Edges must reference existing node ids via source/target.",
  "- FIDELITY: every conditional in the control-flow outline MUST become a branch node with at least two outgoing edges, one per alternative path.",
  "- FIDELITY: every loop MUST form a cycle in the graph — an edge must lead back into the loop body. Never flatten loops into a single straight-line pass.",
  "- Label the outgoing edges of each decision with its outcome using the edge label field (e.g. \"yes\"/\"no\", or the matching case).",
  "- A call from one extracted function to another MUST connect to the callee's own node.",
  "- Each distinct completion path (including early returns) MUST reach a terminal node.",
  "- detectedPatterns lists engineering patterns you recognized (e.g., Retry Loop, State Machine).",
].join("\n");

export function buildTopologyPrompt(analysis: StructuralAnalysis): string {
  const classEntities = analysis.entities.filter((e) => e.kind === "class");
  const lines = [
    "Analyze this extracted code structure and produce the execution topology.",
    "",
    "Structural analysis (deterministic AST extraction):",
    JSON.stringify(analysis, null, 2),
    "",
    "Requirements:",
    `- Start from entry point(s): ${analysis.entryPoints.join(", ")} — ONLY these get "entry" nodes; every other function/method is reached through caller edges.`,
    "- Represent each meaningful entity as a process node using its real name as the label and id.",
  ];
  if (classEntities.length > 0) {
    lines.push(
      `- Declare ONE node of type "class" per class (${classEntities.map((c) => c.name).join(", ")}), labeled with the class name, describing what the class is for. Method nodes set parent to the class node's id.`
    );
  }
  lines.push(
    `- Model the ${analysis.branches.length} branch(es) and ${analysis.ioOperations.length} IO operation(s) faithfully.`,
    "- The result must be a SINGLE connected graph: if the outline shows one entity calling another, their nodes MUST be joined by an edge."
  );
  if (analysis.flows && analysis.flows.length > 0) {
    lines.push(
      "- The per-entity control-flow outline below is authoritative for ORDER and SHAPE:",
      ...analysis.flows.map(
        (f) =>
          `  * ${f.entity}: ${f.steps.map((s) => s.kind).join(" -> ")}. Conditions in the outline MUST appear as branch nodes with labeled alternative edges.`
      )
    );
  }
  lines.push(
    analysis.hasAsync
      ? "- The code is asynchronous; reflect awaits in the flow order."
      : "- The code is synchronous.",
    "- End with terminal node(s) for every completion path."
  );
  return lines.join("\n");
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

  const timeoutMs = env().LLM_TIMEOUT_MS;
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`LLM generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const response = await Promise.race([
    agent.generate(
      [{ role: "user", content: buildTopologyPrompt(analysis) }],
      { structuredOutput: { schema: TopologyGenerationSchema } }
    ),
    timeoutPromise as Promise<any>
  ]);

  return GraphTopologySchema.parse(withEdgeDefaults(response.object));
}

// Re-exported so validateGraphStep (T2.3) can share the same contract source.
export { GraphTopologySchema };
export type { GraphTopology, StructuralAnalysis };
