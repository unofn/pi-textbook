import assert from "node:assert/strict";
import test from "node:test";
import {
  runAgentLoop,
  type AgentRequest,
  type RequestReason,
} from "../src/agent-loop.js";
import { createRuntime, type RuntimeRequestSession } from "../src/composition.js";
import { ScriptedModel } from "../src/scripted-model.js";
import {
  InMemorySessionStore,
  type JsonValue,
  type SessionEntry,
} from "../src/session.js";
import {
  objectSchema,
  stringValue,
  ToolRegistry,
  type Tool,
} from "../src/tool.js";
import {
  assistantMessage,
  text,
  userMessage,
  type AgentMessage,
  type AssistantMessage,
  type ToolCall,
} from "../src/types.js";
import {
  branchSelection,
  createVirtualModelRouting,
  findLatestResponse,
  MODEL_CHANGE_KEY,
  ModelCatalog,
  resolveRoute,
  selectModel,
  VIRTUAL_MODEL_STATE_KEY,
  virtualModelState,
  type ModelRouteRequest,
} from "../src/virtual-models.js";

function reply(model: string, value: string): AssistantMessage {
  return assistantMessage([text(value)], "stop", { model });
}

function call(id: string, name: string, args: unknown): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

const echo: Tool<{ value: string }> = {
  name: "echo",
  description: "echo",
  schema: objectSchema({ value: stringValue }),
  async execute({ value }) {
    return { content: [text(value)] };
  },
};

function metadata(
  id: string,
  key: string,
  value: JsonValue,
): SessionEntry {
  return { id, parentId: null, timestamp: 0, type: "metadata", key, value };
}

/** 一个手写的分支视角：record 直接追加到同一个数组。 */
function memorySession(branch: SessionEntry[] = []): RuntimeRequestSession & {
  recorded: { key: string; value: JsonValue }[];
} {
  const recorded: { key: string; value: JsonValue }[] = [];
  return {
    recorded,
    branch: () => branch,
    record(key, value) {
      recorded.push({ key, value });
      branch.push(metadata(`r${recorded.length}`, key, value));
    },
  };
}

test("目录区分物理模型与虚拟模型：同一个 id 不能同时是两者，provider 只拿得到物理模型", () => {
  const catalog = new ModelCatalog();
  const fast = new ScriptedModel([]);
  catalog.registerPhysical("fast", fast);
  catalog.registerVirtual({ id: "auto", route: () => ({ model: "fast" }) });

  assert.throws(() => catalog.registerPhysical("auto", fast), /已经是虚拟模型/);
  assert.throws(
    () => catalog.registerVirtual({ id: "fast", route: () => ({ model: "fast" }) }),
    /已经是物理模型/,
  );
  assert.throws(() => catalog.registerPhysical(" ", fast), /不能为空/);
  assert.equal(catalog.physical("fast")?.model, fast);
  assert.equal(catalog.physical("auto"), undefined);
  assert.equal(catalog.isVirtual("auto"), true);
  assert.equal(catalog.has("auto") && catalog.has("fast"), true);
  assert.equal(catalog.has("missing"), false);
});

test("previous 只看最近一次成功回复：error 与 aborted 的回复被跳过", () => {
  const ok = reply("fast", "ok");
  const messages: AgentMessage[] = [
    userMessage("a"),
    ok,
    userMessage("b"),
    assistantMessage([], "error", { model: "smart", errorMessage: "boom" }),
    assistantMessage([], "aborted", { model: "smart" }),
  ];
  assert.equal(findLatestResponse(messages), ok);
  assert.equal(findLatestResponse([userMessage("only")]), undefined);
});

