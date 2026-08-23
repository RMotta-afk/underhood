import { defineConfig } from "@playwright/test";

// T4.3 — E2E smoke against the docker compose stack (Caddy on :8080).
// Prereq: docker compose up --build (with .env holding model credentials).
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "./e2e",
  // .e2e.ts keeps Playwright specs out of `bun test`'s default globs.
  testMatch: "**/*.e2e.ts",
  timeout: 240_000, // LLM-backed analysis can take a while
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
