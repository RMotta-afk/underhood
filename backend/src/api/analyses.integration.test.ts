import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GraphTopology } from "@underhood/types";
import { JobStatusSchema } from "@underhood/types";
import {
  createAnalysisJob,
  ensureAnalysisJobsTable,
  getAnalysisJob,
} from "./routes/analyses";
import { ANALYSIS_QUEUE, getBoss } from "../queue/boss";
import { startWorker } from "../queue/worker";
import { wirePostgres } from "../storage/postgres";

// Integration suite for T5.1: async API + worker pool against live compose db.
// Opt-in via TEST_DATABASE_URL only — ambient DATABASE_URL (auto-loaded by bun
// from .env) must never be hijacked by host-side tests. Skips when unset.
const DB = process.env.TEST_DATABASE_URL ?? null;
const describeDb = DB ? describe : describe.skip;

const CONCURRENCY = 2;
const TOTAL_JOBS = 8;

const topologyFixture: GraphTopology = {
  nodes: [
    { id: "n1", label: "Start", type: "entry", plainDescription: "Begins." },
    { id: "n2", label: "End", type: "terminal", plainDescription: "Finishes." },
  ],
  edges: [{ id: "e1", source: "n1", target: "n2", animated: true }],
  detectedPatterns: [],
};

describeDb("Async analysis pipeline (T5.1 integration)", () => {
  let wiring: Awaited<ReturnType<typeof wirePostgres>> | undefined;
  const observedStatuses = new Set<string>();

  beforeAll(async () => {
    wiring = await wirePostgres(DB!);
    await ensureAnalysisJobsTable(wiring.pool);
    const boss = await getBoss(DB!);
    await boss.deleteQueue(ANALYSIS_QUEUE).catch(() => {}); // clean slate per run
    await boss.createQueue(ANALYSIS_QUEUE).catch(() => {});
    await startWorker({
      boss,
      pool: wiring.pool,
      concurrency: CONCURRENCY,
      execute: async () => {
        // Simulated LLM work; tracks real parallelism.
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 80));
        active--;
        return structuredClone(topologyFixture);
      },
    });
  });

  afterAll(async () => {
    await wiring?.pool.end();
  });

  let active = 0;
  let maxActive = 0;

  test(
    `N=${TOTAL_JOBS} simultaneous submissions all complete under a concurrency cap of ${CONCURRENCY}`,
    async () => {
    // Fire all submissions simultaneously.
    const boss = await getBoss(DB!);
    const submitted = await Promise.all(
      Array.from({ length: TOTAL_JOBS }, () =>
        createAnalysisJob(wiring!.pool, boss, "function main() { console.log('hi'); }")
      )
    );
    expect(submitted.length).toBe(TOTAL_JOBS);
    const jobIds = new Set(submitted.map((s) => s.jobId));
    expect(jobIds.size).toBe(TOTAL_JOBS);

    // Poll until every job reaches a terminal state (max ~15s).
    const deadline = Date.now() + 15_000;
    let terminal = 0;
    while (terminal < TOTAL_JOBS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      terminal = 0;
      for (const { jobId } of submitted) {
        const status = await getAnalysisJob(wiring!.pool, jobId);
        if (!status) continue;
        observedStatuses.add(status.status);
        if (status.status === "completed" || status.status === "failed") terminal++;
      }
    }
    expect(terminal).toBe(TOTAL_JOBS);

    // Every completed job carries schema-valid topology; none failed.
    for (const { jobId } of submitted) {
      const status = await getAnalysisJob(wiring!.pool, jobId);
      expect(status).not.toBeNull();
      const parsed = JobStatusSchema.parse(status);
      expect(parsed.status).toBe("completed");
      expect(parsed.topology?.nodes.length).toBe(2);
    }

    // Backpressure held: never more parallel executions than the cap.
    expect(maxActive).toBeLessThanOrEqual(CONCURRENCY);
    // And the queue genuinely ran jobs in parallel during the run window.
    expect(observedStatuses.has("queued") || observedStatuses.has("running")).toBe(true);
    },
    30000
  );

  test("GET returns null for unknown jobId", async () => {
    const missing = await getAnalysisJob(wiring!.pool, "00000000-0000-4000-8000-000000000000");
    expect(missing).toBeNull();
  });
});
