// Single-container supervisor (SDD §7.2): the app service runs the Bun
// backend (:3000) and the Next.js frontend (:3001) side by side. Both are
// stateless; Caddy fronts N replicas of this container.
export {};

const procs: Array<{ kill: () => void; exited: Promise<number> }> = [];

procs.push(
  Bun.spawn(["bun", "run", "--cwd", "frontend", "start"], {
    stdout: "inherit",
    stderr: "inherit",
  })
);
procs.push(
  Bun.spawn(["bun", "run", "backend/src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  })
);

function shutdown(): void {
  for (const proc of procs) proc.kill();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const exitCodes = await Promise.all(procs.map((proc) => proc.exited));
process.exit(exitCodes.find((code) => code !== 0) ?? 0);
