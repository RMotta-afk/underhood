import { parse } from "acorn";
import type {
  CallExpression,
  Node,
  Program,
} from "acorn";
import { z } from "zod";

// T2.1 — analyzeCodeStep: deterministic AST/structural extraction (SDD §4.1 step 1).
// Pure TypeScript: no LLM, no provider coupling. Type stripping uses Bun's native
// transpiler; the AST walk runs on acorn's ESTree output. Entity names are
// deliberately preserved in the output so downstream dedup embeddings (SDD §6.2)
// and plain-language labels stay meaningful for non-coders.

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

export const StructuralAnalysisSchema = z.object({
  language: z.enum(["typescript", "javascript"]),
  entryPoints: z.array(z.string()).min(1),
  entities: z.array(CodeEntitySchema),
  branches: z.array(BranchSchema),
  ioOperations: z.array(IoOperationSchema),
  statementCount: z.number().int().nonnegative(),
  hasAsync: z.boolean(),
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

/** Strip TypeScript syntax via Bun's native transpiler, then parse with acorn. */
export function analyzeCode(rawCode: string): StructuralAnalysis {
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
      // Not JS/TS at all — still produce a minimal valid analysis.
      return emptyAnalysis("javascript");
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
        if (call.callee.type === "Identifier" && importedIoKinds.has(name)) {
          ioOperations.push({ kind: importedIoKinds.get(name)!, callee: name });
          break;
        }
        for (const rule of IO_CALLEES) {
          if (rule.pattern.test(name)) {
            ioOperations.push({ kind: rule.kind, callee: name });
            break;
          }
        }
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

  return StructuralAnalysisSchema.parse({
    language,
    entryPoints: [...entryPoints],
    entities: uniqueEntities,
    branches,
    ioOperations,
    statementCount,
    hasAsync,
    normalizedSkeleton: buildSkeleton(uniqueEntities, branches, ioOperations, hasAsync),
  });
}

function buildSkeleton(
  entities: CodeEntity[],
  branches: Branch[],
  io: IoOperation[],
  hasAsync: boolean
): string {
  // Order-independent structural signature that keeps entity names:
  // sorted entity list + sorted branch/io counts + async flag (SDD §6.2).
  const parts = [
    `entities:${entities.map((e) => `${e.kind} ${e.name}`).sort().join(",")}`,
    `branches:${JSON.stringify(countBy(branches.map((b) => b.kind)))}`,
    `io:${JSON.stringify(countBy(io.map((o) => o.kind)))}`,
    `async:${hasAsync}`,
  ];
  return parts.join("|");
}

function countBy(items: string[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, k) => {
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

function emptyAnalysis(language: "typescript" | "javascript"): StructuralAnalysis {
  return StructuralAnalysisSchema.parse({
    language,
    entryPoints: ["(module)"],
    entities: [],
    branches: [],
    ioOperations: [],
    statementCount: 0,
    hasAsync: false,
    normalizedSkeleton: "entities:|branches:{}|io:{}|async:false",
  });
}
