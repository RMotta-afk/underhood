import { parse } from "acorn";
import type {
  CallExpression,
  Node,
  Program,
} from "acorn";
import { z } from "zod";
import { buildSkeleton } from "./skeleton";
import { detectLanguage, isTreeSitterLanguage } from "./extractors/detect";
import { LANGUAGE_CONFIGS } from "./extractors/language-configs";
import { extractWithTreeSitter } from "./extractors/tree-sitter-extractor";

// T2.1 — analyzeCodeStep: deterministic AST/structural extraction (SDD §4.1 step 1).
// Pure TypeScript: no LLM, no provider coupling. JS/TS uses acorn's ESTree
// output; every other supported language goes through the generic tree-sitter
// extractor (see ./extractors/). Both emit the same StructuralAnalysis contract.
// Entity names are deliberately preserved in the output so downstream dedup
// embeddings (SDD §6.2) and plain-language labels stay meaningful for non-coders.

export const ANALYSIS_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "ruby",
  "php",
] as const;
export type AnalysisLanguage = (typeof ANALYSIS_LANGUAGES)[number];

export const EntityKindSchema = z.enum(["function", "variable", "parameter", "class"]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const CodeEntitySchema = z.object({
  name: z.string(),
  kind: EntityKindSchema,
});
export type CodeEntity = z.infer<typeof CodeEntitySchema>;

export const BranchSchema = z.object({
  kind: z.enum(["if", "switch", "ternary", "try", "loop"]),
});
export type Branch = z.infer<typeof BranchSchema>;

export const IoOperationSchema = z.object({
  kind: z.enum(["console", "fetch", "fs", "database", "process", "timer"]),
  callee: z.string(),
});
export type IoOperation = z.infer<typeof IoOperationSchema>;

// T6.1 — per-entity control-flow outline (CFG-lite). Ordered steps give the
// LLM the actual shape of each function (conditions, loop bodies, returns,
// calls) instead of bare branch counts, so generated topologies can mirror
// real control flow rather than collapsing to entry -> terminal.
export const FlowStepKindSchema = z.enum([
  "statement",
  "branch",
  "loop",
  "return",
  "throw",
  "call",
  "io",
]);
export type FlowStepKind = z.infer<typeof FlowStepKindSchema>;

export const FlowStepSchema = z.object({
  kind: FlowStepKindSchema,
  label: z.string().min(1),
  /** Source text of the governing condition (if/loop/switch test). */
  condition: z.string().optional(),
  /** Callee name for call/io steps — matches an extracted entity for calls. */
  callee: z.string().optional(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const EntityFlowSchema = z.object({
  entity: z.string().min(1),
  steps: z.array(FlowStepSchema),
});
export type EntityFlow = z.infer<typeof EntityFlowSchema>;

export const StructuralAnalysisSchema = z.object({
  language: z.enum(ANALYSIS_LANGUAGES),
  entryPoints: z.array(z.string()).min(1),
  entities: z.array(CodeEntitySchema),
  branches: z.array(BranchSchema),
  ioOperations: z.array(IoOperationSchema),
  statementCount: z.number().int().nonnegative(),
  hasAsync: z.boolean(),
  /** Per-function ordered control-flow outline (T6.1). Optional for
   * backwards compatibility with persisted analyses and test fixtures. */
  flows: z.array(EntityFlowSchema).optional(),
  /** Entity-aware normalized skeleton fed to the embedding dedup service (SDD §6.2). */
  normalizedSkeleton: z.string(),
});
export type StructuralAnalysis = z.infer<typeof StructuralAnalysisSchema>;

const IO_CALLEES: Array<{ pattern: RegExp; kind: IoOperation["kind"] }> = [
  { pattern: /^console\./, kind: "console" },
  { pattern: /^(globalThis\.)?fetch$/, kind: "fetch" },
  { pattern: /^Bun\.write$|^Bun\.file$/, kind: "fs" },
  { pattern: /^(node:)?fs(\.promises)?\./, kind: "fs" },
  { pattern: /^(db|prisma|drizzle)\./, kind: "database" },
  { pattern: /^process\.(exit|env)/, kind: "process" },
  { pattern: /^setTimeout$|^setInterval$/, kind: "timer" },
];

function ioKindFor(
  name: string,
  importedIoKinds: Map<string, IoOperation["kind"]>
): IoOperation["kind"] | null {
  if (importedIoKinds.has(name)) return importedIoKinds.get(name)!;
  for (const rule of IO_CALLEES) {
    if (rule.pattern.test(name)) return rule.kind;
  }
  return null;
}

function calleeName(callee: CallExpression["callee"]): string {
  // Unwrap wrappers so `await db.query()` / `(0, fetch)(...)` still classify.
  let inner = callee as Node;
  while (
    inner.type === "AwaitExpression" ||
    inner.type === "UnaryExpression" ||
    inner.type === "ChainExpression"
  ) {
    inner = (inner as unknown as { argument: Node }).argument;
  }
  if (inner.type === "Identifier") return (inner as unknown as { name: string }).name;
  return sourceText(inner);
}

function sourceText(node: Node): string {
  const anyNode = node as unknown as {
    name?: string;
    object?: Node;
    property?: Node;
  };
  if (anyNode.name) return anyNode.name;
  if (anyNode.object && anyNode.property) {
    const obj = anyNode.object as unknown as { name?: string };
    const prop = anyNode.property as unknown as { name?: string; value?: unknown };
    // Handles both dot access (prop.name) and computed access (prop.value),
    // including numeric/string literals like cache[0] or headers["x-key"].
    const propName =
      prop.name ??
      (typeof prop.value === "string" || typeof prop.value === "number"
        ? String(prop.value)
        : undefined);
    if (obj.name && propName) return `${obj.name}.${propName}`;
  }
  return "?";
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as Node).type === "string") {
          walk(item as Node, visit);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as Node).type === "string") {
      walk(value as Node, visit);
    }
  }
}

