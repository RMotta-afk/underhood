import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { GraphTopology } from "@underhood/types";
import { saveTopologyCache } from "../storage/postgres";
import type { StructuralAnalysis } from "../workflow/steps/analyze-code";

// T5.3 - Entity-aware similar-snippet dedup (SDD §6.2).
// Builds a canonical entity-aware representation of an analyzed snippet,
// embeds it through a cached provider-routed endpoint, and matches against
// stored topologies by cosine similarity. Deduped hits keep their real
// entity names so labels stay meaningful for non-coders.

export type EmbedFn = (text: string) => Promise<number[]>;

export interface DedupOptions {
  modelId: string;
  threshold: number;
  /** Rows from other pipeline versions are invisible to dedup so stale
   * topologies (e.g. pre-fidelity lazy graphs) are never served. */
  pipelineVersion: string;
}

export interface DedupResult {
  deduped: boolean;
  topology: GraphTopology;
  similarity: number;
}

// --- Embedding cache (inputHash, model -> vector) ---

export async function ensureEmbeddingCacheTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      input_hash CHAR(64) NOT NULL,
      model_id TEXT NOT NULL,
      embedding JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (input_hash, model_id)
    )
  `);
}

export async function embedWithCache(
  pool: Pool,
  embed: EmbedFn,
  text: string,
  modelId: string
): Promise<number[]> {
  const inputHash = createHash("sha256").update(`${modelId}\u0000${text}`).digest("hex");
  const existing = await pool.query<{ embedding: number[] }>(
    `SELECT embedding FROM embedding_cache WHERE input_hash = $1 AND model_id = $2`,
    [inputHash, modelId]
  );
  if (existing.rows[0]) return existing.rows[0].embedding;

  const vector = await embed(text);
  await pool.query(
    `INSERT INTO embedding_cache (input_hash, model_id, embedding)
     VALUES ($1, $2, $3) ON CONFLICT (input_hash, model_id) DO NOTHING`,
    [inputHash, modelId, JSON.stringify(vector)]
  );
  return vector;
}

// --- Canonical entity-aware representation ---
// Order-independent by construction: entities are sorted, structural counts
// become sorted key:value lists. Two snippets that differ only in ordering
// or formatting produce IDENTICAL canonical text -> maximal similarity.

export function canonicalRepresentation(analysis: StructuralAnalysis): string {
  const entities = [...analysis.entities]
    .map((e) => `${e.kind} ${e.name}`)
    .sort()
    .join(",");
  const counts = (items: string[]) =>
    Object.entries(
      items.reduce<Record<string, number>>((acc, k) => {
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {})
    )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
  return [
    `entities=${entities}`,
    `branches=${counts(analysis.branches.map((b) => b.kind))}`,
    `io=${counts(analysis.ioOperations.map((o) => o.kind))}`,
    `async=${analysis.hasAsync}`,
  ].join("\n");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Topology similarity index over graph_cache.embedding ---

export async function attachEmbeddingToCacheEntry(
  pool: Pool,
  codeHash: string,
  language: string,
  modelId: string,
  embedding: number[]
): Promise<void> {
  await pool.query(
    `UPDATE graph_cache SET embedding = $2, embedding_model = $3 WHERE code_hash = $1`,
    [codeHash, JSON.stringify(embedding), modelId]
  );
}

/** Best matching stored topology whose embedding sits above `threshold`.
 * Vectors are only comparable within the same embedding model, so the
 * search is scoped to rows produced by `modelId`. */
export async function findSimilarTopology(
  pool: Pool,
  modelId: string,
  threshold: number,
  embedding: number[],
  pipelineVersion: string
): Promise<{ topology: GraphTopology; similarity: number } | null> {
  const result = await pool.query<{
    topology: unknown;
    embedding: number[];
  }>(
    `SELECT topology, embedding FROM graph_cache
     WHERE embedding IS NOT NULL AND embedding_model = $1 AND pipeline_version = $2`,
    [modelId, pipelineVersion]
  );

  let best: { topology: GraphTopology; similarity: number } | null = null;
  for (const row of result.rows) {
    const similarity = cosineSimilarity(embedding, row.embedding);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = {
        topology: row.topology as GraphTopology,
        similarity,
      };
    }
  }
  return best;
}

/**
 * Full dedup flow for a freshly generated topology:
 *   1. canonicalize the analysis, embed via cache
 *   2. look for an existing topology above threshold -> deduped hit
 *   3. otherwise register this snippet's embedding on its cache row
 */
export async function dedupOrRegister(
  pool: Pool,
  embed: EmbedFn,
  analysis: StructuralAnalysis,
  topology: GraphTopology,
  codeHash: string,
  language: string,
  options: DedupOptions
): Promise<DedupResult> {
  const text = canonicalRepresentation(analysis);
  const embedding = await embedWithCache(pool, embed, text, options.modelId);

  const similar = await findSimilarTopology(
    pool,
    options.modelId,
    options.threshold,
    embedding,
    options.pipelineVersion
  );
  if (similar) {
    return { deduped: true, topology: similar.topology, similarity: similar.similarity };
  }

  // Register this snippet: full cache-row upsert so the embedding is queryable
  // even when no cache row exists yet.
  await saveTopologyCache(
    pool,
    {
      codeHash,
      language,
      topologyPayload: topology,
      embedding,
      createdAt: new Date(),
    },
    options.modelId,
    options.pipelineVersion
  );
  return { deduped: false, topology, similarity: 1 };
}
