# Underhood — Project Context & Design Specification

> **Project Name:** Underhood  
> **Repository Architecture:** Full-Stack TypeScript Monorepo (Bun Runtime)  
> **Core Orchestration:** Mastra (TS-Native Agents & Durable Workflows)  
> **Persistence & Resilience:** PostgreSQL (Mastra Workflow State, Checkpointing & Graph Topology Cache)  
> **Rendering Engine:** Hybrid 2D/3D (`@xyflow/react` + `3d-force-graph`)  
> **Dependencies:** Zod, Prettier, ESLint, Bun

---

## 1. Problem Thesis

### The Who & The Pain
Software systems are inherently abstract. Non-technical Product Managers, QA engineers, junior developers, and technical recruiters struggle to understand system mechanics by reading raw source code.

* **The Cost:** Synchronous engineering time is consumed drawing ad-hoc whiteboard diagrams, translating code logic in meetings, or maintaining outdated architectural documentation that drifts from implementation.
* **Why Traditional LLM Prompts Fail:** Direct "text-to-diagram" zero-shot prompts frequently generate invalid syntax, hallucinate disconnected node references, or produce unreadable static text blocks without execution flow context.
* **Why an AI Harness Fits:** An agentic workflow can parse raw code, infer execution stages, identify design patterns, and validate the resulting graph topology deterministically against a strict schema. If syntax or relational links fail validation, the harness runs a self-healing reflection loop before returning the payload to the frontend.
* **Where AI Does Not Fit:** Generating pixel-perfect UI canvas rendering. The LLM is strictly restricted to semantic extraction and topological JSON generation; layout engines (Dagre/ELK) and WebGL renderers handle all visual math deterministically.

---

## 2. System Architecture & The Mastra Harness

The harness is implemented as a durable workflow using Mastra. It enforces deterministic boundaries around the model's non-deterministic output using strict TypeScript tooling, native step execution, and PostgreSQL-backed persistence for crash resilience and execution state recovery.

### Persistence & Storage Layer (PostgreSQL)
* **Workflow State Persistence:** Mastra workflow runs, checkpoint steps, and intermediate evaluation states are persisted to PostgreSQL.
* **Graph Topology & Pattern Cache:** Validated AST extractions and graph topologies are indexed and cached in PostgreSQL by code hash and language to enable instant cache hits on repeated source analysis.
* **Audit & Lifecycle Logs:** Execution metadata and self-healing loop telemetry are retained for SDET validation and observability.

### Workflow Payload (State Context)
* **`rawCode`**: Source code string provided by the user.
* **`language`**: Detected or specified language (e.g., typescript, python, go).
* **`detectedPatterns`**: List of identified structural/behavioral patterns (e.g., Singleton, State Machine, Async Pipeline).
* **`graphPayload`**: Structured topology containing nodes, edges, and particles.
* **`validationErrors`**: Array of validation or schema mismatch strings.
* **`retryCount`**: Counter protecting against infinite self-healing loops.

### Mastra Execution Steps
* **`analyzeCodeStep`**: Performs initial structural reasoning. Identifies the entry point, logical branches, side effects, design patterns, and execution sequence.
* **`generateTopologyStep`**: Translates the logical steps into a strict JSON contract containing discrete execution nodes and directional edge transitions, utilizing a Mastra tool with strict Zod structured output.
* **`validateGraphStep`**: Pure TypeScript validation block executed natively within the workflow.
  * **Checks:**
    * Every `edge.source` and `edge.target` maps to an existing `node.id`.
    * The graph has no orphaned execution paths (unless explicitly representing detached functions).
    * Valid JSON schema compliance.
* **`selfHealBranch`**: A Mastra `.branch()` triggered conditionally when `validationErrors.length > 0` and `retryCount < 2`. Injects the specific schema error back into the Mastra agent prompt for targeted repair.

---

## 3. Dual-Engine Visualization Interface
The web client provides a hybrid visualization surface tailored for both conceptual understanding and deep technical inspection:

* **2D Mode (`@xyflow/react`)**: Interactive flowchart with auto-layout (Dagre/ELK). Displays clean blocks, custom bezier curve edges with animated gradient SVG paths, zoom/pan controls, and inspector drawers for step-by-step code annotations.
* **3D Particle Mode (`3d-force-graph`)**: High-impact WebGL spatial canvas. Renders execution graphs with directional glowing particle streams travelling across links (`linkDirectionalParticles`), highlighting asynchronous I/O and processing bottlenecks in 3D orbit space.
* **Pattern Inspector Bar**: Dynamic panel highlighting detected engineering patterns with visual markers linked directly to corresponding graph nodes.

---

## 4. Failure Modes & Guardrails

| Risk / Failure Mode | Harness Mitigation Strategy |
| :--- | :--- |
| **Malformed JSON Output** | Strict structured outputs using Mastra tools and native Zod schema parsing. |
| **Dangling Edge Targets** | Deterministic topology validation step flags broken references; triggers `selfHealBranch`. |
| **Infinite Reflection Loop** | Hard limit of 2 retries on the Mastra workflow state. Falls back to a gracefully degraded linear graph if validation fails twice. |
| **Large/Monolithic Code** | Input truncation guardrail and token budget enforcement with structured chunking. |
| **Workflow Interruptions / Failures** | PostgreSQL-backed durable execution guarantees workflow recovery from the last successful step. |