import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { ANALYSIS_QUEUE } from "./boss";
import { setJobStatus } from "../api/routes/analyses";

// T5.1 — Worker pool (SDD §5.1): pulls analysis jobs with a concurrency cap
// (WORKER_CONCURRENCY) and executes the Mastra pipeline per job.

export type AnalysisExecutor = (rawCode: string) => Promise<unknown>;

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export interface StartWorkerOptions {
  boss: PgBoss;
  pool: Pool;
  /** Max jobs executing in parallel (SDD backpressure cap). */
  concurrency: number;
  /** Pipeline executor; inject a mock in tests, the real workflow in prod. */
  execute: AnalysisExecutor;
}

/**
 * Registers `concurrency` independent consumers on the analysis queue so up to
 * `concurrency` jobs execute truly in parallel. Each consumer polls batches of
 * one; pg-boss delivers work only while a consumer is idle.
 */
export async function startWorker({
  boss,
  pool,
  concurrency,
  execute,
}: StartWorkerOptions): Promise<WorkerHandle> {
  const unregisterFns: Array<() => void | Promise<void>> = [];

  for (let i = 0; i < Math.max(1, Math.floor(concurrency)); i++) {
    const off = await boss.work(
      ANALYSIS_QUEUE,
      { batchSize: 1 },
      // v12 delivers a Job[] batch; we registered batchSize:1 so it holds one.
      async (jobs: Array<{ data: { jobId: string; rawCode: string } }>) => {
        for (const job of jobs) {
          const { jobId, rawCode } = job.data;
          await setJobStatus(pool, jobId, "running");
          try {
            const topology = await execute(rawCode);
            await setJobStatus(pool, jobId, "completed", topology);
          } catch (err) {
            await setJobStatus(
              pool,
              jobId,
              "failed",
              undefined,
              err instanceof Error ? err.message : String(err)
            );
          }
        }
      }
    );
    if (typeof off === "function") unregisterFns.push(off);
  }

  return {
    stop: async () => {
      for (const off of unregisterFns) await off();
    },
  };
}
