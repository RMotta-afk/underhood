import { createHash } from "node:crypto";
import type { Pool } from "pg";

// T5.2 — Prompt cache (SDD §6.1): Postgres table keyed by
// (promptHash, modelId). Cache hits skip the LLM entirely for identical
// prompts. Hash = SHA-256 of the fully rendered prompt + model id.

export async function ensurePromptCacheTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_cache (
      prompt_hash CHAR(64) NOT NULL,
      model_id TEXT NOT NULL,
      completion JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (prompt_hash, model_id)
    )
  `);
}

export function computePromptHash(prompt: string, modelId: string): string {
  return createHash("sha256").update(`${modelId}\u0000${prompt}`).digest("hex");
}

export async function getCachedCompletion(
  pool: Pool,
  prompt: string,
  modelId: string
): Promise<unknown> {
  const result = await pool.query<{ completion: unknown }>(
    `SELECT completion FROM prompt_cache WHERE prompt_hash = $1 AND model_id = $2`,
    [computePromptHash(prompt, modelId), modelId]
  );
  return result.rows[0]?.completion ?? null;
}

export async function saveCachedCompletion(
  pool: Pool,
  prompt: string,
  modelId: string,
  completion: unknown
): Promise<void> {
  await pool.query(
    `INSERT INTO prompt_cache (prompt_hash, model_id, completion)
     VALUES ($1, $2, $3)
     ON CONFLICT (prompt_hash, model_id) DO NOTHING`,
    [computePromptHash(prompt, modelId), modelId, JSON.stringify(completion)]
  );
}
