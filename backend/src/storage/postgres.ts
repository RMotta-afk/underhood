import { Pool } from "pg";
import { PostgresStore } from "@mastra/pg";
import { GraphCacheSchema, GraphTopologySchema } from "@underhood/types";
import type { GraphCache, GraphTopology } from "@underhood/types";

// T2.4 — PostgreSQL wiring (SDD §2/§3.2): the single Postgres instance hosts
// Mastra durable snapshots (@mastra/pg), the graph topology cache, and the
// pg-boss queue schema. No shadow databases.

export interface PostgresWiring {
  pool: Pool;
  store: PostgresStore;
}

/** Wire Mastra storage + app pools against one connection string. */
export async function wirePostgres(connectionString: string): Promise<PostgresWiring> {
  const store = new PostgresStore({ id: "underhood-storage", connectionString });
  await store.init(); // creates Mastra tables when used outside a Mastra instance

  const pool = new Pool({ connectionString });
  await ensureGraphCacheTable(pool);

  return { pool, store };
}

async function ensureGraphCacheTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS graph_cache (
      code_hash CHAR(64) PRIMARY KEY,
      language TEXT NOT NULL,
      topology JSONB NOT NULL,
      embedding JSONB,
      embedding_model TEXT,
      pipeline_version TEXT NOT NULL DEFAULT '0-legacy',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Migration-safe additions for existing volumes.
  await pool.query(
    `ALTER TABLE graph_cache ADD COLUMN IF NOT EXISTS embedding_model TEXT`
  );
  // T6.2 — rows produced by an older pipeline version must never be served
  // (e.g. pre-fidelity lazy topologies); existing volumes default to a
  // legacy marker that the live version never reads.
  await pool.query(
    `ALTER TABLE graph_cache ADD COLUMN IF NOT EXISTS pipeline_version TEXT NOT NULL DEFAULT '0-legacy'`
  );
}

export function toCacheRow(entry: GraphCache): {
  codeHash: string;
  language: string;
  topology: GraphTopology;
  embedding: number[] | null;
} {
  const parsed = GraphCacheSchema.parse(entry); // never persist unvalidated payloads
  return {
    codeHash: parsed.codeHash,
    language: parsed.language,
    topology: GraphTopologySchema.parse(parsed.topologyPayload),
    embedding: parsed.embedding ?? null,
  };
}

export async function saveTopologyCache(
  pool: Pool,
  entry: GraphCache,
  embeddingModel?: string,
  pipelineVersion = "0-legacy"
): Promise<void> {
  const row = toCacheRow(entry);
  await pool.query(
    `INSERT INTO graph_cache (code_hash, language, topology, embedding, embedding_model, pipeline_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (code_hash) DO UPDATE
       SET language = EXCLUDED.language,
           topology = EXCLUDED.topology,
           embedding = EXCLUDED.embedding,
           embedding_model = EXCLUDED.embedding_model,
           pipeline_version = EXCLUDED.pipeline_version`,
    [
      row.codeHash,
      row.language,
      JSON.stringify(row.topology),
      row.embedding ? JSON.stringify(row.embedding) : null,
      embeddingModel ?? null,
      pipelineVersion,
      entry.createdAt,
    ]
  );
}

export async function getCachedTopology(
  pool: Pool,
  codeHash: string,
  pipelineVersion = "0-legacy"
): Promise<GraphTopology | null> {
  const result = await pool.query<{ topology: unknown }>(
    `SELECT topology FROM graph_cache WHERE code_hash = $1 AND pipeline_version = $2`,
    [codeHash, pipelineVersion]
  );
  if (result.rows.length === 0) return null;
  return GraphTopologySchema.parse(result.rows[0]!.topology);
}
