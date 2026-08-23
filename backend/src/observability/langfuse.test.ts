import { describe, expect, test } from "bun:test";
import { loadEnv } from "../env";
import { createMastraWithObservability } from "./langfuse";

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/underhood",
  OPENAI_API_KEY: "sk-test",
};

describe("Langfuse observability wiring (T5.4)", () => {
  test("absent Langfuse keys => tracing disabled, app still constructs", () => {
    const env = loadEnv(baseEnv);
    expect(env.tracingEnabled).toBe(false);
    const { mastra, tracingEnabled } = createMastraWithObservability(env);
    expect(tracingEnabled).toBe(false);
    expect(mastra).toBeDefined();
  });

  test("present keys => tracing enabled with exporter configured", () => {
    const env = loadEnv({
      ...baseEnv,
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
    });
    expect(env.tracingEnabled).toBe(true);
    const { tracingEnabled } = createMastraWithObservability(env);
    expect(tracingEnabled).toBe(true);
  });

  test("partial keys (public only) disable tracing gracefully", () => {
    const env = loadEnv({ ...baseEnv, LANGFUSE_PUBLIC_KEY: "pk-lf-test" });
    expect(env.tracingEnabled).toBe(false);
  });
});
