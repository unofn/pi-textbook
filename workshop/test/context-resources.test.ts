import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildContext,
  compact,
  groupInteractions,
} from "../src/context.js";
import {
  activateSkill,
  createExtensionHost,
  discoverResources,
  formatResourceContext,
  RESOURCE_SECTION,
  loadExtension,
  loadResources,
  resolveSkillResource,
} from "../src/resources.js";
import type { SessionEntry } from "../src/session.js";
import {
  objectSchema,
  stringValue,
  ToolRegistry,
} from "../src/tool.js";
import {
  assistantMessage,
  text,
  userMessage,
  type AgentMessage,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

function messageEntry(
  id: string,
  parentId: string | null,
  message: AgentMessage,
): SessionEntry {
  return {
    id,
    parentId,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    type: "message",
    message,
  };
}

function result(
  id: string,
  name = "read",
  value = "ok",
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [text(value)],
    isError: false,
    timestamp: 1,
  };
}

function call(
  id: string,
  name = "read",
  argumentsValue: unknown = { path: "a.ts" },
): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: argumentsValue,
  };
}

test("buildContext 报告分项预算，并只在完整 interaction 边界裁剪", () => {
  const activePath: SessionEntry[] = [
    messageEntry("s0", null, {
      role: "system",
      content: "system",
      timestamp: 0,
    }),
    messageEntry("u1", "s0", userMessage("old")),
    messageEntry(
      "a1",
      "u1",
      assistantMessage([text("old answer")]),
    ),
    messageEntry("u2", "a1", userMessage("current")),
    messageEntry(
      "a2",
      "u2",
      assistantMessage([call("c1"), call("c2")], "toolUse"),
    ),
    // 完成顺序与 call 声明顺序不同，仍靠 id 配对。
    messageEntry("r2", "a2", result("c2")),
    messageEntry("r1", "r2", result("c1")),
    messageEntry(
      "a3",
      "r1",
      assistantMessage([text("done")]),
    ),
  ];
  const before = structuredClone(activePath);
  const projection = buildContext(activePath, {
    tokenBudget: 6,
    estimateTokens: () => 1,
    estimateTextTokens: () => 1,
  });

  assert.deepEqual(activePath, before);
  assert.deepEqual(projection.sourceEntryIds, [
    "s0",
    "u2",
    "a2",
    "r2",
    "r1",
    "a3",
  ]);
  assert.deepEqual(projection.messages[0], {
    role: "system",
    content: "system",
    timestamp: 0,
  });
  assert.equal(projection.firstKeptEntryId, "u2");
  assert.equal(projection.safeCutEntryId, "u2");
  assert.equal(projection.selection.reason, "budget_tail");
  assert.deepEqual(projection.usage, {
    system: 1,
    messages: 5,
    total: 6,
    budget: 6,
    overflow: false,
    reservedOutput: 0,
    safetyMargin: 0,
    tokensBefore: 8,
  });
  assert.deepEqual(projection.context.messages, projection.messages);
  assert.deepEqual(projection.omittedEntryIds, ["u1", "a1"]);

  const groups = groupInteractions(
    activePath.filter(
      (
        entry,
      ): entry is Extract<SessionEntry, { type: "message" }> =>
        entry.type === "message",
    ),
  );
  assert.deepEqual(
    groups.map((group) => group.sourceEntryIds),
    [
      ["u1", "a1"],
      ["u2", "a2", "r2", "r1", "a3"],
    ],
  );
  assert.deepEqual(groups[1].toolCallIds, ["c1", "c2"]);
});

test("单个 interaction 自身超限时显式报告，不从 toolResult 中间切", () => {
  const activePath: SessionEntry[] = [
    messageEntry("u1", null, userMessage("current")),
    messageEntry(
      "a1",
      "u1",
      assistantMessage([call("c1")], "toolUse"),
    ),
    messageEntry("r1", "a1", result("c1")),
  ];
  const projection = buildContext(activePath, {
    tokenBudget: 1,
    estimateTokens: () => 1,
    estimateTextTokens: () => 0,
  });
  assert.equal(projection.selection.reason, "single_group_overflow");
  assert.equal(projection.usage.overflow, true);
  assert.deepEqual(projection.sourceEntryIds, ["u1", "a1", "r1"]);
  assert.equal(projection.messages[0].role, "user");
});

