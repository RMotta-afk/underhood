import { z } from "zod";

// --- SDD §3.1 Graph Topology Schema ---

export const NodeTypeSchema = z.enum(["entry", "process", "io", "branch", "terminal", "class"]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const NodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: NodeTypeSchema,
  // Container link: method/process nodes belonging to a class point at the
  // id of that class's container node, so renderers can group them visually.
  parent: z.string().min(1).optional(),
  plainDescription: z
    .string()
    .min(1)
    .describe("Jargon-free, 1-3 sentence explanation of what this node does, understandable by non-coders"),
  // Typed values keep the generated JSON Schema OpenAI-strict compatible:
  // z.any()/untyped records emit additionalProperties:{} which has no "type"
  // and is rejected by structured outputs response_format validation.
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});
export type GraphNode = z.infer<typeof NodeSchema>;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1), // Must map to a valid NodeSchema id
  target: z.string().min(1), // Must map to a valid NodeSchema id
  // Decision-edge outcome label ("yes"/"no", case names). Empty for
  // unconditional flow edges so renderers can omit it cleanly.
  label: z.string().default(""),
  animated: z.boolean().default(true),
});
export type GraphEdge = z.infer<typeof EdgeSchema>;

// --- LLM wire contract (structured outputs) ---
// OpenAI strict mode requires every property to appear in "required";
// .default()/preprocess wrappers drop or obscure that. This variant reuses
// the SAME field schemas (single source of truth) but keeps `animated` a
// plain required boolean and `label` a plain required string for generation;
// defaults are applied afterwards via withEdgeDefaults() before the public
// GraphTopologySchema parse.
const GenerationEdgeSchema = z.object({
  ...EdgeSchema.shape,
  animated: z.boolean(),
  label: z.string(),
});

export const TopologyGenerationSchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(GenerationEdgeSchema),
  detectedPatterns: z.array(z.string()),
});

/** Apply edge-level defaults to a raw generated topology payload. */
export function withEdgeDefaults(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const { edges } = value as { edges?: unknown };
  if (!Array.isArray(edges)) return value;
  return {
    ...(value as Record<string, unknown>),
    edges: edges.map((edge) => {
      if (typeof edge !== "object" || edge === null) return edge;
      const e = edge as Record<string, unknown>;
      return {
        ...e,
        animated: "animated" in e ? e.animated : true,
        label: typeof e.label === "string" ? e.label : "",
      };
    }),
  };
}

export const GraphTopologySchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  detectedPatterns: z.array(z.string()),
});
export type GraphTopology = z.infer<typeof GraphTopologySchema>;

// --- SDD §3.2 PostgreSQL Cache Schema ---

export const GraphCacheSchema = z.object({
  codeHash: z.string().length(64).describe("SHA-256 hash of the raw source code (hex)"),
  language: z.string(),
  topologyPayload: GraphTopologySchema,
  embedding: z.array(z.number()).optional(),
  // coerce: entries may arrive over JSON boundaries (API/job payloads) where
  // dates are ISO strings; raw z.date() would reject them.
  createdAt: z.coerce.date(),
});
export type GraphCache = z.infer<typeof GraphCacheSchema>;

// --- SDD §3.3 Job Status Schema (Async API contract) ---

export const JobStatusValueSchema = z.enum(["queued", "running", "completed", "failed"]);
export type JobStatusValue = z.infer<typeof JobStatusValueSchema>;

export const JobSubmitResponseSchema = z.object({
  jobId: z.string(),
});
export type JobSubmitResponse = z.infer<typeof JobSubmitResponseSchema>;

export const JobStatusSchema = z
  .object({
    jobId: z.string(),
    status: JobStatusValueSchema,
    topology: GraphTopologySchema.optional(), // present when status === "completed"
    error: z.string().optional(), // present when status === "failed"
  })
  .refine((job) => job.status !== "completed" || job.topology !== undefined, {
    message: "completed jobs must carry a topology payload",
    path: ["topology"],
  })
  .refine((job) => job.status !== "failed" || job.error !== undefined, {
    message: "failed jobs must carry an error message",
    path: ["error"],
  });
export type JobStatus = z.infer<typeof JobStatusSchema>;
