import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  computePromptHash,
  getCachedCompletion,
  saveCachedCompletion,
  ensurePromptCacheTable,
} from "./prompt-cache";

// Integration suite for T5.2; requires compose db. Opt-in via TEST_DATABASE_URL
// only (ambient DATABASE_URL may point at a remote/production db); skips otherwise.
const DB = process.env.TEST_DATABASE_URL ?? null;
const describeDb = DB ? describe : describe.skip;

const PROMPT = `Analyze this structure and produce the execution topology. ${randomUUID()}`;
const COMPLETION = { nodes: [], edges: [], detectedPatterns: ["Retry Loop"] };

describeDb("prompt cache (T5.2 integration)", () => {
  let pool: Pool | undefined;

  beforeAll(async () => {
    const { wirePostgres } = await import("../storage/postgres");
    ({ pool } = await wirePostgres(DB!));
    await ensurePromptCacheTable(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  test("miss -> save -> hit keyed by (promptHash, modelId)", async () => {
    expect(await getCachedCompletion(pool!, PROMPT, "gpt-4o")).toBeNull();

    await saveCachedCompletion(pool!, PROMPT, "gpt-4o", COMPLETION);

    // Second identical request hits the cache — no LLM invocation needed.
    const hit = await getCachedCompletion(pool!, PROMPT, "gpt-4o");
    expect(hit).toEqual(COMPLETION);

    // Hash is stable across calls for the same inputs.
    expect(computePromptHash(PROMPT, "gpt-4o")).toBe(
      computePromptHash(PROMPT, "gpt-4o")
    );
  });

  test("different model id misses even with identical prompt", async () => {
    await saveCachedCompletion(pool!, PROMPT, "groq/llama-3.3-70b-versatile", {
      different: true,
    });
    const hit = await getCachedCompletion(pool!, PROMPT, "groq/llama-3.3-70b-versatile");
    expect(hit).toEqual({ different: true });
    // original entry untouched
    expect(await getCachedCompletion(pool!, PROMPT, "gpt-4o")).toEqual(COMPLETION);
  });

  test("different prompt misses", async () => {
    expect(
      await getCachedCompletion(pool!, `${PROMPT} extra`, "gpt-4o")
    ).toBeNull();
  });
});
