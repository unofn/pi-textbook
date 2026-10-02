import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentLoop } from "../src/agent-loop.js";
import { createRuntime } from "../src/composition.js";
import {
  createInMemoryTransportPair,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  LATEST_PROTOCOL_VERSION,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpTimeoutError,
  parseJsonRpcMessage,
  splitJsonRpcLines,
  StdioTransport,
  type InMemoryTransport,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "../src/mcp.js";
import {
  createMcpRuntime,
  createMcpToolName,
  MCP_SERVERS_SECTION,
  renderMcpServersSection,
} from "../src/mcp-runtime.js";
import { ScriptedModel } from "../src/scripted-model.js";
import { InMemorySessionStore } from "../src/session.js";
import { executeToolCall, ToolRegistry } from "../src/tool.js";
import {
  createToolSearchTool,
  TOOL_SEARCH_TOOL_NAME,
} from "../src/tool-search.js";
import {
  assistantMessage,
  currentSystemMessage,
  text,
  userMessage,
  type SystemMessage,
  type ToolCall,
} from "../src/types.js";

const SLOW = { timeout: 15_000 };

function call(id: string, name: string, args: unknown): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface FakeServerOptions {
  protocolVersion?: string;
  /** 每页的工具；第 n 页的 cursor 就是字符串 n。 */
  pages?: { tools: unknown[]; nextCursor?: string | null }[];
  /** 不回答这些方法（模拟挂起）。 */
  silent?: string[];
  /** initialize 在这个 promise 完成后才回答。 */
  gate?: Promise<void>;
  onCall?(name: string, args: unknown): unknown;
}

interface FakeServer {
  received: JsonRpcMessage[];
  requests(method: string): JsonRpcRequest[];
  notifications(method: string): JsonRpcMessage[];
}

/** 一个只有握手、tools/list 与 tools/call 的内存 MCP 服务器。 */
function serveMcp(
  transport: InMemoryTransport,
  options: FakeServerOptions = {},
): FakeServer {
  const received: JsonRpcMessage[] = [];
  const pages = options.pages ?? [{ tools: [] }];
  const answer = async (request: JsonRpcRequest): Promise<unknown> => {
    switch (request.method) {
      case "initialize":
        await options.gate;
        return {
          protocolVersion: options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0" },
          instructions: "fake server",
        };
      case "tools/list": {
        const cursor = (request.params as { cursor?: string } | undefined)
          ?.cursor;
        const page = pages[cursor === undefined ? 0 : Number(cursor)];
        if (!page) throw new McpError(-32602, "unknown cursor");
        return {
          tools: page.tools,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        };
      }
      case "tools/call": {
        const params = request.params as { name: string; arguments?: unknown };
        return options.onCall
          ? options.onCall(params.name, params.arguments)
          : { content: [{ type: "text", text: `called ${params.name}` }] };
      }
      default:
        throw new McpError(-32601, `Method not found: ${request.method}`);
    }
  };
  transport.onMessage((message) => {
    received.push(message);
    if (!isJsonRpcRequest(message)) return;
    if (options.silent?.includes(message.method)) return;
    answer(message).then(
      (result) => transport.send({ jsonrpc: "2.0", id: message.id, result }),
      (error: unknown) =>
        transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: error instanceof McpError ? error.code : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
  });
  void transport.start();
  return {
    received,
    requests: (method) =>
      received.filter(
        (message): message is JsonRpcRequest =>
          isJsonRpcRequest(message) && message.method === method,
      ),
    notifications: (method) =>
      received.filter(
        (message) =>
          isJsonRpcNotification(message) && message.method === method,
      ),
  };
}

function toolInfo(name: string, description = `${name} description`) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  };
}

async function connected(options: FakeServerOptions = {}, requestTimeoutMs?: number) {
  const pair = createInMemoryTransportPair();
  const server = serveMcp(pair.server, options);
  const client = new McpClient({ name: "workshop", version: "0", requestTimeoutMs });
  await client.connect(pair.client);
  return { client, server, pair };
}

