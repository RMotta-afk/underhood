import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { GraphTopology } from "@underhood/types";
import {
  getCachedTopology,
  saveTopologyCache,
  wirePostgres,
} from "./postgres";
import { ANALYSIS_QUEUE, getBoss, resetBoss } from "../queue/boss";

// Integration suite: requires the compose database.
// Opt-in via TEST_DATABASE_URL only — ambient DATABASE_URL (e.g. from .env,
// auto-loaded by bun) may point at a remote/production db and must never be
// hijacked by host-side tests. Skipped when unset.
const DB = process.env.TEST_DATABASE_URL ?? null;
const describeDb = DB ? describe : describe.skip;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const topologyFixture: GraphTopology = {
  nodes: [
    {
      id: "n1",
      label: "main",
      type: "entry",
      plainDescription: "Starts the program and reads config.",
    },
    {
      id: "n2",
      label: "Done",
      type: "terminal",
      plainDescription: "The program finishes.",
    },
  ],
  edges: [{ id: "e1", source: "n1", target: "n2", animated: true, label: "" }],
  detectedPatterns: ["Retry Loop"],
};

describeDb("Postgres wiring (T2.4 integration)", () => {
  let wiring: Awaited<ReturnType<typeof wirePostgres>> | undefined;

  beforeAll(async () => {
    wiring = await wirePostgres(DB!);
  });

  afterAll(async () => {
    await wiring?.pool.end();
  });

  test("graph cache round-trips by SHA-256 codeHash, scoped to pipeline version", async () => {
    // Unique per run so repeated suites stay idempotent against a persistent volume.
    const codeHash = sha256(randomUUID());
    const entry = {
      codeHash,
      language: "typescript",
      topologyPayload: topologyFixture,
      createdAt: new Date(),
    };

    expect(await getCachedTopology(wiring!.pool, codeHash)).toBeNull();

    await saveTopologyCache(wiring!.pool, entry);
    const cached = await getCachedTopology(wiring!.pool, codeHash);
    expect(cached).toEqual(topologyFixture);

    // Upsert semantics on identical hash
    await saveTopologyCache(wiring!.pool, entry);
    expect(await getCachedTopology(wiring!.pool, codeHash)).toEqual(topologyFixture);

    // T6.2: rows from a different pipeline version are invisible
    expect(
      await getCachedTopology(wiring!.pool, codeHash, "some-other-version")
    ).toBeNull();
  });

  test("@mastra/pg init created its durable-storage tables in the same instance", async () => {
    const result = await wiring!.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'mastra%'`
    );
    expect(result.rows.length).toBeGreaterThan(0); // workflow snapshots will persist here from T5.1
  });

  test("pg-boss send/fetch works on the same DATABASE_URL (queue born with db)", async () => {
    resetBoss();
    const boss = await getBoss(DB!);
    await boss.send(ANALYSIS_QUEUE, { rawCode: "const y = 2;", jobId: "test-job" });
    const jobs = await boss.fetch<{ rawCode: string; jobId: string }>(ANALYSIS_QUEUE, {
      batchSize: 1,
    });
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.data.jobId).toBe("test-job");
  });
});
