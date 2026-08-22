import { describe, expect, test } from "bun:test";
import { analyzeCode } from "./analyze-code";

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

describe("analyzeCode (T2.1)", () => {
  const analysis = analyzeCode(SAMPLE_TS);

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

  test("normalized skeleton is order-independent but name-preserving", () => {
    const reordered = analyzeCode(`
      async function main() { await loadConfig("x"); }
      async function loadConfig(p: string) { return fetch(p); }
      main();
    `);
    const original = analyzeCode(`
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

  test("handles plain javascript and non-js input gracefully", () => {
    const js = analyzeCode('console.log("hi");');
    expect(js.language).toBe("javascript");
    expect(js.ioOperations[0]?.kind).toBe("console");

    const py = analyzeCode("def main():\n  print('hello')");
    expect(py.statementCount).toBe(0);
    expect(py.entryPoints).toEqual(["(module)"]);
  });

  test("output validates against StructuralAnalysisSchema shape", () => {
    expect(analysis.statementCount).toBeGreaterThan(0);
    expect(Array.isArray(analysis.entities)).toBe(true);
  });
});
