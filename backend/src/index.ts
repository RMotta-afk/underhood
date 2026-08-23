import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

// @underhood/backend entrypoint (SDD §5): health + async analysis API.
// The API initializes only when DATABASE_URL is available; the health server
// stays up regardless so orchestrators can probe readiness.
import { getBoss } from "./queue/boss";
import { startWorker } from "./queue/worker";
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
  const { pool } = await wirePostgres(e.DATABASE_URL);
  await ensureAnalysisJobsTable(pool);
  const boss = await getBoss(e.DATABASE_URL);
  // Real pipeline executor: analyze -> generate -> validate/heal (G2 chain).
  // Imported lazily to keep boot light and avoid cycles in tests.
  const [{ analyzeCode }, { createTopologyAgent, generateTopology }, { validateGraph }] =
    await Promise.all([
      import("./workflow/steps/analyze-code"),
      import("./workflow/steps/generate-topology"),
      import("./workflow/steps/validate-graph"),
    ]);
  const agent = createTopologyAgent();
  await startWorker({
    boss,
    pool,
    concurrency: e.WORKER_CONCURRENCY,
    execute: async (rawCode) => {
      const analysis = analyzeCode(rawCode);
      const candidate = await generateTopology(analysis, agent as never);
      const validation = validateGraph(candidate);
      if (!validation.valid) {
        throw new Error(`generated topology failed validation: ${validation.errors.join("; ")}`);
      }
      return candidate;
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
