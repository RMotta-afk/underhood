# Underhood — Design Narrative

A project write-up covering thesis, users, architecture, tooling choices, and reflections.
I also an Engineer from heart, and without any imagination, I always struggled to visualize my features from another perspective other than drawing myself or generating flowcharts to understand workflows.\
Since time flies, and an Engineer's time is precious, here is Underhood, that allows you to understand your code from another perspective.

---

## 1. The problem thesis

### Who has it

Software is abstract. The people who need to reason about *what code does* are often not the people who wrote it:

- **Product managers** reviewing an algorithm or acceptance criteria against implementation
- **Junior developers** onboarding into an unfamiliar codebase
- **QA / SDETs** tracing branches and failure paths before writing tests
- **Anyone auditing a snippet** — a PR fragment, a Stack Overflow answer, a take-home exercise — without wanting a full IDE session

They all share the same friction: raw source is a poor medium for *shared understanding*. Meetings fill with whiteboard sketches that evaporate; docs drift from the code; “just read the function” is not a strategy.


### What it costs

The cost is mostly **synchronous engineering time**:

- Engineers pause feature work to translate control flow in standups and design reviews
- Onboarding stretches because juniors reverse-engineer mental models from syntax
- Ad-hoc diagrams go stale the moment the branch condition changes
- Zero-shot “draw me a flowchart of this code” LLM prompts fail in predictable ways: invalid graph syntax, dangling edge IDs, pretty-looking straight lines that ignore every `if` and loop

Wrong diagrams are worse than none — they create false confidence.

### Why an AI harness fits

The valuable part of the job is **semantic**: turn structure into a plain-language story of execution. LLMs are good at that narrative layer. They are bad at layout math, schema discipline, and honesty about what the AST actually contains.

An **AI harness** is the right shape when:

1. A **deterministic front half** can extract hard facts (entities, branches, loops, I/O, call outline)
2. A **constrained model step** is allowed only to produce topology + plain language under a strict schema
3. A **deterministic back half** can reject lazy or broken graphs and force repair — or fail loudly

Underhood is that sandwich. The model never picks pixel coordinates. It never ships a graph that failed fidelity checks. Unparseable code does not become a fake Start → End picture.

Where AI does **not** fit: canvas layout, provider SDKs in business logic, or “best effort” visualizations of code we could not parse.

---

## 2. The end user & the interface

### Who uses it

Primary: **non-coders and code-adjacent roles** who need a trustworthy picture without reading every line.  
Secondary: **developers** who want a fast control-flow sketch of a snippet (not a whole-repo architecture browser — that is explicitly out of MVP scope).

### What their experience is

1. Open the app (Docker: `http://localhost:8080`)
2. Paste a single snippet or file
3. Hit **Visualize**
4. Watch job status: queued → analyzing → done (or a clear error)
5. Explore an interactive **2D flowchart**: pan/zoom, typed nodes (entry / process / I/O / branch / terminal), class containers where relevant
6. **Hover any node** for a jargon-free `plainDescription` (one to three sentences)
7. Optionally see **detected patterns** (e.g. retry loop) called out above the graph

There is no account model, no project browser, no multi-file workspace. The product is deliberately one verb: *show me what this does when it runs*.

### Why this interface

| Choice | Rationale |
| --- | --- |
| **Paste box + one button** | Lowest friction for the thesis. No repo OAuth, no IDE plugin install. |
| **Async submit + poll** | LLM work is slow and bursty; the UI stays honest about queue/worker state instead of hanging a request. |
| **2D flowchart only** | Flowcharts match how people already explain algorithms on whiteboards. Dagre + `@xyflow/react` give readable left-to-right/top-to-bottom structure. |
| **Hover plain language** | Schema-forced descriptions turn the graph into a product artifact, not a developer-only CFG dump. |
| **No 3D in the shipped UI** | Early design called for a 2D/3D toggle (`3d-force-graph`). In practice the workflow emits one renderer-agnostic topology; the 2D path carried the fidelity work and the demo. 3D was retired from the user-facing host so the product has one clear visual language. |
| **Fail in the UI, don’t fake it** | Errors surface as alerts with human-readable job failures. A wrong pretty graph would violate the thesis harder than an error message. |