// --- T6.1: per-entity control-flow outline extraction ---

const MAX_FLOW_STEPS = 80;
const MAX_FLOW_TEXT = 120;

function flowText(js: string, node: Node | null | undefined): string {
  if (!node) return "";
  const r = node as unknown as { start?: number; end?: number };
  if (typeof r.start !== "number" || typeof r.end !== "number") return "?";
  const one = js.slice(r.start, r.end).replace(/\s+/g, " ").trim();
  return one.length > MAX_FLOW_TEXT ? `${one.slice(0, MAX_FLOW_TEXT - 1)}…` : one;
}

function bodyStmts(node: Node | null | undefined): Node[] {
  if (!node) return [];
  const anyNode = node as unknown as { type: string; body?: Node[] };
  if (anyNode.type === "BlockStatement" && Array.isArray(anyNode.body)) {
    return anyNode.body;
  }
  return [node];
}

function loopCondition(js: string, n: Node): string {
  const anyNode = n as unknown as { test?: Node; right?: Node };
  switch (n.type) {
    case "WhileStatement":
    case "DoWhileStatement":
      return flowText(js, anyNode.test);
    case "ForStatement":
      return anyNode.test ? flowText(js, anyNode.test) : "for each step";
    case "ForOfStatement":
    case "ForInStatement":
      return `each ${flowText(js, anyNode.right)}`;
    default:
      return "?";
  }
}

/** Unwrap await/sequence noise to find a directly invoked call. */
function directCall(expr: Node | null | undefined): CallExpression | null {
  let inner = expr;
  while (
    inner &&
    (inner.type === "AwaitExpression" ||
      inner.type === "UnaryExpression" ||
      inner.type === "ChainExpression")
  ) {
    inner = (inner as unknown as { argument: Node }).argument;
  }
  return inner && inner.type === "CallExpression" ? (inner as CallExpression) : null;
}

interface FlowContext {
  js: string;
  functionNames: Set<string>;
  importedIoKinds: Map<string, IoOperation["kind"]>;
}

/** Collect call/io steps embedded inside an expression (e.g. an if-test or
 * a returned call) so cross-function edges are never lost to syntax position. */
