import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRuntime,
  runInteractive,
  runJson,
  runPrint,
  type ModeIO,
  type RuntimeDeps,
} from "../src/composition.js";
import {
  EvalAssertionError,
  runEvalCase,
  runEvalSuite,
} from "../src/eval.js";
import {
  RESOURCE_SECTION,
  type ResourceCatalog,
} from "../src/resources.js";
import { ScriptedModel } from "../src/scripted-model.js";
import { InMemorySessionStore } from "../src/session.js";
import {
  objectSchema,
  stringValue,
  ToolRegistry,
} from "../src/tool.js";
import {
  assistantMessage,
  currentSystemPrompt,
  text,
  type AgentMessage,
  type ToolCall,
} from "../src/types.js";

function output(): {
  io: ModeIO;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  return {
    stdout,
    stderr,
    exitCodes,
    io: {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      setExitCode: (code) => exitCodes.push(code),
    },
  };
}

function call(
  id: string,
  name: string,
  argumentsValue: unknown,
): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: argumentsValue,
  };
}

test("composition root 使用注入依赖，三种 adapter 共享核心语义", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-composition-"));
  const resources: ResourceCatalog = {
    resources: [],
    templates: [],
    skills: [],
    diagnostics: [
      {
        level: "warning",
        code: "root_unreadable",
        message: "fixture",
      },
    ],
    diagnosticMessages: ["fixture"],
  };
  const session = new InMemorySessionStore();
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo a value",
    schema: objectSchema({ value: stringValue }),
    async execute({ value }) {
      return { content: [text(value)] };
    },
  });
  const deps: RuntimeDeps = {
    model: new ScriptedModel([
      assistantMessage([text("one")]),
      assistantMessage([text("two")]),
      assistantMessage(
        [call("echo-1", "echo", { value: "three" })],
        "toolUse",
      ),
      assistantMessage([text("three")]),
    ]),
    tools,
    session,
    resources,
    createId: (() => {
      let value = 0;
      return () => `entry-${++value}`;
    })(),
    now: () => 1,
  };
  const runtime = await createRuntime({ cwd: root }, deps);
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const print = output();
  const interactive = output();
  const json = output();
  const printResult = await runPrint(runtime, "p1", print.io);
  const interactiveResult = await runInteractive(
    runtime,
    "p2",
    interactive.io,
  );
  const jsonResult = await runJson(runtime, "p3", json.io);

  assert.equal(runtime.session, session);
  assert.equal(runtime.resources, resources);
  assert.equal(print.stdout.join(""), "one");
  assert.equal(interactive.stdout.join(""), "two");
  assert.equal(printResult.status, "ok");
  assert.equal(interactiveResult.status, "ok");
  assert.equal(jsonResult.status, "ok");
  assert.equal(printResult.exitCode, 0);
  assert.equal(jsonResult.exitCode, 0);
  assert.deepEqual(print.exitCodes, [0]);
  assert.deepEqual(json.exitCodes, [0]);
  assert.deepEqual(print.stderr, ["[diagnostic] fixture\n"]);
  assert.deepEqual(json.stderr, ["[diagnostic] fixture\n"]);

  const wire = json.stdout.map((line) => JSON.parse(line));
  assert.deepEqual(
    wire.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    wire.map((event) => event.type),
    ["tool_end", "text_delta", "result"],
  );
  assert.deepEqual(Object.keys(wire[0]).sort(), [
    "callId",
    "isError",
    "seq",
    "type",
    "v",
  ]);
  assert.equal(wire[0].callId, "echo-1");
  assert.equal(wire[0].isError, false);
  assert.equal(wire[2].status, "ok");
  assert.equal((wire[0] as Record<string, unknown>).runId, undefined);
  assert.equal((wire[0] as Record<string, unknown>).event, undefined);
  assert.equal((await session.entries()).length, 8);
});

