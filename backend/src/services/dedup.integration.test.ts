import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { GraphTopology } from "@underhood/types";
import { analyzeCode } from "../workflow/steps/analyze-code";
import {
  canonicalRepresentation,
  cosineSimilarity,
  dedupOrRegister,
  embedWithCache,
  ensureEmbeddingCacheTable,
} from "./dedup";

// Integration suite for T5.3; requires compose db. Opt-in via TEST_DATABASE_URL
// only (ambient DATABASE_URL may point at a remote/production db); skips otherwise.
const DB = process.env.TEST_DATABASE_URL ?? null;
const describeDb = DB ? describe : describe.skip;

// Deterministic mock embedder: same text -> same vector (real provider
// embeddings behave equivalently for identical inputs).
const mockEmbed = async (text: string): Promise<number[]> => {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: 32 }, (_, i) => (hash[i] ?? 0) / 255 - 0.5);
};

const topologyFixture: GraphTopology = {
  nodes: [
    { id: "n1", label: "loadConfig", type: "process", plainDescription: "Reads the config file." },
    { id: "n2", label: "main", type: "entry", plainDescription: "Runs the program." },
  ],
  edges: [{ id: "e1", source: "n2", target: "n1", animated: true }],
  detectedPatterns: [],
};

const SNIPPET_A = `
async function loadConfig(path: string) { return readFile(path); }
function main() { loadConfig("cfg.json"); }
main();
`;

// Same entities/structure, different ordering + formatting.
const SNIPPET_B = `
main();

function main() {
  loadConfig( "cfg.json" );
}

async function loadConfig( path: string ) { return readFile(path); }
`;

describeDb("entity-aware dedup (T5.3 integration)", () => {
  let pool: Pool | undefined;
  // Unique per run so repeated suites never collide with persisted rows.
  const runModelId = `test-embed-${randomUUID()}`;
  // Unique per run so repeated suites never collide with persisted rows.

  beforeAll(async () => {
    const { wirePostgres } = await import("../storage/postgres");
    ({ pool } = await wirePostgres(DB!));
    await ensureEmbeddingCacheTable(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  test("canonical representation is identical for reordered equivalents", () => {
    const a = canonicalRepresentation(analyzeCode(SNIPPET_A));
    const b = canonicalRepresentation(analyzeCode(SNIPPET_B));
    expect(a).toBe(b);
    expect(a).toContain("loadConfig"); // entity names preserved for ludic labels
    expect(a).toContain("main");
  });

  test("first registration stores embedding; equivalent snippet dedupes to it", async () => {
    const analysisA = analyzeCode(SNIPPET_A);
    const hashA = createHash("sha256").update(`${SNIPPET_A}:${randomUUID()}`).digest("hex");

    const first = await dedupOrRegister(
      pool!, mockEmbed, analysisA, topologyFixture, hashA, "typescript",
      { modelId: runModelId, threshold: 0.95 }
    );
    expect(first.deduped).toBe(false);

    const analysisB = analyzeCode(SNIPPET_B);
    const hashB = createHash("sha256").update(`${SNIPPET_B}:${randomUUID()}`).digest("hex");
    const second = await dedupOrRegister(
      pool!, mockEmbed, analysisB, topologyFixture, hashB, "typescript",
      { modelId: runModelId, threshold: 0.95 }
    );
    expect(second.deduped).toBe(true);
    expect(second.similarity).toBeGreaterThanOrEqual(0.95);
    // Deduped hit keeps real entity names visible.
    expect(second.topology.nodes.map((n) => n.label)).toContain("loadConfig");
  });

  test("embedding cache prevents repeated embed calls for the same text", async () => {
    let calls = 0;
    const countingEmbed = async (text: string): Promise<number[]> => {
      calls++;
      return mockEmbed(text);
    };
    const text = `entities=fn a\nbranches=\nio=console:1\nasync=false:${randomUUID()}`;
    await embedWithCache(pool!, countingEmbed, text, "test-model");
    await embedWithCache(pool!, countingEmbed, text, "test-model");
    expect(calls).toBe(1);
  });

  test("cosineSimilarity math sanity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