function embeddedCallSteps(ctx: FlowContext, expr: Node | null | undefined): FlowStep[] {
  if (!expr) return [];
  const steps: FlowStep[] = [];
  walk(expr, (n) => {
    if (n.type !== "CallExpression") return;
    const step = stepForCall(ctx, n as CallExpression);
    if (step) steps.push(step);
  });
  return steps;
}

function stepForCall(
  ctx: FlowContext,
  call: CallExpression
): FlowStep | null {
  const name = calleeName(call.callee);
  if (ctx.functionNames.has(name)) {
    return { kind: "call", label: `call ${name}`, callee: name };
  }
  const io = ioKindFor(name, ctx.importedIoKinds);
  if (io) return { kind: "io", label: name, callee: name };
  return null;
}

/** Ordered CFG-lite walk of one statement list. Nested function bodies are
 * skipped here — they become their own entity flows. */
function extractSteps(ctx: FlowContext, statements: Node[]): FlowStep[] {
  const steps: FlowStep[] = [];
  const push = (step: FlowStep): void => {
    if (steps.length < MAX_FLOW_STEPS) steps.push(step);
  };

  for (const stmt of statements) {
    if (steps.length >= MAX_FLOW_STEPS) break;
    switch (stmt.type) {
      case "IfStatement": {
        const s = stmt as unknown as {
          test: Node;
          consequent: Node;
          alternate: Node | null;
        };
        for (const callStep of embeddedCallSteps(ctx, s.test)) push(callStep);
        push({
          kind: "branch",
          label: `if (${flowText(ctx.js, s.test)})`,
          condition: flowText(ctx.js, s.test),
        });
        steps.push(...extractSteps(ctx, bodyStmts(s.consequent)));
        if (s.alternate) steps.push(...extractSteps(ctx, bodyStmts(s.alternate)));
        break;
      }
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement":
      case "WhileStatement":
      case "DoWhileStatement": {
        const s = stmt as unknown as { body: Node };
        push({
          kind: "loop",
          label: `loop while ${loopCondition(ctx.js, stmt)}`,
          condition: loopCondition(ctx.js, stmt),
        });
        steps.push(...extractSteps(ctx, bodyStmts(s.body)));
        break;
      }
      case "SwitchStatement": {
        const s = stmt as unknown as {
          discriminant: Node;
          cases: Array<{ consequent: Node[] }>;
        };
        push({
          kind: "branch",
          label: `switch (${flowText(ctx.js, s.discriminant)})`,
          condition: flowText(ctx.js, s.discriminant),
        });
        for (const c of s.cases) {
          steps.push(...extractSteps(ctx, c.consequent));
        }
        break;
      }
      case "TryStatement": {
        const s = stmt as unknown as {
          block: Node;
          handler: { body: Node } | null;
        };
        push({ kind: "branch", label: "try/catch fallback", condition: "block may fail" });
        steps.push(...extractSteps(ctx, bodyStmts(s.block)));
        if (s.handler) steps.push(...extractSteps(ctx, bodyStmts(s.handler.body)));
        break;
      }
      case "ReturnStatement": {
        const arg = (stmt as unknown as { argument: Node | null }).argument;
        for (const callStep of embeddedCallSteps(ctx, arg)) push(callStep);
        push({ kind: "return", label: `return ${flowText(ctx.js, arg) || "()"}` });
        break;
      }
      case "ThrowStatement": {
        const arg = (stmt as unknown as { argument: Node }).argument;
        for (const callStep of embeddedCallSteps(ctx, arg)) push(callStep);
        push({ kind: "throw", label: `throw ${flowText(ctx.js, arg)}` });
        break;
      }
      case "ExpressionStatement": {
        const call = directCall((stmt as unknown as { expression: Node }).expression);
        const step = call ? stepForCall(ctx, call) : null;
        if (step) push(step);
        break;
      }
      case "VariableDeclaration": {
        const decl = stmt as unknown as {
          declarations: Array<{ init: Node | null }>;
        };
        for (const d of decl.declarations) {
          const call = directCall(d.init);
          const step = call ? stepForCall(ctx, call) : null;
          if (step) push(step);
        }
        break;
      }
      // FunctionDeclaration/others: nested functions are separate flows;
      // plain assignments are noise for topology purposes.
      default:
        break;
    }
  }
  return steps;
}

