import assert from "node:assert/strict";
import test from "node:test";
import { declareToolChanges, runAgentLoop } from "../src/agent-loop.js";
import { ScriptedModel } from "../src/scripted-model.js";
import { recoverJsonl } from "../src/session.js";
import {
  executeToolCall,
  objectSchema,
  stringValue,
  ToolRegistry,
  type Tool,
  type ToolExposure,
} from "../src/tool.js";
import {
  createToolSearchTool,
  rankTools,
  tokenize,
  TOOL_SEARCH_TOOL_NAME,
  toolSearchDocument,
} from "../src/tool-search.js";
import {
  assistantMessage,
  currentTools,
  text,
  toolStateChanges,
  userMessage,
  type AgentMessage,
  type SystemMessage,
  type ToolCall,
  type ToolDefinition,
} from "../src/types.js";

function call(id: string, name: string, args: unknown): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function tool(
  name: string,
  exposure?: ToolExposure,
  description = `${name} tool`,
): Tool<{ value: string }> {
  return {
    name,
    description,
    schema: objectSchema({ value: stringValue }),
    ...(exposure ? { exposure } : {}),
    async execute({ value }) {
      return { content: [text(`${name}:${value}`)] };
    },
  };
}

function definition(name: string, description = name): ToolDefinition {
  return { name, description, parameters: { type: "object" } };
}

function system(
  fields: Pick<SystemMessage, "toolsAdded" | "toolsRemoved">,
): SystemMessage {
  return { role: "system", content: "", ...fields, timestamp: 0 };
}

function names(tools: readonly { name: string }[]): string[] {
  return tools.map((entry) => entry.name);
}

test("注册表从 exposure 推导声明集合与可调用集合，hidden 两者都不进", () => {
  const registry = new ToolRegistry([
    tool("read"),
    tool("search", "model-only"),
    tool("lint", "codemode"),
    tool("issues", "deferred"),
    tool("secret", "hidden"),
  ]);

  assert.deepEqual(names(registry.declared()), ["read", "search"]);
  assert.deepEqual(names(registry.callable()), ["read", "lint", "issues"]);
  assert.deepEqual(names(registry.definitions()), ["read", "search"]);
  assert.equal(registry.usesExposure(), true);
  assert.equal(registry.exposureOf("read"), "direct");
  assert.equal(registry.canCall("secret", "model"), false);
  assert.equal(registry.canCall("secret", "script"), false);
  assert.equal(registry.canCall("search", "script"), false);
  assert.equal(new ToolRegistry([tool("read")]).usesExposure(), false);
});

test("activate 只把 codemode / deferred 加入声明集合，忽略未知、hidden 与已激活，保持注册顺序", () => {
  const registry = new ToolRegistry([
    tool("issues", "deferred"),
    tool("read"),
    tool("lint", "codemode"),
    tool("secret", "hidden"),
  ]);

  assert.deepEqual(
    registry.activate(["lint", "missing", "secret", "read", "issues"]),
    ["lint", "issues"],
  );
  assert.deepEqual(registry.activate(["lint"]), []);
  assert.deepEqual(names(registry.declared()), ["issues", "read", "lint"]);
  assert.equal(registry.isActive("secret"), false);
});

test("executeToolCall 按作用域拒绝未声明或不可调用的工具，结果仍与 call 配对", async () => {
  const registry = new ToolRegistry([
    tool("read"),
    tool("search", "model-only"),
    tool("issues", "deferred"),
    tool("secret", "hidden"),
  ]);

  const deferredByModel = await executeToolCall(
    call("m1", "issues", { value: "x" }),
    registry,
  );
  assert.equal(deferredByModel.isError, true);
  assert.equal(deferredByModel.toolCallId, "m1");
  assert.match(deferredByModel.content[0]!.text, /未声明/);

  const deferredByScript = await executeToolCall(
    call("s1", "issues", { value: "x" }),
    registry,
    {},
    "script",
  );
  assert.equal(deferredByScript.isError, false);
  assert.equal(deferredByScript.content[0]!.text, "issues:x");

  for (const [name, scope] of [
    ["search", "script"],
    ["secret", "script"],
    ["secret", "model"],
  ] as const) {
    const result = await executeToolCall(
      call(`${scope}-${name}`, name, { value: "x" }),
      registry,
      {},
      scope,
    );
    assert.equal(result.isError, true, `${scope} ${name}`);
    assert.equal(result.toolCallId, `${scope}-${name}`);
  }
});

