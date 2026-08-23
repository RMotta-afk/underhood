import type { Agent } from "@mastra/core/agent";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { Mastra } from "@mastra/core";
import { Observability } from "@mastra/observability";
import { LangfuseExporter } from "@mastra/langfuse";
import type { Env } from "../env";

// T5.4 — Langfuse Cloud observability (SDD §6.3).
// Captures per-trace span timelines of workflow steps and agent iterations,
// including token usage, cost data, and timing — zero custom instrumentation.
//
// Env-driven enable/disable: absent LANGFUSE keys => no exporter is registered
// and the app runs normally (SDD hard requirement).

export interface ObservabilityWiring {
  mastra: Mastra;
  tracingEnabled: boolean;
}

/** Build the app Mastra instance; agents registered here emit traced spans
 * that flow through every configured exporter (Langfuse when enabled). */
export function createMastraWithObservability(
  env: Env,
  agents?: Record<string, Agent>,
  storage?: MastraCompositeStore
): ObservabilityWiring {
  const exporters = [];

  if (env.tracingEnabled) {
    exporters.push(
      new LangfuseExporter({
        publicKey: env.LANGFUSE_PUBLIC_KEY!,
        secretKey: env.LANGFUSE_SECRET_KEY!,
        ...(env.LANGFUSE_BASE_URL ? { baseUrl: env.LANGFUSE_BASE_URL } : {}),
        environment: env.NODE_ENV,
      })
    );
  }

  const mastra = new Mastra({
    ...(storage ? { storage } : {}),
    ...(agents ? { agents } : {}),
    ...(exporters.length > 0
      ? {
          observability: new Observability({
            configs: {
              default: {
                serviceName: "underhood-backend",
                exporters,
              },
            },
          }),
        }
      : {}),
  });

  return { mastra, tracingEnabled: env.tracingEnabled };
}