---

## 3. Architecture & the harness

### How it works (pipeline)

```
raw code
   │
   ▼
┌──────────────┐     deterministic AST / structural analysis
│   Analyze    │     entities, branches, loops, I/O, CFG outline
└──────┬───────┘
       │
       ▼
┌──────────────┐     optional: exact hash cache / embedding dedup hit
│  Cache path  │──── return validated topology, skip LLM
└──────┬───────┘
       │ miss
       ▼
┌──────────────┐     LLM → JSON graph (Zod), every node has plainDescription
│   Generate   │
└──────┬───────┘
       │
       ▼
┌──────────────┐     schema + fidelity rules (branch fan-out, loop cycles, …)
│ Validate     │──── fail → inject errors, regenerate (max 2 heals)
│ & heal       │──── still bad → job failed (no degenerate graph)
└──────┬───────┘
       │
       ▼
   topology JSON  →  client dagre layout  →  2D xyflow render
```

Jobs are **asynchronous**: `POST /analyses` enqueues work and returns `{ jobId }`; `GET /analyses/:jobId` polls `queued | running | completed | failed`.

### Key components

| Layer | Role |
| --- | --- |
| **Frontend** | Next.js App Router; typed poll client; GraphView → Graph2D; layout only on the client |
| **API + workers** | Bun server; health on `/healthz`; pg-boss worker pool (`WORKER_CONCURRENCY`) |
| **Mastra workflow** | Durable `analyze → generateWithHealing`; snapshots in Postgres via `@mastra/pg` |
| **Extractors** | JS/TS: acorn. Other languages: tree-sitter grammars. Language override optional on the API |
| **Shared types** | `@underhood/types` Zod schemas — single source of truth for LLM output, API, and DB payload |
| **Postgres** | Queue (pg-boss), workflow snapshots, graph cache, prompt cache, embedding cache |
| **Dedup** | Entity-aware structural skeleton → embeddings → cosine similarity above threshold |
| **Observability** | Optional Langfuse export (tokens, cost, spans); off when keys absent |
| **Deploy shape** | One app image (API :3000 + frontend :3001), Postgres 16, Caddy on :8080 for local multi-replica parity |

### Failure and quality

**Failure modes and mitigations:**

| Risk | Mitigation |
| --- | --- |
| Malformed / schema-invalid JSON | Structured generation + Zod; heal with concrete errors |
| Dangling edges, lazy straight-line graphs | Fidelity checks derived from the analysis (branches must branch, loops must cycle, etc.) |
| Infinite repair loops | Hard cap of **2** heal retries, then **failed** job |
| Unparseable / unsupported code | Job error — never a silent trivial graph |
| Stale cache after pipeline upgrades | Cache and dedup keyed by **pipeline version** (e.g. `fidelity-v3`) |
| Worker/process crash mid-run | Durable Mastra snapshots in Postgres; async job status remains queryable |
| LLM cost / duplicate work | Prompt cache `(promptHash, modelId)`; embedding cache; similar-snippet dedup |
| Load spikes | Bounded concurrency per instance; horizontal scale of stateless app replicas |

**Quality beyond the heal loop:**

- Unit/integration tests on extractors, validation, cache/dedup
- Topology **evals** (scorers including fidelity) against live models when keys are present
- Playwright **e2e** against the compose stack
- Design principle: **fidelity is enforced, not hoped for**

A real defect drove the fidelity follow-up: a binary-search snippet once rendered as entry → terminal. The fix was not “a better prompt only” — it was CFG outline extraction in analyze, fidelity-gated heal, versioned caches so old lazy topologies could not be served, and wiring the durable workflow as the live production path.

---

## 4. Tooling & tradeoffs

### What we chose and why