test("resolveRoute 把虚拟选择换成物理模型并转达 previous / failed / state；路由到虚拟模型、未注册或 route 抛错都失败", async () => {
  const catalog = new ModelCatalog();
  catalog.registerPhysical("fast", new ScriptedModel([]));
  catalog.registerPhysical("smart", new ScriptedModel([]));
  const seen: ModelRouteRequest<{ turns: number }>[] = [];
  catalog.registerVirtual<{ turns: number }>({
    id: "auto",
    route(request) {
      seen.push(request);
      return {
        model: "smart",
        thinkingLevel: "high",
        state: { turns: (request.state?.turns ?? 0) + 1 },
      };
    },
  });
  const failed = assistantMessage([], "error", { model: "smart" });
  const messages = [userMessage("a"), reply("fast", "ok"), failed];

  const route = await resolveRoute(catalog, "auto", {
    reason: "retry",
    messages,
    failed,
    state: { turns: 2 },
  });
  assert.equal(route.model.id, "smart");
  assert.equal(route.thinkingLevel, "high");
  assert.deepEqual(route.state, { turns: 3 });
  assert.equal(seen[0]!.reason, "retry");
  assert.deepEqual(seen[0]!.model, { id: "auto" });
  assert.equal(seen[0]!.previous?.model.id, "fast");
  assert.equal(seen[0]!.failed?.model?.id, "smart");
  assert.equal(seen[0]!.failed?.message, failed);
  assert.deepEqual(seen[0]!.state, { turns: 2 });

  catalog.registerVirtual({ id: "loop", route: () => ({ model: "auto" }) });
  catalog.registerVirtual({ id: "ghost", route: () => ({ model: "nope" }) });
  catalog.registerVirtual({
    id: "broken",
    route: () => {
      throw new Error("router down");
    },
  });
  const options = { reason: "user" as const, messages: [userMessage("x")] };
  await assert.rejects(
    resolveRoute(catalog, "loop", options),
    /routed to auto, which is another virtual model/,
  );
  await assert.rejects(
    resolveRoute(catalog, "ghost", options),
    /routed to nope, which is not a physical model/,
  );
  await assert.rejects(resolveRoute(catalog, "broken", options), /router down/);
  await assert.rejects(
    resolveRoute(catalog, "unknown", options),
    /is not registered/,
  );
});

test("loop 在每次请求前调用 prepareRequest：第一次是 user，工具结果之后是 continuation；只有钩子换入的物理模型收到请求", async () => {
  const configured = new ScriptedModel([]);
  const physical = new ScriptedModel([
    assistantMessage([call("c1", "echo", { value: "x" })], "toolUse", {
      model: "fast",
    }),
    reply("fast", "done"),
  ]);
  const reasons: RequestReason[] = [];
  const result = await runAgentLoop({
    model: configured,
    tools: new ToolRegistry([echo]),
    context: { messages: [userMessage("go")] },
    prepareRequest(request) {
      reasons.push(request.reason);
      assert.equal(request.model, configured);
      return { model: physical };
    },
  });

  assert.equal(result.reason, "stop");
  assert.deepEqual(reasons, ["user", "continuation"]);
  assert.equal(configured.requests.length, 0);
  assert.equal(physical.requests.length, 2);
});

test("直接重跑以失败回复结尾的 transcript 时 reason 为 retry 并带 failed；钩子抛错以 error 回复结束本次请求", async () => {
  const failed = assistantMessage([], "error", { errorMessage: "overloaded" });
  const requests: AgentRequest[] = [];
  const retried = await runAgentLoop({
    model: new ScriptedModel([reply("fast", "ok")]),
    tools: new ToolRegistry(),
    context: { messages: [userMessage("go"), failed] },
    prepareRequest(request) {
      requests.push(request);
    },
  });
  assert.equal(retried.reason, "stop");
  assert.equal(requests[0]!.reason, "retry");
  assert.deepEqual(requests[0]!.failed, failed);

  const model = new ScriptedModel([reply("fast", "never")]);
  const broken = await runAgentLoop({
    model,
    tools: new ToolRegistry(),
    context: { messages: [userMessage("go")] },
    async prepareRequest() {
      throw new Error("no route");
    },
  });
  assert.equal(broken.reason, "error");
  assert.equal(model.requests.length, 0);
  const last = broken.messages.at(-1) as AssistantMessage;
  assert.equal(last.stopReason, "error");
  assert.equal(last.errorMessage, "no route");
});

