import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  JobStatusSchema,
  type JobStatus,
  type JobSubmitResponse,
} from "@underhood/types";
import { ANALYSIS_QUEUE } from "../../queue/boss";

// T5.1 — Async API (SDD §5.1): POST /analyses enqueues via pg-boss and
// returns { jobId } immediately; GET /analyses/:jobId returns JobStatusSchema.
// Job state lives in the same PostgreSQL instance (no shadow stores).

export async function ensureAnalysisJobsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analysis_jobs (
      job_id UUID PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
      topology JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

const MAX_RAW_CODE_BYTES = 512 * 1024;

/** Validate input, persist a queued job, and hand it to the queue. */
export async function createAnalysisJob(
  pool: Pool,
  boss: PgBoss,
  rawCode: string
): Promise<JobSubmitResponse> {
  if (
    !rawCode ||
    typeof rawCode !== "string" ||
    rawCode.trim().length === 0 ||
    rawCode.length > MAX_RAW_CODE_BYTES
  ) {
    throw new Error(
      `rawCode is required and must be under ${MAX_RAW_CODE_BYTES} bytes`
    );
  }
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO analysis_jobs (job_id, status) VALUES ($1, 'queued')`,
    [jobId]
  );
  try {
    await boss.send(ANALYSIS_QUEUE, { jobId, rawCode });
  } catch (err) {
    await setJobStatus(pool, jobId, "failed", undefined, "queueing failed");
    throw new Error("Job enqueue failed", { cause: err });
  }
  return { jobId };
}

interface JobRow {
  job_id: string;
  status: string;
  topology: unknown;
  error: string | null;
}

export async function getAnalysisJob(
  pool: Pool,
  jobId: string
): Promise<JobStatus | null> {
  const result = await pool.query<JobRow>(
    `SELECT job_id, status, topology, error FROM analysis_jobs WHERE job_id = $1`,
    [jobId]
  );
  const row = result.rows[0];
  if (!row) return null;
  // Defensive: response always validated against the shared contract.
  return JobStatusSchema.parse({
    jobId: row.job_id,
    status: row.status,
    ...(row.status === "completed" ? { topology: row.topology } : {}),
    ...(row.error ? { error: row.error } : {}),
  });
}

export async function setJobStatus(
  pool: Pool,
  jobId: string,
  status: "running"
): Promise<void>;
export async function setJobStatus(
  pool: Pool,
  jobId: string,
  status: "completed",
  topology: unknown
): Promise<void>;
export async function setJobStatus(
  pool: Pool,
  jobId: string,
  status: "failed",
  topology: undefined,
  error: string
): Promise<void>;
export async function setJobStatus(
  pool: Pool,
  jobId: string,
  status: "running" | "completed" | "failed",
  topology?: unknown,
  error?: string
): Promise<void> {
  if (status === "completed") {
    await pool.query(
      `UPDATE analysis_jobs SET status = $2, topology = $3, updated_at = now() WHERE job_id = $1`,
      [jobId, status, JSON.stringify(topology)]
    );
    return;
  }
  if (status === "failed") {
    await pool.query(
      `UPDATE analysis_jobs SET status = $2, error = $3, updated_at = now() WHERE job_id = $1`,
      [jobId, status, error ?? "unknown error"]
    );
    return;
  }
  await pool.query(
    `UPDATE analysis_jobs SET status = $2, updated_at = now() WHERE job_id = $1`,
    [jobId, status]
  );
}
