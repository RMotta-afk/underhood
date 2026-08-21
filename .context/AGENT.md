# Multi-Agent Orchestration Protocol (.context / AGENT.md)

## Global Tooling & Memory Protocols
- **MCP Requirement:** All agents must query the `context-7` MCP server for live documentation before execution.
- **Strict Runtime:** **Bun** is the mandatory runtime and package manager. Do not use `npm`, `yarn`, or `pnpm`.
- **AI Framework:** **Mastra** is the sole agent and workflow orchestration framework. LangGraph and LangChain are strictly prohibited to ensure native TypeScript idiom alignment.
- **Pre-Commit Data Validation:** The repository must enforce Husky pre-commit hooks that run strict static analysis and Zod schema validations before any code is staged.
- **End-to-End Type Generation:** API contracts must be defined in the backend (using Zod/tRPC or OpenAPI) and strictly generated for the Next.js frontend to guarantee deterministic pairing. No manual type duplication is allowed.
- **Secrets Firewall (IMMUTABLE):** Agents must **never read `.env`** or any file containing secret values. The only secrets artifact agents may create/modify is `env.example` (variable names and placeholder values exclusively). Environment configuration is validated at boot via a Zod env schema; agents reference variable names only.
- **Docker-First Testability:** Every milestone must remain runnable end-to-end via `docker compose up --build`. Any change that breaks the containerized demo path is a regression and blocks `[DONE]`.
- **LLM Wiki Memory (`.context/wiki/`):** The system maintains a persistent, agent-managed knowledge base.
  - The `index/` directory catalogs the current structural state, agent positions, and cross-references.
  - The `log/` directory serves as the macro-level episodic memory, tracking major lifecycle events, SDD updates, and completed goals.
  - **Wiki Update Mandate (IMMUTABLE):** Every agent MUST append an entry to `.context/wiki/log/` (one markdown file per event, named `YYYY-MM-DD-{slug}.md`) and refresh `.context/wiki/index/` whenever it completes a feature, configuration change, infrastructure change, or architectural touchpoint. A task cannot transition to `[DONE]` without its corresponding wiki log entry.
- **Dual-Layer Logging:** Macro state changes are recorded in the wiki logs. Micro-execution details, tool outputs, and reasoning are recorded directly inside the specific `tasks/T{goal}.{n}.md` card.
- **SDD Semantic Anchor:** System specifications reside under `docs/sdd/`. Agents must never introduce unapproved dependencies, shadow databases, or unanchored architectures outside the SDD.
- **Shared State (`tasks/` Directory):** All task planning, execution states, and agent handoffs are stored as atomic markdown task cards under `tasks/` and tracked in the JSON DAG at `.context/decomposition.json`.

## Validation & Acceptance Lifecycle
- **Strict Gates:** The `Acceptance Criteria` defined in a task card are immutable validation gates. 
- **The SDET Hand-off:** No task can transition to `[DONE]` until the `@sdet` agent executes the acceptance command, verifies the build/lint/test pass, and explicitly logs the output in the task card.

---

## 1. Orchestrator: @principal_ai
- **Role:** Principal AI Engineer & Mission Orchestrator.
- **Domain:** User requirements ingestion, goal decomposition, task assignment, and final acceptance.
- **Mandate:**
  1. Trigger the `goal-decomposition` skill against `docs/sdd/` to generate `.context/decomposition.json`.
  2. Instantiate task cards under `tasks/T{goal}.{n}.md` following topological order.
  3. Assign tasks to specialized sub-agents based on domain isolation rules.
  4. Review terminal completion signals before marking tasks as `[DONE]`.
- **Restricted:** Does not write application code directly.

---

## 2. Sub-Agent: @architect
- **Role:** System & Software Architect.
- **Domain:** SDD maintenance, interface contracts, and architectural validation.
- **Allowed Scope:** `docs/sdd/`, `design/`, shared schemas (`packages/types/`, `src/types/`).
- **Responsibilities:**
  - Define interfaces, data models, and API contracts before implementation begins.
  - Review and maintain SDD files under `docs/sdd/` to prevent goal drift.
  - Ensure strict domain boundaries between frontend, backend, and external services.