test("JSON-RPC 收窄：request / notification / response 的判定互斥，非法消息被拒绝", () => {
  const request = { jsonrpc: "2.0", id: 1, method: "ping" };
  const notification = { jsonrpc: "2.0", method: "notifications/x" };
  const success = { jsonrpc: "2.0", id: "a", result: null };
  const failure = { jsonrpc: "2.0", id: 2, error: { code: -1, message: "no" } };
  const kinds = (value: unknown) => [
    isJsonRpcRequest(value),
    isJsonRpcNotification(value),
    isJsonRpcResponse(value),
  ];
  assert.deepEqual(kinds(request), [true, false, false]);
  assert.deepEqual(kinds(notification), [false, true, false]);
  assert.deepEqual(kinds(success), [false, false, true]);
  assert.deepEqual(kinds(failure), [false, false, true]);
  assert.equal(parseJsonRpcMessage(request), request);

  for (const bad of [
    null,
    { jsonrpc: "1.0", id: 1, method: "x" },
    { jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { message: "missing code" } },
    { jsonrpc: "2.0", id: Number.NaN, method: "x" },
    { jsonrpc: "2.0" },
  ]) {
    assert.throws(
      () => parseJsonRpcMessage(bad),
      (error: unknown) => error instanceof McpError && error.code === -32600,
    );
  }
});

test("内存传输成对交付：connect 先 initialize 再发 notifications/initialized，client 记录 serverInfo 与协议版本", SLOW, async () => {
  const { client, server } = await connected();
  assert.equal(client.connectionState, "connected");
  assert.deepEqual(client.serverInfo, { name: "fake", version: "1.0" });
  assert.equal(client.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(client.instructions, "fake server");
  const methods = server.received.map((message) =>
    "method" in message ? message.method : "response",
  );
  assert.deepEqual(methods, ["initialize", "notifications/initialized"]);
  const init = server.requests("initialize")[0]!;
  assert.deepEqual(init.params, {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "workshop", version: "0" },
  });
  await client.close();
  assert.equal(client.connectionState, "closed");
});

test("版本协商：服务器选了不支持的版本时 connect 失败并关闭连接；已关闭的 client 拒绝新请求", SLOW, async () => {
  const pair = createInMemoryTransportPair();
  serveMcp(pair.server, { protocolVersion: "1999-01-01" });
  const client = new McpClient({ name: "workshop", version: "0" });
  let closed = 0;
  client.onClose(() => {
    closed += 1;
  });
  await assert.rejects(client.connect(pair.client), /unsupported protocol version 1999-01-01/);
  assert.equal(client.connectionState, "closed");
  assert.equal(closed, 1);
  await assert.rejects(client.listTools(), McpConnectionClosedError);
  await assert.rejects(client.connect(pair.client), /closed state/);
});

test("tools/list 跟随 nextCursor 翻页，null 或空串 cursor 表示结束，结果校验 name 与 inputSchema", SLOW, async () => {
  const { client, server } = await connected({
    pages: [
      { tools: [toolInfo("a")], nextCursor: "1" },
      { tools: [toolInfo("b"), toolInfo("c")], nextCursor: "2" },
      { tools: [toolInfo("d")], nextCursor: null },
    ],
  });
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    server.requests("tools/list").map((request) => request.params),
    [undefined, { cursor: "1" }, { cursor: "2" }],
  );

  const empty = await connected({ pages: [{ tools: [toolInfo("x")], nextCursor: "" }] });
  assert.equal((await empty.client.listTools()).length, 1);

  const broken = await connected({ pages: [{ tools: [{ name: "x" }] }] });
  await assert.rejects(broken.client.listTools(), /Invalid entry in MCP tools\/list/);
});

test("重复 cursor 报错，避免无限翻页", SLOW, async () => {
  const { client } = await connected({
    pages: [
      { tools: [toolInfo("a")], nextCursor: "1" },
      { tools: [toolInfo("b")], nextCursor: "1" },
    ],
  });
  await assert.rejects(client.listTools(), /duplicate cursor: 1/);
});

test("tools/call 带 arguments；结果缺 content 时补空数组；服务器 error 响应变成带 code 的 McpError", SLOW, async () => {
  const seen: unknown[] = [];
  const { client } = await connected({
    onCall(name, args) {
      seen.push([name, args]);
      if (name === "structured") return { structuredContent: { ok: true } };
      if (name === "broken") throw new McpError(-32602, "bad arguments");
      return { content: [{ type: "text", text: "hi" }] };
    },
  });
  assert.deepEqual(await client.callTool("greet", { q: "x" }), {
    content: [{ type: "text", text: "hi" }],
  });
  assert.deepEqual(await client.callTool("structured"), {
    structuredContent: { ok: true },
    content: [],
  });
  await assert.rejects(
    client.callTool("broken", {}),
    (error: unknown) =>
      error instanceof McpError &&
      error.code === -32602 &&
      error.message === "bad arguments",
  );
  assert.deepEqual(seen, [
    ["greet", { q: "x" }],
    ["structured", undefined],
    ["broken", {}],
  ]);
});

