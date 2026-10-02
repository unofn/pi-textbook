import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableHarness,
  DurableSession,
  DurableStore,
  StorageRejected,
  type DurableSnapshot,
  type DurableWrite,
  type ReplayPolicy,
  type TaskRecord,
} from "../src/durable.js";
import { AssistantMessageEventStream } from "../src/event-stream.js";
import { ScriptedModel } from "../src/scripted-model.js";
import type { JsonValue } from "../src/session.js";
import { objectSchema, stringValue, type Tool } from "../src/tool.js";
import {
  assistantMessage,
  text,
  type AgentContext,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "../src/types.js";

const SLOW = { timeout: 10_000 };

function write(
  collection: DurableWrite["collection"],
  id: string,
  value: JsonValue,
): DurableWrite {
  return { collection, id, value };
}

function call(id: string, name: string, args: unknown): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function ids(prefix = "id"): () => string {
  let next = 0;
  return () => `${prefix}${++next}`;
}

/** 记录每次提交触及的记录，并在第 N 次提交后拍快照。 */
function observe(store: DurableStore, snapshotAt?: number) {
  const log: string[] = [];
  let snapshot: DurableSnapshot | undefined;
  store.onCommit((seq, writes) => {
    for (const entry of writes) {
      if (entry.collection === "tasks") {
        const task = entry.value as unknown as TaskRecord;
        log.push(`${seq}:${task.kind}:${task.status}:${task.checkpoint.phase}`);
      } else {
        const record = entry.value as { entry: { type: string } };
        log.push(`${seq}:entry:${record.entry.type}`);
      }
    }
    if (seq === snapshotAt) snapshot = store.snapshot();
  });
  return { log, snapshot: () => snapshot };
}

/**
 * 每次请求按计划流式输出：增量之间隔一个宏任务，给“崩溃”留出落点；
 * 计划没有 final 时在增量之后永远挂起。
 */
function streamingModel(
  plans: { deltas: string[]; final?: AssistantMessage }[],
): { model: Model; requests: AgentContext[] } {
  const requests: AgentContext[] = [];
  let cursor = 0;
  return {
    requests,
    model: {
      stream(context) {
        requests.push(structuredClone(context));
        const plan = plans[cursor++] ?? { deltas: [] };
        const stream = new AssistantMessageEventStream();
        void (async () => {
          const partial = assistantMessage([], "stop");
          stream.push({ type: "start", partial: structuredClone(partial) });
          let accumulated = "";
          for (const delta of plan.deltas) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            accumulated += delta;
            partial.content = [text(accumulated)];
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta,
              partial: structuredClone(partial),
            });
          }
          if (!plan.final) return;
          stream.push({ type: "done", reason: "stop", message: plan.final });
          stream.end(plan.final);
        })();
        return stream;
      },
    },
  };
}

interface CountingTool extends Tool<{ value: string }> {
  runs: number;
  started: Promise<void>;
}

/** 第 hangOn 次执行挂起直到被取消：模拟进程在 execute() 中途崩溃。 */
function countingTool(name: string, hangOn?: number): CountingTool {
  let markStarted!: () => void;
  const tool: CountingTool = {
    name,
    description: `${name} tool`,
    schema: objectSchema({ value: stringValue }),
    runs: 0,
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    execute({ value }, context) {
      tool.runs += 1;
      markStarted();
      if (tool.runs === hangOn) {
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () => reject(new Error("crashed")),
            { once: true },
          );
        });
      }
      return Promise.resolve({ content: [text(`${name}:${value}`)] });
    },
  };
  return tool;
}

test("原子批量提交：一批写入要么全部进入存储，要么一个都不进；快照导出再导入得到相同状态", async () => {
  const store = new DurableStore();
  assert.equal(
    await store.commit([
      write("entries", "e1", { index: 0 }),
      write("tasks", "t1", { status: "pending" }),
    ]),
    1,
  );

  await assert.rejects(
    store.commit([
      write("entries", "e2", { index: 1 }),
      write("tasks", "t2", { bad: Number.NaN }),
    ]),
    StorageRejected,
  );
  await assert.rejects(
    store.commit([write("entries", "", {})]),
    StorageRejected,
  );
  assert.equal(store.get("entries", "e2"), undefined, "同批里合法的写入也不能落下");
  assert.equal(store.currentSeq, 1);

  await store.commit([write("entries", "e1", { index: 0, replaced: true })]);
  assert.deepEqual(store.get("entries", "e1"), { index: 0, replaced: true });
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot, {
    seq: 2,
    entries: { e1: { index: 0, replaced: true } },
    tasks: { t1: { status: "pending" } },
  });
  const restored = DurableStore.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.equal(await restored.commit([write("tasks", "t2", {})]), 3);
  assert.equal(store.currentSeq, 2, "快照是副本，不是共享状态");
});