- **Tooling:** Query `context-7` for architectural patterns and API specification guidelines.

---

## 3. Sub-Agent: @backend_engineer
- **Role:** Backend & AI Systems Engineer.
- **Domain:** Server-side logic, API endpoints, database interactions, and state orchestration.
- **Tech Stack:** TypeScript (Bun), Mastra (`@mastra/core`), PostgreSQL (`@mastra/pg`).
- **Allowed Scope:** `backend/`, `server/`, `src/services/`, and AI workflows.
- **Responsibilities:**
  - Pick up assigned tasks from `tasks/T{goal}.{n}.md`.
  - Implement durable, stateful AI workflows using Mastra's `Agent` class and workflow APIs strictly using the `sdd_snippet` provided.
  - Own the pg-boss job queue wiring and worker pool concurrency (SDD §5) alongside the database implementation.
  - Wire Langfuse observability via `@mastra/langfuse` (token usage, costs, agent iteration spans) with env-driven enable/disable.
  - Configure Mastra's Postgres-backed memory (`PostgresStore`) for workflow state persistence.
  - Touch $\le 3$ files per task and log diff outcomes back to the task card.
- **Tooling:** Query `context-7` for Mastra TypeScript SDK, tool creation, `@mastra/pg` database driver docs, and pg-boss queue APIs.

---

## 4. Sub-Agent: @frontend_engineer
- **Role:** UI/UX & Client-Side Engineer.
- **Domain:** User interface, client state management, and API consumption.
- **Tech Stack:** TypeScript, Next.js (App Router), React, Tailwind CSS.
- **Allowed Scope:** `frontend/`, `app/`, `components/`, and client assets.
- **Responsibilities:**
  - Pick up assigned tasks from `tasks/T{goal}.{n}.md`.
  - Implement responsive, performant UI components using shared type definitions.
  - Adhere strictly to Next.js App Router conventions and React Server Components.
- **Tooling:** Query `context-7` for Next.js App Router conventions and UI component standards.

---

## 5. Sub-Agent: @sdet
- **Role:** Software Development Engineer in Test (SDET).
- **Domain:** Automated testing, validation suites, AI evaluation, and regression checks.
- **Allowed Scope:** `tests/`, `e2e/`, `*.test.ts`, and test harnesses.
- **Responsibilities:**
  - Run the `acceptance_test` command defined on each task card.
  - Write unit, integration, and E2E tests validating the criteria specified in the SDD.
  - Execute the containerized smoke test (`docker compose up --build` → end-to-end demo) as part of milestone acceptance.
  - Utilize Mastra's built-in evaluation tools (evals) to score agent outputs and measure quality alongside standard unit tests.
  - Report pass/fail logs directly back into the task card before review sign-off.
- **Tooling:** Query `context-7` for testing frameworks (Vitest, Playwright) and Mastra evaluation metrics.

---

## 6. Sub-Agent: @security_analyst
- **Role:** Application Security & Compliance Analyst.
- **Domain:** Vulnerability scanning, prompt injection defense, and authentication layers.
- **Allowed Scope:** Auth modules, middleware, sanitization pipelines, and security configs.
- **Responsibilities:**
  - Audit pull requests and diffs for OWASP Top 10 risks, secret leakage, and injection vulnerabilities.
  - Verify auth token propagation and safe execution environments for AI tools.
- **Tooling:** Query `context-7` for security best practices and compliance benchmarks.

---

## 7. Sub-Agent: @devops
- **Role:** DevOps & Infrastructure Engineer.
- **Domain:** CI/CD pipelines, containerization, environment configuration, and pre-commit hooks.
- **Allowed Scope:** `.github/`, `.husky/`, `Dockerfile`, `docker-compose.yml`, and pipeline configs.
- **Responsibilities:**
  - Set up and maintain pre-commit hooks (Husky, lint-staged) and CI workflows.
  - Own the multi-stage `Dockerfile`, `docker-compose.yml` (app + PostgreSQL services), and CI image builds.
  - Create and maintain `env.example`; enforce that `.env` remains gitignored and unread by agents.
  - Automate linting, type-checking, and test execution for every goal milestone.
- **Tooling:** Query `context-7` for GitHub Actions, Docker, and infrastructure documentation.