test("currentTools 按顺序重放 toolsAdded / toolsRemoved，先删后加，不与 transcript 共享引用", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "base", timestamp: 0 },
    system({ toolsAdded: [definition("a"), definition("b")] }),
    userMessage("hi"),
    system({ toolsRemoved: [{ name: "a" }] }),
    system({
      toolsRemoved: [{ name: "b" }],
      toolsAdded: [definition("b", "new b"), definition("c")],
    }),
  ];

  const tools = currentTools(messages);
  assert.deepEqual(tools, [definition("b", "new b"), definition("c")]);
  tools[0]!.parameters.mutated = true;
  const added = (messages[4] as SystemMessage).toolsAdded!;
  assert.equal(added[0]!.parameters.mutated, undefined);
  assert.deepEqual(currentTools([userMessage("no system")]), []);
});

test("toolStateChanges 把定义变化表示为先删后加，无差异时两边都为空", () => {
  const before = [definition("a"), definition("b"), definition("c")];
  const after = [definition("a"), definition("b", "changed"), definition("d")];

  assert.deepEqual(toolStateChanges(before, after), {
    toolsAdded: [definition("b", "changed"), definition("d")],
    toolsRemoved: [{ name: "b" }, { name: "c" }],
  });
  assert.deepEqual(toolStateChanges(before, before), {
    toolsAdded: [],
    toolsRemoved: [],
  });
});

test("严格 parser 接受非空 toolsAdded / toolsRemoved，拒绝空列表、未知字段与非 object parameters", () => {
  const line = (message: SystemMessage) =>
    JSON.stringify({
      id: "s",
      parentId: null,
      timestamp: 0,
      type: "message",
      message,
    });
  const valid = system({
    toolsAdded: [definition("a")],
    toolsRemoved: [{ name: "b" }],
  });
  assert.deepEqual(recoverJsonl(`${line(valid)}\n`).entries[0], {
    id: "s",
    parentId: null,
    timestamp: 0,
    type: "message",
    message: valid,
  });

  const invalid = [
    system({ toolsAdded: [] }),
    system({ toolsRemoved: [] }),
    system({
      toolsAdded: [{ ...definition("a"), extra: true } as ToolDefinition],
    }),
    system({
      toolsAdded: [
        { ...definition("a"), parameters: [] as unknown as Record<string, unknown> },
      ],
    }),
    system({ toolsRemoved: [{ name: "" }] }),
  ];
  for (const message of invalid) {
    // 中段损坏必须报错：后面再跟一条合法行，避免被当作截断的最后一行忽略。
    assert.throws(
      () => recoverJsonl(`${line(message)}\n${line(valid)}\n`),
      /JSONL 中段/,
    );
  }
});

const echo: Tool<{ value: string }> = tool("echo");

test("全 direct 的注册表不写声明补丁：工具往返的 transcript 与之前完全一致", async () => {
  const model = new ScriptedModel([
    assistantMessage([call("c1", "echo", { value: "x" })], "toolUse"),
    assistantMessage([text("done")]),
  ]);
  const result = await runAgentLoop({
    model,
    tools: new ToolRegistry([echo]),
    context: { messages: [userMessage("go")] },
  });

  assert.equal(result.reason, "stop");
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.deepEqual(names(model.requests[0]!.tools ?? []), ["echo"]);
});

test("用上 exposure 后，第一次请求前在用户消息之后追加声明补丁，无变化时不再追加；provider 仍从 context.tools 读工具", async () => {
  const registry = new ToolRegistry([echo, tool("issues", "deferred")]);
  const model = new ScriptedModel([
    assistantMessage([call("c1", "echo", { value: "x" })], "toolUse"),
    assistantMessage([text("done")]),
  ]);
  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("go")] },
  });

  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "system", "assistant", "toolResult", "assistant"],
  );
  const patch = result.messages[1] as SystemMessage;
  assert.equal(patch.content, "");
  assert.deepEqual(names(patch.toolsAdded ?? []), ["echo"]);
  assert.equal(patch.toolsRemoved, undefined);
  assert.equal(model.requests.length, 2);
  for (const request of model.requests) {
    assert.deepEqual(names(request.tools ?? []), ["echo"]);
  }
});

test("恢复的 transcript 声明了注册表里没有的工具时，补丁只写 toolsRemoved；已有前缀不改写", async () => {
  const prefix: AgentMessage[] = [
    userMessage("first"),
    system({ toolsAdded: [definition("old")] }),
    assistantMessage([text("ok")]),
    userMessage("second"),
  ];
  const snapshot = structuredClone(prefix);
  const registry = new ToolRegistry([]);
  const patch = declareToolChanges(prefix, registry);
  assert.deepEqual(patch?.toolsRemoved, [{ name: "old" }]);
  assert.equal(patch?.toolsAdded, undefined);

  const result = await runAgentLoop({
    model: new ScriptedModel([assistantMessage([text("done")])]),
    tools: registry,
    context: { messages: prefix },
  });
  assert.deepEqual(result.messages.slice(0, prefix.length), snapshot);
  assert.deepEqual(
    (result.messages[prefix.length] as SystemMessage).toolsRemoved,
    [{ name: "old" }],
  );
  assert.deepEqual(currentTools(result.messages), []);
});

