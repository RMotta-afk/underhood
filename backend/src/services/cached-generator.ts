import type { Pool } from "pg";
import {
  getCachedCompletion,
  saveCachedCompletion,
} from "./prompt-cache";
import type { TopologyGenerator } from "../workflow/steps/generate-topology";
import { PIPELINE_VERSION } from "../version";

// T6.2 — Wire the SDD §6.1 prompt cache into the live generation path.
// Wraps any TopologyGenerator (e.g. the Mastra agent): identical prompts
// within one pipeline version skip the LLM entirely. The version prefix in
// the cache key guarantees a pipeline upgrade naturally invalidates old
// completions.

export function withPromptCache(pool: Pool, generator: TopologyGenerator): TopologyGenerator {
  return {
    async generate(messages, options) {
      const prompt = [
        PIPELINE_VERSION,
        ...messages.map((m) => `${m.role}\u0000${m.content}`),
      ].join("\u0001");
      const modelId = "topology-generator";
      const cached = await getCachedCompletion(pool, prompt, modelId);
      if (cached) return { object: cached };
      const result = await generator.generate(messages, options);
      await saveCachedCompletion(pool, prompt, modelId, result.object);
      return result;
    },
  };
}
