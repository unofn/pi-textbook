import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aliases = {
  prologue: ["foundations-labs"],
  survival: ["foundations-labs"],
  "typescript-survival": ["foundations-labs"],
  types: ["foundations-labs", "model-stream"],
  "event-stream": ["model-stream"],
  "message-ir": ["foundations-labs", "model-stream"],
  "scripted-model": ["model-stream"],
  "provider-adapter": ["model-stream"],
  "tool-contract": ["agent-loop"],
  "agent-loop": ["agent-loop"],
  "coding-tools": ["coding-agent"],
  "stateful-agent": ["coding-agent"],
  "session-tree": ["session-context"],
  session: ["session-context"],
  "context-compaction": ["session-context", "context-resources"],
  context: ["session-context", "context-resources"],
  "resources-extensions": ["context-resources"],
  resources: ["context-resources"],
  "composition-root": ["composition-eval"],
  composition: ["composition-eval"],
  "eval-capstone": ["composition-eval", "product-eval"],
  eval: ["composition-eval", "product-eval"],
  "tool-exposure": ["tool-exposure"],
  exposure: ["tool-exposure"],
  "tool-search": ["tool-exposure"],
  codemode: ["codemode"],
  mcp: ["mcp"],
  "virtual-models": ["virtual-models"],
  virtual: ["virtual-models"],
  durable: ["durable"],
};

const compile = spawnSync(
  path.join(root, "node_modules", ".bin", "tsc"),
  ["-p", path.join(root, "workshop", "tsconfig.json")],
  { cwd: root, stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);

const requested = process.argv[2];
const normalized = requested?.replace(/^0*\d+-/, "");
const filters = normalized
  ? aliases[normalized] ?? [normalized]
  : undefined;
const testRoots = [
  path.join(root, "workshop", ".dist", "test"),
  path.join(root, "workshop", ".dist", "capstone"),
].filter((directory) => existsSync(directory));
const files = testRoots.flatMap((directory) =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".test.js"))
    .filter(
      (file) =>
        !filters || filters.some((filter) => file.includes(filter)),
    )
    .map((file) => path.join(directory, file)),
);

if (files.length === 0) {
  process.stderr.write(`没有匹配 workshop 测试：${requested}\n`);
  process.exit(1);
}

const run = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(run.status ?? 1);
