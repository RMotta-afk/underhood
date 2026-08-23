import { randomUUID } from "node:crypto";
import type { GraphTopology } from "../../packages/types/src/index";
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
    topology: {
      nodes: [
        { id: "n1", label: "main", type: "entry", plainDescription: "The program starts by running main." },
        { id: "n2", label: "loadConfig", type: "io", plainDescription: "Reads the settings file from disk." },
        { id: "n3", label: "Enabled?", type: "branch", plainDescription: "Checks whether the feature is switched on." },
        { id: "n4", label: "Done", type: "terminal", plainDescription: "The program finishes." },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", animated: true },
        { id: "e2", source: "n2", target: "n3", animated: true },
        { id: "e3", source: "n3", target: "n4", animated: false },
      ],
      detectedPatterns: ["Feature Flag"],
    },
  },
  {
    name: "retry loop",
    topology: {
      nodes: [
        { id: "n1", label: "fetchReport", type: "entry", plainDescription: "Starts downloading the report." },
        { id: "n2", label: "Retry?", type: "branch", plainDescription: "Tries again if the download failed." },
        { id: "n3", label: "Done", type: "terminal", plainDescription: "Stops once the report arrives." },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", animated: true },
        { id: "e2", source: "n2", target: "n1", animated: true },
        { id: "e3", source: "n2", target: "n3", animated: false },
      ],
      detectedPatterns: ["Retry Loop"],
    },
  },
];

const degradedTopology: GraphTopology = {
  // Structurally broken on purpose: no terminal, dangling edge, thin text.
  nodes: [
    { id: "n1", label: "x", type: "process", plainDescription: "Runs." },
    { id: "n2", label: "y", type: "process", plainDescription: "Does stuff." },
  ],
  edges: [{ id: "e1", source: "n1", target: "ghost", animated: true }],
  detectedPatterns: [],
};

async function main(): Promise<void> {
  console.log("== topology quality evals (T4.2) ==");

  const persisted: PersistedEntry[] = [];
  let failures = 0;

  for (const testCase of referenceCases) {
    const results = await scoreTopology(testCase.topology);
    const runId = randomUUID();
    for (const result of results) {
      const passed = result.score >= TOPOLOGY_SCORE_THRESHOLD;
      if (!passed) failures++;
      console.log(
        `  [${passed ? "PASS" : "FAIL"}] ${testCase.name} :: ${result.scorerId} = ${result.score.toFixed(2)}`
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
