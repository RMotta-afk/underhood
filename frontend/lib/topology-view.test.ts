import { describe, expect, test } from "bun:test";
import type { GraphTopology } from "@underhood/types";
import {
  buildTopologyView,
  NODE_HEIGHT,
  NODE_WIDTH,
  TYPE_STYLES,
} from "./topology-view";

const topology: GraphTopology = {
  nodes: [
    { id: "n1", label: "main", type: "entry", plainDescription: "Starts the program." },
    { id: "n2", label: "Fetch data", type: "io", plainDescription: "Downloads data." },
    { id: "n3", label: "Retry?", type: "branch", plainDescription: "Checks if it should try again." },
    { id: "n4", label: "Done", type: "terminal", plainDescription: "Finishes." },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", animated: true, label: "" },
    { id: "e2", source: "n2", target: "n3", animated: true, label: "" },
    { id: "e3", source: "n3", target: "n4", animated: false, label: "yes" },
  ],
  detectedPatterns: ["Retry Loop"],
};

describe("buildTopologyView (T3.2)", () => {
  const view = buildTopologyView(topology);

  test("produces one positioned flow node per topology node", () => {
    expect(view.nodes.length).toBe(4);
    for (const node of view.nodes) {
      expect(node.type).toBe("codeStep");
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  test("dagre separates connected nodes (layout math is client-side only)", () => {
    const [a, b] = view.nodes;
    const dx = Math.abs(a!.position.x - b!.position.x);
    const dy = Math.abs(a!.position.y - b!.position.y);
    expect(dx > 0 || dy > 0).toBe(true);
    expect(NODE_WIDTH).toBeGreaterThan(0);
    expect(NODE_HEIGHT).toBeGreaterThan(0);
  });

  test("carries plain-language data and type styling into node data", () => {
    const entry = view.nodes.find((n) => n.id === "n1");
    expect(entry?.data.plainDescription).toContain("Starts");
    expect(TYPE_STYLES.entry.label).toBe("Start");
    expect(TYPE_STYLES.io.className).toContain("amber");
  });

  test("edges preserve animation flags and drop dangling references defensively", () => {
    expect(view.edges.map((e) => e.animated)).toEqual([true, true, false]);
    // Decision-edge labels flow through to the renderer (T6.1).
    expect(view.edges[2]?.label).toBe("yes");
    const dangling = buildTopologyView({
      ...topology,
      edges: [{ id: "bad", source: "ghost", target: "n4", animated: true, label: "" }],
    });
    expect(dangling.edges.length).toBe(0);
  });
});
