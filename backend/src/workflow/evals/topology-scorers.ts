import { createScorer } from "@mastra/core/evals";
import { GraphTopologySchema } from "@underhood/types";
import type { StructuralAnalysis } from "../steps/analyze-code";

// T4.2 — deterministic topology-quality scorers (SDD §6.3, AGENT.md @sdet).
// Built on Mastra's native scorer API (createScorer) but fully deterministic:
// no LLM judge, so evals run hermetically in CI and the Docker build gate.
//
// Scores persist to Postgres observability storage (mastra_scores via
// @mastra/pg saveScore) and appear as Langfuse trace metadata when tracing
// is enabled. No UI surface (SDD §6.3).

export const STRUCTURE_SCORER_ID = "topology-structure";
export const PLAIN_LANGUAGE_SCORER_ID = "topology-plain-language";

/** Scores above this threshold count as quality passes (T4.2 gate). */
export const TOPOLOGY_SCORE_THRESHOLD = 0.75;

function parseTopology(output: unknown) {
  return GraphTopologySchema.safeParse(output);
}

/** Directed cycle detection for loop-fidelity checks (eval-side mirror). */
function hasCycle(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>
): boolean {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  const color = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const root of nodeIds) {
    if (color.get(root) !== 0) continue;
    const stack: Array<{ node: string; i: number }> = [{ node: root, i: 0 }];
    color.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.i < neighbors.length) {
        const next = neighbors[frame.i++]!;
        if (color.get(next) === 1) return true;
        if (color.get(next) === 0) {
          color.set(next, 1);
          stack.push({ node: next, i: 0 });
        }
      } else {
        color.set(frame.node, 2);
        stack.pop();
      }
    }
  }
  return false;
}

/** Fidelity fraction: how faithfully the graph mirrors the declared
 * control flow (branch presence, decision fan-out, loop cycles). */
function fidelityScore(
  topology: { nodes: Array<{ id: string; type: string }>; edges: Array<{ source: string; target: string }> },
  analysis: StructuralAnalysis
): number | null {
  const branchNodes = topology.nodes.filter((n) => n.type === "branch");
  const outDegree = new Map<string, number>();
  for (const e of topology.edges) {
    outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
  }
  const checks: boolean[] = [];
  if (analysis.branches.length > 0) {
    checks.push(branchNodes.length > 0);
  }
  if (branchNodes.length > 0) {
    checks.push(branchNodes.every((b) => (outDegree.get(b.id) ?? 0) >= 2));
  }
  if (analysis.branches.some((b) => b.kind === "loop")) {
    checks.push(hasCycle(topology.nodes.map((n) => n.id), topology.edges));
  }
  if (checks.length === 0) return null; // nothing declared -> no fidelity signal
  return checks.filter(Boolean).length / checks.length;
}

/**
 * Structural soundness: entry + terminal presence, referential integrity,
 * full connectivity, and — when an analysis is supplied — control-flow
 * fidelity. 1.0 only for a logically complete, faithful graph.
 */
export const topologyStructureScorer = createScorer({
  id: STRUCTURE_SCORER_ID,
  description:
    "Scores whether the generated topology is a logical, referentially intact execution flow that faithfully represents the code's branches and loops.",
})
  .generateScore(({ run }) => {
    const parsed = parseTopology(run.output);
    if (!parsed.success) return 0;

    let score = 0;
    const types = new Set(parsed.data.nodes.map((n) => n.type));
    if (types.has("entry")) score += 0.25;
    if (types.has("terminal")) score += 0.25;

    const ids = new Set(parsed.data.nodes.map((n) => n.id));
    const dangling = parsed.data.edges.filter(
      (e) => !ids.has(e.source) || !ids.has(e.target)
    );
    if (dangling.length === 0) score += 0.25;

    if (parsed.data.nodes.length > 1 && parsed.data.edges.length > 0) {
      const connected = new Set<string>();
      for (const edge of parsed.data.edges) {
        connected.add(edge.source);
        connected.add(edge.target);
      }
      if (parsed.data.nodes.every((n) => connected.has(n.id))) score += 0.25;
    } else if (parsed.data.nodes.length === 1) {
      score += 0.25; // standalone single-node topology is legitimate
    }

    // Fidelity component replaces up to half the base score when an
    // analysis declares conditionals/loops.
    const analysis = (run.input as { analysis?: StructuralAnalysis }).analysis;
    if (analysis) {
      const fidelity = fidelityScore(parsed.data, analysis);
      if (fidelity !== null) {
        const base = score / 2;
        return base + 0.5 * fidelity;
      }
    }
    return score;
  });

/**
 * Plain-language mandate (SDD §0): every node must carry a jargon-free
 * description a non-coder can act on. Fraction of compliant nodes.
 */
export const topologyPlainLanguageScorer = createScorer({
  id: PLAIN_LANGUAGE_SCORER_ID,
  description:
    "Scores whether every node carries an understandable plain-language description.",
})
  .generateScore(({ run }) => {
    const parsed = parseTopology(run.output);
    if (!parsed.success || parsed.data.nodes.length === 0) return 0;

    const compliant = parsed.data.nodes.filter((node) => {
      const words = node.plainDescription.trim().split(/\s+/).length;
      // 3..80 words: substantive enough to explain, short enough to scan.
      return words >= 3 && words <= 80;
    }).length;
    return compliant / parsed.data.nodes.length;
  });

export interface TopologyScoreResult {
  scorerId: string;
  score: number;
  reason?: string;
}

/** Run every registered scorer against one candidate topology output.
 * Passing the structural analysis enables fidelity-aware scoring. */
export async function scoreTopology(
  topology: unknown,
  analysis?: StructuralAnalysis
): Promise<TopologyScoreResult[]> {
  const scorers = [topologyStructureScorer, topologyPlainLanguageScorer];
  const results: TopologyScoreResult[] = [];
  for (const scorer of scorers) {
    const run = await scorer.run({ input: { analysis }, output: topology });
    results.push({ scorerId: scorer.id, score: run.score });
  }
  return results;
}
