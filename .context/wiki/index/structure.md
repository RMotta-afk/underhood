# Wiki Index — Structural State
**Last refreshed:** 2026-08-23 (terminal acceptance: live-model E2E + evals green)

## Project
Underhood — code/workflow visualization platform. Parses a single snippet/file, extracts semantic topology (with plain-language node descriptions), serves many users concurrently via a PostgreSQL-backed async job pipeline (pg-boss), caches prompts and dedups similar snippets via entity-aware embeddings, observes costs/tokens/iterations in Langfuse Cloud, and renders as 2D or 3D.

## Current Lifecycle Position
- **G1 Scaffold & Contracts: COMPLETE**
- **G2 Mastra Pipeline: COMPLETE**
- **G3 Visualization Frontend: COMPLETE** (T3.1 input/poll client, T3.2 2D Dagre renderer, T3.3 3D force-graph renderer, T3.4 2D/3D toggle)
- **G5 Async/Caching/Observability: COMPLETE** (pg-boss worker pool, prompt cache, embedding dedup — now wired into the live executor — Langfuse)
- **G4 Quality Gates: COMPLETE** (acceptance suites, Mastra scorers + Postgres-persisted evals, Docker/Playwright smoke — terminal live-model run GREEN)
- **Mission: COMPLETE** (terminal signal satisfied 2026-08-23; optional follow-ups only)

## Structure Map
| Path | Purpose | Status |
|---|---|---|
| `docs/sdd/architecture.md` | Semantic anchor — all architecture truth | rev. 3 |
| `.context/decomposition.json` | Task DAG (Mission → 5 Goals → 20 Tasks) | validated (acyclic) |
| `tasks/T{goal}.{n}.md` | Atomic task cards | implementation tasks [DONE]; see cards for logs |
| `packages/types/` | Shared Zod schemas incl. JobStatusSchema | complete |
| `backend/` | Bun + Mastra workflow + Postgres store + pg-boss queue + cache/dedup executor | complete |
| `frontend/` | Next.js App Router, polling client, GraphView (2D/3D) | complete |
| `tests/` | Cross-cutting schema/workflow suites + evals runner | complete |
| `e2e/`, `playwright.config.ts` | Browser happy-path smoke vs compose stack | complete (full pass needs model keys) |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | One app container (backend :3000 + frontend :3001), db, Caddy parity proxy | complete |

## Agent Positions
| Agent | Current Assignment |
|---|---|
| @principal_ai | Standby (mission complete) |
| @architect | Standby |
| @devops | Optional: verify CI workflow green-run on push |
| @backend_engineer | Standby |
| @frontend_engineer | Standby |
| @sdet | Standby (optional: Langfuse-keyed tracing verification when keys land) |

## Critical Path
Implementation DAG fully discharged; only operator-gated acceptance remains.

## Cross-References
- Mission & terminal signal: `.context/decomposition.json#/mission`
- Immutable scope decisions: `docs/sdd/architecture.md` §0
- Concurrency model: SDD §5 · Caching/dedup/observability: SDD §6
- Protocol rules (secrets firewall, wiki mandate): `.context/AGENT.md`
