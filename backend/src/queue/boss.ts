import { PgBoss } from "pg-boss";

// T2.4 — pg-boss job queue born with the database implementation (SDD §5.1).
// Lives inside the same PostgreSQL instance; schema is created by boss.start().

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

export const ANALYSIS_QUEUE = "analysis-jobs";

/** Singleton accessor; idempotent across hot reloads and multiple callers. */
export function getBoss(connectionString: string): Promise<PgBoss> {
  if (bossInstance) return startPromise ?? Promise.resolve(bossInstance);
  bossInstance = new PgBoss({ connectionString });
  // v12 requires queues to exist before send(); create ours right after schema boot.
  startPromise = bossInstance
    .start()
    .then(async (b) => {
      try {
        await b.createQueue(ANALYSIS_QUEUE);
      } catch {
        // already exists — fine
      }
      return b;
    })
    .then((b) => {
      bossInstance = b;
      return b;
    });
  return startPromise;
}

/** Test helper: stop and forget the singleton so each integration run starts
 * clean without leaking the previous instance's timers/pollers. */
export function resetBoss(): void {
  if (startPromise) {
    void startPromise
      .then((b) => b.stop())
      .catch(() => {
        /* already stopped */
      });
  }
  bossInstance = null;
  startPromise = null;
}