/** Extract ordered flows for every top-level named function unit. */
function extractFlows(
  js: string,
  program: Program,
  importedIoKinds: Map<string, IoOperation["kind"]>,
  functionNames: Set<string>
): EntityFlow[] {
  const ctx: FlowContext = { js, functionNames, importedIoKinds };
  const flows: EntityFlow[] = [];
  for (const stmt of program.body) {
    if (stmt.type === "FunctionDeclaration") {
      const fn = stmt as unknown as { id: { name: string } | null; body: Node };
      if (fn.id?.name) {
        flows.push({
          entity: fn.id.name,
          steps: extractSteps(ctx, bodyStmts(fn.body)),
        });
      }
      continue;
    }
    if (stmt.type === "VariableDeclaration") {
      const decl = stmt as unknown as {
        declarations: Array<{
          id: { name?: string };
          init: Node | null;
        }>;
      };
      for (const d of decl.declarations) {
        const init = d.init as unknown as { type?: string; body?: Node } | null;
        const isFn =
          init?.type === "ArrowFunctionExpression" ||
          init?.type === "FunctionExpression";
        if (isFn && d.id.name) {
          flows.push({
            entity: d.id.name,
            steps: extractSteps(ctx, bodyStmts(init.body)),
          });
        }
      }
    }
  }
  return flows.filter((f) => f.steps.length > 0);
}

