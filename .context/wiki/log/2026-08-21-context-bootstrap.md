# Log Entry: 2026-08-21 — Context Bootstrap (Phases 0 & 0.5)
**Actor:** @principal_ai
**Type:** lifecycle / planning
**Tasks touched:** none (pre-implementation)

## Events
1. **SDD revised to rev. 2** (`docs/sdd/architecture.md`) to codify user decisions:
   - §0 Scope Decisions added: single snippet/file MVP; 2D-or-3D as sole user mode switch; provider-agnostic LLM routing (OpenAI default, Groq via env); mandatory `plainDescription` per node; Docker-first testability; secrets contract.
   - §6 Runtime Environment & Deployment Contract added (`env.example` variable table, Docker topology).
   - PostgreSQL explicitly wired from Goal 2 (no deferral).
2. **AGENT.md updated** with three immutable rules:
   - Secrets Firewall: agents never read `.env`; only artifact is `env.example`.
   - Wiki Update Mandate: every feature/config/arch change requires a wiki log entry before `[DONE]`.
   - DevOps owns Dockerfile/compose/env.example; SDET runs containerized smoke tests.
3. **Goal decomposition executed** against `docs/sdd/`:
   - Output: `.context/decomposition.json` — Mission → G1..G4 → T1.1–T4.3.
   - Validation gates passed: SDD conformance, acyclicity (topological order computed), atomicity (≤3 files/task), uniqueness, completeness.

## State Change
Repository moved from "docs-only" to **"context-complete, implementation-gated"**: all task artifacts exist; application code intentionally absent until dispatch begins at T1.1.

## Next Actions
- Dispatch T1.1 (@principal_ai → scaffold).
- Parallel group `g1-contracts` (T1.2, T1.3, T1.4) unlocks after T1.1.
