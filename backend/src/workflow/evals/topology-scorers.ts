import { createScorer } from "@mastra/core/evals";
import { GraphTopologySchema } from "@underhood/types";

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

/**
 * Structural soundness: entry + terminal presence, referential integrity,
 * and full connectivity of the flow. 1.0 only for a logically complete graph.
 */
export const topologyStructureScorer = createScorer({
  id: STRUCTURE_SCORER_ID,
  description:
    "Scores whether the generated topology is a logical, referentially intact execution flow.",
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

/** Run every registered scorer against one candidate topology output. */
export async function scoreTopology(topology: unknown): Promise<TopologyScoreResult[]> {
  const scorers = [topologyStructureScorer, topologyPlainLanguageScorer];
  const results: TopologyScoreResult[] = [];
  for (const scorer of scorers) {
    const run = await scorer.run({ input: {}, output: topology });
    results.push({ scorerId: scorer.id, score: run.score });
  }
  return results;
}
