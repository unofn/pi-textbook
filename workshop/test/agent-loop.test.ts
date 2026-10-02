import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop, type LoopEvent } from "../src/agent-loop.js";
import { ScriptedModel } from "../src/scripted-model.js";
import {
  objectSchema,
  stringValue,
  ToolRegistry,
  executeToolCall,
  type Tool,
} from "../src/tool.js";
import {
  assistantMessage,
  currentSystemPrompt,
  text,
  userMessage,
  type AgentMessage,
  type ToolCall,
} from "../src/types.js";

function call(id: string, name: string, args: unknown): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

const echoTool: Tool<{ value: string }> = {
  name: "echo",
  description: "echo",
  schema: objectSchema({ value: stringValue }),
  async execute({ value }) {
    return { content: [text(value)] };
  },
};

test("schema、未知工具和异常都返回配对 toolResult", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  registry.register({
    name: "boom",
    description: "throws",
    schema: objectSchema({ value: stringValue }),
    async execute() {
      throw new Error("boom");
    },
  });

  for (const result of [
    await executeToolCall(call("a", "missing", {}), registry),
    await executeToolCall(call("b", "echo", { value: 1 }), registry),
    await executeToolCall(call("c", "boom", { value: "x" }), registry),
  ]) {
    assert.equal(result.isError, true);
    assert.ok(result.toolCallId);
  }
});
test("Agent Loop 闭合 model → tool → result → model", async () => {
  const model = new ScriptedModel([
    assistantMessage(
      [call("call-1", "echo", { value: "observed" })],
      "toolUse",
    ),
    assistantMessage([{ type: "text", text: "done" }], "stop"),
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: [userMessage("run")] },
  });

  assert.equal(result.reason, "stop");
  assert.deepEqual(result.messages.map((message) => message.role), [
    "user",
    "assistant",
    "toolResult",
    "assistant",
  ]);
  assert.equal(model.requests[1].messages.at(-1)?.role, "toolResult");
});

test("length 中的 tool call 从不执行，但 transcript 保持配对", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    ...echoTool,
    async execute(parameters) {
      executions += 1;
      return { content: [text(parameters.value)] };
    },
  });
  const result = await runAgentLoop({
    model: new ScriptedModel([
      assistantMessage(
        [
          {
            ...call("cut", "echo", '{"value":"incomplete'),
            rawArguments: '{"value":"incomplete',
          },
        ],
        "length",
      ),
    ]),
    tools: registry,
    context: { messages: [userMessage("run")] },
  });

  assert.equal(executions, 0);
  assert.equal(result.reason, "length");
  const paired = result.messages.at(-1);
  assert.equal(paired?.role, "toolResult");
  assert.equal(paired?.role === "toolResult" ? paired.toolCallId : "", "cut");
  assert.equal(paired?.role === "toolResult" ? paired.isError : false, true);
});

test("完成事件按真实时间，transcript 按 call 顺序", async () => {
  const delayed = (name: string, delay: number): Tool<{ value: string }> => ({
    name,
    description: name,
    schema: objectSchema({ value: stringValue }),
    async execute({ value }) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { content: [text(value)] };
    },
  });
  const registry = new ToolRegistry();
  registry.register(delayed("slow", 25));
  registry.register(delayed("fast", 1));
  const events: LoopEvent[] = [];
  const result = await runAgentLoop({
    model: new ScriptedModel([
      assistantMessage(
        [
          call("slow-call", "slow", { value: "S" }),
          call("fast-call", "fast", { value: "F" }),
        ],
        "toolUse",
      ),
      assistantMessage([{ type: "text", text: "done" }]),
    ]),
    tools: registry,
    context: { messages: [userMessage("run")] },
    onEvent: (event) => events.push(event),
  });

  const completionOrder = events
    .filter((event) => event.type === "tool_end")
    .map((event) =>
      event.type === "tool_end" ? event.result.toolCallId : "",
    );
  const transcriptOrder = result.messages
    .filter((message) => message.role === "toolResult")
    .map((message) =>
      message.role === "toolResult" ? message.toolCallId : "",
    );
  assert.deepEqual(completionOrder, ["fast-call", "slow-call"]);
  assert.deepEqual(transcriptOrder, ["slow-call", "fast-call"]);
});

test("loop 只追加 assistant 与 toolResult，从不写入 system message", async () => {
  const model = new ScriptedModel([
    assistantMessage(
      [call("call-1", "echo", { value: "observed" })],
      "toolUse",
    ),
    assistantMessage([text("done")]),
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const given: AgentMessage[] = [
    { role: "system", content: "base", timestamp: 0 },
    userMessage("first"),
    assistantMessage([text("earlier")]),
    { role: "system", content: "", sections: { mode: "review" }, timestamp: 1 },
    userMessage("run"),
  ];
  const before = structuredClone(given);
  const result = await runAgentLoop({
    model,
    tools: registry,
    context: { messages: given },
  });

  assert.deepEqual(given, before);
  // 每次请求都以调用方给的 messages（含 system message）为前缀，不另带 system 字段。
  for (const request of model.requests) {
    assert.deepEqual(request.messages.slice(0, given.length), given);
    assert.deepEqual(Object.keys(request).sort(), ["messages", "tools"]);
  }
  assert.equal(currentSystemPrompt(model.requests[1].messages), "base\n\nreview");
  assert.deepEqual(result.messages.slice(0, given.length), given);
  assert.deepEqual(
    result.messages.slice(given.length).map((message) => message.role),
    ["assistant", "toolResult", "assistant"],
  );
  assert.equal(
    result.messages.filter((message) => message.role === "system").length,
    2,
  );
});