| Choice | Why |
| --- | --- |
| **Bun + TS monorepo** | One language across API, workers, tests, and shared packages; fast install/run; fits a small team shipping full-stack quickly |
| **Mastra** | TS-native workflows/agents, durable runs with Postgres, model routing without LangChain/LangGraph (explicitly banned in the SDD) |
| **Zod everywhere** | One schema for model output, HTTP, and storage — no hand-duplicated TypeScript interfaces |
| **PostgreSQL only** | Queue, caches, snapshots, evals in one system — no Redis/SQLite split for MVP ops |
| **pg-boss** | Job queue *inside* Postgres; enough for multi-user concurrency on a small box without a second broker |
| **acorn + tree-sitter** | Deterministic structure before any LLM; multi-language without a forest of language-specific services |
| **Next.js + xyflow + dagre** | Familiar web UX; flowchart idioms; **all** layout on the client so the model cannot invent coordinates |
| **Provider via env** | OpenAI / Groq / OpenAI-compatible base URL — workflow code stays provider-agnostic |
| **Docker Compose + Caddy** | Reproducible demo; replica parity locally; “copy `env.example` → `.env` → up” as the acceptance path |
| **Langfuse (optional)** | Cost/latency/trace visibility without building an observability product |
| **Husky pre-commit pipeline** | Local quality gate before anything lands on `main`: secrets scan → lint-staged ESLint → full-repo `tsc` → `bun test`; `commit-msg` enforces conventional prefixes (`feature|fix|docs|…`) |
| **`.context` wiki + task DAG** | Agent-managed memory for context isolation and predictability: SDD as semantic anchor, `.context/decomposition.json` + `tasks/` for the mission graph, `.context/wiki/` (`index/` + dated `log/`) so every completed touchpoint leaves a recoverable trail instead of chat-only state |

### Quality & context tooling

**Pre-commit (code quality).** Hooks under `.husky/` make “green locally” a hard requirement, not a courtesy:

1. `bun run check:secrets` — staged-diff secrets firewall (never commit keys; agents never read `.env`)
2. `lint-staged` — ESLint on staged TypeScript
3. `bun run typecheck` + `bun test` — monorepo typecheck and unit/integration suite
4. `commit-msg` — conventional commit prefix gate

CI remains the backstop if hooks are bypassed; the intent is to fail fast on the developer machine before review.

**`.context` wiki (context isolation & predictability).** Multi-agent / long-horizon work needs a durable place for *what is true now* and *what just changed*, separate from application code:

- **Isolation** — role protocol in `.context/AGENT.md` (who may touch what), secrets firewall, and SDD-bound architecture so agents do not invent shadow stacks
- **Predictability** — mission → goals → tasks as a validated DAG; task cards carry acceptance gates; wiki `index/` tracks lifecycle position; wiki `log/YYYY-MM-DD-*.md` is mandatory episodic memory on feature/config/infra changes
- **Handoff** — a new session can reconstruct state from SDD + wiki + tasks without replaying the entire chat

### What we weighed against it

| Alternative | Why not (for this MVP) |
| --- | --- |
| **LangChain / LangGraph / Python agents** | Split runtime, weaker fit with a TS monorepo, and easy to blur deterministic vs model boundaries |
| **Sync request that returns the graph** | Ties HTTP latency to LLM tail latency; harder to scale workers independently |
| **Redis / separate queue** | Another moving part; Postgres already required for Mastra state |
| **Client-only LLM calls** | No shared cache/dedup, no server-side fidelity gate, keys in the browser |
| **Full IDE / repo analysis** | Explicitly post-MVP; explodes scope (modules, build graphs, permissions) |
| **UML / class-diagram first** | Answers “what types exist,” not “what happens when it runs” |
| **Shipped 2D + 3D toggle** | Two renderers to keep honest with the same fidelity bar; 3D impressed demos but 2D carried comprehension. Topology stays renderer-agnostic if 3D returns later |
| **Always trust the model’s graph** | Cheaper and simpler — and how we got the binary-search regression. Rejected as a product principle |
| **ELK vs dagre** | Dagre was enough for snippet-scale graphs; ELK remains an option if layouts get denser |
| **Deep responsivity / polish pass** | **Mostly deferred.** Little work went into responsive layouts, mobile breakpoints, or fine-grained UI performance tuning. Building and iterating this stack was already heavy on **agent/tool token spend** (long context, multi-file edits, pre-commit typecheck+test loops). Extra front-end polish rounds would have burned more tokens for marginal product signal versus pipeline fidelity, multi-language parse, and cache/dedup. The shipped UI targets a desktop paste-and-visualize demo, not a fully responsive product shell. |

