// Zero-dependency secrets firewall enforcer (AGENT.md Secrets Firewall).
// Modes:
//   default  -> scan staged additions (pre-commit)
//   --all    -> scan every tracked file's content (CI)
import { $ } from "bun";

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Groq key", re: /\bgsk_[A-Za-z0-9]{20,}\b/ },
  {
    name: "DATABASE_URL with credentials",
    re: /postgres(?:ql)?:\/\/[^\s:@"]+:[^\s@"]+@/i,
  },
  { name: "Generic API key assignment", re: /\bAPI_KEY\s*=\s*['"][^'"\s]{16,}['"]/ },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const ALLOW_FILES: Array<string | RegExp> = [
  "env.example", // placeholder values only, by contract
  /scripts[/\\]check-secrets\.ts$/, // this scanner
  /\.test\.ts$/, // fixtures use synthetic credentials (validated as non-real)
  "docker-compose.yml", // postgres:postgres is a documented LOCAL-ONLY default; prod injects via env
  /docs[/\\]/, // architecture docs quote example connection strings
];

const isAllowed = (file: string) =>
  ALLOW_FILES.some((a) => (typeof a === "string" ? file === a : a.test(file)));

function scanContent(file: string, content: string): number {
  if (isAllowed(file.replace(/\\/g, "/"))) return 0;
  let found = 0;
  for (const line of content.split("\n")) {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        found++;
        console.error(`[check-secrets] ${name} detected in ${file}:\n  ${line.slice(0, 140)}`);
      }
    }
  }
  return found;
}

let findings = 0;
const scanAll = process.argv.includes("--all");

if (scanAll) {
  const files = await $`git ls-files`.quiet().text();
  for (const file of files.split("\n").filter(Boolean)) {
    const f = Bun.file(file);
    if (!(await f.exists())) continue;
    findings += scanContent(file, await f.text());
  }
} else {
  const diff = await $`git diff --staged --unified=0`.quiet().text();
  if (!diff.trim()) {
    console.log("[check-secrets] nothing staged - ok");
    process.exit(0);
  }
  let currentFile = "";
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      currentFile = header[1]!.replace(/\\/g, "/");
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (isAllowed(currentFile)) continue;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        findings++;
        console.error(
          `[check-secrets] ${name} detected in ${currentFile}:\n  ${line.slice(0, 140)}`
        );
      }
    }
  }
}

if (findings > 0) {
  console.error(`\n[check-secrets] BLOCKED: ${findings} secret-pattern finding(s).`);
  process.exit(1);
}
console.log("[check-secrets] no secret patterns - ok");
