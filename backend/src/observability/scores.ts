import type { ScoreRowData } from "@mastra/core/evals";
import type { ScoresStorage } from "@mastra/core/storage";

// T4.2 — eval score persistence (SDD §6.3/§8): scores land in the single
// PostgreSQL instance via the Mastra storage layer's scores domain
// (mastra_scores). No shadow store, no UI surface.

export interface TopologyScoreEntry {
  runId: string;
  entityId: string;
  scorerId: string;
  score: number;
  reason?: string;
  input: unknown;
  output: unknown;
}

type StoreWithScores = { stores: { scores?: ScoresStorage } };

/** Persist one scored eval result through the Mastra storage scores domain. */
export async function persistTopologyScore(
  store: StoreWithScores,
  entry: TopologyScoreEntry
): Promise<ScoreRowData> {
  const scores = store.stores.scores;
  if (!scores) throw new Error("storage instance has no scores domain");
  const { score } = await scores.saveScore({
    runId: entry.runId,
    scorerId: entry.scorerId,
    entityId: entry.entityId,
    entityType: "WORKFLOW",
    entity: { id: entry.entityId },
    scorer: { id: entry.scorerId },
    source: "TEST",
    input: entry.input,
    output: entry.output,
    score: entry.score,
    ...(entry.reason ? { reason: entry.reason } : {}),
  });
  return score;
}