---

## 5. Reflections

### Time spent

Built as a **spec-driven monorepo mission**: SDD → goal decomposition → task cards through scaffold, pipeline, frontend, async/cache/observability, quality gates, then a **fidelity follow-up** (T6.x) after a user-visible control-flow failure. Terminal acceptance (compose stack, live-model e2e/evals) landed around **2026-08-23**, with fidelity hardening the same day. Calendar effort was concentrated and agent-assisted against a fixed architecture doc rather than open-ended greenfield.

### What I’d do next

1. **Richer edge semantics in the UI** — branch labels (`yes`/`no`), clearer loop back-edges, and call edges into callees without reading node metadata
2. **Snippet size guardrails** — explicit truncation/chunk policy for monolithic files (called out early; still a sharp edge)
3. **Optional 3D return** — only if it stays a pure view over the same validated topology, not a second pipeline
4. **Auth’d history** — save prior jobs per user without changing the core paste UX
5. **Tighter Langfuse ↔ eval loop** — promote failing scorer cases into regression fixtures automatically
6. **Post-MVP multi-file** — only under a new SDD revision; the single-snippet constraint is load-bearing
7. **UML Export** - allow the users to export these flowcharts to a mermaid workflow, in order to paste anywhere they want
8. **SDK** - give other devs the opportunity to use underhood inside their documentations, websites and product presentations.

### What I’m least sure about

- **How far plain language can go** without becoming vague. Descriptions are schema-required, but “good for a PM” is still subjective; we score structure more rigorously than prose quality.
- **Embedding dedup thresholds** — similarity that is great for reformatted copies may be wrong for “same shape, different business meaning.” Entity-aware skeletons help; false cache hits would be a silent product bug.
- **Heal budget of two** — enough for schema nits and many fidelity misses; pathological models may burn both retries and surface failure more often than users tolerate unless prompts/models stay tuned.
- **Tree-sitter breadth vs depth** — many languages parse, but CFG outline fidelity is deepest where extractors and tests are thickest (JS/TS-led). Cross-language parity is uneven by construction.
- **Whether flowchart-is-enough holds** for highly async or event-driven code — particles in 3D were once the proposed answer; we have not proven a better 2D idiom for concurrency yet.

---

## Pointers

- Product overview & runbooks: [`README.md`](./README.md)
- Immutable architecture contract: [`docs/sdd/architecture.md`](./docs/sdd/architecture.md)
- Mission / goal DAG: [`.context/decomposition.json`](./.context/decomposition.json)

---

## Bonus: Metrics

Snapshot of the repo as of **2026-08-24** (untracked design doc; figures from local tree + git history).

