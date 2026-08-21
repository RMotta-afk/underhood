# Log Entry: 2026-08-21 — SDD rev. 3 Planning Change (Concurrency, Caching, Observability)
**Actor:** @principal_ai
**Type:** planning / architecture revision
**Tasks touched:** none (pre-implementation); DAG restructured

## Events
1. **User requirements ingested:** concurrent multi-user support on commodity hardware ($5-tier Railway), PostgreSQL-backed job queue created together with the DB implementation, prompt caching, embedding-based result dedup, and cost/token/iteration observability.
2. **Research gate passed:** Context7 confirmed Mastra's official `@mastra/langfuse` `LangfuseExporter` captures token usage, costs, and span timelines natively; Langfuse Cloud free tier chosen over self-hosting (ClickHouse stack not viable on $5 box).
3. **SDD revised to rev. 3:**
   - §5 Concurrency & Distribution: pg-boss inside existing Postgres; async `POST /analyses` → `{jobId}` / `GET /analyses/:jobId`; worker pool via `WORKER_CONCURRENCY`; stateless replicas behind LB (Railway native / Caddy local).
   - §6 Caching, Dedup & Observability: prompt cache `(promptHash, modelId)`; entity-aware embedding dedup (AST skeleton preserving entity names; `SIMILARITY_THRESHOLD` cosine matching; ludic labels preserved on cache hits); Langfuse Cloud tracing with env-driven enable/disable.
   - §3 schemas extended: `GraphCacheSchema.embedding?`, new `JobStatusSchema`.
   - §7 env vars extended: `WORKER_CONCURRENCY`, `EMBEDDING_MODEL`, `SIMILARITY_THRESHOLD`, `LANGFUSE_*`.
   - §8 constraints updated: queue explicitly named under No Shadow Databases.
4. **AGENT.md updated:** @backend_engineer now owns pg-boss wiring/worker pool and Langfuse observability.
5. **DAG regenerated:** Mission updated; new Goal **G5 "Async Distribution, Caching & Observability"** with T5.1–T5.4; T2.4 expanded to include pg-boss schema creation; T1.2 gains `JobStatusSchema`; T3.1 gains polling client; T4.3 gains parallel-load E2E.
   - Validation gates passed: acyclicity verified programmatically (20/20 topologically sorted, stored order valid).
6. **Task cards regenerated:** all 20 cards `[BLOCKED]`, UTF-8 clean (PS 5.1 encoding defect found and fixed during generation).

## State Change
Context structure is complete for a concurrent, cached, observable system. Implementation dispatch begins at `T1.1`.

## Next Actions
- Dispatch T1.1; parallel group `g1-contracts` (T1.2, T1.3, T1.4) unlocks after.