test("排序只用词项重叠：忽略停用词与大小写，分数相同保持文档顺序，无重叠不入选", () => {
  assert.deepEqual(tokenize("Search the GitHubIssues for a bug"), [
    "search",
    "git",
    "hub",
    "issue",
    "bug",
  ]);
  const documents = [
    { name: "close_issue", text: "close issue github" },
    { name: "list_issues", text: "list issues github" },
    { name: "weather", text: "forecast" },
    { name: "issue_search", text: "search github issues" },
  ];
  assert.deepEqual(rankTools("Search github Issues", documents, 8), [
    { name: "issue_search", score: 3 },
    { name: "close_issue", score: 2 },
    { name: "list_issues", score: 2 },
  ]);
  assert.deepEqual(rankTools("the of", documents, 8), []);
  assert.deepEqual(rankTools("issues", documents, 1), [
    { name: "close_issue", score: 1 },
  ]);
  assert.match(
    toolSearchDocument({
      name: "list_issues",
      description: "List issues",
      schema: {
        parse: (value) => value,
        jsonSchema: {
          type: "object",
          properties: { repo: { description: "owner/name" } },
        },
      },
    }).text,
    /list issues List issues repo owner\/name/,
  );
});

test("tool_search 是 model-only 工具：激活命中的 codemode / deferred 工具，忽略已声明与 hidden，返回 loaded 明细", async () => {
  const registry = new ToolRegistry([
    tool("read", undefined, "read issues from disk"),
    tool("list_issues", "deferred", "List GitHub issues"),
    tool("lint_issues", "codemode", "Lint issues"),
    tool("secret_issues", "hidden", "Hidden issues"),
  ]);
  const search = createToolSearchTool(registry);
  registry.register(search);
  assert.equal(search.exposure, "model-only");
  assert.equal(registry.isActive(TOOL_SEARCH_TOOL_NAME), true);

  const result = await executeToolCall(
    call("t1", TOOL_SEARCH_TOOL_NAME, { query: "issues" }),
    registry,
  );
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, {
    loaded: ["list_issues", "lint_issues"],
  });
  assert.match(result.content[0]!.text, /Loaded 2 tools/);
  assert.deepEqual(names(registry.declared()), [
    "read",
    "list_issues",
    "lint_issues",
    TOOL_SEARCH_TOOL_NAME,
  ]);

  const again = await executeToolCall(
    call("t2", TOOL_SEARCH_TOOL_NAME, { query: "issues" }),
    registry,
  );
  assert.deepEqual(again.details, { loaded: [] });
  assert.equal(again.content[0]!.text, "No matching tools found.");

  const empty = await executeToolCall(
    call("t3", TOOL_SEARCH_TOOL_NAME, { query: "  " }),
    registry,
  );
  assert.equal(empty.isError, true);
});

test("经 loop：搜索前调用 deferred 工具被拒绝，搜索后的下一次请求声明它，模型随后才能调用", async () => {
  const registry = new ToolRegistry([
    tool("list_issues", "deferred", "List GitHub issues"),
  ]);
  registry.register(createToolSearchTool(registry));
  const model = new ScriptedModel([
    assistantMessage(
      [call("c1", "list_issues", { value: "early" })],
      "toolUse",
    ),
    assistantMessage(
      [call("c2", TOOL_SEARCH_TOOL_NAME, { query: "github issues" })],
      "toolUse",
    ),
    assistantMessage(
      [call("c3", "list_issues", { value: "later" })],
      "toolUse",
    ),
    assistantMessage([text("done")]),
  ]);

  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("find issues")] },
  });

  assert.equal(result.reason, "stop");
  const results = result.messages.filter(
    (message) => message.role === "toolResult",
  );
  assert.deepEqual(
    results.map((message) => [message.toolCallId, message.isError]),
    [
      ["c1", true],
      ["c2", false],
      ["c3", false],
    ],
  );
  assert.deepEqual(
    model.requests.map((request) => names(request.tools ?? [])),
    [
      [TOOL_SEARCH_TOOL_NAME],
      [TOOL_SEARCH_TOOL_NAME],
      ["list_issues", TOOL_SEARCH_TOOL_NAME],
      ["list_issues", TOOL_SEARCH_TOOL_NAME],
    ],
  );
  const patches = result.messages.filter(
    (message): message is SystemMessage => message.role === "system",
  );
  assert.deepEqual(
    patches.map((patch) => names(patch.toolsAdded ?? [])),
    [[TOOL_SEARCH_TOOL_NAME], ["list_issues"]],
  );
  assert.deepEqual(names(currentTools(result.messages)), [
    TOOL_SEARCH_TOOL_NAME,
    "list_issues",
  ]);
});