test("print/json 都用 stderr 与 exit code 表达失败，JSON 仍有唯一终态", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mode-error-"));
  const runtime = await createRuntime({
    cwd: root,
    model: new ScriptedModel([
      {
        stopReason: "error",
        errorMessage: "provider unavailable",
      },
      {
        stopReason: "aborted",
        errorMessage: "cancelled",
      },
    ]),
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const print = output();
  const printed = await runPrint(runtime, "fail", print.io);
  assert.equal(printed.exitCode, 1);
  assert.deepEqual(print.exitCodes, [1]);
  assert.equal(print.stdout.join(""), "");
  assert.match(print.stderr.join(""), /provider unavailable/);

  const json = output();
  const jsonRun = await runJson(runtime, "cancel", json.io);
  assert.equal(jsonRun.exitCode, 130);
  assert.deepEqual(json.exitCodes, [130]);
  assert.match(json.stderr.join(""), /cancelled/);
  const wire = json.stdout.map((line) => JSON.parse(line));
  assert.equal(wire.at(-1).type, "result");
  assert.equal(wire.at(-1).status, "aborted");
  assert.equal(
    wire.filter((event) => event.type === "result").length,
    1,
  );
});

test("composition 把 resource disclosure 与 extension hook 接入真实 loop", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-runtime-resource-"));
  const skillRoot = path.join(root, ".pi", "skills", "guard");
  const skillFile = path.join(skillRoot, "SKILL.md");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    skillFile,
    "---\nname: guard\ndescription: protect writes\n---\nAlways inspect before editing.",
    "utf8",
  );
  const resources: ResourceCatalog = {
    resources: [
      {
        kind: "skill",
        name: "guard",
        description: "protect writes",
        source: skillFile,
        root: skillRoot,
        scope: "project",
      },
    ],
    templates: [],
    skills: [
      {
        kind: "skill",
        name: "guard",
        description: "protect writes",
        source: skillFile,
        root: skillRoot,
        scope: "project",
      },
    ],
    diagnostics: [],
    diagnosticMessages: [],
  };
  const model = new ScriptedModel([
    assistantMessage(
      [call("echo-denied", "echo", { value: "blocked" })],
      "toolUse",
    ),
    assistantMessage([text("observed denial")]),
  ]);
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    schema: objectSchema({ value: stringValue }),
    async execute({ value }) {
      return { content: [text(value)] };
    },
  });
  const runtime = await createRuntime(
    {
      cwd: root,
      systemPrompt: "base",
      activeSkills: ["guard"],
    },
    { model, tools, resources },
  );
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  runtime.extensions.context.on("beforeToolCall", () => ({
    decision: "deny",
    reason: "teaching policy",
  }));

  const result = await runtime.prompt("go");
  await runtime.flush();
  const toolResult = result.messages.find(
    (message) => message.role === "toolResult",
  );
  assert.equal(toolResult?.role === "toolResult" && toolResult.isError, true);
  assert.match(
    toolResult?.role === "toolResult"
      ? toolResult.content[0].text
      : "",
    /teaching policy/,
  );
  const [head] = model.requests[0].messages;
  assert.equal(head.role, "system");
  assert.equal(head.role === "system" ? head.content : "", "base");
  const section =
    head.role === "system" ? head.sections?.[RESOURCE_SECTION] ?? "" : "";
  assert.match(section, /Available resources/);
  assert.match(section, /Activated skill: guard/);
  assert.equal(
    currentSystemPrompt(model.requests[0].messages),
    `base\n\n${section}`,
  );
  assert.equal(runtime.config.systemPrompt, "base");
  assert.equal(runtime.config.systemSections[RESOURCE_SECTION], section);
  assert.equal(runtime.activatedSkills[0].skill?.name, "guard");
});

test("结构化 eval 使用临时 workspace、composition root 与确定性报告", async () => {
  const editCall = call("edit-1", "edit", {
    path: "src/value.ts",
    oldText: "return 1",
    newText: "return 2",
  });
  const evalCase = {
    id: "fix-value",
    prompt: "fix it",
    files: {
      "src/value.ts": "export function value() { return 1; }\n",
    },
    script: [
      assistantMessage([editCall], "toolUse"),
      assistantMessage([text("fixed")]),
    ],
    assert(result: Awaited<ReturnType<typeof runEvalCase>>) {
      assert.equal(
        result.files["src/value.ts"],
        "export function value() { return 2; }\n",
      );
      assert.equal(result.metrics.turns, 2);
      assert.equal(result.metrics.toolCalls, 1);
      assert.equal(result.session.length, result.transcript.length);
    },
  };

  const first = await runEvalCase(evalCase);
  const second = await runEvalCase(evalCase);
  assert.equal(first.status, "passed");
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes(os.tmpdir()), false);
  assert.deepEqual(
    first.session.map((entry) => entry.id),
    [
      "fix-value-entry-1",
      "fix-value-entry-2",
      "fix-value-entry-3",
      "fix-value-entry-4",
    ],
  );
  assert.ok(
    first.transcript.every((message) => message.timestamp === 0),
  );
});

