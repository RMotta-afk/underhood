import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  asTopology,
  getAnalysis,
  pollAnalysis,
  submitAnalysis,
} from "./api-client";

const validTopology = {
  nodes: [
    { id: "n1", label: "Start", type: "entry", plainDescription: "Begins." },
    { id: "n2", label: "End", type: "terminal", plainDescription: "Finishes." },
  ],
  edges: [{ id: "e1", source: "n1", target: "n2", animated: true }],
  detectedPatterns: [],
};

// Save/restore rather than delete: bun test shares one process across all
// suites, and deleting globalThis.fetch breaks other libraries that inspect it.
const originalFetch = globalThis.fetch;

function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>
): void {
  // Test double only implements call semantics, not the full fetch surface
  // (e.g. Bun's `preconnect`), hence the cast.
  globalThis.fetch = (async (
    input: string | URL,
    init?: RequestInit
  ): Promise<Response> => handler(String(input), init)) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("submitAnalysis", () => {
  test("rejects empty snippets before any network call", async () => {
    try {
      await submitAnalysis("   ");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
  });

  test("posts rawCode and returns typed jobId", async () => {
    let capturedBody: unknown;
    stubFetch(async (url, init) => {
      expect(url).toContain("/analyses");
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 });
    });
    const jobId = await submitAnalysis("function main() {}");
    expect(jobId).toBe("job-1");
    expect((capturedBody as { rawCode: string }).rawCode).toContain("main");
  });

  test("surfaces backend error messages", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: "analysis API unavailable" }), {
          status: 503,
        })
    );
    try {
      await submitAnalysis("code");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(503);
      expect((err as ApiError).message).toContain("unavailable");
    }
  });
});

describe("getAnalysis / pollAnalysis", () => {
  test("parses completed status with topology through shared schema", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            jobId: "job-1",
            status: "completed",
            topology: validTopology,
          }),
          { status: 200 }
        )
    );
    const status = await pollAnalysis("job-1");
    expect(status.status).toBe("completed");
    const topology = asTopology(status);
    expect(topology?.nodes[0]?.plainDescription).toBe("Begins.");
  });

  test("polls until terminal state, reporting updates along the way", async () => {
    const states = [
      { jobId: "j", status: "queued" },
      { jobId: "j", status: "running" },
      { jobId: "j", status: "completed", topology: validTopology },
    ];
    let call = 0;
    stubFetch(async () => new Response(JSON.stringify(states[Math.min(call++, 2)])));
    const seen: string[] = [];
    const final = await pollAnalysis("j", {
      intervalMs: 1,
      onUpdate: (s) => seen.push(s.status),
    });
    expect(final.status).toBe("completed");
    expect(seen).toEqual(["queued", "running", "completed"]);
  });

  test("returns null on 404 and throws on malformed payloads", async () => {
    stubFetch(async () => new Response("{}", { status: 404 }));
    expect(await getAnalysis("ghost")).toBeNull();

    stubFetch(async () => new Response(JSON.stringify({ nonsense: true })));
    try {
      await getAnalysis("j");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Malformed");
    }
  });

  test("failed jobs surface their error message", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ jobId: "j", status: "failed", error: "LLM quota exceeded" }),
          { status: 200 }
        )
    );
    const final = await pollAnalysis("j", { intervalMs: 1 });
    expect(final.status).toBe("failed");
    expect(final.error).toContain("quota");
  });
});
