import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { createCodingTools } from "../src/coding-tools.js";
import { ScriptedModel } from "../src/scripted-model.js";
import { executeToolCall, ToolRegistry } from "../src/tool.js";
import {
  assistantMessage,
  currentSystemPrompt,
  userMessage,
  type ToolCall,
} from "../src/types.js";

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

test("coding tools 支持续读、批量 edit 和 symlink escape 诊断", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-workshop-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-outside-"));
  await writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree\nfour", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  await symlink(outside, path.join(root, "escape"));

  const tools = createCodingTools({
    cwd: root,
    containment: "workspace",
    maxReadLines: 2,
  });
  const read = await executeToolCall(
    call("read-1", "read", { path: "notes.txt", offset: 3, limit: 2 }),
    tools,
  );
  assert.equal(read.isError, false);
  assert.match(read.content[0].text, /3│ three/);
  assert.match(read.content[0].text, /4│ four/);

  const edit = await executeToolCall(
    call("edit-1", "edit", {
      path: "notes.txt",
      edits: [
        { oldText: "one", newText: "ONE" },
        { oldText: "three", newText: "THREE" },
      ],
    }),
    tools,
  );
  assert.equal(edit.isError, false);
  assert.equal(
    await readFile(path.join(root, "notes.txt"), "utf8"),
    "ONE\ntwo\nTHREE\nfour",
  );

  const escaped = await executeToolCall(
    call("read-2", "read", { path: "escape/secret.txt" }),
    tools,
  );
  assert.equal(escaped.isError, true);
  assert.match(escaped.content[0].text, /符号链接/);
});

test("subscriber 抛错不会破坏 Agent cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-agent-"));
  await mkdir(root, { recursive: true });
  const agent = new Agent({
    model: new ScriptedModel([
      assistantMessage([{ type: "text", text: "ok" }]),
    ]),
    tools: createCodingTools({
      cwd: root,
      containment: "workspace",
    }),
  });
  agent.subscribe(() => {
    throw new Error("broken renderer");
  });
  const result = await agent.prompt("hello");

  assert.equal(result.reason, "stop");
  assert.equal(agent.getState().status, "idle");
  assert.match(agent.getState().diagnostics[0], /broken renderer/);
});

test("Agent 把 systemPrompt 放进 transcript 开头，systemPrompt 只读重放", async () => {
  const model = new ScriptedModel([
    assistantMessage([{ type: "text", text: "one" }]),
    assistantMessage([{ type: "text", text: "two" }]),
  ]);
  const agent = new Agent({
    model,
    tools: new ToolRegistry(),
    systemPrompt: "base",
  });
  assert.deepEqual(agent.getState().messages, [
    { role: "system", content: "base", timestamp: 0 },
  ]);
  assert.equal(agent.systemPrompt, "base");

  await agent.prompt("first");
  const result = await agent.prompt("second", {
    system: { content: "Cite files.", sections: { mode: "review" } },
  });

  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["system", "user", "assistant", "system", "user", "assistant"],
  );
  const patch = result.messages[3];
  assert.equal(patch.role, "system");
  assert.deepEqual(
    patch.role === "system" ? [patch.content, patch.sections] : [],
    ["Cite files.", { mode: "review" }],
  );
  assert.equal(agent.systemPrompt, "base\n\nCite files.\n\nreview");
  // 第一条请求只看到开头的 base；补丁属于第二次运行的新 suffix。
  assert.equal(currentSystemPrompt(model.requests[0].messages), "base");
  assert.equal(
    currentSystemPrompt(model.requests[1].messages),
    "base\n\nCite files.\n\nreview",
  );
});

test("初始 transcript 已以 system message 开头时，Agent 不再放入 systemPrompt", () => {
  const restored = [
    { role: "system" as const, content: "persisted", timestamp: 5 },
    userMessage("earlier"),
  ];
  const seeded = new Agent({
    model: new ScriptedModel([]),
    tools: new ToolRegistry(),
    systemPrompt: "config",
    messages: restored,
  });
  assert.deepEqual(seeded.getState().messages, restored);
  assert.equal(seeded.systemPrompt, "persisted");

  const withoutSystem = new Agent({
    model: new ScriptedModel([]),
    tools: new ToolRegistry(),
    systemPrompt: "config",
    messages: [userMessage("earlier")],
  });
  assert.deepEqual(
    withoutSystem.getState().messages.map((message) => message.role),
    ["system", "user"],
  );

  const empty = new Agent({
    model: new ScriptedModel([]),
    tools: new ToolRegistry(),
    systemPrompt: "",
  });
  assert.deepEqual(empty.getState().messages, []);
  assert.equal(empty.systemPrompt, undefined);
});