test("eval 分开报告 protocol、task 与 infra failure，并继续 suite", async () => {
  const cases = [
    {
      id: "unpaired",
      prompt: "go",
      files: {},
      script: [
        assistantMessage(
          [
            call("duplicate-call", "read", { path: "x" }),
            call("duplicate-call", "read", { path: "y" }),
          ],
          "toolUse",
        ),
        assistantMessage([text("done")]),
      ],
      assert() {},
    },
    {
      id: "bad-task",
      prompt: "go",
      files: {},
      script: [assistantMessage([text("done")])],
      assert() {
        throw new EvalAssertionError("task_failed", {
          layer: "task",
          firstDivergence: "wrong final answer",
        });
      },
    },
    {
      id: "bad-fixture",
      prompt: "go",
      files: { "../escape.txt": "no" },
      script: [assistantMessage([text("unused")])],
      assert() {},
    },
    {
      id: "still-runs",
      prompt: "go",
      files: {},
      script: [assistantMessage([text("ok")])],
      assert() {},
    },
  ] as const;

  const results = await runEvalSuite(cases);
  assert.deepEqual(
    results.map((result) => result.status),
    ["protocol_failed", "task_failed", "infra_failed", "passed"],
  );
  assert.match(
    results[0].failure?.firstDivergence ?? "",
    /id 重复/,
  );
  assert.equal(results[3].passed, true);
});

test("tool 抛错会成为配对 result，而不是 runner infra failure", async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "explode",
    description: "throw",
    schema: objectSchema({ message: stringValue }),
    async execute() {
      throw new Error("boom");
    },
  });

  const result = await runEvalCase({
    id: "tool-error",
    prompt: "go",
    files: {},
    tools,
    script: [
      assistantMessage(
        [call("explode-1", "explode", { message: "boom" })],
        "toolUse",
      ),
      assistantMessage([text("recovered")]),
    ],
    assert(value) {
      const toolResult = value.transcript.find(
        (message) => message.role === "toolResult",
      );
      assert.equal(toolResult?.toolCallId, "explode-1");
      assert.equal(toolResult?.isError, true);
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(result.metrics.toolCalls, 1);
});

function catalogWith(templateNames: string[]): ResourceCatalog {
  const templates = templateNames.map((name) => ({
    kind: "template" as const,
    name,
    description: `${name} template`,
    source: `/fixtures/${name}.md`,
    scope: "project",
    body: name,
    content: name,
  }));
  return {
    resources: [...templates],
    templates,
    skills: [],
    diagnostics: [],
    diagnosticMessages: [],
  };
}

function systemMessages(messages: readonly AgentMessage[]) {
  return messages.filter((message) => message.role === "system");
}

test("composition 只为变化的段落追加补丁，已持久化前缀从不改写", async () => {
  const session = new InMemorySessionStore();
  let sequence = 0;
  const open = (
    systemPrompt: string,
    resources: ResourceCatalog,
    replies: string[],
  ) => {
    const model = new ScriptedModel(
      replies.map((reply) => assistantMessage([text(reply)])),
    );
    return createRuntime(
      { cwd: os.tmpdir(), systemPrompt },
      {
        model,
        tools: new ToolRegistry(),
        session,
        resources,
        createId: () => `entry-${++sequence}`,
        now: () => sequence,
      },
    ).then((runtime) => ({ runtime, model }));
  };
  const messagesOf = async () =>
    (await session.entries()).flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );

  // 1. 新会话：开头一条 system message（基础 prompt + 资源段落），之后不再追加。
  const first = await open("base", catalogWith(["alpha"]), ["one", "two"]);
  await runPrint(first.runtime, "p1");
  await runPrint(first.runtime, "p2");
  await first.runtime.dispose();
  const afterFirst = await session.entries();
  const firstMessages = await messagesOf();
  assert.deepEqual(
    firstMessages.map((message) => message.role),
    ["system", "user", "assistant", "user", "assistant"],
  );
  assert.equal(firstMessages[0].role === "system" && firstMessages[0].content, "base");
  assert.match(
    firstMessages[0].role === "system"
      ? firstMessages[0].sections?.[RESOURCE_SECTION] ?? ""
      : "",
    /template alpha/,
  );
  assert.equal(currentSystemPrompt(first.model.requests[1].messages), first.runtime.agent.systemPrompt);

  // 2. 恢复会话、资源变化、配置的基础 prompt 也变化：transcript 是事实，
  //    只追加资源段落补丁，基础 prompt 保持第一次写入的值。
  const second = await open("changed base", catalogWith(["beta"]), ["three"]);
  assert.equal(second.runtime.agent.systemPrompt, first.runtime.agent.systemPrompt);
  await runPrint(second.runtime, "p3");
  await second.runtime.dispose();
  const afterSecond = await session.entries();
  assert.deepEqual(afterSecond.slice(0, afterFirst.length), afterFirst);
  const added = afterSecond.slice(afterFirst.length);
  assert.deepEqual(
    added.map((entry) => entry.type === "message" && entry.message.role),
    ["system", "user", "assistant"],
  );
  assert.equal(added[0].parentId, afterFirst.at(-1)?.id);
  const patch = added[0].type === "message" ? added[0].message : undefined;
  assert.equal(patch?.role === "system" && patch.content, "");
  assert.deepEqual(
    patch?.role === "system" ? Object.keys(patch.sections ?? {}) : [],
    [RESOURCE_SECTION],
  );
  // 模型看到恢复出的完整 transcript，且基础 prompt 仍是 "base"。
  const request = second.model.requests[0].messages;
  assert.deepEqual(request.slice(0, firstMessages.length), firstMessages);
  const prompt = currentSystemPrompt(request) ?? "";
  assert.match(prompt, /^base\n\n/);
  assert.match(prompt, /template beta/);
  assert.equal(prompt.includes("alpha"), false);
  assert.equal(prompt.includes("changed base"), false);

  // 3. 资源相同：不追加 system message。
  const third = await open("base", catalogWith(["beta"]), ["four"]);
  await runPrint(third.runtime, "p4");
  await third.runtime.dispose();
  const afterThird = await session.entries();
  assert.deepEqual(afterThird.slice(0, afterSecond.length), afterSecond);
  assert.deepEqual(
    afterThird
      .slice(afterSecond.length)
      .map((entry) => entry.type === "message" && entry.message.role),
    ["user", "assistant"],
  );

  // 4. 资源清空：段落补丁为 null，删除后只剩基础 prompt。
  const fourth = await open("base", catalogWith([]), ["five", "six"]);
  await runPrint(fourth.runtime, "p5");
  await runPrint(fourth.runtime, "p6");
  await fourth.runtime.dispose();
  const finalMessages = await messagesOf();
  const finalSystems = systemMessages(finalMessages);
  assert.equal(finalSystems.length, 3);
  assert.deepEqual(
    finalSystems[2].role === "system" ? finalSystems[2].sections : undefined,
    { [RESOURCE_SECTION]: null },
  );
  assert.equal(currentSystemPrompt(finalMessages), "base");
  assert.equal(fourth.runtime.agent.systemPrompt, "base");
});

