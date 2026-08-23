import { describe, expect, test } from "bun:test";
import { EnvValidationError, loadEnv } from "./env";

const validBase = {
  DATABASE_URL: "postgres://postgres:postgres@db:5432/underhood",
  OPENAI_API_KEY: "sk-test",
};

describe("loadEnv", () => {
  test("accepts a minimal valid set with defaults applied", () => {
    const e = loadEnv(validBase);
    expect(e.MODEL_PROVIDER).toBe("openai");
    expect(e.WORKER_CONCURRENCY).toBe(4);
    expect(e.SIMILARITY_THRESHOLD).toBe(0.95);
    expect(e.PORT).toBe(3000);
    expect(e.tracingEnabled).toBe(false); // absent Langfuse keys disable tracing gracefully
  });

  test("fails fast when DATABASE_URL is missing", () => {
    expect(() => loadEnv({ OPENAI_API_KEY: "sk-test" })).toThrow(EnvValidationError);
    // Empty-string placeholder counts as missing too (fail-fast preserved).
    expect(() => loadEnv({ DATABASE_URL: "", OPENAI_API_KEY: "sk-test" })).toThrow(
      EnvValidationError
    );
  });

  test("empty-string placeholders for optional vars are treated as absent", () => {
    const e = loadEnv({
      ...validBase,
      GROQ_API_KEY: "",
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
      LANGFUSE_BASE_URL: "",
      MODEL_BASE_URL: "",
    });
    expect(e.GROQ_API_KEY).toBeUndefined();
    expect(e.LANGFUSE_PUBLIC_KEY).toBeUndefined();
    expect(e.LANGFUSE_BASE_URL).toBeUndefined();
    expect(e.tracingEnabled).toBe(false);
  });

  test("openai provider requires OPENAI_API_KEY", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x" })).toThrow(
      /OPENAI_API_KEY/
    );
  });

  test("groq provider requires GROQ_API_KEY and accepts MODEL_BASE_URL override", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://x", MODEL_PROVIDER: "groq" })
    ).toThrow(/GROQ_API_KEY/);

    const e = loadEnv({
      DATABASE_URL: "postgres://x",
      MODEL_PROVIDER: "groq",
      GROQ_API_KEY: "gsk-test",
      MODEL_BASE_URL: "https://api.groq.com/openai/v1",
    });
    expect(e.MODEL_ID).toBe("gpt-4o");
  });

  test("present Langfuse keys enable tracing", () => {
    const e = loadEnv({
      ...validBase,
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
    });
    expect(e.tracingEnabled).toBe(true);
  });

  test("rejects non-numeric WORKER_CONCURRENCY and out-of-range SIMILARITY_THRESHOLD", () => {
    expect(() =>
      loadEnv({ ...validBase, WORKER_CONCURRENCY: "many" })
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({ ...validBase, SIMILARITY_THRESHOLD: "1.5" })
    ).toThrow(EnvValidationError);
  });
});
