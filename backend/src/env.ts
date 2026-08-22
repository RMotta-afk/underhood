import { z } from "zod";

// Secrets firewall: this module validates variable NAMES and shapes only.
// It never reads .env directly; values arrive via process.env injected by the runtime.

const EnvSchema = z
  .object({
    // Model routing (OpenAI-compatible abstraction)
    MODEL_PROVIDER: z.enum(["openai", "groq"]).default("openai"),
    MODEL_ID: z.string().min(1).default("gpt-4o"),
    MODEL_BASE_URL: z.string().url().optional(),

    OPENAI_API_KEY: z.string().min(1).optional(),
    GROQ_API_KEY: z.string().min(1).optional(),

    // Persistence & queue
    DATABASE_URL: z.string().min(1),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),

    // Dedup embeddings
    EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
    SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.95),

    // Observability (Langfuse Cloud; absent keys => tracing disabled)
    LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
    LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
    LANGFUSE_BASE_URL: z.string().url().optional(),

    // App
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .refine((e) => e.MODEL_PROVIDER !== "openai" || !!e.OPENAI_API_KEY || e.NODE_ENV === "test", {
    message: "MODEL_PROVIDER=openai requires OPENAI_API_KEY",
    path: ["OPENAI_API_KEY"],
  })
  .refine((e) => e.MODEL_PROVIDER !== "groq" || !!e.GROQ_API_KEY || e.NODE_ENV === "test", {
    message: "MODEL_PROVIDER=groq requires GROQ_API_KEY",
    path: ["GROQ_API_KEY"],
  });

export type Env = z.infer<typeof EnvSchema> & { tracingEnabled: boolean };

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodError["issues"]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}`
    );
    this.name = "EnvValidationError";
  }
}

/** Parse and validate an env source. Throws EnvValidationError (fail-fast) on any problem. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues);
  }
  return {
    ...parsed.data,
    tracingEnabled:
      !!parsed.data.LANGFUSE_PUBLIC_KEY && !!parsed.data.LANGFUSE_SECRET_KEY,
  };
}

let cached: Env | undefined;

/** Memoized app-wide accessor. Call once at boot; throws on invalid config. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