test("compact 只追加结构化摘要，记录 safe cut、first kept 与 tokens before", () => {
  const entries: SessionEntry[] = [
    messageEntry("e1", null, userMessage("old goal")),
    messageEntry(
      "e2",
      "e1",
      assistantMessage([text("old answer")]),
    ),
    messageEntry("e6", "e2", userMessage("current goal")),
    messageEntry(
      "e7",
      "e6",
      assistantMessage([call("c1")], "toolUse"),
    ),
    messageEntry("e8", "e7", result("c1")),
  ];
  const before = structuredClone(entries);
  const after = compact(entries, {
    id: "cmp-1",
    parentId: "e8",
    timestamp: "2026-01-01T00:00:00.000Z",
    firstKeptEntryId: "e6",
    summary: {
      goal: "修复解析器",
      constraints: ["不改公开消息协议"],
      completed: ["复现失败 fixture"],
      decisions: ["保留 tagged union"],
      changedFiles: ["src/parser.ts"],
      unresolved: ["检查空输入"],
      next: ["运行边界测试"],
    },
    tokensBefore: 1_700,
  });

  assert.deepEqual(entries, before);
  assert.equal(after.length, entries.length + 1);
  const appended = after.at(-1);
  assert.equal(appended?.type, "compaction");
  if (appended?.type !== "compaction") {
    assert.fail("expected compaction entry");
  }
  assert.deepEqual(appended.compactedEntryIds, ["e1", "e2"]);
  assert.equal(
    (appended as typeof appended & { firstKeptEntryId: string })
      .firstKeptEntryId,
    "e6",
  );
  assert.equal(
    (appended as typeof appended & { tokensBefore: number })
      .tokensBefore,
    1_700,
  );

  const projection = buildContext(after, {
    tokenBudget: 100,
    estimateTokens: () => 1,
    estimateTextTokens: () => 0,
  });
  assert.deepEqual(projection.sourceEntryIds, [
    "cmp-1",
    "e6",
    "e7",
    "e8",
  ]);
  assert.equal(projection.tokensBefore, 1_700);
  assert.equal(projection.firstKeptEntryId, "e6");
  const summary = projection.messages[0];
  if (summary.role === "system") {
    assert.fail("no system message was recorded");
  }
  const summaryBlock = summary.content[0];
  if (summaryBlock.type !== "text") {
    assert.fail("summary projection must begin with text");
  }
  assert.match(
    summaryBlock.text,
    /Earlier session summary/,
  );
  assert.deepEqual(projection.omittedEntryIds, ["e1", "e2"]);

  assert.throws(
    () =>
      compact(entries, {
        id: "bad-cut",
        parentId: "e8",
        timestamp: 1,
        firstKeptEntryId: "e8",
        summary: {
          goal: "x",
          decisions: [],
          files: [],
          nextSteps: [],
          invariants: [],
        },
        tokensBefore: 1,
      }),
    /unsafe_compaction_boundary/,
  );
  assert.deepEqual(entries, before);
});

async function writeSkill(
  root: string,
  directory: string,
  options: {
    name: string;
    description?: string;
    body: string;
  },
): Promise<string> {
  const skillRoot = path.join(root, "skills", directory);
  await mkdir(skillRoot, { recursive: true });
  const description = options.description
    ? `description: ${options.description}\n`
    : "";
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    `---\nname: ${options.name}\n${description}---\n${options.body}`,
    "utf8",
  );
  return skillRoot;
}

