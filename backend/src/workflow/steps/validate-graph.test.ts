import { describe, expect, test } from "bun:test";
import {
  generateWithHealing,
  HealExhaustedError,
  validateGraph,
} from "./validate-graph";
import type { TopologyGenerator } from "./generate-topology";
import type { StructuralAnalysis } from "./analyze-code";
import type { GraphTopology } from "@underhood/types";
import type { TopologyGenerationSchema } from "@underhood/types";

const validTopology = {
  nodes: [
    { id: "n1", label: "Start", type: "entry", plainDescription: "Begins." },
    { id: "n2", label: "End", type: "terminal", plainDescription: "Finishes." },
  ],
  edges: [{ id: "e1", source: "n1", target: "n2", animated: true }],
  detectedPatterns: [],
} satisfies GraphTopology;

function countingGenerator(
  outputs: unknown[]
): TopologyGenerator & { getCalls(): number } {
  let calls = 0;
  const generator = {
    getCalls: () => calls,
    async generate(
      _messages: Array<{ role: "system" | "user"; content: string }>,
      _options: { structuredOutput: { schema: typeof TopologyGenerationSchema } }
    ) {
      return { object: outputs[Math.min(calls++, outputs.length - 1)] };
    },
  };
  return generator;
}

const analysis: StructuralAnalysis = {
  language: "javascript",
  entryPoints: ["main"],
  entities: [{ name: "main", kind: "function" }],
  branches: [],
  ioOperations: [{ kind: "console", callee: "console.log" }],
  statementCount: 3,
  hasAsync: false,
  normalizedSkeleton: "entities:function main|branches:{}|io:{\"console\":1}|async:false",
};

describe("validateGraph (T2.3)", () => {
  test("accepts a referentially intact topology", () => {
    const v = validateGraph(validTopology);
    expect(v.valid).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  test("catches dangling edge references (core SDD check)", () => {
    const v = validateGraph({
      ...validTopology,
      edges: [{ id: "e1", source: "n1", target: "ghost" }],
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toContain('missing target node "ghost"');
  });

  test("catches schema violations with path-qualified errors", () => {
    const v = validateGraph({
      nodes: [{ id: "n1", label: "No description", type: "entry" }],
      edges: [],
      detectedPatterns: [],
    });
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toContain("plainDescription");
  });

  test("flags duplicate node ids and empty graphs", () => {
    const dup = validateGraph({
      ...validTopology,
      nodes: [validTopology.nodes[0], validTopology.nodes[0]],
    });
    expect(dup.errors.join()).toContain('duplicate node id "n1"');

    const empty = validateGraph({ nodes: [], edges: [], detectedPatterns: [] });
    expect(empty.errors.join()).toContain("no nodes");
  });

  test("warns on disconnected nodes without failing", () => {
    const v = validateGraph({
      nodes: [
        ...validTopology.nodes,
        { id: "n3", label: "Lonely", type: "process", plainDescription: "Unused." },
      ],
      edges: validTopology.edges,
      detectedPatterns: [],
    });
    expect(v.valid).toBe(true);
    expect(v.warnings.join()).toContain('"n3" is disconnected');
  });
});

describe("generateWithHealing / selfHealBranch (T2.3)", () => {

  test("returns first valid output without retries", async () => {
    const gen = countingGenerator([validTopology]);
    const result = await generateWithHealing(analysis, gen);
    expect(result).toEqual(validTopology);
    expect(gen.getCalls()).toBe(1);
  });

  test("heals once by injecting validation errors into the retry", async () => {
    // First attempt: dangling edge. Second attempt: valid.
    const broken = {
      ...validTopology,
      edges: [{ id: "e1", source: "n1", target: "ghost" }],
    };
    const gen = countingGenerator([broken, validTopology]);
    const result = await generateWithHealing(analysis, gen);
    expect(result).toEqual(validTopology);
    expect(gen.getCalls()).toBe(2);
  });

  test("fails deterministically after maxRetries (2) with accumulated errors", async () => {
    const alwaysBroken = {
      ...validTopology,
      edges: [{ id: "e1", source: "missing-src", target: "ghost-target" }],
    };
    const gen = countingGenerator([alwaysBroken]);
    try {
      await generateWithHealing(analysis, gen, 2);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HealExhaustedError);
      const healErr = err as HealExhaustedError;
      expect(healErr.attempts).toBe(3); // initial + 2 retries
      expect(healErr.errors.length).toBeGreaterThan(0);
    }
    expect(gen.getCalls()).toBe(3);
  });

  test("custom maxRetries respected", async () => {
    const alwaysBroken = {
      ...validTopology,
      edges: [{ id: "e1", source: "n1", target: "ghost" }],
    };
    const gen = countingGenerator([alwaysBroken]);
    try {
      await generateWithHealing(analysis, gen, 0);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as HealExhaustedError).attempts).toBe(1);
    }
    expect(gen.getCalls()).toBe(1);
  });
});
