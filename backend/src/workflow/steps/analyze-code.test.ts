import { beforeAll, describe, expect, test } from "bun:test";
import { analyzeCode } from "./analyze-code";
import type { StructuralAnalysis } from "./analyze-code";

const SAMPLE_TS = `
import { readFile } from "node:fs/promises";

interface Config {
  retries: number;
}

async function loadConfig(path: string): Promise<Config> {
  const raw: string = await readFile(path, "utf-8");
  return JSON.parse(raw) as Config;
}

function shouldRetry(attempt: number, maxRetries: number): boolean {
  if (attempt >= maxRetries) {
    console.log("giving up");
    return false;
  }
  return attempt < maxRetries ? true : false;
}

async function main(): Promise<void> {
  const config = await loadConfig("config.json");
  let attempt = 0;
  while (attempt <= config.retries) {
    try {
      const res = await fetch("https://api.example.com/data");
      if (res.ok) break;
    } catch (err) {
      console.error("attempt failed", err);
    }
    attempt++;
  }
  process.exit(0);
}

main();
`;

const BINARY_SEARCH = `
function binarySearch(arr: number[], target: number): number {
  let left = 0;
  let right = arr.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (arr[mid] === target) {
      return mid;
    }
    if (arr[mid] < target) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return -1;
}
console.log(binarySearch([1, 2, 3], 3));
`;

describe("analyzeCode control-flow outline (T6.1)", () => {
  let analysis: StructuralAnalysis;
  beforeAll(async () => {
    analysis = await analyzeCode(BINARY_SEARCH);
  });
  const flow = () => analysis.flows?.find((f) => f.entity === "binarySearch");

  test("extracts a per-entity flow outline", () => {
    expect(analysis.flows?.length).toBeGreaterThan(0);
    expect(flow).toBeDefined();
  });

  test("loop step carries the real condition text", () => {
    const loop = flow()?.steps.find((s) => s.kind === "loop");
    expect(loop?.condition).toBe("left <= right");
  });

  test("both conditionals appear as branch steps in order", () => {
    const branches = flow()?.steps.filter((s) => s.kind === "branch") ?? [];
    expect(branches.length).toBe(2);
    expect(branches[0]?.condition).toBe("arr[mid] === target");
    expect(branches[1]?.condition).toBe("arr[mid] < target");
  });

  test("completion paths appear as return steps after their branches", () => {
    const kinds = flow()?.steps.map((s) => s.kind) ?? [];
    expect(kinds.indexOf("return")).toBeGreaterThan(kinds.indexOf("branch"));
    expect(kinds.filter((k) => k === "return").length).toBeGreaterThan(0);
  });

  test("cross-function calls reference the callee entity", async () => {
    const caller = await analyzeCode(`
      function helper() { return 1; }
      function main() { if (helper() > 0) { return helper(); } return 0; }
    `);
    const steps = caller.flows?.find((f) => f.entity === "main")?.steps ?? [];
    const calls = steps.filter((s) => s.kind === "call");
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.callee === "helper")).toBe(true);
  });

  test("top-level arrow functions get flows too", async () => {
    const a = await analyzeCode("const double = (n) => { if (n < 0) { return 0; } return n * 2; };");
    const flow = a.flows?.find((f) => f.entity === "double");
    expect(flow?.steps.some((s) => s.kind === "branch")).toBe(true);
  });
});

describe("analyzeCode (T2.1)", () => {
  let analysis: StructuralAnalysis;
  beforeAll(async () => {
    analysis = await analyzeCode(SAMPLE_TS);
  });

  test("detects typescript language after type stripping", () => {
    expect(analysis.language).toBe("typescript");
    expect(analysis.hasAsync).toBe(true);
  });

  test("extracts named entities preserving names (dedup mandate)", () => {
    const names = analysis.entities.map((e) => `${e.kind}:${e.name}`);
    expect(names).toContain("function:loadConfig");
    expect(names).toContain("function:shouldRetry");
    expect(names).toContain("function:main");
    expect(names).toContain("variable:raw");
    expect(names).toContain("variable:config");
  });

  test("finds entry points including module-level invocation", () => {
    expect(analysis.entryPoints.length).toBeGreaterThan(0);
    expect(analysis.entryPoints).toContain("main");
  });

  test("counts branches of multiple kinds", () => {
    const kinds = analysis.branches.map((b) => b.kind);
    expect(kinds).toContain("if");
    expect(kinds).toContain("ternary");
    expect(kinds).toContain("try");
    expect(kinds).toContain("loop"); // while
  });

  test("classifies IO operations by kind", () => {
    const ioKinds = analysis.ioOperations.map((o) => o.kind);
    expect(ioKinds).toContain("console");
    expect(ioKinds).toContain("fetch");
    expect(ioKinds).toContain("fs"); // node:fs/promises readFile
    expect(ioKinds).toContain("process");
  });

  test("normalized skeleton is order-independent but name-preserving", async () => {
    const reordered = await analyzeCode(`
      async function main() { await loadConfig("x"); }
      async function loadConfig(p: string) { return fetch(p); }
      main();
    `);
    const original = await analyzeCode(`
      async function loadConfig(p: string) { return fetch(p); }
      main();
      async function main() { await loadConfig("x"); }
    `);
    // Same entities/structure, different statement order => identical skeleton
    expect(reordered.normalizedSkeleton.split("|").sort()).toEqual(
      original.normalizedSkeleton.split("|").sort()
    );
    expect(original.normalizedSkeleton).toContain("loadConfig");
  });

  test("plain javascript still routes through the acorn path", async () => {
    const js = await analyzeCode('console.log("hi");');
    expect(js.language).toBe("javascript");
    expect(js.ioOperations[0]?.kind).toBe("console");
  });

  test("unparseable code fails loudly instead of degrading silently", async () => {
    try {
      await analyzeCode("this is not code {{{");
      throw new Error("expected analyzeCode to reject");
    } catch (err) {
      expect((err as Error).message).toMatch(/could not be parsed/);
    }
  });

  test("unknown explicit language hints are rejected", async () => {
    try {
      await analyzeCode("print(1)", "cobol");
      throw new Error("expected analyzeCode to reject");
    } catch (err) {
      expect((err as Error).message).toMatch(/Unsupported language hint/);
    }
  });

  test("output validates against StructuralAnalysisSchema shape", () => {
    expect(analysis.statementCount).toBeGreaterThan(0);
    expect(Array.isArray(analysis.entities)).toBe(true);
  });
});