test("resource discovery 确定冲突，skill 正文只在激活后读取", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-resource-contract-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const rootA = path.join(temp, "a");
  const rootB = path.join(temp, "b");
  await mkdir(path.join(rootA, "templates"), { recursive: true });
  await mkdir(path.join(rootB, "templates"), { recursive: true });
  await writeFile(
    path.join(rootA, "templates", "review.md"),
    "---\nname: review-prompt\ndescription: prompt\n---\nReview {{target}}.",
  );
  const skillRootA = await writeSkill(rootA, "review", {
    name: "review",
    description: "inspect a change",
    body: "Read the diff first.",
  });
  await writeSkill(rootB, "review-copy", {
    name: "review",
    description: "second candidate",
    body: "This candidate must lose.",
  });
  await mkdir(path.join(skillRootA, "references"), {
    recursive: true,
  });
  await writeFile(
    path.join(skillRootA, "references", "checklist.md"),
    "tests\nsecurity\n",
  );

  const catalog = await discoverResources([
    { path: rootA, scope: "project" },
    { path: rootB, scope: "user" },
  ]);
  assert.equal(catalog.templates[0].content, "Review {{target}}.");
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0].scope, "project");
  assert.equal(catalog.skills[0].body, undefined);
  assert.equal(catalog.skills[0].content, undefined);
  const conflict = catalog.diagnostics.find(
    (item) => item.code === "resource_conflict",
  );
  assert.ok(conflict);
  assert.equal(conflict.sources?.length, 2);

  const activated = await activateSkill(catalog, "review", {
    resources: ["references/checklist.md"],
  });
  assert.equal(activated.body, "Read the diff first.");
  assert.equal(activated.resources.length, 2);
  assert.match(activated.resources[1].content, /security/);
  // 激活结果是新值，目录自身仍保持 metadata-only。
  assert.equal(catalog.skills[0].body, undefined);

  const eager = await loadResources(rootA);
  assert.equal(eager.skills[0].content, "Read the diff first.");
});

test("skill resource 使用 canonical root，拒绝 ..、绝对路径和 symlink 逃逸", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-skill-root-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "catalog");
  const skillRoot = await writeSkill(root, "review", {
    name: "review",
    description: "inspect",
    body: "Read references/checklist.md",
  });
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "secret");
  await mkdir(path.join(skillRoot, "references"), {
    recursive: true,
  });
  await writeFile(
    path.join(skillRoot, "references", "checklist.md"),
    "safe",
  );
  await symlink(
    outside,
    path.join(skillRoot, "references", "outside-link.md"),
  );

  assert.match(
    await readResolved(skillRoot, "references/checklist.md"),
    /checklist\.md$/,
  );
  await assert.rejects(
    resolveSkillResource(skillRoot, "../../outside.txt"),
    /skill_resource_outside_root/,
  );
  await assert.rejects(
    resolveSkillResource(skillRoot, outside),
    /skill_resource_outside_root/,
  );
  await assert.rejects(
    resolveSkillResource(
      skillRoot,
      "references/outside-link.md",
    ),
    /skill_resource_outside_root/,
  );

  const catalog = await discoverResources(root);
  const activation = await activateSkill(catalog, "review", {
    resources: [
      "references/checklist.md",
      "../../outside.txt",
      outside,
      "references/outside-link.md",
    ],
  });
  assert.equal(
    activation.resources.some(
      (item) => item.request === "references/checklist.md",
    ),
    true,
  );
  assert.equal(
    activation.diagnostics.filter(
      (item) => item.code === "skill_resource_read_failed",
    ).length,
    3,
  );
});

async function readResolved(
  root: string,
  request: string,
): Promise<string> {
  return resolveSkillResource(root, request);
}

