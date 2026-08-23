import { randomUUID } from "node:crypto";
import type { GraphTopology } from "../../packages/types/src/index";
import type { StructuralAnalysis } from "../../backend/src/workflow/steps/analyze-code";
import { persistTopologyScore } from "../../backend/src/observability/scores";
import {
  scoreTopology,
  STRUCTURE_SCORER_ID,
  TOPOLOGY_SCORE_THRESHOLD,
} from "../../backend/src/workflow/evals/topology-scorers";
import { wirePostgres } from "../../backend/src/storage/postgres";

// T4.2 — topology quality eval (SDD §6.3, AGENT.md @sdet).
// Run: bun run tests/evals/topology.eval.ts
//
// Deterministic scorers run hermetically; persistence to Postgres
// observability storage activates when a database is reachable
// (TEST_DATABASE_URL / DATABASE_URL), mirroring the integration suites.

interface ReferenceCase {
  name: string;
  topology: GraphTopology;
  /** When present, fidelity-aware scoring is exercised (T6.1). */
  analysis?: StructuralAnalysis;
}

interface PersistedEntry {
  runId: string;
  caseName: string;
  output: unknown;
  scorerId: string;
  score: number;
  reason?: string;
}

const referenceCases: ReferenceCase[] = [
  {
    name: "config-load with branch",
    analysis: {
      language: "typescript",
      entryPoints: ["main"],
      entities: [
        { name: "main", kind: "function" },
        { name: "loadConfig", kind: "function" },
      ],
      branches: [{ kind: "if" }],
      ioOperations: [{ kind: "fs", callee: "readFile" }],
      statementCount: 6,
      hasAsync: true,
      flows: [
        {
          entity: "main",
          steps: [
            { kind: "call", label: "call loadConfig", callee: "loadConfig" },
            { kind: "branch", label: "if (config.enabled)", condition: "config.enabled" },
            { kind: "return", label: "return config" },
          ],
        },
      ],
      normalizedSkeleton: "entities:function main,function loadConfig|branches:{\"if\":1}|io:{\"fs\":1}|async:true",
    },
    topology: {
      nodes: [
        { id: "n1", label: "main", type: "entry", plainDescription: "The program starts by running main." },
        { id: "n2", label: "loadConfig", type: "io", plainDescription: "Reads the settings file from disk." },
        { id: "n3", label: "Enabled?", type: "branch", plainDescription: "Checks whether the feature is switched on." },
        { id: "n4", label: "Done", type: "terminal", plainDescription: "The program finishes after running the feature." },
        { id: "n5", label: "Skipped", type: "terminal", plainDescription: "The program finishes without running the feature." },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", animated: true, label: "" },
        { id: "e2", source: "n2", target: "n3", animated: true, label: "" },
        { id: "e3", source: "n3", target: "n4", animated: false, label: "yes" },
        { id: "e4", source: "n3", target: "n5", animated: false, label: "no" },
      ],
      detectedPatterns: ["Feature Flag"],
    },
  },
  {
    name: "retry loop",
    analysis: {
      language: "javascript",
      entryPoints: ["fetchReport"],
      entities: [{ name: "fetchReport", kind: "function" }],
      branches: [{ kind: "loop" }],
      ioOperations: [{ kind: "fetch", callee: "fetch" }],
      statementCount: 8,
      hasAsync: true,
      flows: [
        {
          entity: "fetchReport",
          steps: [
            { kind: "loop", label: "loop while attempts left", condition: "attempts > 0" },
            { kind: "branch", label: "if (response.ok)", condition: "response.ok" },
            { kind: "return", label: "return report" },
          ],
        },
      ],
      normalizedSkeleton: "entities:function fetchReport|branches:{\"loop\":1}|io:{\"fetch\":1}|async:true",
    },
    topology: {
      nodes: [
        { id: "n1", label: "fetchReport", type: "entry", plainDescription: "Starts downloading the report." },
        { id: "n2", label: "Retry?", type: "branch", plainDescription: "Tries again if the download failed." },
        { id: "n3", label: "Done", type: "terminal", plainDescription: "Stops once the report arrives." },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", animated: true, label: "" },
        { id: "e2", source: "n2", target: "n1", animated: true, label: "retry" },
        { id: "e3", source: "n2", target: "n3", animated: false, label: "done" },
      ],
      detectedPatterns: ["Retry Loop"],
    },
  },
  // T6.1 regression guard: a lazy straight-line graph must NOT pass when the
  // declared control flow contains conditionals and loops.
  {
    name: "lazy straight-line vs branchy analysis (must fail fidelity)",
    analysis: {
      language: "javascript",
      entryPoints: ["binarySearch"],
      entities: [{ name: "binarySearch", kind: "function" }],
      branches: [{ kind: "loop" }, { kind: "if" }],
      ioOperations: [],
      statementCount: 9,
      hasAsync: false,
      flows: [
        {
          entity: "binarySearch",
          steps: [
            { kind: "loop", label: "loop while left <= right", condition: "left <= right" },
            { kind: "branch", label: "if (arr[mid] === target)", condition: "arr[mid] === target" },
            { kind: "return", label: "return mid" },
          ],
        },
      ],
      normalizedSkeleton: "entities:function binarySearch|branches:{\"if\":1,\"loop\":1}|io:{}|async:false",
    },
    topology: {
      nodes: [
        { id: "n1", label: "binarySearch", type: "entry", plainDescription: "Starts the binary search over the array." },
        { id: "n2", label: "End", type: "terminal", plainDescription: "The search finishes one way or another." },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2", animated: true, label: "" }],
      detectedPatterns: [],
    },
  },
];

const degradedTopology: GraphTopology = {
  // Structurally broken on purpose: no terminal, dangling edge, thin text.
  nodes: [
    { id: "n1", label: "x", type: "process", plainDescription: "Runs." },
    { id: "n2", label: "y", type: "process", plainDescription: "Does stuff." },
  ],
  edges: [{ id: "e1", source: "n1", target: "ghost", animated: true, label: "" }],
  detectedPatterns: [],
};

async function main(): Promise<void> {
  console.log("== topology quality evals (T4.2) ==");

  const persisted: PersistedEntry[] = [];
  let failures = 0;

  for (const testCase of referenceCases) {
    const results = await scoreTopology(testCase.topology, testCase.analysis);
    // Cases marked "must fail" guard the scorer's discrimination: a lazy
    // straight-line graph against a branchy analysis must score BELOW the gate.
    const expectPass = !testCase.name.includes("must fail");
    // A must-fail case only asserts on the structure scorer; its prose is
    // deliberately fine so the plain-language scorer legitimately passes it.
    const scored = expectPass
      ? results
      : results.filter((r) => r.scorerId === STRUCTURE_SCORER_ID);
    const runId = randomUUID();
    for (const result of scored) {
      const passed = result.score >= TOPOLOGY_SCORE_THRESHOLD;
      const ok = expectPass ? passed : !passed;
      if (!ok) failures++;
      console.log(
        `  [${ok ? "PASS" : "FAIL"}] ${testCase.name} :: ${result.scorerId} = ${result.score.toFixed(2)}${expectPass ? "" : " (expected below gate)"}`
      );
      persisted.push({
        runId,
        caseName: testCase.name,
        output: testCase.topology,
        scorerId: result.scorerId,
        score: result.score,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
  }

  // Discrimination check: a degraded graph must score below the gate.
  const degradedResults = await scoreTopology(degradedTopology);
  const degradedStructure = degradedResults.find((r) => r.scorerId === STRUCTURE_SCORER_ID);
  if (!degradedStructure || degradedStructure.score >= TOPOLOGY_SCORE_THRESHOLD) {
    failures++;
    console.log("  [FAIL] degraded fixture scored above threshold — scorer is not discriminating");
  } else {
    console.log(
      `  [PASS] degraded fixture rejected (${degradedStructure.score.toFixed(2)} < ${TOPOLOGY_SCORE_THRESHOLD})`
    );
  }

  // Persistence to Postgres observability storage when a DB is reachable.
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
  if (!dbUrl) {
    console.log("  [SKIP] persistence (no TEST_DATABASE_URL/DATABASE_URL)");
  } else {
    try {
      const { store } = await wirePostgres(dbUrl);
      for (const entry of persisted) {
        await persistTopologyScore(store, {
          runId: entry.runId,
          entityId: `eval:${entry.caseName}`,
          scorerId: entry.scorerId,
          score: entry.score,
          reason: entry.reason,
          input: {},
          output: entry.output,
        });
      }
      const scoresDomain = store.stores.scores;
      if (!scoresDomain) throw new Error("no scores domain on store");
      const readBack = await scoresDomain.listScoresByScorerId({
        scorerId: STRUCTURE_SCORER_ID,
        pagination: { page: 0, perPage: 10 },
      });
      if (readBack.scores.length === 0) throw new Error("no scores found after save");
      console.log(`  [PASS] persisted scores to Postgres observability storage`);
    } catch (err) {
      failures++;
      console.log(`  [FAIL] persistence: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures > 0) {
    console.error(`topology evals FAILED (${failures} failure(s))`);
    process.exit(1);
  }
  console.log("topology evals PASSED");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
