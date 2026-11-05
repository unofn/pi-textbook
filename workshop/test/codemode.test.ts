import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/agent-loop.js";
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS } from "../src/codemode-protocol.js";
import {
  CODEMODE_TOOL_NAME,
  createCodemodeTool,
  createNestedToolBridge,
  runCodemodeScript,
  type CodemodeScriptTool,
  type CodemodeToolDetails,
} from "../src/codemode.js";
import { ScriptedModel } from "../src/scripted-model.js";
import {
  executeToolCall,
  objectSchema,
  stringValue,
  ToolRegistry,
  type Tool,
  type ToolExposure,
} from "../src/tool.js";
import {
  assistantMessage,
  currentTools,
  text,
  userMessage,
  type ToolCall,
  type ToolResultMessage,
} from "../src/types.js";

const SLOW = { timeout: 15_000 };

function call(id: string, name: string, args: unknown): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function scriptTools(
  entries: Record<string, CodemodeScriptTool["execute"]>,
): Map<string, CodemodeScriptTool> {
  return new Map(
    Object.entries(entries).map(([name, execute]) => [
      name,
      { description: `${name} tool`, execute },
    ]),
  );
}

interface CountingTool extends Tool<{ value: string }> {
  callIds: string[];
}

function echo(name: string, exposure?: ToolExposure): CountingTool {
  const tool: CountingTool = {
    name,
    description: `${name} returns its value`,
    schema: objectSchema({ value: stringValue }),
    ...(exposure ? { exposure } : {}),
    callIds: [],
    async execute({ value }, context) {
      tool.callIds.push(context.callId);
      return { content: [text(`${name}:${value}`)], details: { name } };
    },
  };
  return tool;
}

/** 一个只在 signal 触发时才 reject 的工具；started 让测试知道脚本已经调用到它。 */
function waitingTool(): Tool<{ value: string }> & {
  signal?: AbortSignal;
} {
  const tool: Tool<{ value: string }> & { signal?: AbortSignal } = {
    name: "wait",
    description: "waits for its signal",
    schema: objectSchema({ value: stringValue }),
    execute(_parameters, context) {
      tool.signal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener("abort", () =>
          reject(new Error("wait aborted")),
        );
      });
    },
  };
  return tool;
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
}

function detailsOf(result: ToolResultMessage): CodemodeToolDetails {
  return result.details as CodemodeToolDetails;
}

test("脚本在独立 worker 的 QuickJS 里运行：await tools.<name>(args) 经消息桥往返，返回值按 JSON 回到宿主", SLOW, async () => {
  const seen: unknown[] = [];
  const result = await runCodemodeScript(
    `const a = await tools.add({ x: 1, y: 2 });
     const [b, c] = await Promise.all([tools.add({ x: a, y: 1 }), tools.add({ x: 10, y: 0 })]);
     console.log("sum", b + c, { names: ALL_TOOLS.map((tool) => tool.name) });
     return { a, b, c, hasProcess: typeof process, hasTimer: typeof setTimeout };`,
    {
      tools: scriptTools({
        async add(args) {
          seen.push(args);
          const { x, y } = args as { x: number; y: number };
          return x + y;
        },
      }),
    },
  );

  assert.deepEqual(result, {
    ok: true,
    value: { a: 3, b: 4, c: 10, hasProcess: "undefined", hasTimer: "undefined" },
    output: ['sum 14 {"names":["add"]}'],
    calls: [
      { name: "add", status: "ok" },
      { name: "add", status: "ok" },
      { name: "add", status: "ok" },
    ],
  });
  assert.deepEqual(seen, [
    { x: 1, y: 2 },
    { x: 3, y: 1 },
    { x: 10, y: 0 },
  ]);
});

test("脚本抛错、语法错误与工具拒绝都变成 ok:false 的结果，宿主不抛异常", SLOW, async () => {
  const thrown = await runCodemodeScript(
    `console.log("before");\nthrow new RangeError("bad input");`,
  );
  assert.equal(thrown.ok, false);
  if (!thrown.ok) {
    assert.equal(thrown.error.kind, "script");
    assert.equal(thrown.error.name, "RangeError");
    assert.equal(thrown.error.message, "bad input");
    assert.match(thrown.error.stack ?? "", /codemode\.js:2/);
  }
  assert.deepEqual(thrown.output, ["before"]);

  const syntax = await runCodemodeScript(`return (;`);
  assert.equal(syntax.ok, false);
  if (!syntax.ok) {
    assert.equal(syntax.error.kind, "script");
    assert.equal(syntax.error.name, "SyntaxError");
  }

  const rejected = await runCodemodeScript(
    `try { await tools.fail({}); } catch (error) { return "caught " + error.message; }`,
    {
      tools: scriptTools({
        async fail() {
          throw new Error("tool broke");
        },
      }),
    },
  );
  assert.deepEqual(rejected, {
    ok: true,
    value: "caught tool broke",
    output: [],
    calls: [{ name: "fail", status: "error" }],
  });
});

