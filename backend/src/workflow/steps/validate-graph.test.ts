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
  edges: [{ id: "e1", source: "n1", target: "n2", animated: true, label: "" }],
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

// Binary-search-like analysis: one loop + two conditionals (T6.1 fidelity).
const branchyAnalysis: StructuralAnalysis = {
  ...analysis,
  branches: [{ kind: "loop" }, { kind: "if" }, { kind: "if" }],
  flows: [
    {
      entity: "binarySearch",
      steps: [
        { kind: "loop", label: "loop while left <= right", condition: "left <= right" },
        { kind: "branch", label: "if (arr[mid] === target)", condition: "arr[mid] === target" },
        { kind: "return", label: "return mid" },
        { kind: "branch", label: "if (arr[mid] < target)", condition: "arr[mid] < target" },
      ],
    },
  ],
};

/** Faithful topology for branchyAnalysis: loop cycle + decision fan-out. */
const faithfulTopology = {
  nodes: [
    { id: "entry", label: "binarySearch", type: "entry", plainDescription: "Starts the search." },
    { id: "loopCheck", label: "left <= right?", type: "branch", plainDescription: "Checks if the search range is not empty yet." },
    { id: "found", label: "found?", type: "branch", plainDescription: "Checks whether the middle element is the target." },
    { id: "hit", label: "Return index", type: "terminal", plainDescription: "The target was found; its position comes back." },
    { id: "dirCheck", label: "which half?", type: "branch", plainDescription: "Decides which half of the range to keep searching." },
    { id: "exhausted", label: "Not found", type: "terminal", plainDescription: "The range emptied out; the target is absent." },
  ],
  edges: [
    { id: "e1", source: "entry", target: "loopCheck", animated: true, label: "" },
    { id: "e2", source: "loopCheck", target: "found", animated: true, label: "yes" },
    { id: "e3", source: "loopCheck", target: "exhausted", animated: false, label: "no" },
    { id: "e4", source: "found", target: "hit", animated: false, label: "yes" },
    { id: "e5", source: "found", target: "dirCheck", animated: true, label: "no" },
    { id: "e6", source: "dirCheck", target: "loopCheck", animated: true, label: "" }, // back-edge
  ],
  detectedPatterns: ["Binary Search"],
};

describe("validateGraph fidelity checks (T6.1)", () => {
  test("accepts a topology that faithfully mirrors the declared control flow", () => {
    const v = validateGraph(faithfulTopology, branchyAnalysis);
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
  });

  test("backstop: a trivial topology is rejected when the analysis extracted nothing", () => {
    // Regression guard for the Python binary search incident: unparseable code
    // used to produce an empty analysis whose Start -> End graph validated.
    const emptyAnalysis: StructuralAnalysis = {
      ...analysis,
      entryPoints: ["(module)"],
      entities: [],
      branches: [],
      ioOperations: [],
      statementCount: 0,
      normalizedSkeleton: "entities:|branches:{}|io:{}|async:false",
    };
    const v = validateGraph(validTopology, emptyAnalysis);
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toContain("extracted no code structure");
  });

  test("rejects a lazy straight-line graph when conditionals are declared", () => {
    const v = validateGraph(validTopology, branchyAnalysis);
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toContain("no branch nodes");
    expect(v.errors.join()).toContain("no cycle");
  });

  test("warns on a branch node with a single outgoing path (convergence is legal)", () => {
    // Drop loopCheck's "no" exit: it keeps the back-edge cycle (via
    // found -> dirCheck -> loopCheck) but shows only one decision outcome.
    const singleExit = {
      nodes: faithfulTopology.nodes,
      edges: faithfulTopology.edges.filter((e) => e.id !== "e3"),
      detectedPatterns: [],
    };
    const v = validateGraph(singleExit, branchyAnalysis);
    expect(v.valid).toBe(true);
    expect(v.warnings.join()).toContain('"loopCheck" has fewer than two outgoing paths');
  });

  test("warns (not errors) on calls to entities missing from the graph", () => {
    const withUnresolvedCall: StructuralAnalysis = {
      ...analysis,
      flows: [
        {
          entity: "main",
          steps: [{ kind: "call", label: "call helper", callee: "helper" }],
        },
      ],
    };
    const v = validateGraph(validTopology, withUnresolvedCall);
    expect(v.valid).toBe(true);
    expect(v.warnings.join()).toContain('"helper" has no matching node');
  });

  test("fidelity checks stay silent without an analysis", () => {
    const v = validateGraph(validTopology);
    expect(v.valid).toBe(true);
  });
});

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