test("extension trust gate 在 import 前生效，before hook 的 deny 真正包住 executor", async () => {
  let imported = 0;
  const registry = new ToolRegistry();
  let executed = 0;
  registry.register({
    name: "write",
    description: "write a value",
    schema: objectSchema({ path: stringValue }),
    async execute() {
      executed += 1;
      return { content: [text("written")] };
    },
  });
  const host = createExtensionHost(registry);

  const skipped = await loadExtension(
    { id: "untrusted", path: "/tmp/untrusted.ts" },
    {
      isTrusted: () => false,
      async importModule() {
        imported += 1;
        return { default() {} };
      },
      host,
    },
  );
  assert.equal(skipped.status, "skipped_untrusted");
  assert.equal(imported, 0);

  let laterPolicyCalls = 0;
  const loaded = await loadExtension(
    { id: "secret-policy", path: "/tmp/trusted.ts" },
    {
      isTrusted: () => true,
      async importModule() {
        imported += 1;
        return {
          default(context) {
            context.on("beforeToolCall", (toolCall) => {
              if (
                toolCall.name === "write" &&
                String(
                  (toolCall.arguments as { path?: string }).path,
                ).includes(".env")
              ) {
                return {
                  decision: "deny",
                  reason: "secret path",
                };
              }
              return { decision: "allow" };
            });
          },
        };
      },
      host,
    },
  );
  assert.equal(loaded.status, "active");
  assert.equal(imported, 1);

  host.contextFor("later-policy").on("beforeToolCall", () => {
    laterPolicyCalls += 1;
    return { decision: "allow" };
  });
  host.contextFor("observer").on("afterToolResult", () => {
    throw new Error("observer failed");
  });

  const denied = await host.executeToolCall(
    call("call-denied", "write", { path: ".env" }),
  );
  assert.equal(denied.toolCallId, "call-denied");
  assert.equal(denied.toolName, "write");
  assert.equal(denied.isError, true);
  assert.equal(
    (denied.details as { denied?: boolean }).denied,
    true,
  );
  assert.equal(
    (denied.details as { extensionId?: string }).extensionId,
    "secret-policy",
  );
  assert.equal(executed, 0);
  assert.equal(laterPolicyCalls, 0);

  const allowed = await host.executeToolCall(
    call("call-allowed", "write", { path: "src/a.ts" }),
  );
  assert.equal(allowed.isError, false);
  assert.equal(executed, 1);
  assert.equal(laterPolicyCalls, 1);
  const afterDiagnostics = await host.runAfterToolResult(allowed);
  assert.deepEqual(afterDiagnostics, [
    {
      extensionId: "observer",
      hook: "afterToolResult",
      message: "observer failed",
    },
  ]);
  // 观察 hook 失败不能把已经发生的成功结果改成 error。
  assert.equal(allowed.isError, false);
});

test("before hook 抛错按 deny 处理，并返回同 call id 的结构化 toolResult", async () => {
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({
    name: "bash",
    description: "run",
    schema: objectSchema({ command: stringValue }),
    async execute() {
      executed = true;
      return { content: [text("ran")] };
    },
  });
  const host = createExtensionHost(registry);
  host.contextFor("broken-policy").on("beforeTool", () => {
    throw new Error("policy unavailable");
  });

  const denied = await host.executeToolCall(
    call("bash-1", "bash", { command: "pwd" }),
  );
  assert.equal(executed, false);
  assert.equal(denied.toolCallId, "bash-1");
  assert.equal(denied.isError, true);
  assert.match(
    (denied.details as { reason: string }).reason,
    /hook_error:policy unavailable/,
  );
});

test("资源文本是 RESOURCE_SECTION 段落，不与基础 prompt 拼接", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-resource-section-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeSkill(temp, "review", {
    name: "review",
    description: "inspect a change",
    body: "Read the diff first.",
  });
  await writeSkill(temp, "idle", {
    name: "idle",
    description: "never activated",
    body: "Inactive body must stay out.",
  });
  const catalog = await discoverResources(temp);
  const review = await activateSkill(catalog, "review");

  assert.equal(RESOURCE_SECTION, "pi-resources");
  const value = formatResourceContext(catalog, [review]);
  assert.match(value, /## Available resources/);
  assert.match(value, /- skill idle: never activated/);
  assert.match(value, /## Activated skill: review/);
  assert.match(value, /Read the diff first\./);
  assert.equal(value.includes("Inactive body must stay out."), false);
  assert.equal(
    formatResourceContext(
      {
        resources: [],
        templates: [],
        skills: [],
        diagnostics: [],
        diagnosticMessages: [],
      },
      [],
    ),
    "",
  );
});