test("没有基础 prompt 也没有资源时，composition 不写 system message", async () => {
  const session = new InMemorySessionStore();
  const model = new ScriptedModel([assistantMessage([text("ok")])]);
  const runtime = await createRuntime(
    { cwd: os.tmpdir() },
    { model, tools: new ToolRegistry(), session },
  );
  await runPrint(runtime, "hi");
  await runtime.dispose();
  assert.deepEqual(
    (await session.entries()).map(
      (entry) => entry.type === "message" && entry.message.role,
    ),
    ["user", "assistant"],
  );
  assert.equal(currentSystemPrompt(model.requests[0].messages), undefined);
});

test("eval active path 接受 system message，不参与 call/result 配对", async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    schema: objectSchema({ value: stringValue }),
    async execute({ value }) {
      return { content: [text(value)] };
    },
  });
  const result = await runEvalCase({
    id: "with-system",
    prompt: "go",
    files: {},
    tools,
    systemPrompt: "be careful",
    script: [
      assistantMessage(
        [call("echo-1", "echo", { value: "x" })],
        "toolUse",
      ),
      assistantMessage([text("done")]),
    ],
    assert(value) {
      assert.deepEqual(
        value.transcript.map((message) => message.role),
        ["system", "user", "assistant", "toolResult", "assistant"],
      );
      assert.equal(value.session.length, value.transcript.length);
      assert.equal(currentSystemPrompt(value.transcript), "be careful");
    },
  });

  assert.equal(result.status, "passed", result.error);
  assert.equal(result.metrics.toolCalls, 1);
});