test("thinkingLevel 随请求传给物理模型的 stream，钩子看到的 context 就是本次请求，transcript 不被改写", async () => {
  const physical = new ScriptedModel([reply("smart", "ok")]);
  const prefix: AgentMessage[] = [
    { role: "system", content: "base", timestamp: 0 },
    userMessage("go"),
  ];
  const snapshot = structuredClone(prefix);
  let seen: AgentRequest | undefined;
  const result = await runAgentLoop({
    model: new ScriptedModel([]),
    tools: new ToolRegistry(),
    context: { messages: prefix },
    prepareRequest(request) {
      seen = structuredClone(request);
      return { model: physical, thinkingLevel: "medium" };
    },
  });

  assert.deepEqual(physical.requestOptions, [{ thinkingLevel: "medium" }]);
  assert.deepEqual(seen?.context, physical.requests[0]);
  assert.deepEqual(result.messages.slice(0, prefix.length), snapshot);
  assert.equal((result.messages.at(-1) as AssistantMessage).model, "smart");
});

test("分支上的选择与状态：最后一条 model_change 决定选中模型，状态按模型 id 查最近一条", () => {
  const branch = [
    metadata("1", MODEL_CHANGE_KEY, { modelId: "fast" }),
    metadata("2", VIRTUAL_MODEL_STATE_KEY, { modelId: "auto", state: 1 }),
    metadata("3", VIRTUAL_MODEL_STATE_KEY, { modelId: "other", state: 9 }),
    metadata("4", MODEL_CHANGE_KEY, { modelId: "auto" }),
    metadata("5", VIRTUAL_MODEL_STATE_KEY, { modelId: "auto", state: 2 }),
    metadata("6", MODEL_CHANGE_KEY, { wrong: true }),
  ];
  assert.equal(branchSelection(branch), "auto");
  assert.equal(virtualModelState(branch, "auto"), 2);
  assert.equal(virtualModelState(branch, "other"), 9);
  assert.equal(virtualModelState(branch, "none"), undefined);
  assert.equal(branchSelection([]), undefined);
});

test("路由只在状态变化时记录 virtual_model_state；选中物理模型时直接派发；direct 请求不读不写状态", async () => {
  const catalog = new ModelCatalog();
  const fast = new ScriptedModel([]);
  const smart = new ScriptedModel([]);
  catalog.registerPhysical("fast", fast);
  catalog.registerPhysical("smart", smart);
  const states: unknown[] = [];
  catalog.registerVirtual<{ calls: number }>({
    id: "auto",
    route(request) {
      states.push(request.state);
      if (request.reason === "direct") return { model: "fast" };
      const calls = Math.min((request.state?.calls ?? 0) + 1, 2);
      return { model: calls > 1 ? "smart" : "fast", state: { calls } };
    },
  });
  const routing = createVirtualModelRouting(catalog, { defaultModelId: "auto" });
  const session = memorySession();
  const request = (reason: RequestReason): AgentRequest => ({
    context: { messages: [userMessage("go")] },
    model: fast,
    reason,
  });

  const first = await routing.prepareRequest(request("user"), session);
  const second = await routing.prepareRequest(request("continuation"), session);
  const third = await routing.prepareRequest(request("continuation"), session);
  assert.deepEqual(
    [first.model, second.model, third.model],
    [fast, smart, smart],
  );
  assert.deepEqual(session.recorded, [
    { key: VIRTUAL_MODEL_STATE_KEY, value: { modelId: "auto", state: { calls: 1 } } },
    { key: VIRTUAL_MODEL_STATE_KEY, value: { modelId: "auto", state: { calls: 2 } } },
  ]);

  const direct = await routing.routeDirect(session, [userMessage("summarize")]);
  assert.equal(direct.model.id, "fast");
  assert.deepEqual(states, [undefined, { calls: 1 }, { calls: 2 }, undefined]);
  assert.equal(session.recorded.length, 2);

  const pinned = memorySession([metadata("m", MODEL_CHANGE_KEY, { modelId: "smart" })]);
  const prepared = await routing.prepareRequest(request("user"), pinned);
  assert.equal(prepared.model, smart);
  assert.equal(states.length, 4);
  assert.deepEqual(pinned.recorded, []);
});

/** 每个物理模型都有自己的脚本；回复的 model 字段就是它的目录 id。 */
function physicalModels(): {
  catalog: ModelCatalog;
  fast: ScriptedModel;
  smart: ScriptedModel;
} {
  const fast = new ScriptedModel([
    reply("fast", "f1"),
    reply("fast", "f2"),
    reply("fast", "f3"),
  ]);
  const smart = new ScriptedModel([
    reply("smart", "s1"),
    reply("smart", "s2"),
    reply("smart", "s3"),
  ]);
  const catalog = new ModelCatalog();
  catalog.registerPhysical("fast", fast);
  catalog.registerPhysical("smart", smart);
  return { catalog, fast, smart };
}

