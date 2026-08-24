# Underhood

**Paste code. Get a plain-language picture of what it does.**

Underhood turns a source-code snippet into a visual, plain-language execution-flow graph — a flowchart of what actually happens when the code runs. It is built for non-coders, product people, and developers alike: every node in the graph carries a jargon-free explanation, and decisions show their alternatives (`yes`/`no`), loops show their back-edges, and every completion path reaches an end.

```
                 ┌──────────────────────────────┐
   raw code ───▶ │  analyze → generate → heal   │ ───▶ 2D flowchart
                 └──────────────────────────────┘
```

## Why

Reading code is the hard part — for product managers reviewing an algorithm, juniors onboarding into a codebase, or anyone auditing a snippet they found. Underhood answers one question visually: **"what does this code actually do when it runs?"** — not a UML diagram of the type structure, but the real control flow: branches, loops, I/O, calls, and exits, each explained in plain English on hover.

## Features

- **Paste → visualize** — drop a snippet in the UI, hit Visualize, and get an interactive 2D execution flowchart (`@xyflow/react` + client-side dagre layout).
- **Plain-language nodes** — every step carries a jargon-free `plainDescription` shown on hover; non-coders can follow the flow without reading the source.
- **Real control flow** — branches fan out with alternatives, loops form real cycles, I/O and calls are first-class node types (`entry` / `process` / `io` / `branch` / `terminal`), and class methods group into containers.
- **Detected patterns** — completed runs surface high-level patterns (e.g. retry loops) alongside the graph.
- **Multi-language parsing** — JS/TS via acorn; Python, Java, C/C++, Go, Rust, C#, Ruby, and PHP via tree-sitter. Unparseable input fails the job with a clear error.
- **Fidelity-gated AI pipeline** — deterministic AST analysis → LLM topology generation → schema + fidelity validation with up to 2 heal retries; lazy straight-line graphs are rejected.
- **Async job API** — `POST /analyses` + poll `GET /analyses/:id` backed by **pg-boss** (PostgreSQL queue) and a bounded worker pool.
- **Cache & dedup** — exact topologies cached by code hash (per pipeline version); entity-aware embeddings skip the LLM for near-identical snippets.
- **Provider-agnostic models** — OpenAI, Groq, or any OpenAI-compatible endpoint via env (`MODEL_PROVIDER` / `MODEL_ID` / `MODEL_BASE_URL`).
- **Docker-first & scalable** — `docker compose up --build` runs Postgres + app + Caddy; scale app replicas horizontally behind the proxy.
- **Observability** — optional [Langfuse](https://langfuse.com) tracing of LLM calls, tokens, cost, and workflow spans.

## How it works

The pipeline is a durable [Mastra](https://mastra.ai) workflow with a fidelity-gated generate/validate/heal loop:

1. **Analyze (deterministic, no LLM)** — the snippet is parsed into an AST and reduced to a structural analysis: entities (functions/classes), branches (ifs/switches/ternaries), loops, I/O operations, async markers, and a per-function ordered control-flow outline. JS/TS uses `acorn`; all other languages use tree-sitter grammars.
2. **Generate (LLM)** — an LLM (routed provider-agnostically through Mastra's model router) converts the structural analysis into a JSON graph topology under a strict Zod schema. Every node must include a `plainDescription`.
3. **Validate & heal (deterministic)** — the generated graph is validated against the schema *and* against fidelity rules derived from step 1: every declared conditional must become a branch node with alternatives, every loop must form a real cycle, every call between functions must connect. Lazy straight-line graphs are rejected and regenerated with the exact validation errors injected (max 2 retries), then the run fails loudly instead of returning a degenerate graph.
4. **Cache & dedup** — topologies are cached by code hash (per pipeline version), and structurally similar snippets are matched via entity-aware embeddings so near-identical code skips the LLM entirely.
5. **Render** — the frontend lays out the graph client-side (dagre) and renders it as an interactive **2D flowchart** (`@xyflow/react`).

Jobs run asynchronously through **pg-boss** (PostgreSQL-backed queue) with a bounded worker pool, so the API stays responsive under load and the backend scales horizontally behind a reverse proxy.

## Supported languages

| Native (acorn) | Tree-sitter grammars |
| --- | --- |
| JavaScript, TypeScript | Python, Java, C, C++, Go, Rust, C#, Ruby, PHP |

Code that cannot be parsed as any supported language **fails the job with a clear error** — it never silently produces a trivial Start → End graph.

## Quick start (Docker)

Requirements: [Docker](https://docs.docker.com/compose/) with Compose v2.

```bash
cp env.example .env       # then fill in your model API key(s)
docker compose up --build
```

Then open **http://localhost:8080**, paste a snippet, and hit **Visualize**.

The compose stack runs:

| Service | Purpose |
| --- | --- |
| `db` | PostgreSQL 16 (queue, caches, workflow snapshots) |
| `app` | Backend API/worker (`:3000`) + Next.js frontend (`:3001`) — scale with `docker compose up --scale app=N` |
| `proxy` | Caddy reverse proxy on `:8080`, load-balancing the app replicas |

## Running locally (without Docker)

Requirements: [Bun](https://bun.sh) ≥ 1.3, a local PostgreSQL instance.

```bash
bun install
cp env.example .env       # point DATABASE_URL at your local Postgres

bun run dev               # backend on :3000 + frontend on :3001
```

## API

The backend exposes a small async API (the frontend uses the same endpoints):

```bash
# Submit code for analysis (returns immediately with a job id)
curl -X POST http://localhost:3000/analyses \
  -H "content-type: application/json" \
  -d '{"rawCode": "def main():\n    print(\"hello\")"}'
# => {"jobId":"<uuid>"}

# Poll until the job reaches a terminal state
curl http://localhost:3000/analyses/<jobId>
# => {"jobId":"...","status":"completed","topology":{"nodes":[...],"edges":[...],"detectedPatterns":[...]}}
```

Job states: `queued → running → completed | failed`. Failed jobs carry a human-readable `error`; completed jobs carry the validated `topology`. An optional `language` field (`python`, `java`, `go`, …) overrides auto-detection.

`GET /healthz` is the liveness probe.

## Configuration

Copy `env.example` to `.env` and fill in the values:

| Variable | Purpose |
| --- | --- |
| `MODEL_PROVIDER` / `MODEL_ID` | LLM routing (`openai`/`groq` + any model id, e.g. `gpt-4o`) |
| `MODEL_BASE_URL` | Optional OpenAI-compatible endpoint override |
| `OPENAI_API_KEY` / `GROQ_API_KEY` | Provider credentials |
| `DATABASE_URL` | PostgreSQL connection string (queue + all caches) |
| `WORKER_CONCURRENCY` | Max analysis jobs executed in parallel |
| `EMBEDDING_MODEL` / `SIMILARITY_THRESHOLD` | Dedup embedding model and similarity cutoff |
| `LANGFUSE_*` | Optional [Langfuse](https://langfuse.com) tracing of LLM calls and workflow runs |

## Project structure

```
backend/            Bun API server + pg-boss worker pool
  src/api/            Async analysis endpoints (submit / poll)
  src/queue/          pg-boss wiring and worker pool
  src/workflow/       Mastra workflow (analyze → generate → validate/heal)
  src/workflow/steps/extractors/  Multi-language AST extraction (tree-sitter)
  src/services/       Prompt cache + embedding-based snippet dedup
  src/observability/  Langfuse tracing
frontend/           Next.js (App Router) UI
  components/graph/   2D flowchart renderer (xyflow)
  lib/                Typed API client + client-side dagre layout
packages/types/     Shared Zod schemas (single source of truth, no manual type duplication)
docs/sdd/           Software design document
scripts/            start-stack (container entrypoint), secret checks
tests/              Cross-workflow integration tests + topology evals
e2e/                Playwright end-to-end tests
```

## Development

```bash
bun run test          # unit + integration tests (bun test)
bun run typecheck     # strict TypeScript across the monorepo
bun run lint          # eslint
bun run evals         # topology quality evals against the LLM
bun run e2e           # Playwright end-to-end suite
```

Design notes and architectural decisions live in [`docs/sdd/architecture.md`](docs/sdd/architecture.md).

## Design principles

- **Fidelity is enforced, not hoped for.** The LLM's output is checked against what the AST actually contains; lazy graphs are regenerated with the specific violations, and the pipeline fails deterministically rather than showing a wrong picture.
- **Plain language is a schema requirement.** Every node must carry a non-coder-friendly description — it is impossible to generate a node without one.
- **One source of truth.** The same Zod schemas validate LLM output, API responses, and the database payload on both sides of the wire.
- **Fail loudly.** Unparseable or unsupported code produces a clear job error, never a silently useless visualization.