test("每次执行都是新的 VM：全局变量不跨执行泄漏；内存上限下的失控分配以 out of memory 失败", SLOW, async () => {
  const first = await runCodemodeScript(`globalThis.leak = 42; return leak;`);
  const second = await runCodemodeScript(`return typeof globalThis.leak;`);
  assert.deepEqual([first.ok && first.value, second.ok && second.value], [
    42,
    "undefined",
  ]);

  const oom = await runCodemodeScript(
    `const chunks = []; for (;;) chunks.push("x".repeat(1 << 20));`,
    { memoryLimitBytes: 8 * 1024 * 1024 },
  );
  assert.equal(oom.ok, false);
  if (!oom.ok) assert.match(oom.error.message, /out of memory/);
});

test("没有计时器与 I/O：等待永不结算的 promise 立刻以 stalled 失败，而不是挂到超时", SLOW, async () => {
  const started = Date.now();
  const result = await runCodemodeScript(`await new Promise(() => {}); return 1;`, {
    timeoutMs: 10_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "script");
    assert.match(result.error.message, /can never settle/);
  }
  assert.ok(Date.now() - started < 5_000);
});

test("循环打印超过输出上限时脚本以 RangeError 失败，catch 住也不能继续输出，宿主只保留上限内的输出", SLOW, async () => {
  const large = await runCodemodeScript(
    `const s = "x".repeat(1 << 20); for (;;) { try { console.log(s); } catch {} }`,
  );
  assert.equal(large.ok, false);
  if (!large.ok) {
    assert.equal(large.error.kind, "script");
    assert.equal(large.error.name, "RangeError");
    assert.match(large.error.message, /script output exceeded/);
  }
  const chars = large.output.reduce((sum, text) => sum + text.length, 0);
  assert.ok(chars <= MAX_OUTPUT_CHARS);
  assert.ok(chars > MAX_OUTPUT_CHARS - (2 << 20));

  const empty = await runCodemodeScript(`for (;;) console.log("");`);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.name, "RangeError");
  assert.equal(empty.output.length, MAX_OUTPUT_ITEMS);
});

test("嵌套调用走注册表执行路径：id 为 <parent>/<n>，表里只有可调用集合，不存在的成员抛出带近似名的 TypeError", SLOW, async () => {
  const read = echo("read");
  const issues = echo("list_issues", "deferred");
  const registry = new ToolRegistry([
    read,
    issues,
    echo("search", "model-only"),
    echo("secret", "hidden"),
  ]);
  const bridge = createNestedToolBridge(registry, "call-7");
  assert.deepEqual([...bridge.tools.keys()], ["read", "list_issues"]);

  const result = await runCodemodeScript(
    `const a = await tools.read({ value: "a" });
     const b = await tools.list_issues({ value: "b" });
     let suggestion;
     try { tools.listIssues; } catch (error) { suggestion = error.name + ": " + error.message; }
     return { a, b, suggestion };`,
    { tools: bridge.tools },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    const value = result.value as {
      a: unknown;
      b: unknown;
      suggestion: string;
    };
    assert.deepEqual(value.a, { text: "read:a", details: { name: "read" } });
    assert.deepEqual(value.b, {
      text: "list_issues:b",
      details: { name: "list_issues" },
    });
    assert.match(value.suggestion, /^TypeError: tools\.listIssues does not exist\. Did you mean tools\.list_issues\?/);
  }
  assert.deepEqual(read.callIds, ["call-7/1"]);
  assert.deepEqual(issues.callIds, ["call-7/2"]);
  assert.deepEqual(bridge.nestedCalls(), {
    calls: [
      { id: "call-7/1", name: "read", status: "ok", arguments: { value: "a" } },
      {
        id: "call-7/2",
        name: "list_issues",
        status: "ok",
        arguments: { value: "b" },
      },
    ],
    count: 2,
    complete: true,
  });
});