test("单一变更线：并发 commit 串行执行，change 里读到的是前一次提交后的状态", async () => {
  const session = new DurableSession(new DurableStore());
  const order: string[] = [];
  const increment = (label: string) =>
    session.commit(async (tx) => {
      order.push(`start ${label}`);
      const current = (tx.get("tasks", "counter") as number | undefined) ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 2));
      tx.put("tasks", "counter", current + 1);
      order.push(`end ${label}`);
      return current;
    });

  const seen = await Promise.all([increment("a"), increment("b"), increment("c")]);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.equal(session.get("tasks", "counter"), 3);
  assert.equal(session.store.currentSeq, 3);
  assert.equal(await session.commit(() => "read only"), "read only");
  assert.equal(session.store.currentSeq, 3, "没有写入的 change 不产生提交");
});

test("先提交再可见：change 抛错或存储拒绝时没有任何可见进展；失败的提交不阻塞后面的提交", async () => {
  const store = new DurableStore();
  const session = new DurableSession(store);
  await assert.rejects(
    session.commit((tx) => {
      tx.put("entries", "a", { ok: true });
      throw new Error("change failed");
    }),
    /change failed/,
  );
  await assert.rejects(
    session.commit((tx) => {
      tx.put("entries", "b", { ok: true });
      tx.put("entries", "c", { bad: () => undefined } as unknown as JsonValue);
    }),
    StorageRejected,
  );
  assert.deepEqual(session.list("entries"), []);
  assert.deepEqual(store.list("entries"), []);

  await session.commit((tx) => tx.put("entries", "d", { ok: true }));
  assert.deepEqual(session.get("entries", "d"), { ok: true });
  assert.equal(store.currentSeq, 1);
});

test("prompt 把用户 entry 与 generation 任务放进同一次提交；run 让任务 pending → running → completed，检查点整条替换", SLOW, async () => {
  const store = new DurableStore();
  const { log } = observe(store);
  const harness = await DurableHarness.open({
    store,
    model: new ScriptedModel([assistantMessage([text("hello")])]),
    createId: ids(),
  });

  await harness.prompt("c1", "hi");
  assert.deepEqual(log, ["1:entry:user", "1:generation:pending:request"]);
  await harness.run();
  // 文本增量先作为部分输出提交（检查点整条替换），回复与完成再一起提交。
  assert.deepEqual(log.slice(2), [
    "2:generation:running:request",
    "3:generation:running:request",
    "4:entry:assistant",
    "4:generation:completed:request",
  ]);
  assert.deepEqual(
    harness.messages("c1").map((message) => message.role),
    ["user", "assistant"],
  );
  const [task] = harness.tasks();
  assert.equal(task?.status, "completed");
  assert.deepEqual(task?.checkpoint, { phase: "request" });
  assert.deepEqual(harness.messages("other"), []);
});

test("重新打开时 running 的任务改回 pending，其余任务不变", SLOW, async () => {
  const store = new DurableStore();
  const tasks: TaskRecord[] = [
    {
      id: "g1",
      kind: "generation",
      conversationId: "c",
      order: 0,
      status: "completed",
      input: { inputEntryCount: 1 },
      checkpoint: { phase: "request" },
    },
    {
      id: "g2",
      kind: "generation",
      conversationId: "c",
      order: 1,
      status: "running",
      input: { inputEntryCount: 3 },
      checkpoint: { phase: "request" },
    },
    {
      id: "t1",
      kind: "tool",
      conversationId: "c",
      order: 2,
      status: "failed",
      input: { assistantEntryId: "e", callId: "x" },
      checkpoint: { phase: "call" },
      error: "boom",
    },
  ];
  await store.commit(
    tasks.map((task) => write("tasks", task.id, task as unknown as JsonValue)),
  );

  const harness = await DurableHarness.open({
    store: DurableStore.fromSnapshot(store.snapshot()),
    model: new ScriptedModel([]),
    createId: ids(),
  });
  assert.deepEqual(
    harness.tasks().map((task) => [task.id, task.status]),
    [
      ["g1", "completed"],
      ["g2", "pending"],
      ["t1", "failed"],
    ],
  );
  assert.deepEqual(harness.tasks()[2], tasks[2]);
});

