import type { AnalysisLanguage } from "../analyze-code";
import type { TreeSitterLanguageId } from "./language-configs";

// Content-based language detection. Heuristics are ordered by specificity:
// marker-based matches first (shebangs, imports, signature idioms), then the
// JS/TS transpile attempt as the fallback. An explicit language hint from the
// API always wins (handled by the caller).

export function detectLanguage(code: string): AnalysisLanguage | null {
  if (/<\?php|<\?=/.test(code)) return "php";
  if (/^\s*package\s+\w+/m.test(code)) return "go";
  if (/\bfn\s+\w+\s*\(/.test(code) && /(println!|print!|let\s+mut\b|::\w|\bmatch\s+.*\{)/.test(code)) {
    return "rust";
  }
  if (
    /\bpublic\s+(final\s+)?(class|interface|enum)\b/.test(code) ||
    /\bpublic\s+static\s+void\s+main\b/.test(code) ||
    /System\.(out|err)\.print/.test(code)
  ) {
    return "java";
  }
  if (
    /^\s*using\s+System(\.[\w.]+)?;/m.test(code) ||
    /\bConsole\.(Write|Read)/.test(code) ||
    /\bnamespace\s+[\w.]+\s*[;{]/.test(code)
  ) {
    return "csharp";
  }
  if (
    /#include\s*<(iostream|vector|string|map|memory|algorithm)>/.test(code) ||
    /\bstd::/.test(code) ||
    /\b(cout|cin|cerr)\b/.test(code) ||
    /\btemplate\s*</.test(code)
  ) {
    return "cpp";
  }
  if (/#include\s*<\w+\.h>|\bprintf\s*\(|\bmalloc\s*\(|\bstruct\s+\w+\s*\{/.test(code)) {
    return "c";
  }
  if (
    /^\s*(def\s+[\w?!=]+\s*(\(.*\))?\s*:\s*$|class\s+\w+\s*[:(]|from\s+[\w.]+\s+import\b|import\s+[\w.]+\s*$|if\s+.*:\s*$|elif\b|while\s+.*:\s*$|print\()/m.test(
      code
    )
  ) {
    return "python";
  }
  if (/^\s*def\s+[\w?!=]+\s*(\(|$)/m.test(code) && /\bend\b/m.test(code)) {
    return "ruby";
  }
  return null;
}

export function isTreeSitterLanguage(
  lang: AnalysisLanguage
): lang is AnalysisLanguage & TreeSitterLanguageId {
  return lang !== "javascript" && lang !== "typescript";
}