test("一个嵌套调用失败不会让同批其他调用丢失：参数校验失败与工具抛错都只影响自己", SLOW, async () => {
  const registry = new ToolRegistry([
    echo("read"),
    {
      name: "boom",
      description: "always throws",
      schema: objectSchema({ value: stringValue }),
      async execute() {
        throw new Error("exploded");
      },
    },
  ]);
  const bridge = createNestedToolBridge(registry, "p");
  const result = await runCodemodeScript(
    `const settled = await Promise.allSettled([
       tools.read({ value: "ok" }),
       tools.read({ value: 1 }),
       tools.boom({ value: "x" }),
     ]);
     return settled.map((entry) => entry.status === "fulfilled" ? entry.value.text : entry.reason.message);`,
    { tools: bridge.tools },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    const [ok, invalid, thrown] = result.value as string[];
    assert.equal(ok, "read:ok");
    assert.match(invalid!, /Tool read failed: 必须是 string/);
    assert.match(thrown!, /Tool boom failed: exploded/);
  }
  assert.deepEqual(
    bridge.nestedCalls().calls.map((record) => [record.id, record.status]),
    [
      ["p/1", "ok"],
      ["p/2", "error"],
      ["p/3", "error"],
    ],
  );
  assert.match(bridge.nestedCalls().calls[2]!.error ?? "", /exploded/);
});

test("nestedCalls 记录有界：超过条数上限照样执行但不记录，超大参数只记字节数，结果从不记录", SLOW, async () => {
  const read = echo("read");
  const registry = new ToolRegistry([read]);
  const bridge = createNestedToolBridge(registry, "p", {
    limits: { maxCalls: 2, maxArgumentBytesPerCall: 32 },
  });
  const result = await runCodemodeScript(
    `await tools.read({ value: "small" });
     await tools.read({ value: "x".repeat(100) });
     await tools.read({ value: "third" });
     return "done";`,
    { tools: bridge.tools },
  );

  assert.equal(result.ok, true);
  assert.equal(read.callIds.length, 3);
  const summary = bridge.nestedCalls();
  assert.equal(summary.count, 3);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.calls[0], {
    id: "p/1",
    name: "read",
    status: "ok",
    arguments: { value: "small" },
  });
  assert.equal(summary.calls[1]!.arguments, undefined);
  assert.equal(summary.calls[1]!.argumentsBytes, 112);
  assert.equal(summary.calls.length, 2);
  assert.ok(
    summary.calls.every((record) => !JSON.stringify(record).includes("read:")),
  );
});

test("死循环在 deadline 到期后被中断并 terminate，结果 kind 为 timeout", SLOW, async () => {
  const started = Date.now();
  const result = await runCodemodeScript(`console.log("spin"); for (;;) {}`, {
    timeoutMs: 200,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "timeout");
    assert.match(result.error.message, /200 ms/);
  }
  assert.deepEqual(result.output, ["spin"]);
  assert.ok(Date.now() - started < 5_000);
});

test("调用方 abort：worker 结束，未完成的嵌套调用收到 abort 信号并记为 cancelled", SLOW, async () => {
  const controller = new AbortController();
  const wait = waitingTool();
  const bridge = createNestedToolBridge(new ToolRegistry([wait]), "c", {
    signal: controller.signal,
  });
  const running = runCodemodeScript(`await tools.wait({ value: "x" }); return 1;`, {
    tools: bridge.tools,
    signal: controller.signal,
  });
  await until(() => wait.signal !== undefined);
  assert.equal(wait.signal?.aborted, false);
  controller.abort(new Error("user cancelled"));

  const result = await running;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "aborted");
    assert.equal(result.error.message, "user cancelled");
  }
  assert.equal(wait.signal?.aborted, true);
  assert.deepEqual(result.calls, [{ name: "wait", status: "cancelled" }]);
  assert.deepEqual(
    bridge.nestedCalls().calls.map((record) => record.status),
    ["cancelled"],
  );

  const preAborted = await runCodemodeScript(`return 1;`, {
    signal: AbortSignal.abort(),
  });
  assert.equal(preAborted.ok, false);
  if (!preAborted.ok) assert.equal(preAborted.error.kind, "aborted");
});