/** Strip TypeScript syntax via Bun's native transpiler, then parse with acorn. */
export function analyzeJsTs(rawCode: string): StructuralAnalysis {
  let language: "typescript" | "javascript" = "javascript";
  let js: string;
  try {
    // Plain-JS loader first: TS-only syntax fails here, giving accurate detection.
    js = new Bun.Transpiler({ loader: "js" }).transformSync(rawCode);
  } catch {
    try {
      js = new Bun.Transpiler({ loader: "tsx" }).transformSync(rawCode);
      language = "typescript";
    } catch {
      throw new Error(
        "Code could not be parsed as JavaScript or TypeScript (syntax error?)"
      );
    }
  }

  const program: Program = parse(js, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  // Track imported bindings so aliased calls like `readFile(...)` from
  // node:fs/promises still classify as fs IO.
  const importedIoKinds = new Map<string, IoOperation["kind"]>();
  walk(program, (n) => {
    if (n.type !== "ImportDeclaration") return;
    const decl = n as unknown as {
      source: { value: string };
      specifiers: Array<{ local: { name: string } }>;
    };
    const src: string = decl.source.value;
    let kind: IoOperation["kind"] | null = null;
    if (/^(node:)?fs(\.promises)?(\/|$)/.test(src)) kind = "fs";
    else if (/^(node:)?(http|https)(\/|$)/.test(src) || src.includes("undici")) kind = "fetch";
    else if (/^(node:)?child_process/.test(src)) kind = "process";
    if (!kind) return;
    for (const spec of decl.specifiers) {
      importedIoKinds.set(spec.local.name, kind);
    }
  });

  const entities: CodeEntity[] = [];
  const branches: Branch[] = [];
  const ioOperations: IoOperation[] = [];
  const entryPoints = new Set<string>();
  let hasAsync = false;
  const statementCount = program.body.length;

  walk(program, (n) => {
    switch (n.type) {
      case "FunctionDeclaration": {
        const fn = n as unknown as { id: { name: string } | null; async: boolean };
        if (fn.id?.name) {
          entities.push({ name: fn.id.name, kind: "function" });
          entryPoints.add(fn.id.name); // top-level-or-nested declarations are callable units
        }
        if (fn.async) hasAsync = true;
        break;
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression":
      case "AwaitExpression":
        if (n.type === "AwaitExpression") hasAsync = true;
        else if ((n as unknown as { async: boolean }).async) hasAsync = true;
        break;
      case "VariableDeclaration": {
        const decl = n as unknown as {
          declarations: Array<{ id: Node; init: Node | null }>;
        };
        for (const d of decl.declarations) {
          const id = d.id as unknown as { name?: string; elements?: Array<{ name?: string }> };
          const names =
            id.name
              ? [id.name]
              : ((id.elements ?? [])
                  .map((e) => e.name)
                  .filter((n): n is string => typeof n === "string"));
          for (const name of names) {
            entities.push({ name, kind: "variable" });
            const init = d.init as unknown as { type?: string; async?: boolean } | null;
            if (
              init &&
              (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")
            ) {
              entities[entities.length - 1]!.kind = "function";
              if ((program.body as unknown as Node[]).includes(n)) entryPoints.add(name);
              if (init.async) hasAsync = true;
            }
          }
        }
        break;
      }
      case "ClassDeclaration": {
        const cls = n as unknown as { id: { name: string } | null };
        if (cls.id?.name) entities.push({ name: cls.id.name, kind: "class" });
        break;
      }
      case "IfStatement":
        branches.push({ kind: "if" });
        break;
      case "SwitchStatement":
        branches.push({ kind: "switch" });
        break;
      case "ConditionalExpression":
        branches.push({ kind: "ternary" });
        break
      case "TryStatement":
        branches.push({ kind: "try" });
        break;
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        branches.push({ kind: "loop" });
        break;
      case "CallExpression": {
        const call = n as CallExpression;
        const name = calleeName(call.callee);
        const kind = ioKindFor(name, importedIoKinds);
        if (kind) ioOperations.push({ kind, callee: name });
        break;
      }
    }
  });

  // Entry-point fallback: pure top-level script with no named functions.
  const topLevelSideEffects = program.body.some(
    (s) => !["FunctionDeclaration", "ImportDeclaration", "ExportNamedDeclaration", "ExportDefaultDeclaration", "ClassDeclaration"].includes(s.type)
  );
  if (entryPoints.size === 0 && topLevelSideEffects) entryPoints.add("(module)");

  // Deduplicate entities by name+kind while preserving order.
  const seen = new Set<string>();
  const uniqueEntities = entities.filter((e) => {
    const key = `${e.kind}:${e.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Per-entity control-flow outline (T6.1) for downstream topology fidelity.
  const functionNames = new Set(
    uniqueEntities.filter((e) => e.kind === "function").map((e) => e.name)
  );
  const flows = extractFlows(js, program, importedIoKinds, functionNames);

  return StructuralAnalysisSchema.parse({
    language,
    entryPoints: [...entryPoints],
    entities: uniqueEntities,
    branches,
    ioOperations,
    statementCount,
    hasAsync,
    flows,
    normalizedSkeleton: buildSkeleton(uniqueEntities, branches, ioOperations, hasAsync),
  });
}

/**
 * Multi-language entry point (SDD §4.1 step 1). Detects the language (an
 * explicit hint wins), then dispatches: JS/TS via acorn, everything else via
 * the generic tree-sitter extractor. Throws when the code cannot be parsed —
 * a silent empty analysis would flow through generation as a degenerate
 * Start -> End topology, so failing loudly is the contract.
 */
export async function analyzeCode(
  rawCode: string,
  languageHint?: string
): Promise<StructuralAnalysis> {
  const hint = (languageHint ?? "").trim().toLowerCase();
  if (hint) {
    if (!(ANALYSIS_LANGUAGES as readonly string[]).includes(hint)) {
      throw new Error(
        `Unsupported language hint "${languageHint}". Supported: ${ANALYSIS_LANGUAGES.join(", ")}`
      );
    }
    return dispatch(hint as AnalysisLanguage, rawCode);
  }

  const detected = detectLanguage(rawCode);
  if (detected && isTreeSitterLanguage(detected)) {
    return dispatch(detected, rawCode);
  }
  return analyzeJsTs(rawCode);
}

async function dispatch(language: AnalysisLanguage, rawCode: string): Promise<StructuralAnalysis> {
  if (language === "javascript" || language === "typescript") {
    return analyzeJsTs(rawCode);
  }
  const extracted = await extractWithTreeSitter(LANGUAGE_CONFIGS[language], rawCode);
  return StructuralAnalysisSchema.parse({
    ...extracted,
    normalizedSkeleton: buildSkeleton(
      extracted.entities,
      extracted.branches,
      extracted.ioOperations,
      extracted.hasAsync
    ),
  });
}
