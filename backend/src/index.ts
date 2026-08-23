import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

// @underhood/backend entrypoint (SDD §5): health + async analysis API.
// The API initializes only when DATABASE_URL is available; the health server
// stays up regardless so orchestrators can probe readiness.
import { getBoss } from "./queue/boss";
import { startWorker } from "./queue/worker";
import { PIPELINE_VERSION } from "./version";
import {
  createAnalysisJob,
  ensureAnalysisJobsTable,
  getAnalysisJob,
} from "./api/routes/analyses";
import { wirePostgres } from "./storage/postgres";

const port = Number(process.env.PORT ?? 3000);

interface ApiState {
  pool: Pool;
  boss: PgBoss;
}

let api: ApiState | null = null;
let initPromise: Promise<void> | null = null;

async function initApi(): Promise<void> {
  const { loadEnv } = await import("./env");
  const e = loadEnv(); // fail-fast on invalid config
  const { pool, store } = await wirePostgres(e.DATABASE_URL);
  await ensureAnalysisJobsTable(pool);
  const { ensureEmbeddingCacheTable } = await import("./services/dedup");
  await ensureEmbeddingCacheTable(pool);
  const { ensurePromptCacheTable } = await import("./services/prompt-cache");
  await ensurePromptCacheTable(pool);
  const boss = await getBoss(e.DATABASE_URL);
  // Real pipeline executor: analyze -> (cache) -> generate -> validate/heal ->
  // dedup/register (SDD §6.1/§6.2). Cache and dedup hits skip or replace LLM
  // generation; every stored topology lands in the single graph_cache table.
  // Imported lazily to keep boot light and avoid cycles in tests.
  const [{ analyzeCode }, { createTopologyAgent }, { createMastraWithObservability }] =
    await Promise.all([
      import("./workflow/steps/analyze-code"),
      import("./workflow/steps/generate-topology"),
      import("./observability/langfuse"),
    ]);
  const { dedupOrRegister } = await import("./services/dedup");
  const { getCachedTopology } = await import("./storage/postgres");
  const { withPromptCache } = await import("./services/cached-generator");
  const agent = createTopologyAgent();
  // Prompt-cached generator: identical prompts (per pipeline version) skip
  // the LLM; heal retries naturally miss since their messages differ.
  const generatingAgent = withPromptCache(pool, agent as never);
  // Production traffic flows THROUGH the durable Mastra workflow
  // (analyze -> fidelity-gated generate/heal), registered below so run
  // snapshots persist to Mastra storage and traces reach Langfuse.
  const { createTopologyWorkflow } = await import("./workflow");
  const { topologyWorkflow } = createTopologyWorkflow({
    generator: generatingAgent,
  });
  const { tracingEnabled } = createMastraWithObservability(
    e,
    { "topology-generator": agent },
    store,
    { "code-topology-workflow": topologyWorkflow }
  );
  console.log(`langfuse tracing ${tracingEnabled ? "enabled" : "disabled"}`);

  // Provider-routed embeddings (SDD §6.2) through Mastra's model router —
  // no provider SDK imported here.
  const { ModelRouterEmbeddingModel } = await import("@mastra/core/llm");
  const embeddingModel = new ModelRouterEmbeddingModel(`openai/${e.EMBEDDING_MODEL}`);
  const embed = async (text: string): Promise<number[]> => {
    const { embeddings } = await embeddingModel.doEmbed({ values: [text] });
    const vector = embeddings[0];
    if (!vector) throw new Error("embedding provider returned no vector");
    return vector;
  };

  await startWorker({
    boss,
    pool,
    concurrency: e.WORKER_CONCURRENCY,
    execute: async (rawCode) => {
      const codeHash = createHash("sha256").update(rawCode).digest("hex");

      // Exact-match cache hit: identical snippet skips the LLM entirely.
      // Scoped to the pipeline version — stale pre-fidelity topologies
      // (pipeline_version '0-legacy') are invisible here.
      const cached = await getCachedTopology(pool, codeHash, PIPELINE_VERSION);
      if (cached) return cached;

      // Durable Mastra workflow run: analyze -> generate with fidelity-gated
      // healing. The analysis is recomputed here (deterministic, cheap) for
      // the dedup step below; run snapshots persist via @mastra/pg.
      const analysis = await analyzeCode(rawCode);
      const run = await topologyWorkflow.createRun();
      const result = await run.start({ inputData: { rawCode } });
      if (result.status !== "success") {
        throw new Error(
          `topology workflow did not succeed (status: ${result.status})`
        );
      }
      const candidate = result.result;
      // Similarity dedup above SIMILARITY_THRESHOLD returns the stored
      // topology; otherwise this snippet is registered with its embedding.
      const deduped = await dedupOrRegister(
        pool,
        embed,
        analysis,
        candidate,
        codeHash,
        analysis.language,
        { modelId: e.EMBEDDING_MODEL, threshold: e.SIMILARITY_THRESHOLD, pipelineVersion: PIPELINE_VERSION }
      );
      return deduped.topology;
    },
  });
  api = { pool, boss };
  console.log(`analysis API ready (workers=${e.WORKER_CONCURRENCY})`);
}

function ensureInit(): void {
  if (api || initPromise) return;
  initPromise = initApi()
    .then(() => {
      initPromise = null;
    })
    .catch((err: unknown) => {
      console.error("analysis API init failed:", err instanceof Error ? err.message : err);
      initPromise = null; // allow retry on next request
    });
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (req.method === "POST" && url.pathname === "/analyses") {
      ensureInit();
      if (initPromise) await initPromise;
      if (!api) {
        return Response.json({ error: "analysis API unavailable" }, { status: 503 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const rawCode = (body as { rawCode?: unknown }).rawCode;
      if (typeof rawCode !== "string" || rawCode.trim().length === 0) {
        return Response.json({ error: "rawCode is required" }, { status: 400 });
      }
      try {
        const result = await createAnalysisJob(api.pool, api.boss, rawCode);
        return Response.json(result, { status: 202 });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "submission failed" },
          { status: 500 }
        );
      }
    }

    const jobMatch = /^\/analyses\/([\w-]+)$/.exec(url.pathname);
    if (req.method === "GET" && jobMatch) {
      ensureInit();
      if (initPromise) await initPromise;
      if (!api) {
        return Response.json({ error: "analysis API unavailable" }, { status: 503 });
      }
      const status = await getAnalysisJob(api.pool, jobMatch[1]!);
      if (!status) return Response.json({ error: "job not found" }, { status: 404 });
      return Response.json(status);
    }

    return Response.json({
      service: "@underhood/backend",
      version: "0.1.0",
    });
  },
});

console.log(`@underhood/backend listening on :${server.port}`);
