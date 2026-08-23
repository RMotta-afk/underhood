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

/** Directed cycle detection (iterative DFS, three-color). */
function hasDirectedCycle(nodeIds: string[], edges: Array<{ source: string; target: string }>): boolean {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));
  for (const root of nodeIds) {
    if (color.get(root) !== WHITE) continue;
    const stack: Array<{ node: string; edgeIndex: number }> = [
      { node: root, edgeIndex: 0 },
    ];
    color.set(root, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.edgeIndex < neighbors.length) {
        const next = neighbors[frame.edgeIndex++]!;
        if (color.get(next) === GRAY) return true; // back-edge
        if (color.get(next) === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, edgeIndex: 0 });
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }
  return false;
}

/**
 * Deterministic graph integrity check: schema first, then referential rules.
 * When a structural analysis is provided, fidelity is enforced too: declared
 * conditionals/loops MUST be represented as branch nodes and cycles, so lazy
 * straight-line topologies fail validation and trigger the heal loop.
 */
export function validateGraph(
  topology: unknown,
  analysis?: StructuralAnalysis
): GraphValidation {
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

  // --- Fidelity checks (T6.1): only enforced when an analysis is provided ---
  if (analysis) {
    const branchNodes = graph.nodes.filter((n) => n.type === "branch");
    const declaredConditionals = analysis.branches.length;
    const declaredLoops = analysis.branches.filter((b) => b.kind === "loop").length;

    // Degenerate-analysis backstop: an extraction that found no structure at
    // all (unparseable/unsupported code) must never validate as a trivial
    // Start -> End graph — it means generation ran on garbage input.
    if (
      analysis.statementCount === 0 &&
      analysis.entities.length === 0 &&
      declaredConditionals === 0
    ) {
      errors.push(
        "structural analysis extracted no code structure (entities, branches, statements); refusing a trivial topology"
      );
    }

    if (declaredConditionals > 0 && branchNodes.length === 0) {
      errors.push(
        `structural analysis found ${declaredConditionals} conditional(s)/loop(s), but the topology has no branch nodes`
      );
    }

    const outDegree = new Map<string, number>();
    for (const edge of graph.edges) {
      outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    }
    // Single-exit decisions are suspicious but legal (paths can converge),
    // so this is advisory while branch presence/cycles stay hard errors.
    for (const branch of branchNodes) {
      if ((outDegree.get(branch.id) ?? 0) < 2) {
        warnings.push(
          `branch node "${branch.id}" has fewer than two outgoing paths (a decision should show its alternatives)`
        );
      }
    }

    if (
      declaredLoops > 0 &&
      graph.nodes.length > 0 &&
      !hasDirectedCycle(graph.nodes.map((n) => n.id), graph.edges)
    ) {
      errors.push(
        `structural analysis found ${declaredLoops} loop(s), but the topology contains no cycle (missing loop back-edge)`
      );
    }

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const flow of analysis.flows ?? []) {
      for (const step of flow.steps) {
        if (step.kind === "call" && step.callee && !nodeIds.has(step.callee)) {
          warnings.push(
            `call from "${flow.entity}" to "${step.callee}" has no matching node in the topology`
          );
        }
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

    const validation = validateGraph(candidate, analysis);
    if (validation.valid) {
      // Return the normalized parse (defaults applied), not the raw wire object.
      return GraphTopologySchema.parse(candidate);
    }

    attempts++;
    errors = validation.errors;
    previous = candidate;
    if (attempts > maxRetries) {
      throw new HealExhaustedError(errors, attempts);
    }
  }
}
