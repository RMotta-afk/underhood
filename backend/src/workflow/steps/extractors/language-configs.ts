import type { IoOperation } from "../analyze-code";

// Per-language adapter table for the generic tree-sitter extractor. Node type
// names follow each grammar's node-types.json; the extractor itself is
// language-agnostic and reads only this config.

export type TreeSitterLanguageId =
  | "python"
  | "java"
  | "c"
  | "cpp"
  | "go"
  | "rust"
  | "csharp"
  | "ruby"
  | "php";

export interface IoRule {
  pattern: RegExp;
  kind: IoOperation["kind"];
}

export interface LanguageConfig {
  id: TreeSitterLanguageId;
  /** npm package shipping the prebuilt grammar wasm. */
  wasmPackage: string;
  wasmFile: string;
  /** Node types that define functions/methods (each becomes a flow entity). */
  functionDefs: string[];
  /** Class-like node types (become `class` entities and qualify method names). */
  classes: string[];
  /** Decision node types (if/switch/match/ternary). */
  branchTypes: string[];
  /** try/catch/raise-style fallback nodes, rendered as a branch. */
  tryTypes: string[];
  loopTypes: string[];
  returnTypes: string[];
  throwTypes: string[];
  /** Call-expression node types used for call/io steps. */
  callTypes: string[];
  /** Field-name candidates holding the governing condition of a branch/loop. */
  conditionFields: string[];
  /** Node types that are plain statement containers to recurse into. */
  containerTypes: string[];
  asyncPattern?: RegExp;
  ioRules: IoRule[];
}

const commonContainers = [
  "block",
  "statement_block",
  "compound_statement",
  "colon_block",
  "block_sequence",
  "statement_list",
  "expression_statement",
  "do",
  "then",
  "else",
  "else_clause",
  "elif_clause",
  "case_clause",
  "case_statement",
  "switch_block",
  "switch_body",
  "switch_statement_body",
  "switch_block_statement_group",
  "switch_entry",
  "switch_rule",
  "match_block",
  "match_arm",
  "except_clause",
  "finally_clause",
  "rescue",
  "ensure",
  "do_group",
];