test("请求超时以 McpTimeoutError 拒绝并发送 notifications/cancelled；initialize 超时不发 cancelled", SLOW, async () => {
  const { client, server } = await connected({ silent: ["tools/list"] }, 40);
  await assert.rejects(client.listTools(), McpTimeoutError);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancelled = server.notifications("notifications/cancelled");
  assert.equal(cancelled.length, 1);
  assert.deepEqual(
    (cancelled[0] as { params?: unknown }).params,
    { requestId: server.requests("tools/list")[0]!.id, reason: "Request timed out" },
  );

  const pair = createInMemoryTransportPair();
  const hanging = serveMcp(pair.server, { silent: ["initialize"] });
  const client2 = new McpClient({ name: "w", version: "0", requestTimeoutMs: 40 });
  await assert.rejects(client2.connect(pair.client), McpTimeoutError);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(hanging.notifications("notifications/cancelled"), []);
  assert.equal(client2.connectionState, "closed");
});

test("调用方 abort 以 AbortError 拒绝并发送 cancelled；传输关闭让所有在途请求以 McpConnectionClosedError 拒绝", SLOW, async () => {
  const { client, server, pair } = await connected({ silent: ["tools/call"] });
  const controller = new AbortController();
  const aborted = client.callTool("slow", {}, { signal: controller.signal });
  controller.abort("user");
  await assert.rejects(aborted, { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    (server.notifications("notifications/cancelled")[0] as { params?: unknown })
      .params,
    { requestId: server.requests("tools/call")[0]!.id, reason: "user" },
  );
  await assert.rejects(
    client.callTool("x", {}, { signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );

  const errors: Error[] = [];
  client.onError((error) => errors.push(error));
  const first = client.callTool("a", {});
  const second = client.listTools();
  pair.client.emitError(new Error("wire glitch"));
  assert.deepEqual(errors.map((error) => error.message), ["wire glitch"]);
  await pair.server.close();
  await assert.rejects(first, McpConnectionClosedError);
  await assert.rejects(second, McpConnectionClosedError);
  assert.equal(client.connectionState, "closed");
});

const STDIO_FIXTURE = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "stdio-fixture", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] } });
  } else if (message.method === "tools/call" && message.params.name === "burst") {
    // 一次写入里有两条通知、一行垃圾与响应：分帧必须按换行逐条交付。
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { n: 1 } }) + "\n" +
      "this is not json\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { n: 2 } }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "burst done" }] } }) + "\n",
    );
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo:" + JSON.stringify(message.params.arguments) }] } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
rl.on("close", () => setTimeout(() => process.exit(0), 20));
`;

/** 测试编译到 .dist，fixture 写进临时目录，用当前 node 运行。 */
async function withFixture(run: (file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-workshop-mcp-"));
  const file = path.join(directory, "server.cjs");
  await writeFile(file, STDIO_FIXTURE, "utf8");
  try {
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("stdio 传输：与子进程 node 服务器握手、列工具、调用；close 结束子进程", SLOW, async () => {
  await withFixture(async (file) => {
    const transport = new StdioTransport({ command: process.execPath, args: [file] });
    const client = new McpClient({ name: "workshop", version: "0" });
    try {
      await client.connect(transport);
      assert.ok(isAlive(transport.pid));
      assert.deepEqual(client.serverInfo, { name: "stdio-fixture", version: "1" });
      assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["echo"]);
      assert.deepEqual((await client.callTool("echo", { q: 1 })).content, [
        { type: "text", text: 'echo:{"q":1}' },
      ]);
    } finally {
      const pid = transport.pid;
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(isAlive(pid), false, "close 后子进程应退出");
    }
  });

  const missing = new StdioTransport({ command: "/definitely/not/a/command" });
  await assert.rejects(missing.start(), /ENOENT/);
});

test("分帧按换行提交：半行不解析，一次 data 里多行都交付，非 JSON 行只报 error 不断开", SLOW, async () => {
  const half = splitJsonRpcLines("", '{"jsonrpc":"2.0","met');
  assert.deepEqual(half, { messages: [], errors: [], rest: '{"jsonrpc":"2.0","met' });
  const done = splitJsonRpcLines(half.rest, 'hod":"x"}\n\n[1]\n{"jsonrpc":"2.0","id":1,"result":2}\n{"a"');
  assert.deepEqual(done.messages, [
    { jsonrpc: "2.0", method: "x" },
    { jsonrpc: "2.0", id: 1, result: 2 },
  ]);
  assert.equal(done.errors.length, 1);
  assert.equal(done.rest, '{"a"');

  await withFixture(async (file) => {
    const transport = new StdioTransport({ command: process.execPath, args: [file] });
    const client = new McpClient({ name: "workshop", version: "0" });
    const notified: unknown[] = [];
    const errors: string[] = [];
    client.onNotification("notifications/message", (params) => notified.push(params));
    client.onError((error) => errors.push(error.message));
    try {
      await client.connect(transport);
      const result = await client.callTool("burst", {});
      assert.deepEqual(result.content, [{ type: "text", text: "burst done" }]);
      assert.deepEqual(notified, [{ n: 1 }, { n: 2 }]);
      assert.equal(errors.length, 1);
      assert.equal(client.connectionState, "connected");
      assert.deepEqual((await client.callTool("echo", { ok: true })).content, [
        { type: "text", text: 'echo:{"ok":true}' },
      ]);
    } finally {
      await client.close();
    }
  });
});

test("工具命名：mcp__<server>__<tool>，非字母数字转 _，冲突或超长时加 hash 后缀并限制在 64 字符", () => {
  assert.equal(createMcpToolName("git-hub", "list.issues"), "mcp__git_hub__list_issues");
  const taken = createMcpToolName("a", "b-c", (name) => name === "mcp__a__b_c");
  assert.match(taken, /^mcp__a__b_c_[0-9a-f]{8}$/);
  assert.notEqual(taken, createMcpToolName("a", "b_c", (name) => name === "mcp__a__b_c"));
  const long = createMcpToolName("server", "x".repeat(100));
  assert.equal(long.length, 64);
  assert.match(long, /^mcp__server__x+_[0-9a-f]{8}$/);
  assert.equal(long, createMcpToolName("server", "x".repeat(100)));
});

test("服务器工具按 deferred 注册，脚本可调用、模型需经 tool_search 激活；isError 结果保留内容", SLOW, async () => {
  const registry = new ToolRegistry();
  registry.register(createToolSearchTool(registry));
  const pair = createInMemoryTransportPair();
  serveMcp(pair.server, {
    pages: [{ tools: [toolInfo("search_issues", "Search GitHub issues"), toolInfo("fail")] }],
    onCall(name, args) {
      if (name === "fail") {
        return { isError: true, content: [{ type: "text", text: "quota exceeded" }] };
      }
      return { content: [{ type: "text", text: `found ${JSON.stringify(args)}` }, { type: "image", data: "AA" }] };
    },
  });
  const mcp = createMcpRuntime(registry, {
    servers: [{ name: "gh", createTransport: () => pair.client }],
  });
  try {
    await mcp.waitForDirectServers();
    while (mcp.status()[0]!.state === "connecting") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(mcp.status(), [
      { name: "gh", state: "connected", tools: ["mcp__gh__search_issues", "mcp__gh__fail"] },
    ]);
    assert.equal(registry.exposureOf("mcp__gh__search_issues"), "deferred");
    assert.equal(registry.canCall("mcp__gh__search_issues", "script"), true);
    assert.deepEqual(registry.definitions().map((tool) => tool.name), [TOOL_SEARCH_TOOL_NAME]);
    assert.deepEqual(registry.get("mcp__gh__fail")?.schema.jsonSchema, toolInfo("fail").inputSchema);

    const failed = await executeToolCall(call("f", "mcp__gh__fail", {}), registry, {}, "script");
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.content, [text("quota exceeded")]);
    assert.deepEqual(failed.details, { server: "gh", tool: "fail" });

    const model = new ScriptedModel([
      assistantMessage([call("c1", "mcp__gh__search_issues", { q: "bug" })], "toolUse"),
      assistantMessage([call("c2", TOOL_SEARCH_TOOL_NAME, { query: "github issues" })], "toolUse"),
      assistantMessage([call("c3", "mcp__gh__search_issues", { q: "bug" })], "toolUse"),
      assistantMessage([text("done")]),
    ]);
    const result = await runAgentLoop({
      model,
      tools: registry,
      context: { messages: [userMessage("find bugs")] },
    });
    const results = result.messages.filter((message) => message.role === "toolResult");
    assert.deepEqual(results.map((message) => message.isError), [true, false, false]);
    assert.deepEqual(results[2]!.content, [
      text('found {"q":"bug"}'),
      text('{"type":"image","data":"AA"}'),
    ]);
  } finally {
    await mcp.close();
  }
});

test("mcp_servers 段落只在变化时打补丁；首个 prompt 只等待有 direct 工具的服务器，且等待有上限", SLOW, async () => {
  const registry = new ToolRegistry();
  const docsPair = createInMemoryTransportPair();
  serveMcp(docsPair.server, { pages: [{ tools: [toolInfo("search")] }] });
  const gate = deferred();
  const slowPair = createInMemoryTransportPair();
  serveMcp(slowPair.server, { pages: [{ tools: [toolInfo("run")] }], gate: gate.promise });
  const neverPair = createInMemoryTransportPair();
  serveMcp(neverPair.server, { silent: ["initialize"] });
  const mcp = createMcpRuntime(registry, {
    startupTimeoutMs: 60,
    requestTimeoutMs: 5_000,
    servers: [
      { name: "docs", createTransport: () => docsPair.client },
      { name: "slow", createTransport: () => slowPair.client, exposure: "direct" },
      { name: "never", createTransport: () => neverPair.client },
    ],
  });
  const model = new ScriptedModel([
    assistantMessage([text("one")]),
    assistantMessage([text("two")]),
    assistantMessage([text("three")]),
  ]);
  const session = new InMemorySessionStore();
  const runtime = await createRuntime(
    { cwd: process.cwd(), systemPrompt: "BASE" },
    { model, tools: registry, session, sectionProviders: [mcp] },
  );
  const systemMessages = async () =>
    (await session.entries()).flatMap((entry) =>
      entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
    );
  const withSections = async () =>
    (await systemMessages()).filter((message) => message.sections !== undefined);
  const sectionOf = (message: SystemMessage) => message.sections?.[MCP_SERVERS_SECTION];
  try {
    const started = Date.now();
    await runtime.prompt("first");
    await runtime.flush();
    const waited = Date.now() - started;
    assert.ok(waited >= 50 && waited < 2_000, `等待应有上限，实际 ${waited}ms`);
    assert.equal((await systemMessages()).length, 1);
    const first = sectionOf((await withSections())[0]!)!;
    assert.match(first, /- docs: connected, 1 tool \(mcp__docs__search\)/);
    assert.match(first, /- slow: connecting, 0 tools/);
    assert.match(first, /- never: connecting, 0 tools/);
    assert.deepEqual(registry.definitions(), [], "deferred 工具不进入声明集合");

    await runtime.prompt("second");
    await runtime.flush();
    assert.equal((await systemMessages()).length, 1, "服务器状态没变就不打补丁");

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.prompt("third");
    await runtime.flush();
    const patches = await withSections();
    assert.equal(patches.length, 2, "slow 连上后段落变了，才有第二条段落补丁");
    const patch = patches[1]!;
    assert.deepEqual(Object.keys(patch.sections ?? {}), [MCP_SERVERS_SECTION]);
    assert.match(sectionOf(patch)!, /- slow: connected, 1 tool \(mcp__slow__run\)/);
    assert.equal(sectionOf(patch), renderMcpServersSection(mcp.status()));
    // direct 工具进入声明集合，loop 还追加了一条工具声明补丁。
    const declarations = (await systemMessages()).filter((message) => message.toolsAdded);
    assert.deepEqual(
      declarations.map((message) => message.toolsAdded!.map((tool) => tool.name)),
      [["mcp__slow__run"]],
    );
    assert.equal((await systemMessages()).length, 3);
    const replayed = currentSystemMessage(runtime.agent.getState().messages)!;
    assert.equal(replayed.content, "BASE");
    assert.equal(sectionOf(replayed), sectionOf(patch));
  } finally {
    await runtime.dispose();
    await mcp.close();
  }
});
