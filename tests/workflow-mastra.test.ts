import { describe, expect, test } from "bun:test";
import { createTopologyWorkflow } from "../backend/src/workflow";
import type { TopologyGenerator } from "../backend/src/workflow/steps/generate-topology";
import type { TopologyGenerationSchema } from "@underhood/types";

// T6.3 — the Mastra topology workflow is the LIVE production path: a run
// through createRun/start must produce a schema-valid topology using an
// injected mock generator, proving analyze -> generate(heal) composition.

const SNIPPET = `
function binarySearch(arr, target) {
  let left = 0;
  let right = arr.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) { left = mid + 1; } else { right = mid - 1; }
  }
  return -1;
}
console.log(binarySearch([1, 5, 9], 9));
`;

/** Faithful mock topology for the binary search analysis (branch + cycle). */
function mockTopology(): unknown {
  return {
    nodes: [
      { id: "n1", label: "binarySearch", type: "entry", plainDescription: "Starts the search over the sorted array." },
      { id: "n2", label: "Range not empty?", type: "branch", plainDescription: "Checks whether any range is left to search." },
      { id: "n3", label: "Middle match?", type: "branch", plainDescription: "Checks if the middle element is the target." },
      { id: "n4", label: "Found", type: "terminal", plainDescription: "The target exists; its position comes back." },
      { id: "n5", label: "Missing", type: "terminal", plainDescription: "The range emptied; the target is absent." },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", animated: true, label: "" },
      { id: "e2", source: "n2", target: "n3", animated: true, label: "yes" },
      { id: "e3", source: "n2", target: "n5", animated: false, label: "no" },
      { id: "e4", source: "n3", target: "n4", animated: false, label: "yes" },
      { id: "e5", source: "n3", target: "n2", animated: true, label: "no, keep halving" },
    ],
    detectedPatterns: ["Binary Search"],
  };
}

function scriptedGenerator(outputs: unknown[]): TopologyGenerator & { calls: number } {
  let calls = 0;
  return {
    async generate(
      _messages: Array<{ role: "system" | "user"; content: string }>,
      _options: { structuredOutput: { schema: typeof TopologyGenerationSchema } }
    ) {
      const object = outputs[Math.min(calls++, outputs.length - 1)];
      return { object };
    },
    get calls() {
      return calls;
    },
  };
}

/** Narrow WorkflowResult to the success arm (expect() does not narrow). */
function expectSuccess<T>(result: { status: string } & T): T & { status: "success" } {
  if (result.status !== "success") throw new Error(`workflow status: ${result.status}`);
  return result as T & { status: "success" };
}

describe("topologyWorkflow live path (T6.3)", () => {
  test("createRun/start executes analyze -> generate and returns valid topology", async () => {
    const generator = scriptedGenerator([mockTopology()]);
    const { topologyWorkflow } = createTopologyWorkflow({ generator });

    const run = await topologyWorkflow.createRun();
    const result = expectSuccess(await run.start({ inputData: { rawCode: SNIPPET } }));

    expect(generator.calls).toBe(1);
    // The workflow output carries the faithful graph: branch nodes + cycle.
    const nodes = result.result.nodes;
    const edges = result.result.edges;
    expect(nodes.filter((n) => n.type === "branch").length).toBeGreaterThan(0);
    expect(edges.some((e) => e.source === "n3" && e.target === "n2")).toBe(true);
  });

  test("heals a lazy first attempt through the workflow step", async () => {
    const lazy = {
      nodes: [
        { id: "n1", label: "Start", type: "entry", plainDescription: "Begins the program flow." },
        { id: "n2", label: "End", type: "terminal", plainDescription: "Finishes the program flow." },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2", animated: true, label: "" }],
      detectedPatterns: [],
    };
    const generator = scriptedGenerator([lazy, mockTopology()]);
    const { topologyWorkflow } = createTopologyWorkflow({ generator });

    const run = await topologyWorkflow.createRun();
    const result = expectSuccess(await run.start({ inputData: { rawCode: SNIPPET } }));

    expect(result.status).toBe("success");
    // First attempt rejected by fidelity validation -> heal retry fired.
    expect(generator.calls).toBe(2);
    expect(result.result.nodes.length).toBe(5);
  });
});
