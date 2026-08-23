import { describe, expect, test } from "bun:test";
import {
  buildTopologyPrompt,
  generateTopology,
  resolveModel,
  TOPOLOGY_INSTRUCTIONS,
  type TopologyGenerator,
} from "./generate-topology";
import { GraphTopologySchema } from "@underhood/types";
import type { StructuralAnalysis } from "./analyze-code";

const fixtureAnalysis: StructuralAnalysis = {
  language: "typescript",
  entryPoints: ["main"],
  entities: [
    { name: "loadConfig", kind: "function" },
    { name: "main", kind: "function" },
  ],
  branches: [{ kind: "if" }, { kind: "loop" }],
  ioOperations: [
    { kind: "console", callee: "console.log" },
    { kind: "fetch", callee: "fetch" },
  ],
  statementCount: 12,
  hasAsync: true,
  flows: [
    {
      entity: "main",
      steps: [
        { kind: "call", label: "call loadConfig", callee: "loadConfig" },
        { kind: "loop", label: "loop while attempt <= retries", condition: "attempt <= retries" },
        { kind: "branch", label: "if (res.ok)", condition: "res.ok" },
        { kind: "return", label: "return config" },
      ],
    },
  ],
  normalizedSkeleton: "entities:function main,function loadConfig|branches:{...}",
};

function mockGenerator(object: unknown): TopologyGenerator {
  return {
    async generate() {
      return { object };
    },
  };
}

const validFixture = {
  nodes: [
    { id: "n1", label: "main", type: "entry", plainDescription: "Starts the program." },
    { id: "n2", label: "Fetch data", type: "io", plainDescription: "Downloads data from the internet." },
    { id: "n3", label: "Done", type: "terminal", plainDescription: "The program finishes." },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n2", target: "n3" },
  ],
  detectedPatterns: ["Retry Loop"],
};

describe("generateTopology (T2.2)", () => {
  test("returns schema-valid topology from a compliant generator", async () => {
    const result = await generateTopology(fixtureAnalysis, mockGenerator(validFixture));
    expect(GraphTopologySchema.safeParse(result).success).toBe(true);
    expect(result.nodes[0]?.plainDescription).toContain("Starts");
  });

  test("rejects output missing plainDescription even if generator misbehaves", () => {
    const invalid = {
      ...validFixture,
      nodes: [{ id: "n1", label: "main", type: "entry" }],
    };
    // structuredOutput would normally enforce this; the defensive parse is the backstop.
    const promise = generateTopology(fixtureAnalysis, mockGenerator(invalid));
    expect(promise).rejects.toThrow();
  });

  test("prompt carries entity names and plain-language mandate", () => {
    const prompt = buildTopologyPrompt(fixtureAnalysis);
    expect(prompt).toContain("loadConfig");
    expect(prompt).toContain("main");
    expect(prompt).toContain("2 branch(es)");
    expect(prompt).toContain("asynchronous");
  });

  test("prompt serializes the control-flow outline as authoritative (T6.1)", () => {
    const prompt = buildTopologyPrompt(fixtureAnalysis);
    expect(prompt).toContain("authoritative for ORDER and SHAPE");
    expect(prompt).toContain("loop -> branch");
  });

  test("instructions mandate branch fan-out, loop cycles, edge labels, callee links", () => {
    expect(TOPOLOGY_INSTRUCTIONS).toContain("at least two outgoing edges");
    expect(TOPOLOGY_INSTRUCTIONS).toContain("cycle");
    expect(TOPOLOGY_INSTRUCTIONS).toContain("edge label field");
    expect(TOPOLOGY_INSTRUCTIONS).toContain("callee's own node");
  });

  test("instructions enforce jargon-free descriptions and edge integrity", () => {
    expect(TOPOLOGY_INSTRUCTIONS).toContain("plainDescription");
    expect(TOPOLOGY_INSTRUCTIONS).toContain("existing node ids");
  });

  test("model resolution is env-driven only (provider abstraction)", () => {
    const openaiDefault = resolveModel({
      MODEL_PROVIDER: "openai",
      MODEL_ID: "gpt-4o",
    });
    expect(openaiDefault.model).toBe("openai/gpt-4o");

    const groqCustom = resolveModel({
      MODEL_PROVIDER: "groq",
      MODEL_ID: "llama-3.3-70b-versatile",
      MODEL_BASE_URL: "https://api.groq.com/openai/v1",
    });
    expect(groqCustom.model).toEqual({
      id: "custom/llama-3.3-70b-versatile",
      url: "https://api.groq.com/openai/v1",
    });
  });

  test("bare fallback resolves from the FULL environment (regression: partial source dropped API keys)", () => {
    const prevProvider = process.env.MODEL_PROVIDER;
    const prevKey = process.env.OPENAI_API_KEY;
    const prevDb = process.env.DATABASE_URL;
    process.env.MODEL_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.DATABASE_URL = "postgres://localhost/underhood";
    try {
      // Before the fix, resolveModel() fed loadEnv a DATABASE_URL-only source,
      // so OPENAI_API_KEY was invisible and this threw EnvValidationError.
      // Shape depends on whether ambient env carries MODEL_BASE_URL.
      const model = resolveModel().model;
      const ok =
        model === "openai/gpt-4o" ||
        (typeof model === "object" && model.id === "custom/gpt-4o");
      expect(ok).toBe(true);
    } finally {
      if (prevProvider === undefined) delete process.env.MODEL_PROVIDER;
      else process.env.MODEL_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
    }
  });
});