| Metric | Value |
| --- | --- |
| **Calendar span** | 2026-08-20 → 2026-08-24 (~5 active days) |
| **Git commits** | 63 |
| **Mission goals** | 6 (G1–G5 + G6 fidelity follow-up) |
| **Task cards** | 23 (`tasks/T*.md`) |
| **TypeScript / TSX files** | 52 (excl. `node_modules` / build artifacts) |
| **Approx. LOC** | ~6,000 lines across those files |
| **LOC by area** | backend ~4.3k · tests+e2e ~0.7k · frontend ~0.7k · packages ~0.2k |
| **Test files** | 17 (`*.test.ts` / `*.e2e.ts`) |
| **Pipeline version** | `fidelity-v3` |
| **Heal budget** | 1 initial generate + **2** retries, then hard fail |
| **Default worker concurrency** | 4 (`WORKER_CONCURRENCY`) |
| **Dedup similarity default** | 0.95 cosine |
| **Supported languages** | 11 (JS, TS + 9 tree-sitter: Python, Java, C, C++, Go, Rust, C#, Ruby, PHP) |
| **Node types in topology** | 5 (`entry`, `process`, `io`, `branch`, `terminal`) |
| **User-facing viz modes shipped** | 1 (2D flowchart; 3D retired from UI) |
| **Compose services** | 3 (`db`, `app`, `proxy`) |
| **Public API surface** | `POST /analyses`, `GET /analyses/:id`, `GET /healthz` |

### Per-run cost & token usage (approximate)

Estimates for a **typical snippet** (~20–80 LOC, a few branches/calls) on the default stack (`MODEL_ID=gpt-4o`, `EMBEDDING_MODEL=text-embedding-3-small`). Not metered from production Langfuse exports — order-of-magnitude only. Exact usage lands in Langfuse when keys are set.

| Field | Cold path (LLM miss) | Cache / dedup hit |
| --- | --- | --- |
| **LLM calls** | 1 generate; up to **3** if both heals fire (1 + 2 retries) | 0 |
| **Prompt tokens / generate** | ~1.5k–4k (instructions + structural analysis + CFG outline) | — |
| **Completion tokens / generate** | ~0.8k–2.5k (JSON topology + `plainDescription`s) | — |
| **Tokens / successful run (no heal)** | ~2.5k–6.5k total | ~0 (topology served from Postgres) |
| **Tokens / run (1 heal)** | ~5k–12k | — |
| **Tokens / run (2 heals, worst case)** | ~8k–18k | — |
| **Embedding tokens (dedup miss path)** | ~100–400 on the entity-aware skeleton (plus cache on repeat embeds) | 0 if exact `codeHash` hit skips embed |
| **Est. $ / run (gpt-4o, no heal)** | **~$0.02–0.08** | **~$0** (DB read only) |
| **Est. $ / run (gpt-4o, full heal budget)** | **~$0.06–0.20** | — |
| **Est. $ / run (small/fast model, e.g. Groq)** | Often **~$0.001–0.02** cold; still ~$0 on cache hit | **~$0** |
| **Embedding $ / run** | **≪ $0.001** at snippet scale | **~$0** on embed cache hit |

**What dominates cost:** completion size scales with node count and prose length of `plainDescription`; heals multiply both prompt and completion. Exact hash cache and similarity dedup are the main levers that drive marginal cost toward zero for repeats and near-duplicates.

### Speed indicators (approximate)

Wall-clock from **Visualize** click to rendered graph (or terminal job status). Bounded by product timeouts, not lab benchmarks.

| Field | Typical | Bound / note |
| --- | --- | --- |
| **Analyze (AST, no LLM)** | **&lt; 50–200 ms** JS/TS (acorn); **~50–500 ms** tree-sitter cold (wasm load amortized) | Deterministic; not the bottleneck |
| **Single LLM generate** | **~5–25 s** (gpt-4o); often **~1–8 s** on fast Groq-class models | Hard cap `LLM_TIMEOUT_MS` = **90 s** per generate |
| **Validate + heal loop** | +0 s if first graph passes; **+1–2× generate latency** per retry | Max **2** retries → up to **~3×** generate time |
| **Embedding + similarity lookup** | **~100–400 ms** on miss; **~ms** on embed-cache hit | Skipped on exact topology cache hit |
| **End-to-end job (cold, no heal)** | **~8–30 s** | UI poll interval **750 ms** |
| **End-to-end job (cold, with heals)** | **~20–60 s** common; can approach timeout under load | Client poll timeout **120 s**; e2e wait budget **180 s** |
| **End-to-end job (exact / dedup hit)** | **~0.3–2 s** | Queue + DB + status poll only |
| **Time to first API response** | **&lt; ~50–150 ms** | `POST /analyses` enqueues and returns `jobId` immediately |
| **Sustainable parallelism** | **4** concurrent jobs / app replica default | `WORKER_CONCURRENCY`; scale out with more `app` replicas |
| **p95 mental model** | Cold path **LLM-bound**; warm path **queue + network** | Replica backpressure via worker cap, not unbounded fan-out |

*Token, dollar, and latency figures are engineering estimates for design discussion. Re-measure from Langfuse traces and job timestamps for any capacity or pricing decision.*
