# Wiki Index — Structural State
**Last refreshed:** 2026-08-21 (post rev. 3)

## Project
Underhood — code/workflow visualization platform. Parses a single snippet/file, extracts semantic topology (with plain-language node descriptions), serves many users concurrently via a PostgreSQL-backed async job pipeline (pg-boss), caches prompts and dedups similar snippets via entity-aware embeddings, observes costs/tokens/iterations in Langfuse Cloud, and renders as 2D or 3D.

## Current Lifecycle Position
- **Phase 0 / 0.5: COMPLETE** (bootstrap log)
- **SDD rev. 3 planning change: COMPLETE** — concurrency + caching + observability folded into docs, DAG, cards
- **Next:** Implementation dispatch begins at `T1.1` per topological order in `.context/decomposition.json`

## Structure Map
| Path | Purpose | Status |
|---|---|---|
| `docs/sdd/architecture.md` | Semantic anchor — all architecture truth | rev. 3 |
| `.context/decomposition.json` | Task DAG (Mission → 5 Goals → 20 Tasks) | validated (acyclic) |
| `tasks/T{goal}.{n}.md` | Atomic task cards | all `[BLOCKED]`, awaiting dispatch |
| `packages/types/` | Shared Zod schemas incl. JobStatusSchema | not created (T1.2) |
| `backend/` | Bun + Mastra workflow + Postgres store + pg-boss queue | not created (G2/G5) |
| `frontend/` | Next.js App Router, polling client, 2D/3D renderers | not created (G3) |
| `env.example` | Secrets contract (names only; incl. LANGFUSE_*, WORKER_CONCURRENCY) | not created (T1.4) |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Docker-first testability with replica parity | not created (T1.5) |

## Agent Positions
| Agent | Current Assignment |
|---|---|
| @principal_ai | Dispatch T1.1 next session |
| @architect | Standby (contracts anchored in SDD rev. 3) |
| @devops | Queued for T1.3, T1.4, T1.5 |
| @backend_engineer | Queued for G2 chain + G5 (queue, worker pool, caches, Langfuse) |
| @frontend_engineer | Queued for G3 chain |
| @sdet | Queued for G4 + acceptance gates on every task |

## Critical Path
`T1.1 → T1.2 → T2.1 → T2.2 → T2.3 → … , G5 chain off T2.4, … → T4.3`

## Cross-References
- Mission & terminal signal: `.context/decomposition.json#/mission`
- Immutable scope decisions: `docs/sdd/architecture.md` §0
- Concurrency model: SDD §5 · Caching/dedup/observability: SDD §6
- Protocol rules (secrets firewall, wiki mandate): `.context/AGENT.md`
