import { PgBoss } from "pg-boss";

// T2.4 — pg-boss job queue born with the database implementation (SDD §5.1).
// Lives inside the same PostgreSQL instance; schema is created by boss.start().

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

export const ANALYSIS_QUEUE = "analysis-jobs";

/** Singleton accessor; idempotent across hot reloads and multiple callers. */
export function getBoss(connectionString: string): Promise<PgBoss> {
  if (bossInstance) return startPromise ?? Promise.resolve(bossInstance);

  const boss = new PgBoss({ connectionString });
  startPromise = (async () => {
    await boss.start();
    try {
      await boss.createQueue(ANALYSIS_QUEUE);
    } catch {
      // already exists — fine
    }
    bossInstance = boss;
    return boss;
  })();

  return startPromise;
}

/** Test helper: stop and forget the singleton so each integration run starts
 * clean without leaking the previous instance's timers/pollers. */
export async function resetBoss(): Promise<void> {
  if (startPromise) {
    const b = await startPromise;
    await b.stop();
  }
  bossInstance = null;
  startPromise = null;
}