test("codemode 是 model-only 工具：成功时内容是返回值 JSON，details 带 nestedCalls；失败时 isError 并给出错误种类", SLOW, async () => {
  const registry = new ToolRegistry([echo("read"), echo("lint", "codemode")]);
  const codemode = createCodemodeTool(registry);
  registry.register(codemode);
  assert.equal(codemode.exposure, "model-only");
  assert.match(codemode.description, /tools\.read\(args\)/);
  assert.match(codemode.description, /tools\.lint\(args\)/);
  assert.equal(registry.canCall(CODEMODE_TOOL_NAME, "script"), false);

  const ok = await executeToolCall(
    call("c1", CODEMODE_TOOL_NAME, {
      code: `const r = await tools.lint({ value: "x" }); console.log(r.text); return [r.text];`,
    }),
    registry,
  );
  assert.equal(ok.isError, false);
  assert.equal(ok.content[0]!.text, '["lint:x"]');
  assert.deepEqual(detailsOf(ok), {
    ok: true,
    output: ["lint:x"],
    nestedCalls: {
      calls: [
        { id: "c1/1", name: "lint", status: "ok", arguments: { value: "x" } },
      ],
      count: 1,
      complete: true,
    },
  });

  const failed = await executeToolCall(
    call("c2", CODEMODE_TOOL_NAME, { code: `return await tools.LINT({});` }),
    registry,
  );
  assert.equal(failed.isError, true);
  assert.equal(detailsOf(failed).error?.kind, "script");
  assert.match(failed.content[0]!.text, /Did you mean tools\.lint\?/);
});

test("经 loop：脚本调用 deferred 工具不需要先声明，嵌套调用不进入 transcript，只出现在父结果的记录里", SLOW, async () => {
  const issues = echo("list_issues", "deferred");
  const registry = new ToolRegistry([issues]);
  registry.register(createCodemodeTool(registry));
  const model = new ScriptedModel([
    assistantMessage(
      [
        call("c1", CODEMODE_TOOL_NAME, {
          code: `const r = await tools.list_issues({ value: "open" }); return r.text;`,
        }),
      ],
      "toolUse",
    ),
    assistantMessage([text("done")]),
  ]);

  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("go")] },
  });

  assert.equal(result.reason, "stop");
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "system", "assistant", "toolResult", "assistant"],
  );
  assert.deepEqual(
    currentTools(result.messages).map((tool) => tool.name),
    [CODEMODE_TOOL_NAME],
  );
  const parent = result.messages[3] as ToolResultMessage;
  assert.equal(parent.content[0]!.text, '"list_issues:open"');
  assert.deepEqual(
    detailsOf(parent).nestedCalls.calls.map((record) => record.id),
    ["c1/1"],
  );
  assert.deepEqual(issues.callIds, ["c1/1"]);
});

test("超时通过 details 报告后 loop 继续；loop 的 abort 让脚本以 aborted 结束，并以 aborted 收口", SLOW, async () => {
  const registry = new ToolRegistry([echo("read")]);
  registry.register(createCodemodeTool(registry, { timeoutMs: 150 }));
  const timedOut = await runAgentLoop({
    model: new ScriptedModel([
      assistantMessage(
        [call("c1", CODEMODE_TOOL_NAME, { code: `for (;;) {}` })],
        "toolUse",
      ),
      assistantMessage([text("recovered")]),
    ]),
    tools: registry,
    context: { messages: [userMessage("go")] },
  });
  assert.equal(timedOut.reason, "stop");
  const timeout = timedOut.messages[3] as ToolResultMessage;
  assert.equal(timeout.isError, true);
  assert.equal(detailsOf(timeout).error?.kind, "timeout");

  const controller = new AbortController();
  const wait = waitingTool();
  const abortable = new ToolRegistry([wait]);
  abortable.register(createCodemodeTool(abortable));
  const running = runAgentLoop({
    model: new ScriptedModel([
      assistantMessage(
        [
          call("c2", CODEMODE_TOOL_NAME, {
            code: `await tools.wait({ value: "x" });`,
          }),
        ],
        "toolUse",
      ),
    ]),
    tools: abortable,
    signal: controller.signal,
    context: { messages: [userMessage("go")] },
  });
  await until(() => wait.signal !== undefined);
  controller.abort();
  const aborted = await running;
  assert.equal(aborted.reason, "aborted");
  const result = aborted.messages[3] as ToolResultMessage;
  assert.equal(detailsOf(result).error?.kind, "aborted");
  assert.deepEqual(
    detailsOf(result).nestedCalls.calls.map((record) => record.status),
    ["cancelled"],
  );
});
