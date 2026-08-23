import type { Branch, CodeEntity, IoOperation } from "./analyze-code";

// Shared, order-independent structural signature (SDD §6.2). Used by both the
// acorn (JS/TS) extractor and the tree-sitter (multi-language) extractor so
// dedup embeddings stay comparable within a language and meaningful across
// pipeline versions.

export function buildSkeleton(
  entities: CodeEntity[],
  branches: Branch[],
  io: IoOperation[],
  hasAsync: boolean
): string {
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
