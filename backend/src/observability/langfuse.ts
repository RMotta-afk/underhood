import type { Agent } from "@mastra/core/agent";
import type { Workflow } from "@mastra/core/workflows";
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

/** Build the app Mastra instance; agents and workflows registered here emit
 * traced spans that flow through every configured exporter (Langfuse when
 * enabled), and workflow run snapshots persist to the shared Mastra storage. */
export function createMastraWithObservability(
  env: Env,
  agents?: Record<string, Agent>,
  storage?: MastraCompositeStore,
  workflows?: Record<string, Workflow>
): ObservabilityWiring {
  const exporters = [];

  if (env.tracingEnabled) {
    exporters.push(
      new LangfuseExporter({
        publicKey: env.LANGFUSE_PUBLIC_KEY!,
        secretKey: env.LANGFUSE_SECRET_KEY!,
        // The OTLP exporter rejects a relative path-only URL, so an unset
        // LANGFUSE_BASE_URL must still yield an absolute Langfuse Cloud host.
        baseUrl: env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
        environment: env.NODE_ENV,
      })
    );
  }

  const mastra = new Mastra({
    ...(storage ? { storage } : {}),
    ...(agents ? { agents } : {}),
    ...(workflows ? { workflows } : {}),
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