test("经 Runtime：model_change 与路由状态都是分支上的 metadata entry，状态跟在本轮消息之后落盘，重新打开后从 active path 还原", async () => {
  const { catalog, fast, smart } = physicalModels();
  catalog.registerVirtual<number>({
    id: "alternate",
    route(request) {
      const turn = (request.state ?? 0) + 1;
      return { model: turn % 2 === 1 ? "smart" : "fast", state: turn };
    },
  });
  const routing = createVirtualModelRouting(catalog, { defaultModelId: "fast" });
  const session = new InMemorySessionStore();
  let nextId = 0;
  const deps = {
    model: new ScriptedModel([]),
    tools: new ToolRegistry(),
    session,
    prepareRequest: routing.prepareRequest,
    createId: () => `e${++nextId}`,
    now: () => 0,
  };

  const runtime = await createRuntime({ cwd: process.cwd() }, deps);
  await runtime.prompt("one");
  await selectModel(runtime, catalog, "alternate");
  await runtime.prompt("two");
  await runtime.flush();
  await assert.rejects(selectModel(runtime, catalog, "missing"), /未注册/);

  const entries = await session.entries();
  assert.deepEqual(
    entries.map((entry) =>
      entry.type === "metadata" ? entry.key : entry.type === "message" ? entry.message.role : entry.type,
    ),
    [
      "user",
      "assistant",
      MODEL_CHANGE_KEY,
      "user",
      "assistant",
      VIRTUAL_MODEL_STATE_KEY,
    ],
  );
  assert.equal(runtime.getActiveLeafId(), entries.at(-1)!.id);
  assert.deepEqual(
    entries.slice(1).map((entry) => entry.parentId),
    entries.slice(0, -1).map((entry) => entry.id),
  );
  assert.equal(fast.requests.length, 1);
  assert.equal(smart.requests.length, 1);
  const dispatched = runtime.agent
    .getState()
    .messages.filter((message) => message.role === "assistant")
    .map((message) => (message as AssistantMessage).model);
  assert.deepEqual(dispatched, ["fast", "smart"]);

  // 重新打开：选择与状态都从 active path 读出，第三轮路由到 fast（turn 2）。
  const reopened = await createRuntime({ cwd: process.cwd() }, deps);
  await reopened.prompt("three");
  await reopened.flush();
  assert.equal(fast.requests.length, 2);
  const last = (await session.entries()).at(-1)!;
  assert.equal(last.type, "metadata");
  assert.deepEqual(last.type === "metadata" ? last.value : undefined, {
    modelId: "alternate",
    state: 2,
  });
});

test("路由失败时本轮以 error 回复结束且不写状态；下一轮仍从分支上的选择重新路由", async () => {
  const { catalog, smart } = physicalModels();
  let healthy = false;
  catalog.registerVirtual<string>({
    id: "flaky",
    route() {
      if (!healthy) throw new Error("router offline");
      return { model: "smart", state: "ok" };
    },
  });
  const routing = createVirtualModelRouting(catalog, { defaultModelId: "flaky" });
  const session = new InMemorySessionStore();
  const runtime = await createRuntime(
    { cwd: process.cwd() },
    {
      model: new ScriptedModel([]),
      tools: new ToolRegistry(),
      session,
      prepareRequest: routing.prepareRequest,
    },
  );

  const failed = await runtime.prompt("one");
  assert.equal(failed.reason, "error");
  const errorReply = failed.messages.at(-1) as AssistantMessage;
  assert.equal(errorReply.errorMessage, "router offline");
  await runtime.flush();
  assert.ok(
    (await session.entries()).every((entry) => entry.type !== "metadata"),
  );

  healthy = true;
  const recovered = await runtime.prompt("two");
  await runtime.flush();
  assert.equal(recovered.reason, "stop");
  assert.equal(smart.requests.length, 1);
  const kinds = (await session.entries()).map((entry) =>
    entry.type === "metadata" ? entry.key : entry.type,
  );
  assert.deepEqual(kinds, [
    "message",
    "message",
    "message",
    "message",
    VIRTUAL_MODEL_STATE_KEY,
  ]);
});
