import { z } from "zod";

// --- SDD §3.1 Graph Topology Schema ---

export const NodeTypeSchema = z.enum(["entry", "process", "io", "branch", "terminal"]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const NodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: NodeTypeSchema,
  plainDescription: z
    .string()
    .min(1)
    .describe("Jargon-free, 1-3 sentence explanation of what this node does, understandable by non-coders"),
  metadata: z.record(z.any()).optional(),
});
export type GraphNode = z.infer<typeof NodeSchema>;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1), // Must map to a valid NodeSchema id
  target: z.string().min(1), // Must map to a valid NodeSchema id
  animated: z.boolean().default(true),
});
export type GraphEdge = z.infer<typeof EdgeSchema>;

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
  createdAt: z.date(),
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
