import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser, type Node as TsNode } from "web-tree-sitter";
import type {
  Branch,
  CodeEntity,
  EntityFlow,
  FlowStep,
  IoOperation,
} from "../analyze-code";
import type { LanguageConfig, TreeSitterLanguageId } from "./language-configs";

// Generic multi-language structural extractor. One walker driven purely by the
// per-language LanguageConfig — the same StructuralAnalysis shape the acorn
// JS/TS extractor produces, so prompt, validation, dedup and rendering stay
// unchanged across languages.

const require = createRequire(import.meta.url);

const MAX_FLOW_STEPS = 80;
const MAX_FLOW_TEXT = 120;

let parserReady: Promise<void> | null = null;
const parsers = new Map<string, Promise<Parser>>();

async function ensureParserInit(): Promise<void> {
  parserReady ??= Parser.init();
  return parserReady;
}

function wasmPath(cfg: LanguageConfig): string {
  const pkgJson = require.resolve(`${cfg.wasmPackage}/package.json`);
  return join(dirname(pkgJson), cfg.wasmFile);
}

async function getParser(cfg: LanguageConfig): Promise<Parser> {
  const cached = parsers.get(cfg.id);
  if (cached) return cached;
  const created = (async () => {
    await ensureParserInit();
    const language = await Language.load(wasmPath(cfg));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  parsers.set(cfg.id, created);
  return created;
}

// --- small AST helpers ---

function namedChildren(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

function walk(node: TsNode, visit: (n: TsNode) => void): void {
  visit(node);
  for (const child of namedChildren(node)) walk(child, visit);
}

/** Skip subtrees rooted at nested function definitions. */
function walkStatements(node: TsNode, cfg: LanguageConfig, visit: (n: TsNode) => void): void {
  visit(node);
  for (const child of namedChildren(node)) {
    if (cfg.functionDefs.includes(child.type)) continue;
    walkStatements(child, cfg, visit);
  }
}

function flowText(node: TsNode | null): string {
  if (!node) return "";
  const one = node.text.replace(/\s+/g, " ").trim();
  return one.length > MAX_FLOW_TEXT ? `${one.slice(0, MAX_FLOW_TEXT - 1)}…` : one;
}

function fieldText(node: TsNode, fields: string[]): TsNode | null {
  for (const f of fields) {
    const n = node.childForFieldName(f);
    if (n) return n;
  }
  return null;
}

/** Condition text for a branch/loop: dedicated fields first; grammars without
 * a condition field (PHP, Ruby) expose it as the first non-container child. */
function conditionNodeOf(cfg: LanguageConfig, node: TsNode): TsNode | null {
  const byField = fieldText(node, cfg.conditionFields);
  if (byField) return byField;
  return (
    namedChildren(node).find(
      (c) => !cfg.containerTypes.includes(c.type) && !cfg.functionDefs.includes(c.type)
    ) ?? null
  );
}

/** Callee name of a call node: dedicated fields first, then the source text
 * before the argument list — robust across grammar conventions (Java's
 * method_invocation only exposes the bare method name as `name`, and macros
 * carry `!` which is stripped for IO matching). */
function calleeOf(call: TsNode): string {
  for (const f of ["function", "method", "macro"]) {
    const n = call.childForFieldName(f);
    if (n) return n.text.replace(/\s+/g, "");
  }
  const raw = call.text.replace(/\s+/g, " ");
  const paren = raw.indexOf("(");
  const head = (paren > 0 ? raw.slice(0, paren) : raw.split(" ")[0] ?? "").trim();
  return head.replace(/!+$/, "");
}

function lastSegment(name: string): string {
  return name.split(/::|\.|->|@/).pop() ?? name;
}

interface ExtractContext {
  cfg: LanguageConfig;
  code: string;
  functionNames: Set<string>;
}

function matchIoRule(ctx: ExtractContext, calleeFull: string): IoOperation["kind"] | null {
  const short = lastSegment(calleeFull);
  for (const rule of ctx.cfg.ioRules) {
    if (rule.pattern.test(calleeFull) || rule.pattern.test(short)) return rule.kind;
  }
  return null;
}

function stepForCall(ctx: ExtractContext, call: TsNode): FlowStep | null {
  const full = calleeOf(call);
  if (!full) return null;
  if (ctx.functionNames.has(lastSegment(full))) {
    return { kind: "call", label: `call ${lastSegment(full)}`, callee: lastSegment(full) };
  }
  const io = matchIoRule(ctx, full);
  if (io) return { kind: "io", label: full, callee: full };
  return null;
}

function embeddedCallSteps(ctx: ExtractContext, node: TsNode): FlowStep[] {
  const steps: FlowStep[] = [];
  walkStatements(node, ctx.cfg, (n) => {
    if (!ctx.cfg.callTypes.includes(n.type)) return;
    const step = stepForCall(ctx, n);
    if (step) steps.push(step);
  });
  return steps;
}

function branchKindFor(type: string): Branch["kind"] {
  if (/switch|match|select/.test(type)) return "switch";
  if (/conditional|ternary/.test(type)) return "ternary";
  return "if";
}

// --- ordered CFG-lite flow extraction ---

function extractSteps(ctx: ExtractContext, node: TsNode, steps: FlowStep[]): void {
  const push = (step: FlowStep): void => {
    if (steps.length < MAX_FLOW_STEPS) steps.push(step);
  };

  for (const child of namedChildren(node)) {
    if (steps.length >= MAX_FLOW_STEPS) break;
    const t = child.type;

    if (ctx.cfg.functionDefs.includes(t) || ctx.cfg.classes.includes(t)) {
      continue; // separate entity flows
    }
    if (ctx.cfg.loopTypes.includes(t)) {
      const condNode = conditionNodeOf(ctx.cfg, child);
      const cond = condNode ? flowText(condNode) : "each step";
      push({ kind: "loop", label: `loop while ${cond}`, condition: cond });
      extractSteps(ctx, child, steps);
      continue;
    }
    if (ctx.cfg.tryTypes.includes(t)) {
      push({ kind: "branch", label: "try/catch fallback", condition: "block may fail" });
      extractSteps(ctx, child, steps);
      continue;
    }
    if (ctx.cfg.branchTypes.includes(t)) {
      const condNode = conditionNodeOf(ctx.cfg, child);
      const cond = condNode ? flowText(condNode) : "?";
      push({ kind: "branch", label: `if (${cond})`, condition: cond });
      extractSteps(ctx, child, steps);
      continue;
    }
    if (ctx.cfg.returnTypes.includes(t)) {
      for (const callStep of embeddedCallSteps(ctx, child)) push(callStep);
      push({ kind: "return", label: `return ${flowText(child)}` });
      continue;
    }
    if (ctx.cfg.throwTypes.includes(t)) {
      for (const callStep of embeddedCallSteps(ctx, child)) push(callStep);
      push({ kind: "throw", label: `throw ${flowText(child)}` });
      continue;
    }
    if (ctx.cfg.containerTypes.includes(t)) {
      extractSteps(ctx, child, steps);
      continue;
    }
    for (const callStep of embeddedCallSteps(ctx, child)) push(callStep);
  }
}

function enclosingClassName(cfg: LanguageConfig, node: TsNode): string | null {
  let parent = node.parent;
  while (parent) {
    if (cfg.classes.includes(parent.type)) {
      const name = parent.childForFieldName("name");
      if (name) return name.text;
    }
    parent = parent.parent;
  }
  return null;
}

/** Function name across grammar conventions: a `name` field where it exists
 * (most languages), otherwise the `declarator` chain used by C/C++
 * (function_definition -> function_declarator -> declarator -> identifier). */
function functionNameOf(cfg: LanguageConfig, node: TsNode): string | null {
  const named = node.childForFieldName("name");
  if (named) return named.text;
  const declarator = node.childForFieldName("declarator");
  if (declarator) {
    const inner = declarator.childForFieldName("declarator") ?? declarator;
    return inner.text;
  }
  return null;
}

/** Extract the full StructuralAnalysis payload (pre-schema) for one language. */
export async function extractWithTreeSitter(
  cfg: LanguageConfig,
  code: string
): Promise<{
  language: TreeSitterLanguageId;
  entryPoints: string[];
  entities: CodeEntity[];
  branches: Branch[];
  ioOperations: IoOperation[];
  statementCount: number;
  hasAsync: boolean;
  flows: EntityFlow[];
}> {
  const parser = await getParser(cfg);
  const tree = parser.parse(code);
  const root = tree?.rootNode;
  if (!root) throw new Error(`failed to parse ${cfg.id} source`);

  const entities: CodeEntity[] = [];
  const branches: Branch[] = [];
  const ioOperations: IoOperation[] = [];
  const entryPoints = new Set<string>();
  const flows: EntityFlow[] = [];

  const ctx: ExtractContext = { cfg, code, functionNames: new Set() };

  // Pass 1: entities (functions/methods + classes) and global branch counts.
  const functionBodies: Array<{ name: string; node: TsNode }> = [];
  walk(root, (n) => {
    if (cfg.branchTypes.includes(n.type)) {
      branches.push({ kind: branchKindFor(n.type) });
      return;
    }
    if (cfg.tryTypes.includes(n.type)) {
      branches.push({ kind: "try" });
      return;
    }
    if (cfg.loopTypes.includes(n.type)) {
      branches.push({ kind: "loop" });
      return;
    }
    if (cfg.classes.includes(n.type)) {
      const name = n.childForFieldName("name");
      if (name) entities.push({ name: name.text, kind: "class" });
      return;
    }
    if (!cfg.functionDefs.includes(n.type)) return;
    const fnName = functionNameOf(cfg, n);
    if (!fnName) return;
    const cls = enclosingClassName(cfg, n);
    const qualified = cls ? `${cls}.${fnName}` : fnName;
    entities.push(
      cls
        ? { name: qualified, kind: "function", parent: cls }
        : { name: qualified, kind: "function" }
    );
    // Top-level functions are callable units; class entries are chosen after
    // flows exist (roots of the intra-class call graph), see below.
    if (!cls) entryPoints.add(qualified);
    const body = n.childForFieldName("body");
    if (body) functionBodies.push({ name: qualified, node: body });
  });

  // Global IO classification over every call site.
  walk(root, (n) => {
    if (!cfg.callTypes.includes(n.type)) return;
    const full = calleeOf(n);
    const io = full ? matchIoRule(ctx, full) : null;
    if (io) ioOperations.push({ kind: io, callee: full });
  });

  for (const e of entities) {
    if (e.kind === "function") {
      ctx.functionNames.add(lastSegment(e.name));
    }
  }

  // Pass 2: ordered per-function control-flow outlines.
  for (const fn of functionBodies) {
    const steps: FlowStep[] = [];
    extractSteps(ctx, fn.node, steps);
    if (steps.length > 0) flows.push({ entity: fn.name, steps });
  }

  // Class entry points: the public API surface is the set of methods no
  // sibling method calls (roots of the intra-class call graph). Call steps
  // store bare names (stepForCall), so compare on the last segment. The
  // constructor only becomes an entry when nothing else qualifies.
  const methodEntities = entities.filter(
    (e): e is CodeEntity & { parent: string } => e.kind === "function" && !!e.parent
  );
  const methodEntityNames = new Set(methodEntities.map((m) => m.name));
  const calledBySibling = new Set<string>();
  for (const flow of flows) {
    if (!methodEntityNames.has(flow.entity)) continue;
    for (const step of flow.steps) {
      if (
        step.kind === "call" &&
        step.callee &&
        methodEntities.some((m) => lastSegment(m.name) === step.callee)
      ) {
        calledBySibling.add(step.callee);
      }
    }
  }
  const publicMethods = methodEntities.filter((m) => !m.name.endsWith(".constructor"));
  let classEntries = publicMethods.filter((m) => !calledBySibling.has(lastSegment(m.name)));
  if (classEntries.length === 0 && publicMethods.length > 0) classEntries = publicMethods;
  if (classEntries.length === 0 && methodEntities.length > 0) classEntries = [...methodEntities];
  for (const entry of classEntries) entryPoints.add(entry.name);
  // Methods-less class declarations still need a usable anchor.
  if (entryPoints.size === 0 && entities.some((e) => e.kind === "class")) {
    entryPoints.add("(module)");
  }

  // Top-level script code (common in Python/Ruby/PHP) becomes its own flow so
  // module-level branches and calls are never lost.
  const topLevelOther = namedChildren(root).some(
    (c) => !cfg.functionDefs.includes(c.type) && !cfg.classes.includes(c.type)
  );
  if (topLevelOther) {
    const moduleSteps: FlowStep[] = [];
    extractSteps(ctx, root, moduleSteps);
    if (moduleSteps.length > 0) flows.push({ entity: "(module)", steps: moduleSteps });
  }

  // Entry-point fallback: top-level statements outside definitions.
  if (entryPoints.size === 0 && topLevelOther) entryPoints.add("(module)");

  const hasAsync = cfg.asyncPattern ? cfg.asyncPattern.test(code) : false;

  return {
    language: cfg.id,
    entryPoints: [...entryPoints],
    entities,
    branches,
    ioOperations,
    statementCount: root.namedChildCount,
    hasAsync,
    flows,
  };
}


