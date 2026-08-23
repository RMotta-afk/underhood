import {
  GraphTopologySchema,
  TopologyGenerationSchema,
  withEdgeDefaults,
} from "@underhood/types";
import type { GraphTopology } from "@underhood/types";
import type { StructuralAnalysis } from "./analyze-code";
import { buildTopologyPrompt, type TopologyGenerator } from "./generate-topology";

// T2.3 — validateGraphStep + selfHealBranch (SDD §4.1 step 3).
// Pure TypeScript validation: no LLM, no I/O. The heal loop injects the exact
// validation failures back into the generator (max 2 retries per SDD).

export interface GraphValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Deterministic graph integrity check: schema first, then referential rules. */
export function validateGraph(topology: unknown): GraphValidation {
  const parsed = GraphTopologySchema.safeParse(topology);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      ),
      warnings: [],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const graph = parsed.data;

  const idCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push(`duplicate node id "${id}" (${count} occurrences)`);
  }

  for (const edge of graph.edges) {
    if (!idCounts.has(edge.source)) {
      errors.push(`edge "${edge.id}" references missing source node "${edge.source}"`);
    }
    if (!idCounts.has(edge.target)) {
      errors.push(`edge "${edge.id}" references missing target node "${edge.target}"`);
    }
  }

  if (graph.nodes.length === 0) {
    errors.push("topology has no nodes");
  }

  // Orphan detection: connected graphs should touch every node; standalone
  // single-node topologies (detached functions) are legitimate.
  if (graph.nodes.length > 1 && graph.edges.length > 0) {
    const connected = new Set<string>();
    for (const edge of graph.edges) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
    for (const node of graph.nodes) {
      if (!connected.has(node.id)) {
        warnings.push(`node "${node.id}" is disconnected from the flow`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export class HealExhaustedError extends Error {
  constructor(
    public readonly errors: string[],
    public readonly attempts: number
  ) {
    super(
      `Topology failed validation after ${attempts} generation attempt(s); unresolved errors:\n${errors.join("\n")}`
    );
    this.name = "HealExhaustedError";
  }
}

async function requestGeneration(
  generator: TopologyGenerator,
  analysis: StructuralAnalysis,
  feedback?: { errors: string[]; previous: unknown }
): Promise<unknown> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "user", content: buildTopologyPrompt(analysis) },
  ];
  if (feedback) {
    messages.push({
      role: "user",
      content: [
        "Your previous attempt FAILED validation. Fix every listed problem.",
        "Validation errors:",
        ...feedback.errors.map((e) => `- ${e}`),
        "Previous output:",
        JSON.stringify(feedback.previous),
        "Return the corrected topology.",
      ].join("\n"),
    });
  }
  const response = await generator.generate(messages, {
    structuredOutput: { schema: TopologyGenerationSchema },
  });
  return withEdgeDefaults(response.object);
}

/**
 * Generate -> validate -> heal loop (SDD §4.1 step 4 / selfHealBranch).
 * Retries at most `maxRetries` times (default 2), injecting the accumulated
 * Zod/integrity errors into each repair attempt. Fails deterministically.
 */
export async function generateWithHealing(
  analysis: StructuralAnalysis,
  generator: TopologyGenerator,
  maxRetries = 2
): Promise<GraphTopology> {
  let previous: unknown;
  let errors: string[] = [];
  let attempts = 0;

  for (;;) {
    const candidate =
      attempts === 0
        ? await requestGeneration(generator, analysis)
        : await requestGeneration(generator, analysis, { errors, previous });

    const validation = validateGraph(candidate);
    if (validation.valid) {
      return candidate as GraphTopology;
    }

    attempts++;
    errors = validation.errors;
    previous = candidate;
    if (attempts > maxRetries) {
      throw new HealExhaustedError(errors, attempts);
    }
  }
}
