import { describe, expect, test } from "bun:test";
import {
  EdgeSchema,
  GraphCacheSchema,
  GraphTopologySchema,
  JobStatusSchema,
  JobSubmitResponseSchema,
} from "../packages/types/src/index";

// T4.1 — cross-cutting schema acceptance suite (SDD §3). The per-package
// unit tests cover internals; this suite pins the *contracts* every boundary
// (API, queue payloads, cache rows, renderers) depends on.

const validNode = {
  id: "n1",
  label: "main",
  type: "entry" as const,
  plainDescription: "Starts the program.",
};

describe("GraphTopologySchema contract", () => {
  test("parses a valid topology and applies the animated default", () => {
    const parsed = GraphTopologySchema.parse({
      nodes: [validNode],
      edges: [{ id: "e1", source: "n1", target: "n1" }],
      detectedPatterns: ["Entry Point"],
    });
    expect(parsed.edges[0]!.animated).toBe(true);
  });

  test("EdgeSchema keeps explicit animated values", () => {
    expect(EdgeSchema.parse({ id: "e", source: "a", target: "b", animated: false }).animated).toBe(false);
  });

  test("rejects nodes without a plain-language description", () => {
    const result = GraphTopologySchema.safeParse({
      nodes: [{ id: "n1", label: "main", type: "entry" }],
      edges: [],
      detectedPatterns: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown node types", () => {
    const result = GraphTopologySchema.safeParse({
      nodes: [{ ...validNode, type: "quantum" }],
      edges: [],
      detectedPatterns: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("JobStatusSchema async contract (SDD §3.3)", () => {
  const base = { jobId: "11111111-1111-1111-1111-111111111111" };

  test("queued/running statuses need neither topology nor error", () => {
    for (const status of ["queued", "running"] as const) {
      const parsed = JobStatusSchema.safeParse({ ...base, status });
      expect(parsed.success).toBe(true);
    }
  });

  test("completed requires a topology payload", () => {
    const missing = JobStatusSchema.safeParse({ ...base, status: "completed" });
    expect(missing.success).toBe(false);

    const complete = JobStatusSchema.safeParse({
      ...base,
      status: "completed",
      topology: { nodes: [validNode], edges: [], detectedPatterns: [] },
    });
    expect(complete.success).toBe(true);
  });

  test("failed requires an error message", () => {
    const missing = JobStatusSchema.safeParse({ ...base, status: "failed" });
    expect(missing.success).toBe(false);

    const failed = JobStatusSchema.safeParse({ ...base, status: "failed", error: "boom" });
    expect(failed.success).toBe(true);
  });

  test("submit response contract is jobId-only", () => {
    const parsed = JobSubmitResponseSchema.parse({ jobId: "abc-123" });
    expect(parsed.jobId).toBe("abc-123");
    // Unknown keys are stripped, never trusted.
    expect(Object.keys(parsed)).toEqual(["jobId"]);
  });
});

describe("GraphCacheSchema persistence contract (SDD §3.2)", () => {
  test("round-trips a cache entry, coercing ISO dates over JSON boundaries", () => {
    const topology = {
      nodes: [validNode],
      edges: [],
      detectedPatterns: [],
    };
    const wire = {
      codeHash: "a".repeat(64),
      language: "javascript",
      topologyPayload: topology,
      createdAt: new Date().toISOString(),
    };
    const parsed = GraphCacheSchema.parse(wire);
    expect(parsed.createdAt instanceof Date).toBe(true);
    expect(parsed.topologyPayload).toEqual(topology);
  });

  test("enforces sha-256 hex length on codeHash", () => {
    const result = GraphCacheSchema.safeParse({
      codeHash: "short",
      language: "javascript",
      topologyPayload: { nodes: [], edges: [], detectedPatterns: [] },
      createdAt: new Date(),
    });
    expect(result.success).toBe(false);
  });
});