/** 恢复后的模型只需要给出最终回复：工具调用那一轮已经提交过了。 */
function finalTurnModel() {
  return new ScriptedModel([assistantMessage([text("done")])]);
}

/** 一轮工具调用：模型先调 tool，再给最终回复。 */
function toolTurnModel(toolName: string) {
  return new ScriptedModel([
    assistantMessage([call("call-1", toolName, { value: "x" })], "toolUse"),
    assistantMessage([text("done")]),
  ]);
}

test("工具任务在 execute() 之前提交意图（参数与 replay 策略），结果与下一轮 generation 在意图之后同一次提交里可见", SLOW, async () => {
  const store = new DurableStore();
  const tool = countingTool("echo");
  let intentSeqAtExecute: number | undefined;
  const watched: Tool<{ value: string }> = {
    ...tool,
    execute(parameters, context) {
      intentSeqAtExecute = store.currentSeq;
      return tool.execute(parameters, context);
    },
  };
  const { log } = observe(store);
  const harness = await DurableHarness.open({
    store,
    model: toolTurnModel("echo"),
    tools: [{ tool: watched as Tool, replay: "safe" }],
    createId: ids(),
  });
  await harness.prompt("c", "go");
  await harness.run();

  assert.deepEqual(log.slice(2), [
    "2:generation:running:request",
    "3:entry:assistant",
    "3:tool:pending:call",
    "3:generation:completed:request",
    "4:tool:running:call",
    "5:tool:running:execute",
    "6:entry:toolResult",
    "6:tool:completed:execute",
    "6:generation:pending:request",
    "7:generation:running:request",
    "8:generation:running:request",
    "9:entry:assistant",
    "9:generation:completed:request",
  ]);
  assert.equal(intentSeqAtExecute, 5, "execute() 看到的已提交状态里已经有意图");
  const toolTask = harness.tasks().find((task) => task.kind === "tool");
  assert.deepEqual(toolTask?.checkpoint, {
    phase: "execute",
    arguments: { value: "x" },
    replay: "safe",
  });
  assert.deepEqual(
    harness.messages("c").map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
});

/** 跑到工具 execute() 挂起处“崩溃”，返回崩溃时的存储快照。 */
async function crashDuringExecute(replay: ReplayPolicy): Promise<DurableSnapshot> {
  const store = new DurableStore();
  const tool = countingTool("echo", 1);
  const harness = await DurableHarness.open({
    store,
    model: toolTurnModel("echo"),
    tools: [{ tool: tool as Tool, replay }],
    createId: ids("a"),
  });
  await harness.prompt("c", "go");
  const controller = new AbortController();
  const running = harness.run({ signal: controller.signal });
  await tool.started;
  controller.abort();
  await running;
  const snapshot = store.snapshot();
  const task = Object.values(snapshot.tasks)
    .map((value) => value as unknown as TaskRecord)
    .find((candidate) => candidate.kind === "tool");
  assert.equal(task?.status, "running");
  assert.equal(task?.checkpoint.phase, "execute");
  return snapshot;
}

test("恢复时存储意图与当前注册都是 replay:safe 才重跑：安全工具从头重跑一次，结果正常", SLOW, async () => {
  const snapshot = await crashDuringExecute("safe");
  const tool = countingTool("echo");
  const harness = await DurableHarness.open({
    store: DurableStore.fromSnapshot(snapshot),
    model: finalTurnModel(),
    tools: [{ tool: tool as Tool, replay: "safe" }],
    createId: ids("b"),
  });
  await harness.run();

  assert.equal(tool.runs, 1);
  const messages = harness.messages("c");
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  const result = messages[2];
  assert.equal(result?.role === "toolResult" && result.isError, false);
  assert.ok(harness.tasks().every((task) => task.status === "completed"));
});

test("存储意图是 unsafe，或当前注册改成 unsafe，恢复都给模型 interrupted 错误结果而不重跑", SLOW, async () => {
  for (const [stored, current] of [
    ["unsafe", "safe"],
    ["safe", "unsafe"],
  ] as const) {
    const snapshot = await crashDuringExecute(stored);
    const tool = countingTool("echo");
    const harness = await DurableHarness.open({
      store: DurableStore.fromSnapshot(snapshot),
      model: finalTurnModel(),
      tools: [{ tool: tool as Tool, replay: current }],
      createId: ids("b"),
    });
    await harness.run();

    assert.equal(tool.runs, 0, `${stored}/${current} 不能重跑`);
    const messages = harness.messages("c");
    const result = messages[2];
    assert.equal(result?.role, "toolResult");
    if (result?.role === "toolResult") {
      assert.equal(result.isError, true);
      assert.deepEqual(result.details, {
        error: "interrupted",
        message: "Tool echo was interrupted and may have partially run",
      });
    }
    const toolTask = harness.tasks().find((task) => task.kind === "tool");
    assert.equal(toolTask?.status, "failed");
    assert.equal(toolTask?.error, "Tool echo was interrupted");
    assert.equal(messages.at(-1)?.role, "assistant", "模型拿到 interrupted 结果后继续");
  }
});

test("流式部分输出逐步提交；崩溃后已提交的部分输出变成 aborted assistant entry，请求用同样的消息从头重发", SLOW, async () => {
  const store = new DurableStore();
  // 提交 1：prompt；2：running；3、4：两段部分输出。第 4 次提交之后“崩溃”。
  const { snapshot } = observe(store, 4);
  const first = streamingModel([{ deltas: ["Hel", "lo", " never"] }]);
  const harness = await DurableHarness.open({
    store,
    model: first.model,
    createId: ids("a"),
  });
  await harness.prompt("c", "hi");
  const controller = new AbortController();
  store.onCommit((seq) => {
    if (seq === 4) controller.abort();
  });
  await harness.run({ signal: controller.signal });

  const crashed = snapshot();
  assert.ok(crashed);
  const before = Object.values(crashed.tasks)[0] as unknown as TaskRecord;
  assert.equal(before.status, "running");
  assert.deepEqual(
    before.kind === "generation" ? before.checkpoint.partial?.content : undefined,
    [text("Hello")],
  );

  const final = assistantMessage([text("Hello again")]);
  const second = streamingModel([{ deltas: ["Hello again"], final }]);
  const reopened = await DurableHarness.open({
    store: DurableStore.fromSnapshot(crashed),
    model: second.model,
    createId: ids("b"),
  });
  await reopened.run();

  const messages = reopened.messages("c");
  assert.deepEqual(
    messages.map((message) =>
      message.role === "assistant" ? message.stopReason : message.role,
    ),
    ["user", "aborted", "stop"],
  );
  assert.deepEqual(messages[1]?.role === "assistant" && messages[1].content, [
    text("Hello"),
  ]);
  assert.deepEqual(
    second.requests[0]?.messages,
    first.requests[0]?.messages,
    "重发用的是同样的输入消息，不含 aborted entry",
  );
  const [task] = reopened.tasks();
  assert.equal(task?.status, "completed");
  assert.deepEqual(task?.checkpoint, { phase: "request" });
});

test("模型以 error 结束时：错误回复落盘为 entry，不创建新的 generation；下一次 prompt 从新的用户消息继续", SLOW, async () => {
  const model = new ScriptedModel([
    { stopReason: "error", errorMessage: "overloaded" },
    assistantMessage([text("recovered")]),
  ]);
  const harness = await DurableHarness.open({
    store: new DurableStore(),
    model,
    createId: ids(),
  });
  await harness.prompt("c", "first");
  await harness.run();
  assert.deepEqual(
    harness.messages("c").map((message) =>
      message.role === "assistant" ? message.stopReason : message.role,
    ),
    ["user", "error"],
  );
  assert.equal(harness.tasks().length, 1);
  assert.equal(harness.tasks()[0]?.status, "completed");

  await harness.prompt("c", "second");
  await harness.run();
  assert.deepEqual(
    harness.messages("c").map((message) =>
      message.role === "assistant" ? message.stopReason : message.role,
    ),
    ["user", "error", "user", "stop"],
  );
  assert.equal(model.requests[1]?.messages.length, 3);
});
