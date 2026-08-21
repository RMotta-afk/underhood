import { describe, expect, test } from "bun:test";
import {
  EdgeSchema,
  GraphCacheSchema,
  GraphTopologySchema,
  JobStatusSchema,
  NodeSchema,
} from "./index";

const validNode = {
  id: "n1",
  label: "Parse input",
  type: "process",
  plainDescription: "Reads the raw text and figures out its structure.",
};

describe("NodeSchema", () => {
  test("accepts a valid node", () => {
    expect(NodeSchema.safeParse(validNode).success).toBe(true);
  });

  test("rejects a node without plainDescription (plain-language mandate)", () => {
    const { plainDescription: _omitted, ...withoutDescription } = validNode;
    expect(NodeSchema.safeParse(withoutDescription).success).toBe(false);
  });

  test("rejects unknown node types", () => {
    expect(
      NodeSchema.safeParse({ ...validNode, type: "widget" }).success
    ).toBe(false);
  });
});

describe("GraphTopologySchema", () => {
  test("parses a full topology with animated edge default applied", () => {
    const parsed = GraphTopologySchema.parse({
      nodes: [validNode],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
      detectedPatterns: ["State Machine"],
    });
    expect(parsed.edges[0]?.animated).toBe(true);
  });
});

describe("GraphCacheSchema", () => {
  test("requires a 64-char SHA-256 codeHash", () => {
    const base = {
      codeHash: "a".repeat(64),
      language: "typescript",
      topologyPayload: { nodes: [], edges: [], detectedPatterns: [] },
      createdAt: new Date(),
    };
    expect(GraphCacheSchema.safeParse(base).success).toBe(true);
    expect(
      GraphCacheSchema.safeParse({ ...base, codeHash: "short" }).success
    ).toBe(false);
  });
});

describe("JobStatusSchema", () => {
  test("completed status requires a topology payload", () => {
    expect(
      JobStatusSchema.safeParse({ jobId: "j1", status: "queued" }).success
    ).toBe(true);
    expect(
      JobStatusSchema.safeParse({ jobId: "j1", status: "completed" }).success
    ).toBe(false);
    expect(
      JobStatusSchema.safeParse({
        jobId: "j1",
        status: "completed",
        topology: { nodes: [], edges: [], detectedPatterns: [] },
      }).success
    ).toBe(true);
  });

  test("failed status requires an error message", () => {
    expect(
      JobStatusSchema.safeParse({ jobId: "j1", status: "failed" }).success
    ).toBe(false);
    expect(
      JobStatusSchema.safeParse({ jobId: "j1", status: "failed", error: "boom" })
        .success
    ).toBe(true);
  });

  test("rejects unknown statuses", () => {
    expect(
      JobStatusSchema.safeParse({ jobId: "j1", status: "paused" }).success
    ).toBe(false);
  });
});