export const LANGUAGE_CONFIGS: Record<TreeSitterLanguageId, LanguageConfig> = {
  python: {
    id: "python",
    wasmPackage: "tree-sitter-python",
    wasmFile: "tree-sitter-python.wasm",
    functionDefs: ["function_definition"],
    classes: ["class_definition"],
    branchTypes: ["if_statement", "elif_clause", "conditional_expression", "match_statement"],
    tryTypes: ["try_statement"],
    loopTypes: ["for_statement", "while_statement"],
    returnTypes: ["return_statement"],
    throwTypes: ["raise_statement"],
    callTypes: ["call"],
    conditionFields: ["condition", "right"],
    containerTypes: commonContainers,
    asyncPattern: /\basync\s+def\b/,
    ioRules: [
      { pattern: /^(builtins\.)?print$/, kind: "console" },
      { pattern: /^(builtins\.)?input$/, kind: "console" },
      { pattern: /^(builtins\.)?open$/, kind: "fs" },
      { pattern: /^(pathlib\.Path|shutil|os\.fs|os\.remove|os\.rename)/, kind: "fs" },
      { pattern: /^(requests|urllib|httpx|aiohttp)\./, kind: "fetch" },
      { pattern: /^(sqlite3|psycopg2?|pymysql|sqlalchemy)\./, kind: "database" },
      { pattern: /^(os\.system|os\.popen|subprocess)\./, kind: "process" },
      { pattern: /^(time|asyncio)\.(sleep|wait_for)/, kind: "timer" },
    ],
  },
  java: {
    id: "java",
    wasmPackage: "tree-sitter-java",
    wasmFile: "tree-sitter-java.wasm",
    functionDefs: ["method_declaration", "constructor_declaration"],
    classes: ["class_declaration", "interface_declaration", "enum_declaration"],
    branchTypes: ["if_statement", "switch_statement", "switch_expression", "ternary_expression"],
    tryTypes: ["try_statement", "try_with_resources_statement"],
    loopTypes: ["for_statement", "enhanced_for_statement", "while_statement", "do_statement"],
    returnTypes: ["return_statement"],
    throwTypes: ["throw_statement"],
    callTypes: ["method_invocation"],
    conditionFields: ["condition"],
    containerTypes: commonContainers,
    ioRules: [
      { pattern: /^System\.(out|err)\./, kind: "console" },
      { pattern: /^(Files|FileReader|FileWriter|BufferedReader|BufferedWriter|RandomAccessFile)\./, kind: "fs" },
      { pattern: /^(HttpClient|HttpRequest|URLConnection|HttpURLConnection)\.?/, kind: "fetch" },
      { pattern: /^(DriverManager|PreparedStatement|Statement|ResultSet)\.?/, kind: "database" },
      { pattern: /^Runtime\.getRuntime|^System\.exit/, kind: "process" },
      { pattern: /^Thread\.sleep/, kind: "timer" },
    ],
  },
  c: {
    id: "c",
    wasmPackage: "tree-sitter-c",
    wasmFile: "tree-sitter-c.wasm",
    functionDefs: ["function_definition"],
    classes: [],
    branchTypes: ["if_statement", "switch_statement", "conditional_expression"],
    tryTypes: [],
    loopTypes: ["for_statement", "while_statement", "do_statement"],
    returnTypes: ["return_statement"],
    throwTypes: [],
    callTypes: ["call_expression"],
    conditionFields: ["condition"],
    containerTypes: commonContainers,
    ioRules: [
      { pattern: /^(printf|fprintf|sprintf|puts|putchar|fputs)$/, kind: "console" },
      { pattern: /^(scanf|fscanf|sscanf|gets|fgets|getchar)$/, kind: "console" },
      { pattern: /^(fopen|fclose|fread|fwrite|fseek|open|read|write)$/, kind: "fs" },
      { pattern: /^system$/, kind: "process" },
      { pattern: /^sleep$/, kind: "timer" },
    ],
  },
  cpp: {
    id: "cpp",
    wasmPackage: "tree-sitter-cpp",
    wasmFile: "tree-sitter-cpp.wasm",
    functionDefs: ["function_definition"],
    classes: ["class_specifier", "struct_specifier"],
    branchTypes: ["if_statement", "switch_statement", "conditional_expression"],
    tryTypes: ["try_statement"],
    loopTypes: ["for_statement", "for_range_loop", "while_statement", "do_statement"],
    returnTypes: ["return_statement"],
    throwTypes: ["throw_statement"],
    callTypes: ["call_expression"],
    conditionFields: ["condition"],
    containerTypes: commonContainers,
    ioRules: [
      { pattern: /^(std::)?(cout|cerr|clog)$/, kind: "console" },
      { pattern: /^(std::)?cin$/, kind: "console" },
      { pattern: /^(std::)?(ifstream|ofstream|fstream)$/, kind: "fs" },
      { pattern: /^(printf|puts|putchar)$/, kind: "console" },
      { pattern: /^(std::)?filesystem\./, kind: "fs" },
      { pattern: /^system$/, kind: "process" },
      { pattern: /^(std::this_thread::sleep_for|sleep)$/, kind: "timer" },
    ],
  },
  go: {
    id: "go",
    wasmPackage: "tree-sitter-go",
    wasmFile: "tree-sitter-go.wasm",
    functionDefs: ["function_declaration", "method_declaration"],
    classes: [],
    branchTypes: ["if_statement", "switch_statement", "type_switch_statement", "select_statement"],
    tryTypes: [],
    loopTypes: ["for_statement"],
    returnTypes: ["return_statement"],
    throwTypes: [],
    callTypes: ["call_expression"],
    conditionFields: ["condition", "right"],
    containerTypes: commonContainers,
    ioRules: [
      { pattern: /^fmt\.(Print|Sprint|Fprint)/, kind: "console" },
      { pattern: /^fmt\.(Scan|Sscan|Fscan)/, kind: "console" },
      { pattern: /^os\.(Stdout|Stderr|Open|Create|ReadFile|WriteFile)/, kind: "fs" },
      { pattern: /^(ioutil)\./, kind: "fs" },
      { pattern: /^http\.(Get|Post|Head|NewRequest)/, kind: "fetch" },
      { pattern: /^(db|sql)\.(Query|Exec|Prepare)|^sql\.Open/, kind: "database" },
      { pattern: /^os\.Exit|^exec\.Command/, kind: "process" },
      { pattern: /^time\.(Sleep|Tick|After)/, kind: "timer" },
    ],
  },
  rust: {
    id: "rust",
    wasmPackage: "tree-sitter-rust",
    wasmFile: "tree-sitter-rust.wasm",
    functionDefs: ["function_item"],
    classes: ["struct_item", "enum_item", "trait_item"],
    branchTypes: ["if_expression", "if_let_expression", "match_expression"],
    tryTypes: [],
    loopTypes: ["for_expression", "while_expression", "while_let_expression", "loop_expression"],
    returnTypes: ["return_expression"],
    throwTypes: [],
    callTypes: ["call_expression", "macro_invocation"],
    conditionFields: ["value", "condition", "right"],
    containerTypes: commonContainers,
    asyncPattern: /\basync\s+(fn|move)\b/,
    ioRules: [
      { pattern: /^(println|print|eprintln|eprint)$/, kind: "console" },
      { pattern: /^(std::)?fs::|^File::/, kind: "fs" },
      { pattern: /^(reqwest|ureq|hyper|attohttpc)::/, kind: "fetch" },
      { pattern: /^(std::)?process::exit|^Command::new/, kind: "process" },
      { pattern: /^(std::)?thread::sleep/, kind: "timer" },
    ],
  },
  csharp: {
    id: "csharp",
    wasmPackage: "tree-sitter-c-sharp",
    wasmFile: "tree-sitter-c_sharp.wasm",
    functionDefs: ["method_declaration", "constructor_declaration", "operator_declaration"],
    classes: ["class_declaration", "interface_declaration", "struct_declaration", "record_declaration"],
    branchTypes: ["if_statement", "switch_statement", "conditional_expression"],
    tryTypes: ["try_statement"],
    loopTypes: ["for_statement", "for_each_statement", "while_statement", "do_statement"],
    returnTypes: ["return_statement"],
    throwTypes: ["throw_statement"],
    callTypes: ["invocation_expression", "object_creation_expression"],
    conditionFields: ["condition"],
    containerTypes: commonContainers,
    asyncPattern: /\basync\s+\w/,
    ioRules: [
      { pattern: /^Console\.(Write|Read)/, kind: "console" },
      { pattern: /^(File|Directory|StreamReader|StreamWriter|FileStream)\.?/, kind: "fs" },
      { pattern: /^(HttpClient|WebRequest|HttpWebRequest)\.?/, kind: "fetch" },
      { pattern: /^(SqlCommand|SqlConnection|DbContext)\.?/, kind: "database" },
      { pattern: /^Environment\.Exit|^Process\.Start/, kind: "process" },
      { pattern: /^Thread\.Sleep|^Task\.Delay/, kind: "timer" },
    ],
  },
  ruby: {
    id: "ruby",
    wasmPackage: "tree-sitter-ruby",
    wasmFile: "tree-sitter-ruby.wasm",
    functionDefs: ["method", "singleton_method"],
    classes: ["class", "module"],
    branchTypes: ["if", "unless", "case", "elsif"],
    tryTypes: ["rescue"],
    loopTypes: ["while", "until", "for"],
    returnTypes: ["return"],
    throwTypes: ["raise"],
    callTypes: ["call"],
    conditionFields: ["condition", "value"],
    containerTypes: commonContainers,
    ioRules: [
      { pattern: /^(puts|print|p|pp|printf)$/, kind: "console" },
      { pattern: /^(gets|readline|readlines)$/, kind: "console" },
      { pattern: /^(File|IO|Dir|FileUtils)\.|^(open)$/, kind: "fs" },
      { pattern: /^Net::HTTP|^URI\.(parse|open)/, kind: "fetch" },
      { pattern: /^(DBI|Sequel|ActiveRecord)\./, kind: "database" },
      { pattern: /^(system|exec|backtick|Open3\.)`?/, kind: "process" },
      { pattern: /^sleep$/, kind: "timer" },
    ],
  },
  php: {
    id: "php",
    wasmPackage: "tree-sitter-php",
    wasmFile: "tree-sitter-php_only.wasm",
    functionDefs: ["function_definition", "method_declaration"],
    classes: ["class_declaration", "interface_declaration", "trait_declaration"],
    branchTypes: ["if_statement", "else_if_clause", "switch_statement", "conditional_expression"],
    tryTypes: ["try_statement"],
    loopTypes: ["for_statement", "foreach_statement", "while_statement", "do_statement"],
    returnTypes: ["return_statement"],
    throwTypes: ["throw_statement"],
    callTypes: ["call_expression", "function_call_expression", "member_call_expression", "scoped_call_expression"],
    conditionFields: ["condition"],
    containerTypes: commonContainers,
    ioRules: [
      { pattern: /^(echo|print|printf|var_dump|print_r|sprintf)$/, kind: "console" },
      { pattern: /^(fopen|fclose|file_get_contents|file_put_contents|fread|fwrite)$/, kind: "fs" },
      { pattern: /^curl_init|^curl_exec/, kind: "fetch" },
      { pattern: /^(PDO|mysqli)\.?/, kind: "database" },
      { pattern: /^(exec|shell_exec|system|passthru)$/, kind: "process" },
      { pattern: /^(sleep|usleep)$/, kind: "timer" },
    ],
  },
};
