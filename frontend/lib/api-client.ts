/**
 * Typed API client for the Underhood async analysis API (SDD §5.1).
 * All responses are parsed through the shared Zod schemas — the frontend
 * never trusts raw wire data (No Manual Type Duplication, SDD §8).
 */
import {
  GraphTopologySchema,
  JobStatusSchema,
  JobSubmitResponseSchema,
  type GraphTopology,
  type JobStatus,
} from "@underhood/types";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** POST /analyses → { jobId } (202). Throws ApiError on invalid input/reject. */
export async function submitAnalysis(rawCode: string): Promise<string> {
  if (!rawCode || rawCode.trim().length === 0) {
    throw new ApiError("Code snippet is required", 400);
  }
  const response = await fetch(`${API_BASE}/analyses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rawCode }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errValue =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: unknown }).error
        : undefined;
    const message =
      typeof errValue === "string"
        ? errValue
        : `Submission failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  const parsed = JobSubmitResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError("Malformed submission response");
  }
  return parsed.data.jobId;
}

/** GET /analyses/:jobId → JobStatus. Returns null on 404. */
export async function getAnalysis(jobId: string): Promise<JobStatus | null> {
  const response = await fetch(`${API_BASE}/analyses/${jobId}`);
  if (response.status === 404) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(`Status check failed (${response.status})`, response.status);
  }
  const parsed = JobStatusSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError("Malformed job status response");
  }
  return parsed.data;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (status: JobStatus) => void;
}

/** Poll until terminal state (completed/failed) or timeout. */
export async function pollAnalysis(
  jobId: string,
  { intervalMs = 750, timeoutMs = 120_000, signal, onUpdate }: PollOptions = {}
): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Polling aborted", "AbortError");
    const status = await getAnalysis(jobId);
    if (!status) throw new ApiError(`Job ${jobId} not found`, 404);
    onUpdate?.(status);
    if (status.status === "completed" || status.status === "failed") {
      return status;
    }
    if (Date.now() > deadline) {
      throw new ApiError(`Job ${jobId} timed out after ${timeoutMs}ms`);
    }
    await new Promise((r, reject) => {
      const id = setTimeout(r, intervalMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new DOMException("Polling aborted", "AbortError"));
      });
    });
  }
}

/** Type-guard re-export so components can narrow completed payloads safely. */
export function asTopology(status: JobStatus): GraphTopology | null {
  const result = GraphTopologySchema.safeParse(status.topology);
  return result.success ? result.data : null;
}
