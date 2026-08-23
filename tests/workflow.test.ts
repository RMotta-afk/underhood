import { describe, expect, test } from "bun:test";
import type { GraphTopology } from "../packages/types/src/index";
import { analyzeCode } from "../backend/src/workflow/steps/analyze-code";
import type { StructuralAnalysis } from "../backend/src/workflow/steps/analyze-code";
import type { TopologyGenerator } from "../backend/src/workflow/steps/generate-topology";
import {
  generateWithHealing,
  HealExhaustedError,
  validateGraph,
} from "../backend/src/workflow/steps/validate-graph";

// T4.1 — workflow composition acceptance: the real analyze step feeds a
// (mocked) generator through the validate/heal loop exactly like the live
// executor in backend/src/index.ts does.

const SNIPPET = `
function loadConfig(path) { return readFile(path); }
function main() {
  const config = loadConfig("cfg.json");
  if (!config.enabled) { return; }
  console.log(config.name);
}
main();
`;

function scriptedGenerator(
  outputs: unknown[]
): TopologyGenerator & { calls: Array<Array<{ role: string; content: string }>> } {
  let index = 0;
  return {
    calls: [],
    async generate(messages, _options) {
      this.calls.push(messages);
      return { object: outputs[Math.min(index++, outputs.length - 1)] };
    },
  };
}

function topologyFrom(analysis: StructuralAnalysis): GraphTopology {
  // Deterministic stand-in for the LLM: builds a well-formed chain from the
  // real analysis output so the pipeline contract is exercised end-to-end.
  const nodes = [
    {
      id: "entry",
      label: analysis.entryPoints[0] ?? "start",
      type: "entry" as const,
      plainDescription: "The program starts here.",
    },
    ...analysis.entities.map((entity) => ({
      id: `entity-${entity.name}`,
      label: entity.name,
      type: "process" as const,
      plainDescription: `${entity.name} runs its logic.`,
    })),
    ...(analysis.branches.length > 0
      ? [{
          id: "branch",
          label: "Decision",
          type: "branch" as const,
          plainDescription: "The program chooses what to do next.",
        }]
      : []),
    {
      id: "done",
      label: "Done",
      type: "terminal" as const,
      plainDescription: "The program finishes.",
    },
  ];
  const edges = nodes.slice(1).map((node, i) => ({
    id: `e${i}`,
    source: i === 0 ? nodes[0]!.id : nodes[i]!.id,
    target: node.id,
    animated: true,
  }));
  return { nodes, edges, detectedPatterns: [] };
}

describe("workflow composition (T4.1)", () => {
  test("analyze -> generate -> validate produces a schema-valid topology", async () => {
    const analysis = analyzeCode(SNIPPET);
    expect(analysis.entryPoints.length).toBeGreaterThan(0);

    const candidate = topologyFrom(analysis);
    const generator = scriptedGenerator([candidate]);
    const result = await generateWithHealing(analysis, generator);

    const validation = validateGraph(result);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
    // Every node keeps its plain-language promise (SDD §0).
    for (const node of result.nodes) {
      expect(node.plainDescription.length).toBeGreaterThan(0);
    }
  });

  test("heal retry injects the exact validation errors into the repair prompt", async () => {
    const analysis = analyzeCode(SNIPPET);
    const broken = topologyFrom(analysis);
    (broken as { edges: Array<{ target: string }> }).edges[0]!.target = "ghost";

    const fixed = topologyFrom(analysis);
    const generator = scriptedGenerator([broken, fixed]);
    const result = await generateWithHealing(analysis, generator);

    expect(validateGraph(result).valid).toBe(true);
    expect(generator.calls).toHaveLength(2);
    const repairPrompt = generator.calls[1]!.map((m) => m.content).join("\n");
    expect(repairPrompt).toContain("FAILED validation");
    expect(repairPrompt).toContain('missing target node "ghost"');
    expect(repairPrompt).toContain(JSON.stringify(broken));
  });

  test("pipeline fails deterministically when healing is exhausted", async () => {
    const analysis = analyzeCode(SNIPPET);
    const alwaysBroken = topologyFrom(analysis);
    (alwaysBroken as { edges: Array<{ target: string }> }).edges[0]!.target = "ghost";

    const generator = scriptedGenerator([alwaysBroken]);
    try {
      await generateWithHealing(analysis, generator, 2);
      throw new Error("expected HealExhaustedError");
    } catch (err) {
      expect(err).toBeInstanceOf(HealExhaustedError);
      expect((err as HealExhaustedError).attempts).toBe(3); // initial + 2 retries
      expect(generator.calls).toHaveLength(3);
    }
  });
});
